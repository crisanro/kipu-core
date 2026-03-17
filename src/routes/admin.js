const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { serviceAuth } = require('../middlewares/serviceAuth');

/**
 * @openapi
 * /admin/topup:
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


/**
 * @openapi
 * /admin/request-pin:
 *   post:
 *     summary: Solicitar PIN de verificación
 *     description: |
 *       Genera un PIN de 6 dígitos válido por 10 minutos y lo devuelve a n8n
 *       para que lo entregue al usuario por WhatsApp. Invalida cualquier PIN
 *       previo del mismo email antes de generar el nuevo.
 *       Requiere autenticación por API Key.
 *     tags:
 *       - Integraciones
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - whatsapp_number
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: "Email del usuario registrado en el sistema."
 *                 example: "usuario@ejemplo.com"
 *               whatsapp_number:
 *                 type: string
 *                 description: "Número de WhatsApp al que n8n entregará el PIN."
 *                 example: "593987654321"
 *               tipo_accion:
 *                 type: string
 *                 nullable: true
 *                 description: "Contexto del PIN. Si se omite, se usa 'VALIDACION_GENERAL'."
 *                 example: "VALIDACION_GENERAL"
 *     responses:
 *       200:
 *         description: PIN generado correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 pin:
 *                   type: string
 *                   description: "PIN de 6 dígitos a entregar al usuario. Válido por 10 minutos."
 *                   example: "482719"
 *       401:
 *         description: API Key inválida o ausente
 *       404:
 *         description: El email no está registrado en el sistema
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
 *                   example: "Email no registrado."
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
 *                   example: "error message"
 */
router.post('/request-pin', serviceAuth, async (req, res) => {
    const { email, whatsapp_number, tipo_accion } = req.body;

    try {
        // 1. Verificar que el usuario existe
        const userRes = await pool.query(
            'SELECT emisor_id FROM profiles WHERE email = $1', 
            [email]
        );

        if (userRes.rowCount === 0) {
            return res.status(404).json({ ok: false, mensaje: "Email no registrado." });
        }

        const emisor_id = userRes.rows[0].emisor_id;

        // 2. Limpiar pins viejos
        await pool.query('DELETE FROM auth_challenges WHERE email = $1', [email]);

        // 3. Generar PIN de 6 dígitos
        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const expires_at = new Date(Date.now() + 10 * 60000); // 10 min

        await pool.query(`
            INSERT INTO auth_challenges (emisor_id, email, whatsapp_number, pin, tipo_accion, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [emisor_id, email, whatsapp_number, pin, tipo_accion || 'VALIDACION_GENERAL', expires_at]);

        // 4. Devolver el PIN a n8n para que se lo entregue al usuario por WhatsApp
        res.json({ ok: true, pin });

    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});




module.exports = router;
