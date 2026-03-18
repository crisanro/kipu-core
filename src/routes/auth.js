const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');
const authController = require("../utils/controllers");
const { minioClient } = require('../services/storageService');
const admin = require('../config/firebase');


/**
 * @openapi
 * /auth/send-verification:
 *   post:
 *     summary: Reenviar correo de verificación
 *     description: Genera un link de verificación con Firebase y lo envía al correo del usuario autenticado.
 *     tags: [Autenticación]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Correo enviado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Correo de verificación enviado"
 *       401:
 *         description: Token inválido o no enviado
 *       500:
 *         description: Error enviando el correo
 */
router.post("/send-verification", authMiddleware, authController.sendVerification);


/**
 * @openapi
 * /auth/reset:
 *   post:
 *     summary: Enviar correo de recuperación de contraseña
 *     description: Genera un link de reset con Firebase y lo envía al correo indicado. No requiere sesión activa.
 *     tags: [Autenticación]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 example: "usuario@ejemplo.com"
 *     responses:
 *       200:
 *         description: Correo enviado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Correo de recuperación enviado"
 *       400:
 *         description: Email no proporcionado
 *       500:
 *         description: Error enviando el correo
 */
router.post("/reset", authController.sendResetPassword);


/**
 * @openapi
 * /auth/nuke:
 *   delete:
 *     summary: Eliminar cuenta completamente
 *     description: |
 *       Borra de forma permanente e irreversible todos los datos del emisor autenticado.
 *       El proceso elimina en orden:
 *       1. Guarda un registro en `leads_ex_usuarios` antes de borrar.
 *       2. Borra en cascada manual: logs, transacciones, facturas, API keys,
 *          puntos de emisión, establecimientos, créditos y perfil.
 *       3. Elimina todos los archivos del emisor en MinIO (XMLs, PDFs y P12).
 *       4. Elimina el usuario de Firebase Auth.
 *
 *       **Esta operación no tiene vuelta atrás.**
 *     tags:
 *       - Emisor
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cuenta eliminada completamente
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
 *                   example: "Cuenta eliminada completamente. Datos borrados de DB, S3 y Firebase."
 *       400:
 *         description: El token no tiene un emisor vinculado
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
 *                   example: "No hay un emisor vinculado para borrar."
 *       401:
 *         description: Token de Firebase inválido o ausente
 *       500:
 *         description: Error crítico durante el proceso de eliminación. La transacción se revierte pero los archivos de MinIO o Firebase pueden haber quedado en estado inconsistente.
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
 *                   example: "Error en el proceso de eliminación."
 */
