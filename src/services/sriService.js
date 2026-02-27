const pool = require('../database/index');
const { DateTime } = require('luxon');
const forge = require('node-forge');
const { create } = require('xmlbuilder2');
const { generarClaveAcceso, decrypt } = require('../utils/cryptoUtils');
const { calcularTotalesEImpuestos } = require('../utils/calculadoraSri');
const { signInvoiceXmlCustom } = require('./signer');
const { downloadFile, uploadFile, deleteFile, minioClient } = require('./storageService');
const { generarPDFStream } = require('./rideService');

/**
 * Selecciona el certificado correcto para firma digital del P12.
 * Prioriza: digitalSignature + nonRepudiation > solo digitalSignature > primer no-CA.
 * Compatible con P12s del BCE (2 certs de usuario) y Security Data (1 cert de usuario).
 */
function seleccionarCertificadoDeFirma(certBags) {
    // Log de diagnóstico (comentar en producción)
    certBags.forEach((bag, i) => {
        const cert = bag.cert;
        const ku = cert.getExtension('keyUsage');
        console.log(`[P12] Cert #${i} | CN: ${cert.subject.getField('CN')?.value} | Serial: ${cert.serialNumber} | CA: ${cert.cA} | KeyUsage: ${ku ? JSON.stringify({ ds: ku.digitalSignature, nr: ku.nonRepudiation, ke: ku.keyEncipherment }) : 'ninguno'}`);
    });

    // Prioridad 1: digitalSignature + nonRepudiation (firma XAdES — lo que exige el SRI)
    let target = certBags.find(bag => {
        if (bag.cert.cA) return false;
        const ku = bag.cert.getExtension('keyUsage');
        return ku && ku.digitalSignature === true && ku.nonRepudiation === true;
    });

    // Prioridad 2: solo digitalSignature (Security Data y otros emiten así)
    if (!target) {
        target = certBags.find(bag => {
            if (bag.cert.cA) return false;
            const ku = bag.cert.getExtension('keyUsage');
            return ku && ku.digitalSignature === true;
        });
    }

    // Prioridad 3 (fallback): primer certificado que no sea CA
    if (!target) {
        target = certBags.find(bag => !bag.cert.cA);
    }

    if (!target) throw new Error("No se encontró un certificado de firma digital válido en el P12.");

    const certSeleccionado = target.cert;
    const ku = certSeleccionado.getExtension('keyUsage');
    console.log(`[P12] ✅ Cert seleccionado: CN=${certSeleccionado.subject.getField('CN')?.value} | Serial=${certSeleccionado.serialNumber} | ds=${ku?.digitalSignature} | nr=${ku?.nonRepudiation}`);

    return target;
}

/**
 * PASO 1 (API): Registro inicial de la factura en estado PENDIENTE
 */
async function crearFacturaInterna(inputCliente, emisor) {
    const detallesArr = inputCliente.detalles || inputCliente.items || [];
    if (detallesArr.length === 0) throw new Error("La factura no tiene detalles.");

    const estabCod = (inputCliente.establecimiento || '001').toString().padStart(3, '0');
    const ptoEmiCod = (inputCliente.punto_emision || '100').toString().padStart(3, '0');

    const ptoRes = await pool.query(`
        SELECT p.id, p.codigo, e.codigo as estab_codigo, e.direccion
        FROM puntos_emision p
        JOIN establecimientos e ON p.establecimiento_id = e.id
        WHERE p.codigo = $1 AND e.codigo = $2 AND e.emisor_id = $3
    `, [ptoEmiCod, estabCod, emisor.id]);

    if (ptoRes.rowCount === 0) throw new Error(`Punto de emisión ${estabCod}-${ptoEmiCod} no encontrado.`);
    const puntoEmisionDB = ptoRes.rows[0];

    const calculos = calcularTotalesEImpuestos(detallesArr);
    const tempClave = `PENDING-${require('uuid').v4()}`;

    const insertRes = await pool.query(`
        INSERT INTO invoices (
            emisor_id, clave_acceso, punto_emision_id, importe_total,
            subtotal_0, subtotal_iva, valor_iva, estado, client_input_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id, estado
    `, [
        emisor.id, tempClave, puntoEmisionDB.id,
        calculos.totales.importeTotal, calculos.totales.subtotal_0,
        calculos.totales.subtotal_iva, calculos.totales.totalIva,
        'PENDIENTE', JSON.stringify(inputCliente)
    ]);

    return { exito: true, id: insertRes.rows[0].id, estado: 'PENDIENTE' };
}

