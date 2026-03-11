const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');

/**
 * @openapi
 * /:
 *   get:
 *     summary: Dashboard principal del emisor
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: fecha_inicio
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *           example: "2025-01-01"
 *       - in: query
 *         name: fecha_fin
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *           example: "2025-02-14"
 *     responses:
 *       200:
 *         description: Dashboard obtenido correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     health:
 *                       type: object
 *                       properties:
 *                         ruc:
 *                           type: boolean
 *                         ambiente_produccion:
 *                           type: boolean
 *                         firma_electronica:
 *                           type: boolean
 *                         firma_vigente:
 *                           type: boolean
 *                         firma_alerta:
 *                           type: string
 *                           nullable: true
 *                         tiene_establecimiento:
 *                           type: boolean
 *                         tiene_punto_emision:
 *                           type: boolean
 *                     resumen:
 *                       type: object
 *                       properties:
 *                         total_facturas:
 *                           type: integer
 *                         subtotal_iva:
 *                           type: number
 *                         subtotal_0:
 *                           type: number
 *                         valor_iva:
 *                           type: number
 *                         importe_total:
 *                           type: number
 *                     facturas:
 *                       type: array
 *                       items:
 *                         type: object
 *       400:
 *         description: Fechas inválidas o rango mayor a 45 días
 *       500:
 *         description: Error interno del servidor
 */
router.get('/', authMiddleware, async (req, res) => {
    try {
        const { fecha_inicio, fecha_fin } = req.query;

        // --- Validación de fechas ---
        if (!fecha_inicio || !fecha_fin) {
            return res.status(400).json({ ok: false, error: 'fecha_inicio y fecha_fin son requeridas' });
        }

        const inicio = new Date(fecha_inicio);
        const fin    = new Date(fecha_fin);

        if (isNaN(inicio) || isNaN(fin)) {
            return res.status(400).json({ ok: false, error: 'Formato de fecha inválido, use YYYY-MM-DD' });
        }

        if (fin < inicio) {
            return res.status(400).json({ ok: false, error: 'fecha_fin no puede ser menor a fecha_inicio' });
        }

        const diffDays = (fin - inicio) / (1000 * 60 * 60 * 24);
        if (diffDays > 45) {
            return res.status(400).json({ ok: false, error: 'El rango máximo permitido es de 45 días' });
        }

        // --- Queries en paralelo ---
        const [emisorResult, estabResult, facturasResult] = await Promise.all([

            // 1. Datos del emisor
            pool.query(
                `SELECT ruc, ambiente, p12_path, p12_expiration
                 FROM emisores
                 WHERE id = $1`,
                [req.emisor_id]
            ),

            // 2. Conteo de establecimientos y puntos de emisión
            pool.query(
                `SELECT
                    COUNT(DISTINCT e.id)  AS total_establecimientos,
                    COUNT(DISTINCT p.id)  AS total_puntos
                 FROM establecimientos e
                 LEFT JOIN puntos_emision p ON p.establecimiento_id = e.id
                 WHERE e.emisor_id = $1`,
                [req.emisor_id]
            ),

            // 3. Facturas en el rango
            pool.query(
                `SELECT
                    i.id,
                    i.secuencial,
                    i.clave_acceso,
                    i.fecha_emision,
                    i.estado,
                    i.identificacion_comprador,
                    i.razon_social_comprador,
                    i.subtotal_iva,
                    i.subtotal_0,
                    i.valor_iva,
                    i.importe_total,
                    e.codigo  AS estab_codigo,
                    p.codigo  AS punto_codigo
                 FROM invoices i
                 JOIN puntos_emision p  ON i.punto_emision_id = p.id
                 JOIN establecimientos e ON p.establecimiento_id = e.id
                 WHERE i.emisor_id    = $1
                   AND i.fecha_emision BETWEEN $2 AND $3
                 ORDER BY i.fecha_emision DESC, i.secuencial DESC`,
                [req.emisor_id, fecha_inicio, fecha_fin]
            )
        ]);

        // --- Health checks del emisor ---
        const emisor = emisorResult.rows[0];
        const estab  = estabResult.rows[0];
        const hoy    = new Date();
        hoy.setHours(0, 0, 0, 0);

        let firma_vigente = false;
        let firma_alerta  = null;

        if (emisor.p12_expiration) {
            const expiracion = new Date(emisor.p12_expiration);
            firma_vigente = expiracion > hoy;

            if (firma_vigente) {
                const diasRestantes = Math.ceil((expiracion - hoy) / (1000 * 60 * 60 * 24));
                if (diasRestantes <= 30) {
                    firma_alerta = `Tu firma electrónica caduca en ${diasRestantes} día${diasRestantes === 1 ? '' : 's'}`;
                }
            } else {
                firma_alerta = 'Tu firma electrónica ha caducado';
            }
        }

        const health = {
            ruc:                  !!emisor.ruc,
            ambiente_produccion:  emisor.ambiente === '2',
            firma_electronica:    !!emisor.p12_path,
            firma_vigente,
            firma_alerta,
            tiene_establecimiento: parseInt(estab.total_establecimientos) > 0,
            tiene_punto_emision:   parseInt(estab.total_puntos) > 0,
        };

        // --- Resumen de totales ---
        const facturas = facturasResult.rows;
        const resumen = facturas.reduce((acc, f) => {
            acc.subtotal_iva  += parseFloat(f.subtotal_iva  || 0);
            acc.subtotal_0    += parseFloat(f.subtotal_0    || 0);
            acc.valor_iva     += parseFloat(f.valor_iva     || 0);
            acc.importe_total += parseFloat(f.importe_total || 0);
            return acc;
        }, { total_facturas: facturas.length, subtotal_iva: 0, subtotal_0: 0, valor_iva: 0, importe_total: 0 });

        // Redondear a 2 decimales
        for (const key of ['subtotal_iva', 'subtotal_0', 'valor_iva', 'importe_total']) {
            resumen[key] = Math.round(resumen[key] * 100) / 100;
        }

        res.json({ ok: true, data: { health, resumen, facturas } });

    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

module.exports = router;
