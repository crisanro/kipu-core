const axios = require('axios');
const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { minioClient } = require('../services/storageService');
const publicAuth = require('../middlewares/publicAuth');
const { URLSearchParams } = require('url'); // Viene con Node.js

require('dotenv').config();
// ── Descarga PDF ──────────────────────────────────────────────────────────────
/**
 * @openapi
 * /public/pdf/{claveAcceso}:
 *   get:
 *     summary: Descargar RIDE (PDF) público
 *     tags: [Público]
 *     parameters:
 *       - in: path
 *         name: claveAcceso
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Archivo PDF del comprobante
 *       404:
 *         description: Factura no encontrada
 */
router.get('/pdf/:claveAcceso', publicAuth, async (req, res) => {
  const { claveAcceso } = req.params;
  if (!/^\d{49}$/.test(claveAcceso)) return res.status(400).send('Clave inválida');
  try {
    const result = await pool.query(
      "SELECT pdf_path FROM invoices WHERE clave_acceso = $1",
      [claveAcceso]
    );
    if (result.rowCount === 0) return res.status(404).send('Factura no encontrada');
    const [bucket, ...pathParts] = result.rows[0].pdf_path.split('/');
    const stream = await minioClient.getObject(bucket, pathParts.join('/'));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${claveAcceso}.pdf"`);
    stream.pipe(res);
  } catch (error) {
    console.error('Error Public PDF:', error.message);
    res.status(404).send('Archivo no encontrado');
  }
});

// ── Descarga XML ──────────────────────────────────────────────────────────────
/**
 * @openapi
 * /public/xml/{claveAcceso}:
 *   get:
 *     summary: Descargar XML autorizado
 *     tags: [Público]
 *     parameters:
 *       - in: path
 *         name: claveAcceso
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Archivo XML autorizado por el SRI
 *       404:
 *         description: Archivo no encontrado
 */
router.get('/xml/:claveAcceso', publicAuth, async (req, res) => {
  const { claveAcceso } = req.params;
  if (!/^\d{49}$/.test(claveAcceso)) return res.status(400).send('Clave inválida');
  try {
    const result = await pool.query(
      "SELECT xml_path FROM invoices WHERE clave_acceso = $1",
      [claveAcceso]
    );
    if (result.rowCount === 0) return res.status(404).send('Factura no encontrada');
    const [bucket, ...pathParts] = result.rows[0].xml_path.split('/');
    const stream = await minioClient.getObject(bucket, pathParts.join('/'));
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${claveAcceso}.xml"`);
    stream.pipe(res);
  } catch (error) {
    console.error('Error Public XML:', error.message);
    res.status(404).send('Archivo no encontrado');
  }
});

/**
 * @openapi
 * /public/consultar/{claveAcceso}:
 *   post:
 *     summary: Consultar factura por clave de acceso
 *     description: |
 *       Endpoint público para verificar la autenticidad de un comprobante electrónico.
 *       Incluye múltiples capas de seguridad antes de consultar la BD:
 *       - **Honeypot** — rechaza bots que llenen campos trampa.
 *       - **Formato** — valida que la clave de acceso tenga exactamente 49 dígitos.
 *       - **Turnstile** — verifica el captcha de Cloudflare antes de tocar la BD.
 *
 *       Si la factura está `AUTORIZADO`, devuelve datos completos y links de descarga.
 *       Para cualquier otro estado, devuelve el estado actual sin datos de descarga.
 *     tags:
 *       - Público
 *     parameters:
 *       - in: path
 *         name: claveAcceso
 *         required: true
 *         schema:
 *           type: string
 *           pattern: '^\d{49}$'
 *           example: "2406202401179214673900110010010000000011234567813"
 *         description: "Clave de acceso de 49 dígitos del comprobante SRI."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - captchaToken
 *             properties:
 *               captchaToken:
 *                 type: string
 *                 description: "Token generado por Cloudflare Turnstile en el frontend."
 *                 example: "0.ABC123xyz..."
 *               hpValue:
 *                 type: string
 *                 nullable: true
 *                 description: "Campo honeypot. Debe estar vacío — si tiene valor, la petición se rechaza como bot."
 *                 example: ""
 *     responses:
 *       200:
 *         description: |
 *           Consulta procesada. El campo `success` indica si la factura está autorizada.
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - description: "Factura autorizada — incluye datos y links de descarga"
 *                   type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: true
 *                     estado:
 *                       type: string
 *                       example: "AUTORIZADO"
 *                     data:
 *                       type: object
 *                       properties:
 *                         cabecera:
 *                           type: object
 *                           properties:
 *                             emisor:
 *                               type: string
 *                               example: "ACME S.A."
 *                             ruc:
 *                               type: string
 *                               example: "1792146739001"
 *                             nro:
 *                               type: string
 *                               example: "001-001-000000001"
 *                             fecha:
 *                               type: string
 *                               format: date
 *                               example: "2024-06-15"
 *                         totales:
 *                           type: object
 *                           properties:
 *                             total:
 *                               type: number
 *                               format: float
 *                               example: 112.00
 *                         links:
 *                           type: object
 *                           properties:
 *                             pdf:
 *                               type: string
 *                               example: "https://core.kipu.ec/api/v1/public/pdf/2406202401179214673900110010010000000011234567813"
 *                             xml:
 *                               type: string
 *                               example: "https://core.kipu.ec/api/v1/public/xml/2406202401179214673900110010010000000011234567813"
 *                 - description: "Factura existe pero no está autorizada"
 *                   type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: false
 *                     estado:
 *                       type: string
 *                       example: "DEVUELTA"
 *                     mensaje_usuario:
 *                       type: string
 *                       example: "El comprobante se encuentra en estado: DEVUELTA"
 *       400:
 *         description: Bot detectado por honeypot o formato de clave de acceso inválido
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Clave de acceso inválida"
 *       403:
 *         description: Verificación Turnstile fallida
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 mensaje_usuario:
 *                   type: string
 *                   example: "La verificación de seguridad ha fallado. Por favor, recarga la página."
 *       404:
 *         description: La clave de acceso no existe en el sistema
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 mensaje_usuario:
 *                   type: string
 *                   example: "La factura no existe en nuestro sistema. Verifique la clave de acceso."
 *       500:
 *         description: Error interno del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Error interno del servidor"
 */
