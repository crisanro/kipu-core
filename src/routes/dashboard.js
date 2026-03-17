const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');

/**
 * @openapi
 * /:
 *   get:
 *     summary: Obtener datos del dashboard
 *     description: |
 *       Retorna en una sola llamada el estado de salud del emisor, el resumen financiero
 *       y el listado de facturas dentro del rango de fechas indicado.
 *       Todas las queries se ejecutan en paralelo para minimizar latencia.
 *       Si el emisor no tiene configuración inicial, devuelve datos vacíos con `usuario_nuevo: true`.
 *     tags:
 *       - Dashboard
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: fecha_inicio
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *           example: "2024-01-01"
 *         description: "Fecha de inicio del rango (inclusive)."
 *       - in: query
 *         name: fecha_fin
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *           example: "2024-12-31"
 *         description: "Fecha de fin del rango (inclusive)."
 *     responses:
 *       200:
 *         description: Datos del dashboard cargados correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     health:
 *                       type: object
 *                       description: "Estado de configuración del emisor."
 *                       properties:
 *                         ruc:
 *                           type: boolean
 *                           description: "true si el emisor tiene RUC registrado."
 *                           example: true
 *                         ambiente_produccion:
 *                           type: boolean
 *                           description: "true si el emisor está en ambiente de producción (ambiente = 2)."
 *                           example: false
 *                         firma_configurada:
 *                           type: boolean
 *                           description: "true si tiene un certificado P12 subido."
 *                           example: true
 *                         firma_vigente:
 *                           type: boolean
 *                           description: "true si el certificado P12 no ha expirado."
 *                           example: true
 *                         firma_alerta:
 *                           type: string
 *                           nullable: true
 *                           description: "Mensaje de alerta sobre el certificado. Null si está vigente y sin problemas."
 *                           example: "Firma próxima a caducar (12 días)"
 *                         establecimientos_configurados:
 *                           type: boolean
 *                           description: "true si el emisor tiene al menos un establecimiento."
 *                           example: true
 *                         puntos_emision_configurados:
 *                           type: boolean
 *                           description: "true si el emisor tiene al menos un punto de emisión."
 *                           example: true
 *                         creditos_disponibles:
 *                           type: number
 *                           description: "Saldo actual de créditos del emisor."
 *                           example: 10
 *                         usuario_nuevo:
 *                           type: boolean
 *                           description: "true si el token no tiene un emisor vinculado aún."
 *                           example: false
 *                         tiene_api_key:
 *                           type: boolean
 *                           description: "true si el emisor tiene al menos una API key activa."
 *                           example: true
 *                     resumen:
 *                       type: object
 *                       description: "Resumen financiero del período solicitado."
 *                       properties:
 *                         total_facturas:
 *                           type: integer
 *                           example: 38
 *                         subtotal_iva:
 *                           type: number
 *                           format: float
 *                           example: 1250.00
 *                         subtotal_0:
 *                           type: number
 *                           format: float
 *                           example: 300.00
 *                         valor_iva:
 *                           type: number
 *                           format: float
 *                           example: 150.00
 *                         importe_total:
 *                           type: number
 *                           format: float
 *                           example: 1700.00
 *                     facturas:
 *                       type: array
 *                       description: "Últimas 50 facturas del período ordenadas por fecha de creación descendente."
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                             example: 101
 *                           secuencial:
 *                             type: string
 *                             example: "000000001"
 *                           estado:
 *                             type: string
 *                             example: "AUTORIZADA"
 *                           razon_social_comprador:
 *                             type: string
 *                             example: "Juan Pérez"
 *                           importe_total:
 *                             type: number
 *                             format: float
 *                             example: 112.00
 *                           fecha_emision:
 *                             type: string
 *                             format: date
 *                             example: "2024-06-15"
 *       400:
 *         description: Parámetros de fecha faltantes
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
 *                   example: "fecha_inicio y fecha_fin son requeridas"
 *       401:
 *         description: Token de Firebase inválido o ausente
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
 *                   example: "Error al cargar el dashboard"
 */
