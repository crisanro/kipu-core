const pool = require('../database/index');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { minioClient, downloadFile, uploadFile } = require('../services/storageService');
const { notificarCambioEstado } = require('./notifierService');
const emailService = require('../services/mailService');
const { generarPDFStream } = require('../services/rideService');

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

// ─── HELPER: Reintento automático para conexiones inestables del SRI ──────────
// Si el SRI corta la conexión (ECONNRESET, timeout, etc.), reintenta hasta 3 veces
// esperando 2s, 4s y 6s entre cada intento antes de rendirse.
async function axiosWithRetry(url, body, headers, maxRetries = 3) {
    for (let intento = 1; intento <= maxRetries; intento++) {
        try {
            return await axios.post(url, body, { headers, timeout: 10000 });
        } catch (err) {
            const esReintentable = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT'].includes(err.code);
            if (esReintentable && intento < maxRetries) {
                const espera = intento * 2000; // 2s → 4s → 6s
                console.warn(`[SRI] ⚠️ Intento ${intento}/${maxRetries} fallido (${err.code}). Reintentando en ${espera / 1000}s...`);
                await new Promise(r => setTimeout(r, espera));
            } else {
                throw err;
            }
        }
    }
}

/**
 * JOB 1: Recepción técnica en el SRI
 */
async function enviarFacturasAlSRI() {
    try {
        const query1 = `
            SELECT 
                i.id, i.xml_path, i.clave_acceso,
                e.ambiente, e.id as emisor_db_id,
                p.id as user_uid
            FROM invoices i
            JOIN emisores e ON i.emisor_id = e.id
            JOIN profiles p ON e.id = p.emisor_id
            WHERE i.estado = 'FIRMADO'
            ORDER BY i.created_at ASC
            LIMIT 15
        `;
        const { rows } = await pool.query(query1);
        if (rows.length === 0) return;

        //console.log(`[SRI Job1] Procesando ${rows.length} facturas en estado FIRMADO...`);

        for (const factura of rows) {
            try {
                console.log(`[SRI Job1] Enviando clave: ${factura.clave_acceso}`);

                const xmlBuffer = await downloadFile('invoices', factura.xml_path.replace('invoices/', ''));
                const urls = factura.ambiente === '2' ? URLS_SRI.produccion : URLS_SRI.pruebas;
                const xmlBase64 = xmlBuffer.toString('base64');

                const soapBody = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion"><soapenv:Body><ec:validarComprobante><xml>${xmlBase64}</xml></ec:validarComprobante></soapenv:Body></soapenv:Envelope>`;

                const res = await axiosWithRetry(
                    urls.recepcion,
                    soapBody,
                    { 'Content-Type': 'text/xml' }
                );

                const json = parser.parse(res.data);
                const respRecepcion = json['soap:Envelope']['soap:Body']['ns2:validarComprobanteResponse'].RespuestaRecepcionComprobante;

                if (respRecepcion.estado === 'RECIBIDA') {
                    await pool.query(
                        'UPDATE invoices SET estado = $1, fecha_envio_sri = NOW() WHERE id = $2',
                        ['RECIBIDA', factura.id]
                    );
                    console.log(`[SRI Job1] ✅ RECIBIDA: ${factura.clave_acceso}`);
                    await notificarCambioEstado(factura, 'RECIBIDA');

                } else {
                    // ❌ SRI devolvió la factura por errores de validación — reembolsar crédito
                    const errorMsg = JSON.stringify(respRecepcion.comprobantes || respRecepcion);

                    await pool.query(
                        'UPDATE invoices SET estado = $1, mensajes_sri = $2, fecha_envio_sri = NOW() WHERE id = $3',
                        ['DEVUELTA', errorMsg, factura.id]
                    );

                    // 💳 Reembolso del crédito
                    await pool.query(
                        'UPDATE user_credits SET balance = balance + 1 WHERE emisor_id = $1',
                        [factura.emisor_db_id]
                    );

                    console.warn(`[SRI Job1] ⚠️ DEVUELTA: ${factura.clave_acceso} | Crédito devuelto al emisor ${factura.emisor_db_id} | Motivo: ${errorMsg}`);
                    await notificarCambioEstado(factura, 'DEVUELTA', respRecepcion);
                }

            } catch (err) {
                console.error(`[SRI Job1] ❌ Error Recepción (${factura.clave_acceso}): ${err.message}`);
            }
        }
    } catch (error) {
        console.error('[SRI Job1] ❌ Error Crítico Job Envío:', error.message);
    }
}

/**
 * JOB 2: Autorización legal en el SRI
 */
