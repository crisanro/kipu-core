const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');
const { calcularTotalesEImpuestos } = require('../utils/calculadoraSri');

/**
 * @openapi
 * /invoices/emit:
 *   post:
 *     summary: Emitir una factura electrónica
 *     tags: [Invoices]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cliente, items]
 *             properties:
 *               cliente:
 *                 type: object
 *                 description: Datos del cliente receptor
 *               items:
 *                 type: array
 *                 description: Líneas de detalle de la factura
 *                 items:
 *                   type: object
 *               establecimiento:
 *                 type: string
 *                 description: Código del establecimiento (default 001)
 *               punto_emision:
 *                 type: string
 *                 description: Código del punto de emisión (default 100)
 *               pagos:
 *                 type: array
 *                 description: Formas de pago
 *                 items:
 *                   type: object
 *     responses:
 *       200:
 *         description: Factura recibida y en cola de procesamiento
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 mensaje:
 *                   type: string
 *                 invoice_id:
 *                   type: integer
 *                 estado:
 *                   type: string
 *                   example: PENDIENTE
 *       400:
 *         description: Datos faltantes, firma no subida o expirada
 *       402:
 *         description: Saldo de créditos insuficiente
 *       403:
 *         description: Emisor no identificado
 *       404:
 *         description: Punto de emisión no encontrado
 *       500:
 *         description: Error interno al procesar la factura
 */
router.post('/emit', authMiddleware, async (req, res) => {
    // 1. Validar que el emisor esté identificado (vía JWT o API Key)
    const emisorId = req.emisor_id;
    if (!emisorId) {
        return res.status(403).json({ ok: false, mensaje: "Emisor no identificado en la sesión." });
    }

    const { cliente, items, establecimiento, punto_emision, pagos } = req.body;

    // 2. Validación básica de integridad
    if (!cliente || !items || items.length === 0) {
        return res.status(400).json({ ok: false, mensaje: "Datos del cliente o items faltantes." });
    }

    try {
        // 3. Verificar créditos y estado del P12 del emisor
        const emisorRes = await pool.query(
            `SELECT e.ruc, e.p12_path, e.p12_expiration, c.balance 
             FROM emisores e 
             JOIN user_credits c ON e.id = c.emisor_id 
             WHERE e.id = $1`, 
            [emisorId]
        );

        const emisor = emisorRes.rows[0];

        if (!emisor.p12_path) return res.status(400).json({ ok: false, mensaje: "No has subido tu firma electrónica (.p12)." });
        if (emisor.balance <= 0) return res.status(402).json({ ok: false, mensaje: "Saldo de créditos insuficiente." });
        if (new Date(emisor.p12_expiration) < new Date()) return res.status(400).json({ ok: false, mensaje: "Tu firma electrónica ha expirado." });

        // 4. Calcular impuestos y totales localmente
        const calculos = calcularTotalesEImpuestos(items);

        // 5. Buscar el ID del punto de emisión solicitado
        const ptoRes = await pool.query(
            `SELECT p.id FROM puntos_emision p 
             JOIN establecimientos est ON p.establecimiento_id = est.id
             WHERE est.emisor_id = $1 AND est.codigo = $2 AND p.codigo = $3`,
            [emisorId, establecimiento || '001', punto_emision || '100']
        );

        if (ptoRes.rowCount === 0) return res.status(404).json({ ok: false, mensaje: "Punto de emisión no encontrado." });
        const puntoEmisionId = ptoRes.rows[0].id;

        // 6. Inserción Blindada (PENDIENTE)
        // La clave de acceso real se generará en el scheduler para evitar saltos en secuenciales
        const tempClave = `PENDING-${require('crypto').randomBytes(8).toString('hex')}`;

        const insertRes = await pool.query(
            `INSERT INTO invoices (
                emisor_id, punto_emision_id, clave_acceso, estado, 
                importe_total, subtotal_0, subtotal_iva, valor_iva, 
                client_input_data
            ) VALUES ($1, $2, $3, 'PENDIENTE', $4, $5, $6, $7, $8)
            RETURNING id, created_at`,
            [
                emisorId, 
                puntoEmisionId, 
                tempClave, 
                calculos.totales.importeTotal,
                calculos.totales.subtotal_0,
                calculos.totales.subtotal_iva,
                calculos.totales.totalIva,
                JSON.stringify(req.body) // Guardamos el input original para el scheduler
            ]
        );

        res.json({ 
            ok: true, 
            mensaje: "Factura recibida y en cola de procesamiento.",
            invoice_id: insertRes.rows[0].id,
            estado: 'PENDIENTE'
        });

    } catch (error) {
        console.error("[Invoice Route Error]", error.message);
        res.status(500).json({ ok: false, error: "Error interno al procesar la factura." });
    }
});

/**
 * @openapi
 * /invoices/history:
 *   get:
 *     summary: Obtener historial de facturas del emisor
 *     tags: [Invoices]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Listado de las últimas 50 facturas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       clave_acceso:
 *                         type: string
 *                       estado:
 *                         type: string
 *                       importe_total:
 *                         type: number
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                       pdf_path:
 *                         type: string
 *       500:
 *         description: Error interno del servidor
 */
router.get('/history', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, clave_acceso, estado, importe_total, created_at, pdf_path 
             FROM invoices 
             WHERE emisor_id = $1 
             ORDER BY created_at DESC LIMIT 50`,
            [req.emisor_id]
        );
        res.json({ ok: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});


module.exports = router;
