const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');
const { encrypt } = require('../utils/cryptoUtils');
const { validarP12 } = require('../services/signer');
const { uploadFile, deleteFile } = require('../services/storageService');


/**
 * @openapi
 * /emitter/onboarding:
 *   post:
 *     summary: Registro inicial del emisor (RUC y datos legales)
 *     description: Crea la identidad fiscal del emisor, vincula el perfil Firebase y asigna 10 créditos de cortesía. Debe ejecutarse antes de crear establecimientos.
 *     tags:
 *       - Emisor
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
 *               - obligado_contabilidad
 *               - contribuyente_especial
 *             properties:
 *               ruc:
 *                 type: string
 *                 pattern: '^\d{13}$'
 *                 example: "1792146739001"
 *               razon_social:
 *                 type: string
 *                 example: "ACME S.A."
 *               nombre_comercial:
 *                 type: string
 *                 nullable: true
 *                 example: "ACME"
 *               direccion_matriz:
 *                 type: string
 *                 example: "Av. República del Salvador N34-183, Quito"
 *               obligado_contabilidad:
 *                 type: string
 *                 enum: [SI, NO]
 *                 example: "SI"
 *               contribuyente_especial:
 *                 type: string
 *                 nullable: true
 *                 description: "Número de resolución del contribuyente especial. Null si no aplica."
 *                 example: "12345"
 *     responses:
 *       200:
 *         description: Emisor registrado correctamente
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
 *                   example: "Identidad fiscal registrada. Por favor, configura tu primer establecimiento."
 *                 emisor_id:
 *                   type: integer
 *                   example: 42
 *       400:
 *         description: RUC inválido o ya registrado
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
 *                   example: "Este RUC ya se encuentra registrado en el sistema."
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
 *                   example: "Error al registrar la empresa."
 */
router.post('/onboarding', authMiddleware, async (req, res) => {
    const { 
        ruc, 
        razon_social, 
        nombre_comercial, 
        direccion_matriz, 
        obligado_contabilidad, 
        contribuyente_especial,
        full_name // Agregamos el nombre para el perfil
    } = req.body;
    
    // Validación de RUC
    if (!/^\d{13}$/.test(ruc)) {
        return res.status(400).json({ ok: false, mensaje: "El RUC debe tener 13 dígitos numéricos." });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Crear el emisor (Identidad Fiscal)
        const emisorRes = await client.query(
            `INSERT INTO emisores (ruc, razon_social, nombre_comercial, direccion_matriz, obligado_contabilidad, contribuyente_especial, ambiente)
             VALUES ($1, $2, $3, $4, $5, $6, 1) RETURNING id`,
            [ruc, razon_social, nombre_comercial, direccion_matriz, obligado_contabilidad, contribuyente_especial]
        );
        const newEmisorId = emisorRes.rows[0].id;

        // 2. CREAR el perfil (Aquí es donde estaba el error antes)
        // Usamos el UID y el Email que el authMiddleware ya validó desde Firebase
        await client.query(
            `INSERT INTO profiles (firebase_uid, emisor_id, email, full_name, role)
             VALUES ($1, $2, $3, $4, 'admin')`,
            [req.user.uid, newEmisorId, req.user.email, full_name]
        );

        // 3. Inicializar créditos
        await client.query(
            `INSERT INTO user_credits (emisor_id, balance, last_updated) 
             VALUES ($1, 10, NOW())`,
            [newEmisorId]
        );
        
        // 4. Registrar la transacción en el historial
        await client.query(
            `INSERT INTO credit_transactions (emisor_id, tipo, cantidad, precio_total, metodo_pago, notas)
             VALUES ($1, 'BONO', 10, 0.00, 'SISTEMA', 'Créditos iniciales de bienvenida')`,
            [newEmisorId]
        );
        
        await client.query('COMMIT');

        res.json({ 
            ok: true, 
            mensaje: "Perfil y empresa registrados con éxito.", 
            emisor_id: newEmisorId 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("[Onboarding Error]:", error);
        
        if (error.code === '23505') { 
            const detail = error.detail.includes('ruc') ? "El RUC" : "El usuario";
            return res.status(400).json({ ok: false, mensaje: `${detail} ya se encuentra registrado.` });
        }
        
        res.status(500).json({ ok: false, error: "Error en el registro inicial." });
    } finally {
        client.release();
    }
});


// Configuración de Multer para recibir el P12 en memoria
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 } // Límite de 2MB para el certificado
});

