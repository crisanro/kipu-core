const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');
const { encrypt } = require('../utils/cryptoUtils');
const { validarP12 } = require('../services/signer');
const { uploadFile, deleteFile } = require('../services/storageService');

// Configuración de Multer para recibir el P12 en memoria
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 } // Límite de 2MB para el certificado
});

/**
 * @openapi
 * /api/emitter/profile:
 *   get:
 *     summary: Obtener datos del perfil del emisor
 *     tags: [Emitter]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Datos del emisor obtenidos correctamente
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
 *                     ruc:
 *                       type: string
 *                     razon_social:
 *                       type: string
 *                     nombre_comercial:
 *                       type: string
 *                     direccion_matriz:
 *                       type: string
 *                     ambiente:
 *                       type: string
 *                     p12_path:
 *                       type: string
 *                     p12_expiration:
 *                       type: string
 *       404:
 *         description: Emisor no encontrado
 *       500:
 *         description: Error interno del servidor
 */
router.get('/profile', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT ruc, razon_social, nombre_comercial, direccion_matriz, 
                    ambiente, p12_path, p12_expiration 
             FROM emisores WHERE id = $1`,
            [req.emisor_id]
        );
        
        if (result.rowCount === 0) return res.status(404).json({ ok: false, mensaje: "Emisor no encontrado" });
        
        res.json({ ok: true, data: result.rows[0] });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/**
 * @openapi
 * /api/emitter/upload-p12:
 *   post:
 *     summary: Subir y vincular firma electrónica P12
 *     tags: [Emitter]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file, password]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Archivo de firma electrónica .p12
 *               password:
 *                 type: string
 *                 description: Contraseña del certificado P12
 *     responses:
 *       200:
 *         description: Firma electrónica vinculada correctamente
 *       400:
 *         description: Archivo o contraseña faltante, o certificado inválido
 *       500:
 *         description: Error al procesar el certificado
 */
router.post('/upload-p12', authMiddleware, upload.single('file'), async (req, res) => {
    const { password } = req.body;
    const emisorId = req.emisor_id;

    if (!req.file || !password) {
        return res.status(400).json({ ok: false, mensaje: "Archivo P12 y contraseña son requeridos." });
    }

    try {
        const emisorRes = await pool.query('SELECT ruc, p12_path FROM emisores WHERE id = $1', [emisorId]);
        const emisor = emisorRes.rows[0];

        // 2. VALIDACIÓN: Extraemos la expiración del certificado
        const val = validarP12(req.file.buffer, password, emisor.ruc);
        if (!val.ok) return res.status(400).json(val);

        // 3. Limpieza en MinIO si ya existe uno
        if (emisor.p12_path) {
            const [bucket, ...pathParts] = emisor.p12_path.split('/');
            await deleteFile(bucket, pathParts.join('/')).catch(() => {});
        }

        // 4. Subir a MinIO
        const fileName = `${emisor.ruc}/certificate_${Date.now()}.p12`;
        const p12Path = await uploadFile('certificates', fileName, req.file.buffer, 'application/x-pkcs12');

        // 5. Encriptar contraseña
        const passwordEnc = encrypt(password);
        
        // 6. ACTUALIZACIÓN: Aquí nos aseguramos de que val.expiration tenga la fecha
        await pool.query(
            `UPDATE emisores SET 
                p12_path = $1, 
                p12_pass = $2, 
                p12_expiration = $3, 
                updated_at = NOW()
             WHERE id = $4`,
            [p12Path, passwordEnc, val.expiration, emisorId] // $3 es la fecha de vencimiento
        );

        res.json({ 
            ok: true, 
            mensaje: "Firma electrónica vinculada correctamente.",
            vencimiento: val.expiration // Devolvemos la fecha al frontend para mostrarla
        });

    } catch (error) {
        console.error("[P12 Upload Error]", error.message);
        res.status(500).json({ ok: false, error: "Error al procesar el certificado." });
    }
});

/**
 * @openapi
 * /api/emitter/config:
 *   patch:
 *     summary: Actualizar configuración del emisor
 *     tags: [Emitter]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ambiente:
 *                 type: string
 *                 enum: ['1', '2']
 *                 description: "1: Pruebas, 2: Producción"
 *               nombre_comercial:
 *                 type: string
 *               direccion_matriz:
 *                 type: string
 *     responses:
 *       200:
 *         description: Configuración actualizada correctamente
 *       500:
 *         description: Error interno del servidor
 */
router.patch('/config', authMiddleware, async (req, res) => {
    const { ambiente, nombre_comercial, direccion_matriz } = req.body;
    
    try {
        await pool.query(
            `UPDATE emisores SET 
                ambiente = COALESCE($1, ambiente),
                nombre_comercial = COALESCE($2, nombre_comercial),
                direccion_matriz = COALESCE($3, direccion_matriz)
             WHERE id = $4`,
            [ambiente, nombre_comercial, direccion_matriz, req.emisor_id]
        );
        res.json({ ok: true, mensaje: "Configuración actualizada." });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

module.exports = router;