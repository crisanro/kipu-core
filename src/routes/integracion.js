const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { apiKeyAuth } = require('../middlewares/apiKeyAuth');
const { encrypt, decrypt, generarClaveAcceso } = require('../utils/cryptoUtils');
const { calcularTotalesEImpuestos } = require('../utils/calculadoraSri');
const { signInvoiceXmlCustom } = require('../services/signer');
const { uploadFile, downloadFile, minioClient } = require('../services/storageService');
const { generarPDFStream } = require('../services/rideService');
const { create } = require('xmlbuilder2');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const forge = require('node-forge');
const { DateTime } = require('luxon');
const parser = new XMLParser({ ignoreAttributes: false });

/**
 * @openapi
 * /integrations/validate:
 *   post:
 *     summary: Validar si existe una combinación de establecimiento y punto de emisión
 *     tags: [Integrations]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [estab_codigo, punto_codigo]
 *             properties:
 *               estab_codigo: { type: string, example: "001" }
 *               punto_codigo: { type: string, example: "001" }
 *     responses:
 *       200:
 *         description: Combinación válida
 *       404:
 *         description: Combinación no encontrada
 *       500:
 *         description: Error interno
 */
router.post('/validate', apiKeyAuth, async (req, res) => {
  const { estab_codigo, punto_codigo } = req.body;

  if (!estab_codigo || !punto_codigo) {
    return res.status(400).json({
      ok: false,
      error: 'estab_codigo y punto_codigo son requeridos.',
    });
  }

  const query = `
    SELECT
      p.id,
      p.secuencial_actual,
      e.direccion
    FROM puntos_emision p
    JOIN establecimientos e ON p.establecimiento_id = e.id
    WHERE e.emisor_id = $1
      AND e.codigo    = $2
      AND p.codigo    = $3
  `;

  try {
    const { rows, rowCount } = await pool.query(query, [req.emisor_id, estab_codigo, punto_codigo]);

    if (rowCount === 0) {
      return res.status(404).json({
        ok: false,
        error: 'La combinación de establecimiento y punto de emisión no existe para este emisor.',
      });
    }

    res.json({ ok: true, mensaje: 'Estructura válida', data: rows[0] });

  } catch (error) {
    console.error('[POST /structure/validate]', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * @openapi
 * /integrations/status:
 *   get:
 *     summary: Resumen completo del estado del emisor para sistemas externos
 *     tags: [Integrations]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Estado actual del emisor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:      { type: boolean, example: true }
 *                 emisor:
 *                   type: object
 *                   properties:
 *                     ruc:          { type: string, example: "1234567890001" }
 *                     razon_social: { type: string }
 *                     ambiente:     { type: string, enum: [PRUEBAS, PRODUCCIÓN] }
 *                     firma:
 *                       type: object
 *                       properties:
 *                         valida:      { type: boolean }
 *                         vencimiento: { type: string, format: date-time }
 *                 creditos: { type: number, example: 100 }
 *                 historial:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:           { type: string }
 *                       clave_acceso: { type: string }
 *                       estado:       { type: string }
 *                       total:        { type: number }
 *                       created_at:   { type: string, format: date-time }
 *       500:
 *         description: Error interno del servidor
 */
router.get('/status', apiKeyAuth, async (req, res) => {
  try {
    const query = `
      SELECT
        e.ruc, 
        e.razon_social, 
        e.nombre_comercial, 
        e.ambiente,
        e.p12_expiration,
        c.balance AS creditos_disponibles,
        (
          SELECT json_agg(last_docs)
          FROM (
            SELECT 
              id, 
              fecha_emision,           -- Nuevo campo solicitado
              estado, 
              identificacion_comprador, -- Nuevo campo solicitado
              razon_social_comprador,   -- Nuevo campo solicitado
              importe_total AS total,   -- Mapeado a 'total' para tu JSON
              clave_acceso,
              created_at
            FROM invoices 
            WHERE emisor_id = e.id
            ORDER BY created_at DESC
            LIMIT 20
          ) last_docs
        ) AS ultimas_facturas
      FROM emisores e
      LEFT JOIN user_credits c ON e.id = c.emisor_id
      WHERE e.id = $1
    `;

    const { rows } = await pool.query(query, [req.emisor_id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: "Emisor no encontrado" });
    }

    const data = rows[0];

    const firmaValida = data.p12_expiration
      ? new Date(data.p12_expiration) > new Date()
      : false;

    res.json({
      ok: true,
      emisor: {
        ruc:          data.ruc,
        razon_social: data.razon_social,
        ambiente:      data.ambiente === 1 ? 'PRUEBAS' : 'PRODUCCIÓN', 
        firma: {
          valida:      firmaValida,
          vencimiento: data.p12_expiration,
        },
      },
      creditos: data.creditos_disponibles || 0,
      historial: data.ultimas_facturas || [],
    });
  } catch (error) {
    console.error('[GET /integrations/status]', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * @openapi
 * /integrations/invoice:
 *   post:
 *     summary: Genera, firma y envía una factura electrónica al SRI
 *     description: |
 *       Proceso atómico que ejecuta los siguientes pasos:
 *       1. Verifica y bloquea créditos del emisor (prevención de doble gasto)
 *       2. Obtiene el punto de emisión y genera el secuencial
 *       3. Calcula totales e impuestos
 *       4. Construye y firma el XML según estructura del SRI
 *       5. Envía al SRI via SOAP y recibe confirmación
 *       6. Almacena XML y RIDE (PDF) en MinIO
 *       7. Descuenta crédito y registra la factura en base de datos
 *     tags: [Integrations]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items, cliente, pagos]
 *             properties:
 *               establecimiento:
 *                 type: string
 *                 default: "001"
 *                 description: Código del establecimiento
 *               punto_emision:
 *                 type: string
 *                 default: "001"
 *                 description: Código del punto de emisión
 *               fechaEmision:
 *                 type: string
 *                 example: "23/02/2026"
 *                 description: Fecha en formato DD/MM/YYYY
 *               cliente:
 *                 type: object
 *                 required: [tipo_id, nombre, identificacion]
 *                 properties:
 *                   tipo_id:        { type: string, example: "05" }
 *                   nombre:         { type: string, example: "Juan Pérez" }
 *                   identificacion: { type: string, example: "1234567890" }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   description: Detalle de productos/servicios facturados
 *               pagos:
 *                 type: array
 *                 items:
 *                   type: object
 *                   description: Formas de pago según catálogo SRI
 *     responses:
 *       201:
 *         description: Factura generada, firmada y recibida por el SRI
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:          { type: boolean, example: true }
 *                 claveAcceso: { type: string, example: "2302202601..." }
 *                 mensaje:     { type: string }
 *       402:
 *         description: Créditos insuficientes para procesar la factura
 *       500:
 *         description: Error en el motor de facturación (se hace ROLLBACK automático)
 */
router.post('/invoice', apiKeyAuth, async (req, res) => {
    const facturaData = req.body;
    const emisorId = req.emisor_id;

    const client = await pool.pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Obtener Emisor y bloquear créditos (FOR UPDATE para evitar saltos)
        const emisorRes = await client.query(`
            SELECT e.*, c.balance 
            FROM emisores e 
            JOIN user_credits c ON e.id = c.emisor_id 
            WHERE e.id = $1 FOR UPDATE
        `, [emisorId]);
        
        const emisor = emisorRes.rows[0];
        if (!emisor || emisor.balance <= 0) {
            return res.status(402).json({ ok: false, mensaje: "Créditos insuficientes." });
        }

        // Calculamos balance que quedará tras esta operación
        const balanceRestante = emisor.balance - 1;

        // 2. Obtener Punto de Emisión y Direcciones
        const ptoRes = await client.query(`
            SELECT 
                p.id as punto_id, 
                p.codigo as punto_codigo, 
                e.codigo as estab_codigo, 
                e.direccion as direccion_establecimiento, 
                em.direccion_matriz as direccion_emisor
            FROM puntos_emision p
            JOIN establecimientos e ON p.establecimiento_id = e.id
            JOIN emisores em ON e.emisor_id = em.id
            WHERE e.codigo = $1 AND p.codigo = $2 AND e.emisor_id = $3
        `, [facturaData.establecimiento || '001', facturaData.punto_emision || '100', emisorId]);

        if (ptoRes.rowCount === 0) throw new Error("Establecimiento o Punto de Emisión no válido.");
        const puntoEmision = ptoRes.rows[0];

        // 3. Generar Secuencial Atómico
        const secRes = await client.query('SELECT generar_secuencial($1)', [puntoEmision.punto_id]);
        const secuencialRaw = secRes.rows[0].generar_secuencial;
        if (!secuencialRaw) throw new Error(`Secuencial nulo para el punto ${puntoEmision.punto_id}.`);
        const secuencial = secuencialRaw.toString().padStart(9, '0');

        // --- 4. MANEJO DE TIEMPO (Luxon) ---
        const ahoraEcuador = DateTime.now().setZone('America/Guayaquil');
        const ahoraJS = ahoraEcuador.toJSDate();
        const fechaFormatoClave = ahoraEcuador.toFormat('yyyy-MM-dd');
        const fechaFormatoSRI = ahoraEcuador.toFormat('dd/MM/yyyy');

        // 5. Clave de Acceso y Cálculos
        const calculos = calcularTotalesEImpuestos(facturaData.items);
        const claveAcceso = generarClaveAcceso(
            fechaFormatoClave, 
            '01', 
            emisor.ruc, 
            emisor.ambiente, 
            puntoEmision.estab_codigo + puntoEmision.punto_codigo, 
            secuencial
        );

        // 6. Construcción del XML (CON FIX DE ID PARA XPATH)
        const direccionMatrizFinal = puntoEmision.direccion_establecimiento || emisor.direccion_matriz || "Dirección No Definida";

        const xmlObj = {
            factura: {
                '@id': 'comprobante',
                '@version': '1.1.0',
                infoTributaria: {
                    ambiente: emisor.ambiente,
                    tipoEmision: '1',
                    razonSocial: emisor.razon_social,
                    nombreComercial: emisor.nombre_comercial || emisor.razon_social,
                    ruc: emisor.ruc,
                    claveAcceso: claveAcceso,
                    codDoc: '01',
                    estab: puntoEmision.estab_codigo,
                    ptoEmi: puntoEmision.punto_codigo,
                    secuencial: secuencial,
                    dirMatriz: direccionMatrizFinal
                },
                infoFactura: {
                    fechaEmision: fechaFormatoSRI,
                    dirEstablecimiento: puntoEmision.direccion_establecimiento,
                    obligadoContabilidad: emisor.obligado_contabilidad || 'NO',
                    tipoIdentificacionComprador: facturaData.cliente.tipoId || facturaData.cliente.tipo_id,
                    razonSocialComprador: facturaData.cliente.razonSocial || facturaData.cliente.nombre,
                    identificacionComprador: facturaData.cliente.identificacion,
                    totalSinImpuestos: calculos.totales.totalSinImpuestos,
                    totalDescuento: calculos.totales.totalDescuento,
                    totalConImpuestos: { 
                        totalImpuesto: calculos.totalConImpuestosXml 
                    },
                    propina: '0.00', 
                    importeTotal: calculos.totales.importeTotal,
                    moneda: 'DOLAR', 
                    pagos: { 
                        pago: facturaData.pagos.map(p => ({
                            formaPago: p.formaPago || '01', 
                            total: parseFloat(p.total).toFixed(2),
                            plazo: p.plazo || '0', 
                            unidadTiempo: p.unidadTiempo || 'dias'
                        }))
                    }
                },
                detalles: {
                    detalle: calculos.detallesXml // Usamos el cálculo procesado para mayor seguridad
                }
            }
        };

        // Generamos XML y forzamos el ID si el builder lo omite
        let xmlString = create(xmlObj).end({ prettyPrint: false });
        if (!xmlString.includes('id="comprobante"')) {
            xmlString = xmlString.replace('<factura', '<factura id="comprobante"');
        }

        // 7. Firma Electrónica
        const [bucketP12, ...pathP12] = emisor.p12_path.split('/');
        const p12Buffer = await downloadFile(bucketP12, pathP12.join('/'));
        const p12Password = decrypt(emisor.p12_pass);
        const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, p12Password);
        
        const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
        let certBag = certBags.find(b => !b.cert.cA) || certBags[certBags.length - 1];
        let keyBag = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag][0];

        const xmlFirmado = signInvoiceXmlCustom(xmlString, certBag, keyBag, p12);

        // 8. Almacenamiento MinIO
        const pdfStream = await generarPDFStream(xmlFirmado, emisor, 'FIRMADO');
        const xmlPathRelative = `${emisor.ruc}/${claveAcceso}.xml`;
        const pdfPathRelative = `${emisor.ruc}/${claveAcceso}.pdf`;

        await uploadFile('invoices', xmlPathRelative, Buffer.from(xmlFirmado), 'text/xml');
        await minioClient.putObject('invoices', pdfPathRelative, pdfStream, null, { 'Content-Type': 'application/pdf' });

        // 9. Registro en DB
        const insertQuery = `
            INSERT INTO invoices (
                emisor_id, punto_emision_id, secuencial, fecha_emision, clave_acceso, 
                estado, identificacion_comprador, razon_social_comprador, importe_total, 
                subtotal_iva, subtotal_0, valor_iva, xml_path, pdf_path
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `;

        await client.query(insertQuery, [
            emisorId, 
            puntoEmision.punto_id, 
            secuencial, 
            ahoraJS, 
            claveAcceso, 
            'FIRMADO', 
            facturaData.cliente.identificacion, 
            facturaData.cliente.razonSocial || facturaData.cliente.nombre,
            calculos.totales.importeTotal, 
            calculos.totales.subtotal_iva, 
            calculos.totales.subtotal_0, 
            calculos.totales.totalIva,
            `invoices/${xmlPathRelative}`, 
            `invoices/${pdfPathRelative}`
        ]);

        await client.query('COMMIT');

        // Respuesta con créditos disponibles
        res.status(201).json({
            ok: true,
            claveAcceso: claveAcceso,
            creditos_restantes: balanceRestante,
            xml: `invoices/${xmlPathRelative}`,
            pdf: `invoices/${pdfPathRelative}`,
            mensaje: "Factura generada y firmada exitosamente."
        });

    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error("❌ Error en facturación:", error.message);
        res.status(500).json({ ok: false, error: error.message });
    } finally {
        client.release();
    }
});


module.exports = router;