router.post('/consultar/:claveAcceso', publicAuth, async (req, res) => {
  // --- ERROR SOLUCIONADO: Añadimos el try principal ---
  try { 
    const { claveAcceso } = req.params;
    const { captchaToken, hpValue } = req.body; 

    // --- VALIDACIÓN DE BYPASS PARA N8N ---
    const isN8nRequest = req.headers['x-n8n-api-key'] === process.env.N8N_API_KEY;

    // --- CAPA 4: HONEYPOT (Solo si NO es n8n) ---
    if (!isN8nRequest && hpValue) {
      console.warn(`[SECURITY] Honeypot activado por IP: ${req.ip}`);
      return res.status(400).json({ error: 'Bot detectado' });
    }

    // --- CAPA 5: VALIDACIÓN DE FORMATO ---
    if (!/^\d{49}$/.test(claveAcceso)) {
      return res.status(400).json({ error: 'Clave de acceso inválida' });
    }

    // --- CAPA 2: VALIDACIÓN TURNSTILE (Omitir si es n8n) ---
    if (!isN8nRequest) {
        const secretKey = process.env.TURNSTILE_SECRET_KEY;
        const params = new URLSearchParams();
        params.append('secret', secretKey);
        params.append('response', captchaToken);
        params.append('remoteip', req.ip);

        const verifyURL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
        
        // Usamos axios sin un try-catch interno para que el catch general capture fallos de red
        const response = await axios.post(verifyURL, params, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        if (!response.data.success) {
          return res.status(403).json({ 
            success: false, 
            mensaje_usuario: 'La verificación de seguridad ha fallado.' 
          });
        }
    }

    // --- LOGICA DE BASE DE DATOS ---
    const query = `
      SELECT 
        i.clave_acceso, i.secuencial, i.fecha_emision, i.estado, i.mensajes_sri,
        i.razon_social_comprador, i.identificacion_comprador,
        i.importe_total, i.subtotal_iva, i.subtotal_0, i.valor_iva,
        e.razon_social as emisor_nombre, e.ruc as emisor_ruc
      FROM invoices i
      JOIN emisores e ON i.emisor_id = e.id
      WHERE i.clave_acceso = $1
    `;
    
    const result = await pool.query(query, [claveAcceso]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        mensaje_usuario: 'La factura no existe en nuestro sistema. Verifique la clave de acceso.'
      });
    }

    const factura = result.rows[0];

    // --- RESPUESTA SEGÚN ESTADO ---
    switch (factura.estado) {
      case 'AUTORIZADO':
        return res.json({
          success: true,
          estado: 'AUTORIZADO',
          data: {
            cabecera: {
              emisor: factura.emisor_nombre,
              ruc: factura.emisor_ruc,
              nro: factura.secuencial,
              fecha: factura.fecha_emision
            },
            totales: { total: factura.importe_total },
            links: {
              pdf: `https://core.kipu.ec/api/v1/public/pdf/${claveAcceso}`,
              xml: `https://core.kipu.ec/api/v1/public/xml/${claveAcceso}`
            }
          }
        });

      case 'RECIBIDO':
      case 'EN PROCESO':
        return res.status(200).json({
          success: false,
          estado: factura.estado,
          mensaje_usuario: 'Tu factura ha sido recibida por el SRI y está en proceso de autorización.'
        });

      case 'DEVUELTA':
      case 'RECHAZADO':
        return res.status(200).json({
          success: false,
          estado: factura.estado,
          mensaje_usuario: 'La factura presenta inconsistencias y fue devuelta/rechazada por el SRI.',
          detalles_sri: factura.mensajes_sri,
          sugerencia: `Por favor, contacta al emisor (${factura.emisor_nombre}) para solucionar este inconveniente.`
        });

      default:
        return res.status(200).json({
           success: false,
           estado: factura.estado,
           mensaje_usuario: 'El comprobante se encuentra en estado: ' + factura.estado,
           sugerencia: 'Si el problema persiste, contacta al comercio emisor.'
        });
    }

  } catch (error) { // Este es el catch que fallaba (línea 357)
    if (error.response) {
      console.error('Error de Cloudflare:', error.response.data);
    } else {
      console.error('Error en validación o consulta:', error.message);
    }
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