/**
 * @openapi
 * /emitter/upload-p12:
 *   post:
 *     summary: Subir y vincular certificado de firma electrónica (P12)
 *     description: |
 *       Recibe el archivo P12 y su contraseña, valida que el RUC del certificado
 *       coincida con el emisor, lo sube a MinIO y almacena la contraseña encriptada.
 *       Si ya existía un certificado previo, lo elimina antes de subir el nuevo.
 *     tags:
 *       - Emisor
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *               - password
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: "Archivo de certificado P12 emitido por el BCE."
 *               password:
 *                 type: string
 *                 description: "Contraseña del certificado P12."
 *                 example: "mi_password_seguro"
 *     responses:
 *       200:
 *         description: Certificado vinculado correctamente
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
 *                   example: "Firma electrónica vinculada correctamente."
 *                 vencimiento:
 *                   type: string
 *                   format: date-time
 *                   description: "Fecha de expiración del certificado extraída del P12."
 *                   example: "2026-08-15T00:00:00.000Z"
 *       400:
 *         description: Archivo o contraseña faltantes, o certificado inválido (RUC no coincide, P12 corrupto, etc.)
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
 *                   example: "Archivo P12 y contraseña son requeridos."
 *       401:
 *         description: Token de Firebase inválido o ausente
 *       500:
 *         description: Error interno al procesar el certificado
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
 *                   example: "Error al procesar el certificado."
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
 * /emitter/config:
 *   get:
 *     summary: Obtener configuración completa del emisor
 *     description: |
 *       Retorna los datos legales y el estado de la firma electrónica del emisor autenticado.
 *       Si el token no tiene un emisor vinculado (onboarding pendiente), responde con
 *       `configurado: false` en lugar de un error, para que el frontend pueda redirigir
 *       al flujo de registro sin romper la experiencia.
 *     tags:
 *       - Emisor
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Configuración del emisor o indicador de onboarding pendiente
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - description: "Usuario sin onboarding completado"
 *                   type: object
 *                   properties:
 *                     ok:
 *                       type: boolean
 *                       example: true
 *                     configurado:
 *                       type: boolean
 *                       example: false
 *                     mensaje:
 *                       type: string
 *                       example: "Pendiente de configuración inicial (Onboarding)."
 *                 - description: "Emisor configurado"
 *                   type: object
 *                   properties:
 *                     ok:
 *                       type: boolean
 *                       example: true
 *                     configurado:
 *                       type: boolean
 *                       example: true
 *                     data:
 *                       type: object
 *                       properties:
 *                         legal:
 *                           type: object
 *                           properties:
 *                             ruc:
 *                               type: string
 *                               example: "1792146739001"
 *                             razon_social:
 *                               type: string
 *                               example: "ACME S.A."
 *                             nombre_comercial:
 *                               type: string
 *                               nullable: true
 *                               example: "ACME"
 *                             direccion_matriz:
 *                               type: string
 *                               example: "Av. República del Salvador N34-183, Quito"
 *                             contribuyente_especial:
 *                               type: string
 *                               nullable: true
 *                               description: "Número de resolución del contribuyente especial. Null si no aplica."
 *                               example: "12345"
 *                             obligado_contabilidad:
 *                               type: string
 *                               enum: [SI, NO]
 *                               example: "SI"
 *                             ambiente:
 *                               type: string
 *                               enum: [PRUEBAS, PRODUCCION]
 *                               example: "PRUEBAS"
 *                             fecha_registro:
 *                               type: string
 *                               format: date-time
 *                               example: "2024-01-15T10:30:00.000Z"
 *                         firma:
 *                           type: object
 *                           properties:
 *                             configurada:
 *                               type: boolean
 *                               description: "true si tiene un certificado P12 subido."
 *                               example: true
 *                             expiracion:
 *                               type: string
 *                               format: date-time
 *                               nullable: true
 *                               example: "2026-08-15T00:00:00.000Z"
 *                             dias_restantes:
 *                               type: integer
 *                               nullable: true
 *                               description: "Días hasta la expiración. Negativo si ya expiró. Null si no hay P12."
 *                               example: 245
 *                             estado:
 *                               type: string
 *                               enum: [PENDIENTE, VIGENTE, EXPIRADA]
 *                               description: "PENDIENTE si no hay P12, VIGENTE si no ha expirado, EXPIRADA si ya venció."
 *                               example: "VIGENTE"
 *       401:
 *         description: Token de Firebase inválido o ausente
 *       404:
 *         description: Emisor no encontrado en la base de datos
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
 *                   example: "Emisor no encontrado en la base de datos."
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
 *                   example: "Error al cargar la configuración del emisor."
 */
