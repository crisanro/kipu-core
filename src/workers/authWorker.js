const pool = require('../database/index');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { downloadFile, uploadFile } = require('../services/storageService');
const { notificarCambioEstado } = require('./notifierService');

const parser = new XMLParser({
    ignoreAttributes: false,
    trimValues: true
});

const URLS_SRI = {
    pruebas: {
        recepcion: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
        autorizacion: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl'
    },
    produccion: {
        recepcion: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
        autorizacion: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl'
    }
};

/**
 * JOB 1: Recepción técnica en el SRI
 */
async function enviarFacturasAlSRI() {
    try {
        const query1 = `
            SELECT 
                i.id, i.xml_path, i.clave_acceso,
                e.ambiente, e.id as emisor_db_id,
                p.id as user_uid -- UID necesario para notificaciones n8n
            FROM invoices i
            JOIN emisores e ON i.emisor_id = e.id
            JOIN profiles p ON e.id = p.emisor_id -- Relación Emisor -> Perfil
            WHERE i.estado = 'FIRMADO'
            ORDER BY i.created_at ASC
            LIMIT 15
        `;
        const { rows } = await pool.query(query1); 
        if (rows.length === 0) return;

        for (const factura of rows) {
            try {
                const xmlBuffer = await downloadFile('invoices', factura.xml_path.replace('invoices/', ''));
                const urls = factura.ambiente === '2' ? URLS_SRI.produccion : URLS_SRI.pruebas;
                const xmlBase64 = xmlBuffer.toString('base64');
                
                const soapBody = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion"><soapenv:Body><ec:validarComprobante><xml>${xmlBase64}</xml></ec:validarComprobante></soapenv:Body></soapenv:Envelope>`;

                const res = await axios.post(urls.recepcion, soapBody, { 
                    headers: { 'Content-Type': 'text/xml' },
                    timeout: 8000 
                });

                const json = parser.parse(res.data);
                const respRecepcion = json['soap:Envelope']['soap:Body']['ns2:validarComprobanteResponse'].RespuestaRecepcionComprobante;

                if (respRecepcion.estado === 'RECIBIDA') {
                    await pool.query(
                        'UPDATE invoices SET estado = $1, fecha_envio_sri = NOW() WHERE id = $2', 
                        ['RECIBIDA', factura.id]
                    );
                    // Pasamos el objeto factura que ya contiene el user_uid
                    await notificarCambioEstado(factura, 'RECIBIDA');
                } else {
                    const errorMsg = JSON.stringify(respRecepcion.comprobantes || respRecepcion);
                    await pool.query(
                        'UPDATE invoices SET estado = $1, mensajes_sri = $2, fecha_envio_sri = NOW() WHERE id = $3', 
                        ['DEVUELTA', errorMsg, factura.id]
                    );
                    await notificarCambioEstado(factura, 'DEVUELTA', respRecepcion);
                }
            } catch (err) {
                console.error(`⚠️ Error Recepción (${factura.clave_acceso}):`, err.message);
            }
        }
    } catch (error) {
        console.error('❌ Error Crítico Job Envío:', error.message);
    }
}

/**
 * JOB 2: Autorización legal en el SRI
 */
async function autorizarFacturasSRI() {
    try {
        const query2 = `
            SELECT 
                i.id, i.clave_acceso,
                e.ambiente, e.ruc, e.id as emisor_db_id,
                p.id as user_uid -- UID necesario para notificaciones n8n
            FROM invoices i
            JOIN emisores e ON i.emisor_id = e.id
            JOIN profiles p ON e.id = p.emisor_id -- Relación Emisor -> Perfil
            WHERE i.estado = 'RECIBIDA'
            ORDER BY i.created_at ASC
            LIMIT 15
        `;
        const { rows } = await pool.query(query2);
        if (rows.length === 0) return;

        for (const factura of rows) {
            try {
                const urls = factura.ambiente === '2' ? URLS_SRI.produccion : URLS_SRI.pruebas;
                const soapBody = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion"><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>${factura.clave_acceso}</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>`;

                const res = await axios.post(urls.autorizacion, soapBody, { 
                    headers: { 'Content-Type': 'text/xml' },
                    timeout: 8000 
                });

                const json = parser.parse(res.data);
                const respAuth = json['soap:Envelope']['soap:Body']['ns2:autorizacionComprobanteResponse'].RespuestaAutorizacionComprobante;

                if (parseInt(respAuth.numeroComprobantes) > 0) {
                    const autorizacion = Array.isArray(respAuth.autorizaciones.autorizacion) 
                        ? respAuth.autorizaciones.autorizacion[0] 
                        : respAuth.autorizaciones.autorizacion;

                    if (autorizacion.estado === 'AUTORIZADO') {
                        const xmlAutorizado = autorizacion.comprobante;
                        const xmlAuthPath = `authorized/${factura.ruc}/${factura.clave_acceso}.xml`;
                        
                        await uploadFile('invoices', xmlAuthPath, Buffer.from(xmlAutorizado), 'text/xml');

                        // Actualización con fecha legal del SRI
                        await pool.query(
                            'UPDATE invoices SET estado = $1, xml_path = $2, fecha_autorizacion = $3 WHERE id = $4', 
                            ['AUTORIZADO', `invoices/${xmlAuthPath}`, autorizacion.fechaAutorizacion, factura.id]
                        );
                        
                        // Descuento de crédito por éxito
                        await pool.query('UPDATE user_credits SET balance = balance - 1 WHERE emisor_id = $1', [factura.emisor_db_id]);
                        
                        await notificarCambioEstado(factura, 'AUTORIZADO');
                    } else {
                        const estadoFinal = (autorizacion.estado === 'NO AUTORIZADO') ? 'RECHAZADO' : autorizacion.estado;
                        const msg = JSON.stringify(autorizacion.mensajes);
                        
                        await pool.query(
                            'UPDATE invoices SET estado = $1, mensajes_sri = $2 WHERE id = $3', 
                            [estadoFinal, msg, factura.id]
                        );
                        await notificarCambioEstado(factura, estadoFinal, autorizacion.mensajes);
                    }
                }
            } catch (err) {
                console.error(`⚠️ Error Autorización (${factura.clave_acceso}):`, err.message);
            }
        }
    } catch (error) {
        console.error('❌ Error Crítico Job Autorización:', error.message);
    }
}

module.exports = { enviarFacturasAlSRI, autorizarFacturasSRI };