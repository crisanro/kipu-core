const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { minioClient } = require('../services/storageService');

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
router.get('/pdf/:claveAcceso', async (req, res) => {
  const { claveAcceso } = req.params;
  if (!/^\d{49}$/.test(claveAcceso)) return res.status(400).send('Clave inválida');

  try {
    const result = await pool.query(
      "SELECT pdf_path FROM invoices WHERE clave_acceso = $1", 
      [claveAcceso]
    );

    if (result.rowCount === 0) return res.status(404).send('Factura no encontrada');

    const fullPath = result.rows[0].pdf_path;
    const [bucket, ...pathParts] = fullPath.split('/');
    const fileName = pathParts.join('/');

    const stream = await minioClient.getObject(bucket, fileName);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${claveAcceso}.pdf"`);
    
    stream.pipe(res);
  } catch (error) {
    console.error('Error Public PDF:', error.message);
    res.status(404).send('Archivo no encontrado');
  }
});

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
router.get('/xml/:claveAcceso', async (req, res) => {
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
    stream.pipe(res);
  } catch (error) {
    res.status(404).send('Archivo no encontrado');
  }
});


module.exports = router;
