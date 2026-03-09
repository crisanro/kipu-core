const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { minioClient } = require('../services/storageService');
const publicAuth = require('../middlewares/publicAuth');

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

// ── Consulta pública ──────────────────────────────────────────────────────────
/**
 * @openapi
 * /public/consultar/{claveAcceso}:
 *   get:
 *     summary: Consultar estado de un comprobante
 *     tags: [Público]
 *     parameters:
 *       - in: path
 *         name: claveAcceso
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Información del comprobante
 *       404:
 *         description: Factura no encontrada
 */
router.get('/consultar/:claveAcceso', publicAuth, async (req, res) => {
  const { claveAcceso } = req.params;
  if (!/^\d{49}$/.test(claveAcceso)) {
    return res.status(400).json({ error: 'Clave de acceso inválida' });
  }
  try {
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
          mensaje_usuario: 'Tu factura ha sido recibida por el SRI y está en proceso de autorización. Por favor, intenta en unos minutos.'
        });
      case 'DEVUELTA':
      case 'RECHAZADO':
        return res.status(200).json({
          success: false,
          estado: factura.estado,
          mensaje_usuario: 'La factura presenta inconsistencias y fue devuelta/rechazada por el SRI.',
          detalles_sri: factura.mensajes_sri,
          sugerencia: 'Por favor, contacta al emisor (' + factura.emisor_nombre + ') para solucionar este inconveniente.'
        });
      default:
        return res.status(200).json({
          success: false,
          estado: factura.estado,
          mensaje_usuario: 'El comprobante se encuentra en estado: ' + factura.estado,
          sugerencia: 'Si el problema persiste, contacta al comercio emisor.'
        });
    }
  } catch (error) {
    console.error('Error en consulta pública:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