router.get('/', authMiddleware, async (req, res) => {
    try {
        const { fecha_inicio, fecha_fin } = req.query;
        const emisor_id = req.emisor_id;

        if (!fecha_inicio || !fecha_fin) {
            return res.status(400).json({ ok: false, error: 'fecha_inicio y fecha_fin son requeridas' });
        }

        // Helper con reintento automático para queries que pueden fallar por ECONNRESET
        const queryConReintento = async (text, params, fallback) => {
            try {
                return await pool.query(text, params);
            } catch (err) {
                if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED') {
                    console.warn('⚠️ Reintentando query tras ECONNRESET...');
                    await new Promise(r => setTimeout(r, 200)); // espera 200ms
                    return await pool.query(text, params);      // un solo reintento
                }
                if (fallback !== undefined) return fallback;
                throw err;
            }
        };

        const [emisorResult, healthCheckResult, resumenResult, facturasResult, apiKeysResult] = await Promise.all([
            // 1. Datos básicos del emisor y créditos
            emisor_id ? queryConReintento(
                `SELECT e.ruc, e.ambiente, e.p12_path, e.p12_expiration, c.balance 
                 FROM emisores e LEFT JOIN user_credits c ON c.emisor_id = e.id WHERE e.id = $1`,
                [emisor_id]
            ) : { rows: [] },

            // 2. Infraestructura
            emisor_id ? queryConReintento(
                `SELECT 
                    (SELECT COUNT(*) FROM establecimientos WHERE emisor_id = $1) as total_estab,
                    (SELECT COUNT(*) FROM puntos_emision p 
                     JOIN establecimientos e ON p.establecimiento_id = e.id WHERE e.emisor_id = $1) as total_puntos`,
                [emisor_id]
            ) : { rows: [{ total_estab: 0, total_puntos: 0 }] },

            // 3. Resumen financiero
            emisor_id ? queryConReintento(
                `SELECT COUNT(id) as total_facturas, COALESCE(SUM(subtotal_iva), 0) as subtotal_iva,
                 COALESCE(SUM(subtotal_0), 0) as subtotal_0, COALESCE(SUM(valor_iva), 0) as valor_iva,
                 COALESCE(SUM(importe_total), 0) as importe_total
                 FROM invoices WHERE emisor_id = $1 AND fecha_emision BETWEEN $2 AND $3`,
                [emisor_id, fecha_inicio, fecha_fin]
            ) : { rows: [{ total_facturas: 0, subtotal_iva: 0, subtotal_0: 0, valor_iva: 0, importe_total: 0 }] },

            // 4. Listado de facturas
            emisor_id ? queryConReintento(
                `SELECT id, secuencial, estado, razon_social_comprador, importe_total, fecha_emision
                 FROM invoices WHERE emisor_id = $1 AND fecha_emision BETWEEN $2 AND $3
                 ORDER BY created_at DESC LIMIT 50`,
                [emisor_id, fecha_inicio, fecha_fin]
            ) : { rows: [] },

            // 5. API Keys
            emisor_id ? queryConReintento(
                `SELECT COUNT(*) as total_keys FROM api_keys WHERE emisor_id = $1 AND revoked = false`,
                [emisor_id]
            ) : { rows: [{ total_keys: 0 }] }
        ]);

        const emisor = emisorResult.rows[0] || {};
        const healthStats = healthCheckResult.rows[0];
        const resumen = resumenResult.rows[0];
        const totalKeys = parseInt(apiKeysResult.rows[0].total_keys);

        const hoy = new Date();
        const expiracion = emisor.p12_expiration ? new Date(emisor.p12_expiration) : null;
        let firma_vigente = false;
        let firma_alerta = emisor_id ? null : "Configuración inicial pendiente";

        if (expiracion) {
            firma_vigente = expiracion > hoy;
            const diasRestantes = Math.ceil((expiracion - hoy) / (1000 * 60 * 60 * 24));
            if (diasRestantes <= 0) firma_alerta = "Firma caducada";
            else if (diasRestantes <= 30) firma_alerta = `Firma próxima a caducar (${diasRestantes} días)`;
        }

        res.json({
            ok: true,
            data: {
                health: {
                    ruc: !!emisor.ruc,
                    ambiente_produccion: emisor.ambiente === 2,
                    firma_configurada: !!emisor.p12_path,
                    firma_vigente,
                    firma_alerta,
                    establecimientos_configurados: parseInt(healthStats.total_estab) > 0,
                    puntos_emision_configurados: parseInt(healthStats.total_puntos) > 0,
                    creditos_disponibles: emisor.balance || 0,
                    usuario_nuevo: !emisor_id,
                    tiene_api_key: totalKeys > 0
                },
                resumen: {
                    total_facturas: parseInt(resumen.total_facturas),
                    subtotal_iva: parseFloat(resumen.subtotal_iva),
                    subtotal_0: parseFloat(resumen.subtotal_0),
                    valor_iva: parseFloat(resumen.valor_iva),
                    importe_total: parseFloat(resumen.importe_total)
                },
                facturas: facturasResult.rows
            }
        });

    } catch (error) {
        console.error("Dashboard Error:", error);
        res.status(500).json({ ok: false, error: 'Error al cargar el dashboard' });
    }
});


module.exports = router;