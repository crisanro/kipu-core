const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { minioClient } = require('../services/storageService');
const publicAuth = require('../middlewares/publicAuth');

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
        i.pdf_path, i.xml_path,
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
      case 'AUTORIZADO': {
        const [pdfBucket, ...pdfParts] = factura.pdf_path.split('/');
        const [xmlBucket, ...xmlParts] = factura.xml_path.split('/');

        const pdfUrl = await minioClient.presignedGetObject(pdfBucket, pdfParts.join('/'), 3600);
        const xmlUrl = await minioClient.presignedGetObject(xmlBucket, xmlParts.join('/'), 3600);

        // Reemplazar host interno de MinIO por el dominio público
        const pdfPublic = pdfUrl.replace(/^https?:\/\/[^/]+/, 'https://s3.kipu.ec');
        const xmlPublic = xmlUrl.replace(/^https?:\/\/[^/]+/, 'https://s3.kipu.ec');

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
              pdf: pdfPublic,
              xml: xmlPublic
            }
          }
        });
      }
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