router.delete('/nuke', authMiddleware, async (req, res) => {
    const emisor_id = req.emisor_id; // Puede ser null si no hizo onboarding
    const firebase_uid = req.user.uid;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ── BLOQUE EMISOR (solo si hizo onboarding) ──────────────────────────
        if (emisor_id) {
            // 1. Guardar en leads antes de borrar
            const infoRes = await client.query(`
                SELECT 
                    e.ruc, e.razon_social, e.created_at as fecha_reg,
                    p.full_name, p.email,
                    c.balance,
                    (SELECT COUNT(*) FROM invoices WHERE emisor_id = e.id) as total_facturas
                FROM emisores e
                LEFT JOIN profiles p ON p.emisor_id = e.id
                LEFT JOIN user_credits c ON c.emisor_id = e.id
                WHERE e.id = $1
            `, [emisor_id]);

            const info = infoRes.rows[0];

            if (info) {
                await client.query(`
                    INSERT INTO leads_ex_usuarios 
                    (ruc, razon_social, email, full_name, ultimo_balance, total_facturas_emitidas, fecha_registro_original)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [info.ruc, info.razon_social, info.email, info.full_name, 
                    info.balance, info.total_facturas, info.fecha_reg]);

                // 2. Limpiar archivos en MinIO (silencioso si no hay nada)
                try {
                    const objectsList = [];
                    const stream = minioClient.listObjectsV2('invoices', info.ruc, true);
                    for await (const obj of stream) objectsList.push(obj.name);
                    if (objectsList.length > 0) {
                        await minioClient.removeObjects('invoices', objectsList);
                    }
                } catch (minioErr) {
                    console.warn('⚠️ MinIO cleanup omitido:', minioErr.message);
                }

                // 3. Borrar P12 si existe
                try {
                    if (info.p12_path) {
                        const [p12Bucket, ...p12Path] = info.p12_path.split('/');
                        await minioClient.removeObject(p12Bucket, p12Path.join('/'));
                    }
                } catch (p12Err) {
                    console.warn('⚠️ P12 cleanup omitido:', p12Err.message);
                }
            }

            // 4. Borrado en cascada en DB
            await client.query('DELETE FROM transaction_logs WHERE target_emisor_id = $1', [emisor_id]);
            await client.query('DELETE FROM credit_transactions WHERE emisor_id = $1', [emisor_id]);
            await client.query('DELETE FROM invoices WHERE emisor_id = $1', [emisor_id]);
            await client.query('DELETE FROM api_keys WHERE emisor_id = $1', [emisor_id]);
            await client.query(`
                DELETE FROM puntos_emision 
                WHERE establecimiento_id IN (SELECT id FROM establecimientos WHERE emisor_id = $1)
            `, [emisor_id]);
            await client.query('DELETE FROM establecimientos WHERE emisor_id = $1', [emisor_id]);
            await client.query('DELETE FROM user_credits WHERE emisor_id = $1', [emisor_id]);
        }

        // ── SIEMPRE SE EJECUTA ────────────────────────────────────────────────
        // 5. Borrar perfil (existe aunque no haya emisor)
        await client.query('DELETE FROM profiles WHERE firebase_uid = $1', [firebase_uid]);

        // 6. Eliminar de Firebase Auth
        await admin.auth().deleteUser(firebase_uid);

        await client.query('COMMIT');

        res.json({ 
            ok: true, 
            mensaje: "Cuenta eliminada completamente." 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("CRITICAL ERROR EN BORRADO TOTAL:", error);
        res.status(500).json({ ok: false, error: "Error en el proceso de eliminación." });
    } finally {
        client.release();
    }
});


/**
 * @openapi
 * /auth/verify-pin:
 *   post:
 *     summary: Verificar PIN y ejecutar acción asociada
 *     description: |
 *       Valida el PIN ingresado y ejecuta automáticamente la acción vinculada al challenge.
 *       El PIN se consume al verificarse — no puede usarse dos veces.
 *       La operación es transaccional: si la acción falla, el PIN no se consume.
 *
 *       Acciones disponibles según `tipo_accion`:
 *       - `VALIDAR_WS` — Vincula el número de WhatsApp al perfil del usuario.
 *       - `CREAR_TOKEN` — Autoriza la creación de una API Key con el nombre en `metadata.nombre`.
 *       - `ELIMINAR_TOKEN` — Revoca la API Key indicada en `metadata.key_id`.
 *       - `ELIMINAR_CUENTA` — Marca el inicio del proceso de borrado total.
 *       - Cualquier otro valor — Validación genérica sin efecto en BD.
 *     tags:
 *       - Integraciones
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pin
 *             properties:
 *               pin:
 *                 type: string
 *                 description: "PIN de 6 dígitos recibido por WhatsApp."
 *                 example: "482719"
 *     responses:
 *       200:
 *         description: PIN validado y acción ejecutada correctamente
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
 *                   example: "Validación exitosa."
 *                 tipo_accion:
 *                   type: string
 *                   description: "Acción que fue ejecutada con este PIN."
 *                   example: "ELIMINAR_TOKEN"
 *                 data_ejecutada:
 *                   type: object
 *                   description: "Metadata del challenge que fue procesado."
 *                   example: { "key_id": 5 }
 *       400:
 *         description: PIN incorrecto o expirado
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
 *                   example: "PIN incorrecto o expirado."
 *       401:
 *         description: Token de Firebase inválido o ausente
 *       500:
 *         description: Error interno del servidor. La transacción se revierte y el PIN no se consume.
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
 *                   example: "ID de token no proporcionado en el desafío."
 */
router.post('/verify-pin', authMiddleware, async (req, res) => {
    const { pin } = req.body;
    const email = req.user.email; // Proveniente de Firebase
    const emisor_id = req.emisor_id; // Proveniente de tu middleware

    if (!pin || pin.length !== 6) {
        return res.status(400).json({ ok: false, mensaje: "El PIN de 6 dígitos es obligatorio." });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Buscar el desafío activo en auth_challenges
        // Usamos FOR UPDATE para bloquear la fila y evitar doble validación simultánea
        const result = await client.query(`
            SELECT id, whatsapp_number, tipo_accion, metadata, emisor_id 
            FROM auth_challenges 
            WHERE LOWER(email) = LOWER($1) 
              AND pin = $2 
              AND expires_at > NOW()
            FOR UPDATE
        `, [email, pin.toString()]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ ok: false, mensaje: "PIN incorrecto o expirado." });
        }

        const challenge = result.rows[0];

        // 2. Switch de acciones basado en tipo_accion
        switch (challenge.tipo_accion) {
            
            case 'VALIDACION_GENERAL': // Caso detectado en tu DB
            case 'VALIDAR_WS':
                // Si hay un número en el challenge, lo movemos al perfil del usuario
                if (challenge.whatsapp_number) {
                    await client.query(`
                        UPDATE profiles 
                        SET whatsapp_number = $1 
                        WHERE LOWER(email) = LOWER($2)
                    `, [challenge.whatsapp_number, email.toLowerCase()]);
                    
                    console.log(`✅ WhatsApp ${challenge.whatsapp_number} vinculado a ${email}`);
                }
                break;

            case 'ELIMINAR_TOKEN':
                if (challenge.metadata && challenge.metadata.key_id) {
                    await client.query(`
                        UPDATE api_keys 
                        SET revoked = true, revoked_at = NOW()
                        WHERE id = $1 AND emisor_id = $2
                    `, [challenge.metadata.key_id, emisor_id]);
                    
                    console.log(`🚫 Token ${challenge.metadata.key_id} revocado.`);
                }
                break;

            // Puedes añadir más casos como 'CREAR_TOKEN' aquí
        }

        // 3. Borrar el PIN de la tabla auth_challenges para que no se use de nuevo
        await client.query('DELETE FROM auth_challenges WHERE id = $1', [challenge.id]);

        await client.query('COMMIT');

        res.json({ 
            ok: true, 
            mensaje: "Validación exitosa.",
            accion_ejecutada: challenge.tipo_accion,
            whatsapp_registrado: challenge.whatsapp_number || null
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error crítico en verify-pin:", error);
        res.status(500).json({ ok: false, error: "Error interno al procesar la validación." });
    } finally {
        // Siempre liberar el cliente del pool
        client.release();
    }
});

module.exports = router;