router.get('/config', authMiddleware, async (req, res) => {
    const emisor_id = req.emisor_id;

    if (!emisor_id) {
        return res.json({ 
            ok: true, 
            configurado: false, 
            mensaje: "Pendiente de configuración inicial (Onboarding)." 
        });
    }

    try {
        const result = await pool.query(
            `SELECT 
                ruc, razon_social, nombre_comercial, direccion_matriz, 
                contribuyente_especial, obligado_contabilidad, ambiente,
                p12_path, p12_expiration,
                created_at
             FROM emisores 
             WHERE id = $1`,
            [emisor_id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ ok: false, mensaje: "Emisor no encontrado en la base de datos." });
        }

        const data = result.rows[0];

        // --- Lógica de la Firma Electrónica ---
        const hoy = new Date();
        const expiracion = data.p12_expiration ? new Date(data.p12_expiration) : null;
        
        // Extraer nombre del archivo de la ruta (ej: "bucket/ruc/firma.p12" -> "firma.p12")
        const nombreFirma = data.p12_path ? data.p12_path.split('/').pop() : 'No configurada';

        let firma_info = {
            configurada: !!data.p12_path,
            nombre: nombreFirma,
            expiracion: data.p12_expiration,
            estado: 'PENDIENTE', 
            mensaje_vencimiento: 'Firma no cargada'
        };

        if (expiracion) {
            const diffTime = expiracion - hoy;
            const diasRestantes = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            // Formatear fecha para el mensaje (ej: 31 de dic de 2026)
            const opcionesFecha = { day: 'numeric', month: 'short', year: 'numeric' };
            const fechaFormateada = expiracion.toLocaleDateString('es-EC', opcionesFecha);

            if (diasRestantes <= 0) {
                firma_info.estado = 'EXPIRADA';
                firma_info.mensaje_vencimiento = `Expirada el ${fechaFormateada}`;
            } else if (diasRestantes <= 60) {
                firma_info.estado = 'ALERTA'; // Cambiamos a alerta si faltan 60 días o menos
                firma_info.mensaje_vencimiento = `Expira en ${diasRestantes} días`;
            } else {
                firma_info.estado = 'VIGENTE';
                firma_info.mensaje_vencimiento = `Vigente hasta el ${fechaFormateada}`;
            }
        }

        // --- Respuesta Final ---
        res.json({
            ok: true,
            configurado: true,
            data: {
                legal: {
                    ruc: data.ruc,
                    razon_social: data.razon_social,
                    nombre_comercial: data.nombre_comercial,
                    direccion_matriz: data.direccion_matriz,
                    contribuyente_especial: data.contribuyente_especial,
                    obligado_contabilidad: data.obligado_contabilidad,
                    ambiente: data.ambiente === 1 ? 'PRUEBAS' : 'PRODUCCION',
                    fecha_registro: data.created_at
                },
                firma: firma_info
            }
        });

    } catch (error) {
        console.error("Error al obtener configuración:", error);
        res.status(500).json({ ok: false, error: "Error al cargar la configuración del emisor." });
    }
});





/**
 * @openapi
 * /emitter/profile:
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
 * /emitter/config:
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
