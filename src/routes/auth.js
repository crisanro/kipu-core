const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');

/**
 * @openapi
 * /auth/sync:
 *  post:
 *      summary: Sincronizar usuario de Firebase (Paso 1 del Registro)
 *      description: Guarda el UID y correo en la tabla profiles. No pide RUC.
 *      tags: [Autenticación]
 *      security:
 *          - bearerAuth: []
 *      responses:
 *          200:
 *              description: Perfil sincronizado. Indica si necesita completar el RUC.
 */
router.post('/sync', authMiddleware, async (req, res) => {
    // Gracias al authMiddleware, req.user siempre trae el uid y email validados por Firebase
    const { uid, email } = req.user; 

    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // 1. Insertamos el perfil. Si ya existe (porque hizo login de nuevo), no hace nada.
        await client.query(`
            INSERT INTO profiles (id, email, role) 
            VALUES ($1, $2, 'admin')
            ON CONFLICT (id) DO NOTHING
        `, [uid, email]);

        await client.query('COMMIT');

        // 2. Verificamos si este usuario ya tiene una empresa (emisor_id) vinculada
        const profileRes = await pool.query('SELECT emisor_id FROM profiles WHERE id = $1', [uid]);
        const emisorId = profileRes.rows[0].emisor_id;

        // 3. Le respondemos al frontend diciéndole qué pantalla debe mostrar
        res.status(200).json({ 
            ok: true, 
            mensaje: "Perfil sincronizado correctamente.",
            // Esta variable es ORO para tu frontend:
            requireOnboarding: emisorId === null 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en sync:', error);
        res.status(500).json({ ok: false, error: 'Error al sincronizar el perfil' });
    } finally {
        client.release();
    }
});

/**
 * @openapi
 * /auth/activar-ruc:
 *   post:
 *     summary: Activar cuenta de facturación (Onboarding Paso 2)
 *     description: Registra la empresa, crea el establecimiento 001 y punto de emisión 100, y lo vincula al usuario de Firebase.
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ruc
 *               - razon_social
 *               - direccion_matriz
 *             properties:
 *               ruc:
 *                 type: string
 *                 example: "1712345678001"
 *               razon_social:
 *                 type: string
 *                 example: "EMPRESA DE PRUEBA S.A."
 *               nombre_comercial:
 *                 type: string
 *                 example: "Mi Tienda"
 *               direccion_matriz:
 *                 type: string
 *                 example: "Av. Siempre Viva 123"
 *               contribuyente_especial:
 *                 type: string
 *                 example: "5368"
 *               obligado_contabilidad:
 *                 type: string
 *                 example: "SI"
 *     responses:
 *       201:
 *         description: Empresa activada exitosamente
 */
router.post('/activar-ruc', authMiddleware, async (req, res) => {
    // NOTA: req.user vendrá de nuestro middleware de Firebase (lo configuraremos en el siguiente paso)
    // Por ahora, simularemos que ya lo tenemos para que veas la lógica.
    const uid = req.user.uid; 
    const email = req.user.email;

    const { 
        ruc, 
        razon_social, 
        nombre_comercial, 
        direccion_matriz, 
        contribuyente_especial, 
        obligado_contabilidad 
    } = req.body;

    // Validación básica
    if (!ruc || ruc.length !== 13) return res.status(400).json({ error: 'El RUC debe tener 13 dígitos.' });
    if (!razon_social || !direccion_matriz) return res.status(400).json({ error: 'Razón Social y Dirección son obligatorias.' });

    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Inicia la transacción

        // 1. Verificar si el RUC ya existe para evitar errores
        const rucCheck = await client.query('SELECT id FROM emisores WHERE ruc = $1', [ruc]);
        if (rucCheck.rowCount > 0) {
            return res.status(409).json({ error: 'Este RUC ya está registrado en el sistema.' });
        }

        // 2. Crear la Empresa (Emisor)
        const emisorResult = await client.query(
            `INSERT INTO emisores 
            (ruc, razon_social, nombre_comercial, direccion_matriz, contribuyente_especial, obligado_contabilidad) 
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [ruc, razon_social, nombre_comercial, direccion_matriz, contribuyente_especial, obligado_contabilidad || 'NO']
        );
        const emisorId = emisorResult.rows[0].id;

        // 3. Crear Local Principal (001) y Caja (100) obligatorios para el SRI
        const localResult = await client.query(
            `INSERT INTO establecimientos (emisor_id, codigo, nombre_comercial, direccion) 
             VALUES ($1, '001', 'Matriz', $2) RETURNING id`,
            [emisorId, direccion_matriz]
        );
        const localId = localResult.rows[0].id;

        await client.query(
            `INSERT INTO puntos_emision (establecimiento_id, codigo, secuencial_actual) 
             VALUES ($1, '100', 0)`,
            [localId]
        );

        // 4. Crear el Perfil del usuario y vincularlo a la empresa
        // Usamos UPSERT (ON CONFLICT) por si el usuario ya se había guardado antes sin empresa
        await client.query(
            `INSERT INTO profiles (id, emisor_id, email, role) 
             VALUES ($1, $2, $3, 'admin')
             ON CONFLICT (id) DO UPDATE SET emisor_id = EXCLUDED.emisor_id`,
            [uid, emisorId, email]
        );

        // 5. Regalar 50 facturas de cortesía (Opcional, genial para marketing)
        await client.query(
            `INSERT INTO user_credits (emisor_id, balance) VALUES ($1, 50)`,
            [emisorId]
        );

        await client.query('COMMIT'); // Guarda todos los cambios juntos
        res.status(201).json({ message: 'RUC activado exitosamente. Ya puedes facturar.', emisorId });

    } catch (error) {
        await client.query('ROLLBACK'); // Si algo falla, cancela todo para no dejar datos a medias
        console.error('Error activando RUC:', error.message);
        res.status(500).json({ error: 'Ocurrió un error al activar la cuenta.' });
    } finally {
        client.release();
    }
});


module.exports = router;