/**
 * JOB 0: Firma la factura, genera el RIDE y la deja en estado FIRMADO.
 * El envío al SRI lo maneja sriJobs.js (enviarFacturasAlSRI).
 */
async function firmarYEnviarLote(facturaId, inputCliente, emisor, puntoEmisionDB) {
    const client = await pool.pool.connect();
    let archivosSubidos = [];

    try {
        // --- A. PREPARACIÓN (fuera de transacción para no mantenerla abierta durante I/O) ---
        const password = decrypt(emisor.p12_pass);
        const [bucketP12, ...pathPartsP12] = emisor.p12_path.split('/');
        const p12Buffer = await downloadFile(bucketP12, pathPartsP12.join('/'));

        const detallesArr = inputCliente.detalles || inputCliente.items || [];
        const calculos = calcularTotalesEImpuestos(detallesArr);

        // --- B. TRANSACCIÓN ATÓMICA ---
        await client.query('BEGIN');

        // 1. Secuencial (función DB que garantiza unicidad)
        const secRes = await client.query('SELECT generar_secuencial($1)', [puntoEmisionDB.id]);
        const secuencialStr = secRes.rows[0].generar_secuencial.toString().padStart(9, '0');

        const ahora = DateTime.now().setZone('America/Guayaquil');
        const claveAcceso = generarClaveAcceso(
            ahora.toFormat('yyyy-MM-dd'), '01', emisor.ruc, emisor.ambiente,
            puntoEmisionDB.estab_codigo + puntoEmisionDB.codigo, secuencialStr,
            ahora.toFormat('HHmmss') + Math.floor(Math.random() * 90 + 10).toString()
        );

        // 2. Construir XML
        const doc = create({ version: '1.0', encoding: 'UTF-8' })
            .ele('factura', { id: 'comprobante', version: '1.1.0' });
        // (lógica de construcción del XML integrada aquí)
        const xmlString = doc.end({ prettyPrint: false });

        // 3. Parsear P12 y seleccionar el certificado correcto
        const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

        const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
        const targetCertBag = seleccionarCertificadoDeFirma(certBags); // ✅ siempre el de firma digital

        const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
        const targetKeyBag = keyBags[0];

        if (!targetKeyBag) throw new Error("No se encontró la llave privada en el P12.");

        // 4. Firmar XML
        const xmlFirmado = signInvoiceXmlCustom(xmlString, targetCertBag, targetKeyBag, p12);

        // 5. Generar RIDE como stream
        const pdfStream = await generarPDFStream(xmlFirmado, emisor, 'FIRMADO');

        // --- C. SUBIDA A MINIO ---
        const xmlStoragePath = `signed/${emisor.ruc}/${claveAcceso}.xml`;
        const pdfStoragePath = `signed/${emisor.ruc}/${claveAcceso}.pdf`;

        await uploadFile('invoices', xmlStoragePath, Buffer.from(xmlFirmado), 'text/xml');
        archivosSubidos.push(xmlStoragePath);

        await minioClient.putObject('invoices', pdfStoragePath, pdfStream, null, {
            'Content-Type': 'application/pdf'
        });
        archivosSubidos.push(pdfStoragePath);

        // --- D. ACTUALIZAR DB Y CERRAR TRANSACCIÓN ---
        await client.query(`
            UPDATE invoices SET
                clave_acceso = $1,
                estado       = 'FIRMADO',
                xml_path     = $2,
                pdf_path     = $3,
                updated_at   = NOW()
            WHERE id = $4
        `, [claveAcceso, `invoices/${xmlStoragePath}`, `invoices/${pdfStoragePath}`, facturaId]);

        await client.query('COMMIT');

        // El envío al SRI lo tomará sriJobs.enviarFacturasAlSRI en el siguiente ciclo
        console.log(`[Firma] ✅ Factura ${facturaId} firmada y lista. Clave: ${claveAcceso}`);

    } catch (err) {
        await client.query('ROLLBACK');

        for (const path of archivosSubidos) {
            await deleteFile('invoices', path).catch(e => console.error("[MinIO Limpieza]", e.message));
        }

        console.error(`[Error Firma] Factura ${facturaId}:`, err.message);
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { crearFacturaInterna, firmarYEnviarLote };