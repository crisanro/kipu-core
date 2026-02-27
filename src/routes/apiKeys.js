const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../database/index');
const { authMiddleware: auth } = require('../middlewares/auth');

/**
 * @openapi
 * /keys:
 *   get:
 *     summary: Listar mis API Keys (sin incluir la llave real, solo metadatos)
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de API Keys del emisor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:   { type: boolean, example: true }
 *                 keys:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:           { type: string }
 *                       nombre:       { type: string }
 *                       emisor_id:    { type: string }
 *                       created_at:   { type: string, format: date-time }
 *                       last_used_at: { type: string, format: date-time }
 *       500:
 *         description: Error interno del servidor
 */
router.get('/', auth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, nombre, emisor_id, created_at, last_used_at 
             FROM api_keys 
             WHERE emisor_id = $1 AND revoked = false 
             ORDER BY created_at DESC`,
            [req.emisor_id]
        );
        res.json({ ok: true, keys: result.rows });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/**
 * @openapi
 * /keys:
 *   post:
 *     summary: Generar una nueva API Key
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nombre]
 *             properties:
 *               nombre: { type: string, example: "Mi App de Contabilidad" }
 *     responses:
 *       201:
 *         description: API Key generada. La llave solo se muestra una vez.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:         { type: boolean, example: true }
 *                 mensaje:    { type: string }
 *                 key_id:     { type: string }
 *                 api_key:    { type: string, example: "kp_live_abc123..." }
 *                 created_at: { type: string, format: date-time }
 *       400:
 *         description: Nombre de aplicación no proporcionado
 *       500:
 *         description: Error interno del servidor
 */
router.post('/', auth, async (req, res) => {
    const { nombre } = req.body;

    if (!nombre) {
        return res.status(400).json({ ok: false, mensaje: "El nombre de la aplicación es requerido" });
    }

    try {
        // 1. Definimos el prefijo y generamos la parte secreta
        const prefix = 'kp_live';
        const secret = crypto.randomBytes(24).toString('hex');
        const rawKey = `${prefix}_${secret}`; // Esto es lo que verá el usuario
        
        // 2. Creamos el hash para la base de datos
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

        // 3. Guardar incluyendo el KEY_PREFIX
        const result = await pool.query(
            `INSERT INTO api_keys (emisor_id, key_hash, key_prefix, nombre) 
             VALUES ($1, $2, $3, $4) 
             RETURNING id, created_at`,
            [req.emisor_id, keyHash, prefix, nombre] // 👈 Agregamos el prefix aquí
        );

        res.status(201).json({
            ok: true,
            mensaje: "API Key generada exitosamente.",
            key_id: result.rows[0].id,
            api_key: rawKey,
            created_at: result.rows[0].created_at
        });

    } catch (error) {
        console.error("[Create API Key Error]", error.message);
        res.status(500).json({ ok: false, error: "No se pudo generar la llave" });
    }
});

/**
 * @openapi
 * /keys/{id}:
 *   delete:
 *     summary: Revocar una API Key (desactivación permanente)
 *     tags: [API Keys]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: ID de la API Key a revocar
 *     responses:
 *       200:
 *         description: API Key revocada exitosamente
 *       404:
 *         description: Llave no encontrada o no pertenece al emisor
 *       500:
 *         description: Error interno del servidor
 */
router.delete('/:id', auth, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `UPDATE api_keys 
             SET revoked = true, revoked_at = NOW() 
             WHERE id = $1 AND emisor_id = $2 
             RETURNING id`,
            [id, req.emisor_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ ok: false, mensaje: "Llave no encontrada o no pertenece a tu usuario" });
        }

        res.json({ ok: true, mensaje: "API Key revocada exitosamente" });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});


module.exports = router;
