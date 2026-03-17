const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');

/**
 * @openapi
 * /keys:
 *   get:
 *     summary: Listar API keys activas
 *     description: |
 *       Retorna todas las API keys activas (no revocadas) del emisor autenticado,
 *       ordenadas por fecha de creación descendente.
 *       No expone el valor completo de la key, solo el prefijo identificador.
 *     tags:
 *       - API Keys
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Listado de API keys activas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 keys:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                         example: 3
 *                       nombre:
 *                         type: string
 *                         description: "Nombre descriptivo asignado a la key al crearla."
 *                         example: "Integración ERP"
 *                       key_prefix:
 *                         type: string
 *                         description: "Primeros caracteres de la key para identificarla visualmente."
 *                         example: "kp_live_xK9m"
 *                       created_at:
 *                         type: string
 *                         format: date-time
 *                         example: "2024-06-15T10:30:00.000Z"
 *                       last_used_at:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         description: "Última vez que se usó la key. Null si nunca se ha utilizado."
 *                         example: "2024-11-20T08:15:00.000Z"
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
 *                   example: "error message"
 */
router.get('/', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, nombre, key_prefix, created_at, last_used_at 
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
 *     summary: Crear una nueva API key
 *     description: |
 *       Genera una nueva API key para el emisor autenticado. La key se muestra
 *       una única vez en la respuesta — no se puede recuperar después porque
 *       solo se almacena su hash SHA-256 en la base de datos.
 *       No se permiten dos keys activas con el mismo nombre para el mismo emisor.
 *     tags:
 *       - API Keys
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - nombre
 *             properties:
 *               nombre:
 *                 type: string
 *                 description: "Nombre descriptivo de la aplicación o integración. Se aplica trim automáticamente."
 *                 example: "Integración ERP"
 *     responses:
 *       201:
 *         description: API key generada correctamente
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
 *                   example: "¡Guarda tu API Key en un lugar seguro! No podrás verla de nuevo."
 *                 key_id:
 *                   type: integer
 *                   description: "ID interno de la key para operaciones futuras (ej: revocar)."
 *                   example: 5
 *                 api_key:
 *                   type: string
 *                   description: "Valor completo de la key. Solo visible en esta respuesta, nunca más."
 *                   example: "kp_live_a3f92c1d4e8b7f06a3f92c1d4e8b7f06a3f92c1d4e8b7f06"
 *                 created_at:
 *                   type: string
 *                   format: date-time
 *                   example: "2024-06-15T10:30:00.000Z"
 *       400:
 *         description: Nombre faltante, vacío o ya existe una key activa con ese nombre
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
 *                   example: "Ya tienes una API Key activa con el nombre \"Integración ERP\". Por favor, usa un nombre diferente o revoca la anterior."
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
 *                   example: "No se pudo generar la llave"
 */
router.post('/', authMiddleware, async (req, res) => {
    const { nombre } = req.body;
    const emisor_id = req.emisor_id;

    // Validación de entrada
    if (!nombre || nombre.trim().length === 0) {
        return res.status(400).json({ ok: false, mensaje: "El nombre de la aplicación es requerido" });
    }

    const nombreLimpio = nombre.trim();

    try {
        // 1. VALIDACIÓN: Verificar si ya existe una llave activa con ese nombre
        const existingKey = await pool.query(
            `SELECT id FROM api_keys 
             WHERE emisor_id = $1 AND nombre = $2 AND revoked = false`,
            [emisor_id, nombreLimpio]
        );

        if (existingKey.rowCount > 0) {
            return res.status(400).json({ 
                ok: false, 
                mensaje: `Ya tienes una API Key activa con el nombre "${nombreLimpio}". Por favor, usa un nombre diferente o revoca la anterior.` 
            });
        }

        // 2. Generar la llave física
        const prefix = 'kp_live';
        const secret = crypto.randomBytes(24).toString('hex');
        const rawKey = `${prefix}_${secret}`; 
        
        // 3. Crear el hash para la base de datos
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

        // 4. Insertar en DB
        const result = await pool.query(
            `INSERT INTO api_keys (emisor_id, key_hash, key_prefix, nombre) 
             VALUES ($1, $2, $3, $4) 
             RETURNING id, created_at`,
            [emisor_id, keyHash, prefix, nombreLimpio]
        );

        res.status(201).json({
            ok: true,
            mensaje: "¡Guarda tu API Key en un lugar seguro! No podrás verla de nuevo.",
            key_id: result.rows[0].id,
            api_key: rawKey,
            created_at: result.rows[0].created_at
        });

    } catch (error) {
        console.error("[Create API Key Error]", error);
        
        // Manejo de error por si falla la constraint de la DB
        if (error.code === '23505') {
            return res.status(400).json({ ok: false, mensaje: "Ya existe una llave activa con ese nombre." });
        }

        res.status(500).json({ ok: false, error: "No se pudo generar la llave" });
    }
});


/**
 * @openapi
 * /keys/{id}:
 *   delete:
 *     summary: Revocar una API key
 *     description: |
 *       Marca una API key como revocada. La operación es irreversible —
 *       una key revocada no puede reactivarse. Solo el emisor propietario
 *       de la key puede revocarla.
 *     tags:
 *       - API Keys
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *           example: 5
 *         description: "ID de la API key a revocar."
 *     responses:
 *       200:
 *         description: API key revocada correctamente
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
 *                   example: "API Key revocada exitosamente. Ya no podrá ser utilizada."
 *       401:
 *         description: Token de Firebase inválido o ausente
 *       404:
 *         description: La key no existe o no pertenece al emisor autenticado
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
 *                   example: "Llave no encontrada o no pertenece a tu usuario"
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
router.delete('/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `UPDATE api_keys 
             SET revoked = true
             WHERE id = $1 AND emisor_id = $2 
             RETURNING id`,
            [id, req.emisor_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ ok: false, mensaje: "Llave no encontrada o no pertenece a tu usuario" });
        }

        res.json({ ok: true, mensaje: "API Key revocada exitosamente. Ya no podrá ser utilizada." });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

module.exports = router;