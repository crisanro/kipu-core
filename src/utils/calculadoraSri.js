const pool = require('../database/index');
const { encrypt, decrypt, generarClaveAcceso } = require('../utils/cryptoUtils');
const { signInvoiceXmlCustom } = require('../services/signer');
const { uploadFile, downloadFile, minioClient } = require('../services/storageService');
const { generarPDFStream } = require('../services/rideService');
const { create } = require('xmlbuilder2');
const forge = require('node-forge');
const { DateTime } = require('luxon');
const { XMLParser } = require('fast-xml-parser'); 
const parser = new XMLParser({ ignoreAttributes: false }); 
const axios = require('axios');
const { notificarCambioEstado } = require('../workers/notifierService'); 
const emailService = require('../services/mailService');

// Mapeo de códigos SRI actualizado al 2026
const CODIGOS_IVA = {
    0:  { codigo: '2', codigoPorcentaje: '0' }, // 0%
    12: { codigo: '2', codigoPorcentaje: '2' }, // 12%
    15: { codigo: '2', codigoPorcentaje: '4' }, // 15% (Esencial para evitar tu error)
    5:  { codigo: '2', codigoPorcentaje: '5' }  // 5% (Construcción)
};

/**
 * Recibe items simples y devuelve la estructura compleja del SRI
 */
function calcularTotalesEImpuestos(items) {
    let totalSinImpuestos = 0;
    let totalDescuento = 0;
    const impuestosAcumulados = {};

    const detallesXml = items.map(item => {
        const cantidad = parseFloat(item.cantidad);
        const precioUnitario = parseFloat(item.precioUnitario || item.precio || 0);
        const descuento = parseFloat(item.descuento || 0);

        const precioTotalSinImpuesto = (cantidad * precioUnitario) - descuento;
        totalSinImpuestos += precioTotalSinImpuesto;
        totalDescuento += descuento;

        // --- LÓGICA DE NORMALIZACIÓN DE TARIFA ---
        let tarifaRaw = 0;
        if (item.tarifaIva !== undefined) {
            tarifaRaw = parseFloat(item.tarifaIva);
        } else if (item.impuestos && item.impuestos.length > 0) {
            tarifaRaw = parseFloat(item.impuestos[0].tarifa || 0);
        }

        // Si mandas 0.15, lo convertimos a 15. Si mandas 15, se queda en 15.
        const tarifa = (tarifaRaw > 0 && tarifaRaw < 1) ? tarifaRaw * 100 : tarifaRaw;

        // Buscamos en el mapa. Si no existe (ej. mandaste 50), por seguridad cae en IVA 0
        const infoSri = CODIGOS_IVA[tarifa] || CODIGOS_IVA[0];
        
        const valorImpuesto = precioTotalSinImpuesto * (tarifa / 100);

        // Acumular para el bloque <totalConImpuestos>
        if (!impuestosAcumulados[tarifa]) {
            impuestosAcumulados[tarifa] = {
                codigo: infoSri.codigo,
                codigoPorcentaje: infoSri.codigoPorcentaje,
                baseImponible: 0,
                valor: 0,
                tarifa: tarifa
            };
        }
        impuestosAcumulados[tarifa].baseImponible += precioTotalSinImpuesto;
        impuestosAcumulados[tarifa].valor += valorImpuesto;

        return {
            codigoPrincipal: item.codigoPrincipal || item.codigo,
            descripcion: item.descripcion || item.nombre,
            cantidad: cantidad.toFixed(2),
            precioUnitario: precioUnitario.toFixed(2),
            descuento: descuento.toFixed(2),
            precioTotalSinImpuesto: precioTotalSinImpuesto.toFixed(2),
            impuestos: { // El SRI espera un objeto o array dependiendo del parser, usualmente objeto
                impuesto: {
                    codigo: infoSri.codigo,
                    codigoPorcentaje: infoSri.codigoPorcentaje,
                    tarifa: tarifa.toString(),
                    baseImponible: precioTotalSinImpuesto.toFixed(2),
                    valor: valorImpuesto.toFixed(2)
                }
            }
        };
    });

    const totalConImpuestosXml = Object.values(impuestosAcumulados).map(imp => ({
        codigo: imp.codigo,
        codigoPorcentaje: imp.codigoPorcentaje,
        baseImponible: imp.baseImponible.toFixed(2),
        valor: imp.valor.toFixed(2)
    }));

    const totalIvaGeneral = Object.values(impuestosAcumulados).reduce((sum, imp) => sum + imp.valor, 0);
    const importeTotal = totalSinImpuestos + totalIvaGeneral;

    let subtotal_0 = 0;
    let subtotal_iva = 0;
    Object.values(impuestosAcumulados).forEach(imp => {
        if (imp.tarifa === 0) {
            subtotal_0 += imp.baseImponible;
        } else {
            subtotal_iva += imp.baseImponible;
        }
    });

    return {
        detallesXml,
        totalConImpuestosXml,
        totales: {
            totalSinImpuestos: totalSinImpuestos.toFixed(2),
            totalDescuento: totalDescuento.toFixed(2),
            importeTotal: importeTotal.toFixed(2),
            totalIva: totalIvaGeneral.toFixed(2),
            subtotal_0: subtotal_0.toFixed(2),
            subtotal_iva: subtotal_iva.toFixed(2)
        }
    };
}


