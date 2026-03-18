const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { apiKeyAuth } = require('../middlewares/apiKeyAuth');
const { emitirFacturaCore } = require('../utils/calculadoraSri');
const axios = require('axios');


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
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 emisor:
 *                   type: object
 *                   properties:
 *                     ruc:
 *                       type: string
 *                       example: "1234567890001"
 *                     razon_social:
 *                       type: string
 *                       example: "Empresa Ejemplo S.A."
 *                     nombre_comercial:
 *                       type: string
 *                       example: "Empresa Ejemplo"
 *                     ambiente:
 *                       type: string
 *                       enum: [PRUEBAS, PRODUCCIÓN]
 *                       example: "PRODUCCIÓN"
 *                     firma:
 *                       type: object
 *                       properties:
 *                         valida:
 *                           type: boolean
 *                           example: true
 *                         vencimiento:
 *                           type: string
 *                           format: date-time
 *                           example: "2026-01-15T00:00:00.000Z"
 *                 creditos:
 *                   type: number
 *                   example: 100
 *                 historial:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
 *                       clave_acceso:
 *                         type: string
 *                         example: "2301202301179214673400110010010000000011234567811"
 *                       fecha_emision:
 *                         type: string
 *                         format: date
 *                         example: "2024-01-23"
 *                       estado:
 *                         type: string
 *                         enum: [AUTORIZADO, RECHAZADO, PENDIENTE, ANULADO]
 *                         example: "AUTORIZADO"
 *                       identificacion_comprador:
 *                         type: string
 *                         example: "0987654321001"
 *                       razon_social_comprador:
 *                         type: string
 *                         example: "Cliente Ejemplo S.A."
 *                       total:
 *                         type: number
 *                         example: 150.75
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                         example: "2024-01-23T14:30:00.000Z"
 *       404:
 *         description: Emisor no encontrado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Emisor no encontrado"
 *       500:
 *         description: Error interno del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Error interno del servidor"
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
 * /invoice:
 *   post:
 *     summary: Emitir una factura electrónica
 *     description: |
 *       Genera, firma y almacena una factura electrónica en formato SRI.
 *       El proceso se ejecuta en tres bloques secuenciales:
 *       1. **TX rápida** — valida créditos, reserva secuencial atómico y construye el XML.
 *       2. **Firma** — descarga el P12 desde MinIO, firma el XML con XAdES-BES y genera el PDF.
 *       3. **TX final** — sube XML y PDF a MinIO, descuenta 1 crédito y registra la factura en BD.
 *
 *       Requiere autenticación por API Key (`x-api-key`), no por token Firebase.
 *     tags:
 *       - Facturación
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - establecimiento
 *               - punto_emision
 *               - cliente
 *               - items
 *               - pagos
 *             properties:
 *               establecimiento:
 *                 type: string
 *                 pattern: '^\d{3}$'
 *                 description: "Código del establecimiento en formato SRI (3 dígitos)."
 *                 example: "001"
 *               punto_emision:
 *                 type: string
 *                 pattern: '^\d{3}$'
 *                 description: "Código del punto de emisión en formato SRI (3 dígitos)."
 *                 example: "001"
 *               cliente:
 *                 type: object
 *                 required:
 *                   - tipo_id
 *                   - nombre
 *                   - identificacion
 *                 properties:
 *                   tipo_id:
 *                     type: string
 *                     description: "Tipo de identificación según catálogo SRI."
 *                     example: "04"
 *                   nombre:
 *                     type: string
 *                     description: "Razón social o nombre del comprador."
 *                     example: "Juan Pérez"
 *                   identificacion:
 *                     type: string
 *                     description: "RUC, cédula o pasaporte del comprador."
 *                     example: "1712345678"
 *               items:
 *                 type: array
 *                 description: "Líneas de detalle de la factura."
 *                 items:
 *                   type: object
 *                   required:
 *                     - descripcion
 *                     - cantidad
 *                     - precio_unitario
 *                   properties:
 *                     descripcion:
 *                       type: string
 *                       example: "Servicio de consultoría"
 *                     cantidad:
 *                       type: number
 *                       example: 2
 *                     precio_unitario:
 *                       type: number
 *                       example: 100.00
 *                     descuento:
 *                       type: number
 *                       nullable: true
 *                       example: 0.00
 *               pagos:
 *                 type: array
 *                 description: "Formas de pago según catálogo SRI."
 *                 items:
 *                   type: object
 *                   required:
 *                     - total
 *                   properties:
 *                     forma_pago:
 *                       type: string
 *                       description: "Código de forma de pago SRI. Por defecto '01' (efectivo)."
 *                       example: "01"
 *                     total:
 *                       type: number
 *                       example: 224.00
 *                     plazo:
 *                       type: string
 *                       nullable: true
 *                       example: "0"
 *                     unidad_tiempo:
 *                       type: string
 *                       nullable: true
 *                       example: "dias"
 *     responses:
 *       201:
 *         description: Factura generada y firmada exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 mensaje:
 *                   type: string
 *                   example: "Factura generada y firmada exitosamente."
 *                 claveAcceso:
 *                   type: string
 *                   description: "Clave de acceso de 49 dígitos generada según algoritmo SRI."
 *                   example: "2406202401179214673900110010010000000011234567813"
 *                 creditos_restantes:
 *                   type: integer
 *                   description: "Saldo de créditos del emisor después de descontar 1."
 *                   example: 9
 *                 xml:
 *                   type: string
 *                   description: "Ruta del XML firmado en MinIO."
 *                   example: "invoices/1792146739001/2406202401179214673900110010010000000011234567813.xml"
 *                 pdf:
 *                   type: string
 *                   description: "Ruta del PDF generado en MinIO."
 *                   example: "invoices/1792146739001/2406202401179214673900110010010000000011234567813.pdf"
 *       400:
 *         description: Campos requeridos faltantes
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 mensaje:
 *                   type: string
 *                   example: "Los campos 'establecimiento' y 'punto_emision' son requeridos para la secuencia legal."
 *       402:
 *         description: Créditos insuficientes para emitir la factura
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 mensaje:
 *                   type: string
 *                   example: "Créditos insuficientes."
 *       401:
 *         description: API Key inválida o ausente
 *       404:
 *         description: La combinación establecimiento + punto de emisión no existe o no pertenece al emisor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 mensaje:
 *                   type: string
 *                   example: "La combinación Establecimiento [001] y Punto [001] no existe o no te pertenece."
 *       500:
 *         description: Error interno en cualquiera de los tres bloques de procesamiento
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Error al firmar: certificado P12 no encontrado."
 */
router.post('/invoice', apiKeyAuth, emitirFacturaCore);

module.exports = router;