async function autorizarFacturasSRI() {
    try {
        const query2 = `
            SELECT 
                i.id, i.clave_acceso, i.email_comprador,
                i.razon_social_comprador, i.secuencial, i.importe_total,
                i.pdf_path,
                e.ambiente, e.ruc, e.id as emisor_db_id, e.razon_social,
                p.id as user_uid
            FROM invoices i
            JOIN emisores e ON i.emisor_id = e.id
            JOIN profiles p ON e.id = p.emisor_id
            WHERE i.estado = 'RECIBIDA'
            ORDER BY i.created_at ASC
            LIMIT 15
        `;
        const { rows } = await pool.query(query2);
        if (rows.length === 0) return;

        //console.log(`[SRI Job2] Procesando ${rows.length} facturas en estado RECIBIDA...`);

        for (const factura of rows) {
            try {
                //console.log(`[SRI Job2] Consultando autorización: ${factura.clave_acceso}`);

                const urls = factura.ambiente === '2' ? URLS_SRI.produccion : URLS_SRI.pruebas;
                const soapBody = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion"><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>${factura.clave_acceso}</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>`;

                const res = await axiosWithRetry(
                    urls.autorizacion,
                    soapBody,
                    { 'Content-Type': 'text/xml' }
                );

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

                        // Regenerar PDF con fecha de autorización real
                        const emisorCompleto = await pool.query(
                            'SELECT * FROM emisores WHERE id = $1', [factura.emisor_db_id]
                        );
                        const pdfActualizado = await generarPDFStream(
                            xmlAutorizado,
                            emisorCompleto.rows[0],
                            'AUTORIZADO',
                            autorizacion.fechaAutorizacion
                        );

                        // Sobreescribe el PDF firmado con el autorizado
                        const pdfPath = factura.pdf_path.replace('invoices/', '');
                        await minioClient.putObject('invoices', pdfPath, pdfActualizado, null, { 'Content-Type': 'application/pdf' });

                        await pool.query(
                            'UPDATE invoices SET estado = $1, xml_path = $2, fecha_autorizacion = $3 WHERE id = $4',
                            ['AUTORIZADO', `invoices/${xmlAuthPath}`, autorizacion.fechaAutorizacion, factura.id]
                        );

                        // ✅ Crédito ya descontado en el endpoint, no tocar aquí
                        console.log(`[SRI Job2] ✅ AUTORIZADO: ${factura.clave_acceso}`);
                        await notificarCambioEstado(factura, 'AUTORIZADO');

                        // 📧 Enviar correo solo si el comprador tiene email
                        if (factura.email_comprador) {
                            try {
                                //console.log(`[SRI Job2] 📧 Enviando comprobante a ${factura.email_comprador}...`);
                                const xmlBuffer = Buffer.from(xmlAutorizado);
                                const pdfBuffer = await downloadFile('invoices', factura.pdf_path.replace('invoices/', ''));

                                await emailService.enviarComprobante(factura.email_comprador, xmlBuffer, pdfBuffer, {
                                    razonSocialEmisor: factura.razon_social,
                                    nombreCliente: factura.razon_social_comprador,
                                    secuencial: factura.secuencial,
                                    claveAcceso: factura.clave_acceso,
                                    total: factura.importe_total
                                });

                                //console.log(`[SRI Job2] ✅ Correo enviado a ${factura.email_comprador}`);
                            } catch (emailErr) {
                                // Error de correo no frena el flujo principal
                                console.error(`[SRI Job2] ⚠️ Error enviando correo a ${factura.email_comprador}: ${emailErr.message}`);
                            }
                        } else {
                            console.log(`[SRI Job2] ℹ️ Factura ${factura.clave_acceso} sin email, omitiendo envío.`);
                        }

                    } else {
                        // ❌ SRI rechazó la factura — devolver 1 crédito al emisor
                        const estadoFinal = autorizacion.estado === 'NO AUTORIZADO' ? 'RECHAZADO' : autorizacion.estado;
                        const msg = JSON.stringify(autorizacion.mensajes);

                        await pool.query(
                            'UPDATE invoices SET estado = $1, mensajes_sri = $2 WHERE id = $3',
                            [estadoFinal, msg, factura.id]
                        );

                        // 💳 Reembolso del crédito
                        await pool.query(
                            'UPDATE user_credits SET balance = balance + 1 WHERE emisor_id = $1',
                            [factura.emisor_db_id]
                        );

                        console.warn(`[SRI Job2] ⚠️ ${estadoFinal}: ${factura.clave_acceso} | Crédito devuelto al emisor ${factura.emisor_db_id} | Motivo: ${msg}`);
                        await notificarCambioEstado(factura, estadoFinal, autorizacion.mensajes);
                    }
                }
            } catch (err) {
                console.error(`[SRI Job2] ❌ Error Autorización (${factura.clave_acceso}): ${err.message}`);
            }
        }
    } catch (error) {
        console.error('[SRI Job2] ❌ Error Crítico Job Autorización:', error.message);
    }
}

module.exports = { enviarFacturasAlSRI, autorizarFacturasSRI };