const emitirFacturaCore = async (req, res) => {
    const facturaData = req.body;
    const emisorId = req.emisor_id;

    // ─────────────────────────────────────────────────────────────
    // BLOQUE 1: TX RÁPIDA — Solo lecturas y reservas en BD
    // ─────────────────────────────────────────────────────────────
    let emisor, puntoEmision, secuencial, calculos, claveAcceso, xmlString;
    let fechaFormatoSRI, ahoraJS;

    // Validación estricta de entrada antes de tocar la BD
    if (!facturaData.establecimiento || !facturaData.punto_emision) {
        return res.status(400).json({ 
            ok: false, 
            mensaje: "Los campos 'establecimiento' y 'punto_emision' son requeridos para la secuencia legal." 
        });
    }
    const client = await pool.pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Obtener emisor y bloquear créditos
        const emisorRes = await client.query(`
            SELECT e.*, c.balance 
            FROM emisores e 
            JOIN user_credits c ON e.id = c.emisor_id 
            WHERE e.id = $1 FOR UPDATE
        `, [emisorId]);

        emisor = emisorRes.rows[0];
        if (!emisor || emisor.balance <= 0) {
            await client.query('ROLLBACK');
            return res.status(402).json({ ok: false, mensaje: "Créditos insuficientes." });
        }

        // 2. Obtener punto de emisión
        const ptoRes = await client.query(`
            SELECT 
                p.id as punto_id, 
                p.codigo as punto_codigo, 
                e.codigo as estab_codigo, 
                e.direccion as direccion_establecimiento, 
                e.nombre_comercial as nombre_establecimiento
            FROM puntos_emision p
            JOIN establecimientos e ON p.establecimiento_id = e.id
            WHERE e.codigo = $1 AND p.codigo = $2 AND e.emisor_id = $3
        `, [facturaData.establecimiento, facturaData.punto_emision, emisorId]);

        if (ptoRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                ok: false, 
                mensaje: `La combinación Establecimiento [${facturaData.establecimiento}] y Punto [${facturaData.punto_emision}] no existe o no te pertenece.` 
            });
        }
        puntoEmision = ptoRes.rows[0];

        // 3. Generar secuencial atómico
        const secRes = await client.query('SELECT generar_secuencial($1)', [puntoEmision.punto_id]);
        const secuencialRaw = secRes.rows[0].generar_secuencial;
        if (!secuencialRaw) throw new Error(`Secuencial nulo para el punto ${puntoEmision.punto_id}.`);
        secuencial = secuencialRaw.toString().padStart(9, '0');

        // 4. Lógica de Mitigación (Respaldo de datos)
        const nombreComercialFinal = puntoEmision.nombre_establecimiento || emisor.nombre_comercial || emisor.razon_social;
        const direccionEstablecimientoFinal = puntoEmision.direccion_establecimiento || emisor.direccion_matriz;

        // 5. Calcular fechas y totales
        const ahoraEcuador = DateTime.now().setZone('America/Guayaquil');
        ahoraJS = ahoraEcuador.toJSDate();
        const fechaFormatoClave = ahoraEcuador.toFormat('yyyy-MM-dd');
        fechaFormatoSRI = ahoraEcuador.toFormat('dd/MM/yyyy');

        calculos = calcularTotalesEImpuestos(facturaData.items);
        
        claveAcceso = generarClaveAcceso(
            fechaFormatoClave,
            '01',
            emisor.ruc,
            emisor.ambiente,
            puntoEmision.estab_codigo + puntoEmision.punto_codigo,
            secuencial
        );

        // 6. Construir XML
        const xmlObj = {
            factura: {
                '@id': 'comprobante',
                '@version': '1.1.0',
                infoTributaria: {
                    ambiente: emisor.ambiente,
                    tipoEmision: '1',
                    razonSocial: emisor.razon_social,
                    nombreComercial: nombreComercialFinal,
                    ruc: emisor.ruc,
                    claveAcceso: claveAcceso,
                    codDoc: '01',
                    estab: puntoEmision.estab_codigo,
                    ptoEmi: puntoEmision.punto_codigo,
                    secuencial: secuencial,
                    dirMatriz: emisor.direccion_matriz
                },
                infoFactura: {
                    fechaEmision: fechaFormatoSRI,
                    dirEstablecimiento: direccionEstablecimientoFinal,
                    obligadoContabilidad: emisor.obligado_contabilidad || 'NO',
                    tipoIdentificacionComprador: facturaData.cliente.tipo_id || facturaData.cliente.tipoId,
                    razonSocialComprador: facturaData.cliente.nombre || facturaData.cliente.razonSocial,
                    identificacionComprador: facturaData.cliente.identificacion,
                    totalSinImpuestos: calculos.totales.totalSinImpuestos,
                    totalDescuento: calculos.totales.totalDescuento,
                    totalConImpuestos: { totalImpuesto: calculos.totalConImpuestosXml },
                    propina: '0.00',
                    importeTotal: calculos.totales.importeTotal,
                    moneda: 'DOLAR',
                    pagos: {
                        pago: facturaData.pagos.map(p => ({
                            formaPago: p.forma_pago || p.formaPago || '01',
                            total: parseFloat(p.total).toFixed(2),
                            plazo: p.plazo || '0',
                            unidadTiempo: p.unidad_tiempo || p.unidadTiempo || 'dias'
                        }))
                    }
                },
                detalles: {
                    detalle: calculos.detallesXml
                }
            }
        };

        xmlString = create(xmlObj).end({ prettyPrint: false });
        if (!xmlString.includes('id="comprobante"')) {
            xmlString = xmlString.replace('<factura', '<factura id="comprobante"');
        }

        datosFactura = JSON.stringify(xmlObj.factura);

        await client.query('COMMIT');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("❌ Error en Bloque 1:", error.message);
        return res.status(500).json({ ok: false, error: error.message });
    } finally {
        // ✅ Un solo punto de salida, siempre se ejecuta
        client.release();
    }

    // ─────────────────────────────────────────────────────────────
    // BLOQUE 2: FIRMA + PDF — Fuera de cualquier transacción
    // ─────────────────────────────────────────────────────────────
    let xmlFirmado, pdfStream;

    try {
        const [bucketP12, ...pathP12] = emisor.p12_path.split('/');
        const p12Buffer = await downloadFile(bucketP12, pathP12.join('/'));
        const p12Password = decrypt(emisor.p12_pass);
        const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, p12Password);

        const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
        const certBag = certBags.find(b => !b.cert.cA) || certBags[certBags.length - 1];
        const keyBag = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag][0];

        xmlFirmado = signInvoiceXmlCustom(xmlString, certBag, keyBag, p12);
        pdfStream = await generarPDFStream(xmlFirmado, emisor, 'FIRMADO');

    } catch (error) {
        console.error("❌ Error en Bloque 2 (firma):", error.message);
        return res.status(500).json({ ok: false, error: "Error al firmar: " + error.message });
    }

    // ─────────────────────────────────────────────────────────────
    // BLOQUE 3: TX FINAL — Subir archivos y registrar en BD
    // ─────────────────────────────────────────────────────────────
    const client2 = await pool.pool.connect();
    try {
        const xmlPathRelative = `${emisor.ruc}/${claveAcceso}.xml`;
        const pdfPathRelative = `${emisor.ruc}/${claveAcceso}.pdf`;

        await uploadFile('invoices', xmlPathRelative, Buffer.from(xmlFirmado), 'text/xml');
        await minioClient.putObject('invoices', pdfPathRelative, pdfStream, null, { 'Content-Type': 'application/pdf' });

        await client2.query('BEGIN');

        await client2.query(`UPDATE user_credits SET balance = balance - 1 WHERE emisor_id = $1`, [emisorId]);

        const insertResult = await client2.query(`
            INSERT INTO invoices (
                emisor_id, punto_emision_id, secuencial, fecha_emision, clave_acceso,
                estado, identificacion_comprador, razon_social_comprador, importe_total,
                subtotal_iva, subtotal_0, valor_iva, xml_path, pdf_path, datos_factura,
                email_comprador
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING id
        `, [
            emisorId, puntoEmision.punto_id, secuencial, ahoraJS, claveAcceso, 'FIRMADO',
            facturaData.cliente.identificacion,
            facturaData.cliente.nombre || facturaData.cliente.razonSocial,
            calculos.totales.importeTotal, calculos.totales.subtotal_iva,
            calculos.totales.subtotal_0, calculos.totales.totalIva,
            `invoices/${xmlPathRelative}`, `invoices/${pdfPathRelative}`,
            datosFactura,
            facturaData.cliente.email || null
        ]);

        const facturaId = insertResult.rows[0].id;
        await client2.query('COMMIT');
        try {
            const URLS_SRI_LOCAL = {
                1: { rec: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl', auth: 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl' },
                2: { rec: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl', auth: 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl' }
            };

            const urls = URLS_SRI_LOCAL[emisor.ambiente];
            const xmlBase64 = Buffer.from(xmlFirmado).toString('base64');
            const { XMLParser } = require('fast-xml-parser');
            const fastParser = new XMLParser({ ignoreAttributes: false, trimValues: true });

            // Preparamos el objeto "factura" para los servicios de notificación
            // Debe ser igual al SELECT que hacen los Cronjobs
            const facturaParaNotificar = {
                id: facturaId,
                clave_acceso: claveAcceso,
                email_comprador: facturaData.cliente.email,
                razon_social_comprador: facturaData.cliente.nombre || facturaData.cliente.razonSocial,
                secuencial: secuencial,
                importe_total: calculos.totales.importeTotal,
                pdf_path: `invoices/${emisor.ruc}/${claveAcceso}.pdf`,
                ambiente: emisor.ambiente,
                ruc: emisor.ruc,
                emisor_db_id: emisorId,
                razon_social: emisor.razon_social
            };

            // 1. RECEPCIÓN
            const soapRec = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion"><soapenv:Body><ec:validarComprobante><xml>${xmlBase64}</xml></ec:validarComprobante></soapenv:Body></soapenv:Envelope>`;
            const resRec = await axios.post(urls.rec, soapRec, { headers: { 'Content-Type': 'text/xml' }, timeout: 8000 });
            const jsonRec = fastParser.parse(resRec.data);
            const respRec = jsonRec['soap:Envelope']?.['soap:Body']?.['ns2:validarComprobanteResponse']?.RespuestaRecepcionComprobante;

            if (respRec && respRec.estado === 'RECIBIDA') {
                await pool.query('UPDATE invoices SET estado = $1, fecha_envio_sri = NOW() WHERE id = $2', ['RECIBIDA', facturaId]);
                await notificarCambioEstado(facturaParaNotificar, 'RECIBIDA');

                // 2. BUCLE DE AUTORIZACIÓN
                const soapAuth = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion"><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>`;
                const pausas = [1200, 1800, 2500];

                for (let ms of pausas) {
                    await new Promise(r => setTimeout(r, ms));
                    try {
                        const resAuth = await axios.post(urls.auth, soapAuth, { headers: { 'Content-Type': 'text/xml' }, timeout: 5000 });
                        const jsonAuth = fastParser.parse(resAuth.data);
                        const respAuth = jsonAuth['soap:Envelope']?.['soap:Body']?.['ns2:autorizacionComprobanteResponse']?.RespuestaAutorizacionComprobante;

                        if (respAuth && parseInt(respAuth.numeroComprobantes) > 0) {
                            const auth = Array.isArray(respAuth.autorizaciones.autorizacion) ? respAuth.autorizaciones.autorizacion[0] : respAuth.autorizaciones.autorizacion;
                            
                            if (auth.estado === 'AUTORIZADO') {
                                const xmlAuthPath = `authorized/${emisor.ruc}/${claveAcceso}.xml`;
                                await uploadFile('invoices', xmlAuthPath, Buffer.from(auth.comprobante), 'text/xml');

                                // Actualizar PDF a 'AUTORIZADO' (Igual que Job 2)
                                const pdfAutorizado = await generarPDFStream(auth.comprobante, emisor, 'AUTORIZADO', auth.fechaAutorizacion);
                                await minioClient.putObject('invoices', `${emisor.ruc}/${claveAcceso}.pdf`, pdfAutorizado, null, { 'Content-Type': 'application/pdf' });

                                await pool.query(
                                    'UPDATE invoices SET estado = $1, xml_path = $2, fecha_autorizacion = $3 WHERE id = $4',
                                    ['AUTORIZADO', `invoices/${xmlAuthPath}`, auth.fechaAutorizacion, facturaId]
                                );

                                // Notificaciones Instantáneas
                                await notificarCambioEstado(facturaParaNotificar, 'AUTORIZADO');
                                
                                if (facturaParaNotificar.email_comprador) {
                                    const pdfBuffer = await downloadFile('invoices', `${emisor.ruc}/${claveAcceso}.pdf`);
                                    await emailService.enviarComprobante(facturaParaNotificar.email_comprador, Buffer.from(auth.comprobante), pdfBuffer, {
                                        razonSocialEmisor: emisor.razon_social,
                                        nombreCliente: facturaParaNotificar.razon_social_comprador,
                                        secuencial: secuencial,
                                        claveAcceso: claveAcceso,
                                        total: facturaParaNotificar.importe_total
                                    });
                                }
                                console.log(`[FAST-TRACK] ⭐ ÉXITO: ${claveAcceso}`);
                                break; 
                            } else if (auth.estado === 'RECHAZADO' || auth.estado === 'NO AUTORIZADO') {
                                const msg = JSON.stringify(auth.mensajes);
                                await pool.query('UPDATE invoices SET estado = $1, mensajes_sri = $2 WHERE id = $3', ['RECHAZADO', msg, facturaId]);
                                await pool.query('UPDATE user_credits SET balance = balance + 1 WHERE emisor_id = $1', [emisorId]);
                                await notificarCambioEstado(facturaParaNotificar, 'RECHAZADO', auth.mensajes);
                                break;
                            }
                        }
                    } catch (eAuth) { continue; }
                }
            } else if (respRec && respRec.estado === 'DEVUELTA') {
                const errorMsg = JSON.stringify(respRec.comprobantes || respRec);
                await pool.query('UPDATE invoices SET estado = $1, mensajes_sri = $2 WHERE id = $3', ['DEVUELTA', errorMsg, facturaId]);
                await pool.query('UPDATE user_credits SET balance = balance + 1 WHERE emisor_id = $1', [emisorId]);
                await notificarCambioEstado(facturaParaNotificar, 'DEVUELTA', respRec);
            }
        } catch (e) {
            console.log(`[FAST-TRACK] ℹ️ SRI en modo asíncrono para clave ${claveAcceso}`);
        }

        // Consulta final para responder al cliente con el estado real tras el intento
        const finalCheck = await pool.query('SELECT estado FROM invoices WHERE id = $1', [facturaId]);
        const estadoFinal = finalCheck.rows[0].estado;

        res.status(201).json({
            ok: true,
            id: facturaId,
            claveAcceso,
            estado: estadoFinal,
            mensaje: estadoFinal === 'AUTORIZADO' ? "Factura autorizada exitosamente." : "Comprobante en proceso."
        });

    } catch (error) {
        await client2.query('ROLLBACK');
        console.error("❌ Error en Bloque 3:", error.message);
        res.status(500).json({ ok: false, error: error.message });
    } finally {
        client2.release();
    }
}


module.exports = { calcularTotalesEImpuestos, emitirFacturaCore };