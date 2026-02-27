const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { serviceAuth } = require('../middlewares/serviceAuth');

/**
 * @openapi
 * /api/admin/topup:
 *   post:
 *     summary: Recargar créditos a un emisor (exclusivo n8n)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ruc, amount]
 *             properties:
 *               ruc:
 *                 type: string
 *                 description: RUC del emisor a recargar
 *               amount:
 *                 type: integer
 *                 description: Cantidad de créditos a agregar
 *               reference_id:
 *                 type: string
 *                 description: Referencia externa (Stripe, etc.)
 *     responses:
 *       200:
 *         description: Recarga exitosa
 *       400:
 *         description: RUC o monto faltante
 *       403:
 *         description: Acceso restringido a servicios internos
 *       500:
 *         description: Error interno del servidor
 */
router.post('/topup', serviceAuth, async (req, res) => {
    // Ya no necesitas validar el rol aquí. 
    // Si llegó a este punto, serviceAuth ya garantizó que es n8n.

    const { ruc, amount, reference_id } = req.body;

    if (!ruc || !amount) {
        return res.status(400).json({ ok: false, mensaje: "RUC y monto son requeridos" });
    }

    const client = await pool.pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Obtener ID del emisor por RUC
        const emisorRes = await client.query('SELECT id FROM emisores WHERE ruc = $1', [ruc]);
        if (emisorRes.rowCount === 0) {
            throw new Error(`Emisor con RUC ${ruc} no encontrado`);
        }
        const emisorId = emisorRes.rows[0].id;

        // 2. Incrementar balance (Atomic Update)
        const updateRes = await client.query(`
            UPDATE user_credits 
            SET balance = balance + $1, 
                last_updated = NOW() 
            WHERE emisor_id = $2 
            RETURNING balance
        `, [parseInt(amount), emisorId]);

        // 3. Registrar Log de Transacción (Auditoría)
        await client.query(`
            INSERT INTO transaction_logs (target_emisor_id, amount, action_type, description)
            VALUES ($1, $2, 'STRIPE_RECHARGE', $3)
        `, [emisorId, amount, `Recarga n8n - Ref: ${reference_id || 'N/A'}`]);

        await client.query('COMMIT');
        
        res.json({ 
            ok: true, 
            mensaje: "Recarga exitosa", 
            nuevo_balance: updateRes.rows[0].balance 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("[Admin Topup Error]", error.message);
        res.status(500).json({ ok: false, error: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;