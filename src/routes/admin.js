const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { serviceAuth , whatsappServiceAuth } = require('../middlewares/serviceAuth');
const { emitirFacturaCore } = require('../utils/calculadoraSri');

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
    const emailFmt = email.toLowerCase().trim();

    try {
        // 1. Verificar si el usuario existe
        const userRes = await pool.query(
            'SELECT emisor_id FROM profiles WHERE email = $1', 
            [emailFmt]
        );

        if (userRes.rowCount === 0) {
            return res.status(404).json({ ok: false, mensaje: "Email no registrado." });
        }

        const emisor_id = userRes.rows[0].emisor_id;

        // 2. CONTROL DE FRECUENCIA (Anti-Spam)
        // Verificamos si ya existe un PIN creado hace menos de 60 segundos
        const recentCheck = await pool.query(
            `SELECT created_at FROM auth_challenges 
             WHERE email = $1 AND created_at > NOW() - INTERVAL '1 minute'`,
            [emailFmt]
        );

        if (recentCheck.rowCount > 0) {
            return res.status(429).json({ 
                ok: false, 
                mensaje: "Demasiadas solicitudes. Por favor, espera 60 segundos para pedir un nuevo código." 
            });
        }

        // 3. VALIDACIÓN DE TELÉFONO ÚNICO (Si es para vincular)
        if (tipo_accion === 'VALIDAR_WS') {
            const phoneCheck = await pool.query(
                'SELECT email FROM profiles WHERE whatsapp_number = $1 AND email != $2',
                [whatsapp_number, emailFmt]
            );
            if (phoneCheck.rowCount > 0) {
                return res.status(409).json({ ok: false, mensaje: "Este número ya está vinculado a otra cuenta." });
            }
        }

        // 4. ELIMINAR CUALQUER SOLICITUD PREVIA (Garantiza UN SOLO PIN a la vez)
        // No importa si era de hace 2 o 9 minutos, si pide uno nuevo, el anterior muere.
        await pool.query(
            'DELETE FROM auth_challenges WHERE email = $1 OR whatsapp_number = $2', 
            [emailFmt, whatsapp_number]
        );

        // 5. Generar nuevo PIN
        const pin = Math.floor(100000 + Math.random() * 900000).toString();
        const expires_at = new Date(Date.now() + 10 * 60000); // 10 min

        await pool.query(`
            INSERT INTO auth_challenges (emisor_id, email, whatsapp_number, pin, tipo_accion, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [emisor_id, emailFmt, whatsapp_number, pin, tipo_accion || 'VALIDACION_GENERAL', expires_at]);

        res.status(201).json({ 
            ok: true, 
            pin, 
            mensaje: "PIN generado. El anterior (si existía) ha sido invalidado." 
        });

    } catch (error) {
        console.error("Error en request-pin:", error);
        res.status(500).json({ ok: false, error: "Error interno del servidor." });
    }
});


/**
 * @openapi
 * /admin/check-status:
 *   get:
 *     summary: Verificar estado de cuenta por número de WhatsApp
 *     description: |
 *       Consulta el estado de una cuenta Kipu a partir del número de WhatsApp.
 *       Devuelve siempre un `mensaje_cliente` listo para enviar directamente al usuario por WhatsApp.
 *       Usado por n8n para validar si un número puede facturar antes de iniciar el flujo.
 *       Requiere autenticación de servicio (`serviceAuth`).
 *     tags:
 *       - Integraciones
 *     security:
 *       - n8nKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: whatsapp_number
 *         required: true
 *         schema:
 *           type: string
 *           example: "593987654321"
 *         description: "Número de WhatsApp a consultar."
 *     responses:
 *       200:
 *         description: |
 *           Respuesta en todos los casos exitosos. El campo `ok` indica si el usuario existe,
 *           `has_credits` indica si puede facturar. Ver los tres escenarios posibles.
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - description: "Número no vinculado a ninguna cuenta"
 *                   type: object
 *                   properties:
 *                     ok:
 *                       type: boolean
 *                       example: false
 *                     codigo_error:
 *                       type: string
 *                       example: "USER_NOT_FOUND"
 *                     mensaje_cliente:
 *                       type: string
 *                       example: "❌ Tu número no está vinculado a ninguna cuenta de Kipu. Por favor, regístrate o vincula tu WhatsApp desde la App."
 *                 - description: "Usuario existe pero sin créditos"
 *                   type: object
 *                   properties:
 *                     ok:
 *                       type: boolean
 *                       example: true
 *                     has_credits:
 *                       type: boolean
 *                       example: false
 *                     data:
 *                       type: object
 *                       properties:
 *                         nombre:
 *                           type: string
 *                           example: "Juan Pérez"
 *                         empresa:
 *                           type: string
 *                           example: "ACME S.A."
 *                     mensaje_cliente:
 *                       type: string
 *                       example: "⚠️ Hola Juan Pérez, no tienes créditos disponibles para facturar con ACME S.A."
 *                 - description: "Usuario listo para facturar"
 *                   type: object
 *                   properties:
 *                     ok:
 *                       type: boolean
 *                       example: true
 *                     has_credits:
 *                       type: boolean
 *                       example: true
 *                     data:
 *                       type: object
 *                       properties:
 *                         emisor_id:
 *                           type: integer
 *                           example: 42
 *                         nombre:
 *                           type: string
 *                           example: "Juan Pérez"
 *                         empresa:
 *                           type: string
 *                           example: "ACME S.A."
 *                         balance:
 *                           type: integer
 *                           example: 8
 *                     mensaje_cliente:
 *                       type: string
 *                       example: "✅ Hola Juan Pérez, estás listo para facturar con ACME S.A. Tienes 8 créditos disponibles."
 *       400:
 *         description: Número de WhatsApp no proporcionado
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
 *                   example: "Número de WhatsApp no proporcionado."
 *       401:
 *         description: Service key inválida o ausente
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
 *                 mensaje_cliente:
 *                   type: string
 *                   example: "❌ Ocurrió un error técnico al verificar tu cuenta. Intenta más tarde."
 */
router.get('/check-status', serviceAuth, async (req, res) => {
    const { whatsapp_number } = req.query;

    if (!whatsapp_number) {
        return res.status(400).json({ ok: false, mensaje: "Número de WhatsApp no proporcionado." });
    }

    try {
        // 1. Buscamos el emisor y sus créditos
        const query = `
            SELECT 
                p.email, 
                p.full_name, 
                e.id as emisor_id, 
                e.razon_social,
                e.ruc,
                c.balance
            FROM profiles p
            JOIN emisores e ON p.emisor_id = e.id
            JOIN user_credits c ON e.id = c.emisor_id
            WHERE p.whatsapp_number = $1
        `;
        
        const result = await pool.query(query, [whatsapp_number]);

        if (result.rowCount === 0) {
            return res.json({
                ok: false,
                codigo_error: 'USER_NOT_FOUND',
                mensaje_cliente: "❌ Tu número no está vinculado a ninguna cuenta de Kipu."
            });
        }

        const data = result.rows[0];

        // --- NUEVO CHECK: Punto de Emisión 001-194 ---
        const puntoEmisionQuery = `
            SELECT p.id 
            FROM puntos_emision p
            JOIN establecimientos e ON p.establecimiento_id = e.id
            WHERE e.emisor_id = $1 
              AND e.codigo = '001' 
              AND p.codigo = '333'
        `;
        const puntoRes = await pool.query(puntoEmisionQuery, [data.emisor_id]);

        if (puntoRes.rowCount === 0) {
            return res.json({
                ok: false,
                codigo_error: 'POINT_NOT_CONFIGURED',
                mensaje_cliente: `⚠️ Hola ${data.razon_social}, para facturar por WhatsApp debes tener habilitado el Establecimiento 001 - Punto de Emisión 333.\n\n Por favor, créalo en la configuración de establecimientos.`
            });
        }

        // 2. Check de Créditos
        if (parseInt(data.balance) <= 0) {
            return res.json({
                ok: true, 
                has_credits: false,
                data: { nombre: data.full_name, empresa: data.razon_social },
                codigo_error: 'USER_NOT_CREDITS',
                mensaje_cliente: `⚠️ Hola ${data.razon_social}, no tienes créditos disponibles.`
            });
        }

        // 3. Todo OK
        res.json({
            ok: true,
            has_credits: true,
            data: {
                emisor_id: data.emisor_id,
                nombre: data.full_name,
                empresa: data.razon_social,
                ruc: data.ruc,
                balance: data.balance,
                establecimiento: '001', // Ya sabemos que es este
                punto_emision: '194'    // Ya sabemos que es este
            },
            mensaje_cliente: `✅ Hola ${data.full_name}, estás listo para facturar (Punto 001-194). Tienes ${data.balance} créditos.`
        });

    } catch (error) {
        console.error("Error en check-status:", error);
        res.status(500).json({ ok: false, mensaje_cliente: "❌ Error técnico al verificar cuenta." });
    }
});


/**
 * @openapi
 * /admin/invoice-whatsapp:
 *   post:
 *     summary: Emitir una factura electrónica
 *     description: |
 *       Genera, firma y almacena una factura electrónica en formato SRI.
 *       El proceso se ejecuta en tres bloques secuenciales:
 *       1. **TX rápida** — valida créditos, reserva secuencial atómico y construye el XML.
 *       2. **Firma** — descarga el P12 desde MinIO, firma el XML con XAdES-BES y genera el PDF.
 *       3. **TX final** — sube XML y PDF a MinIO, descuenta 1 crédito y registra la factura en BD.
 *
 *       Requiere autenticación por API Key (`x-api-key`), no por token Firebase.
 *     tags:
 *       - Facturación
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - establecimiento
 *               - punto_emision
 *               - cliente
 *               - items
 *               - pagos
 *             properties:
 *               establecimiento:
 *                 type: string
 *                 pattern: '^\d{3}$'
 *                 description: "Código del establecimiento en formato SRI (3 dígitos)."
 *                 example: "001"
 *               punto_emision:
 *                 type: string
 *                 pattern: '^\d{3}$'
 *                 description: "Código del punto de emisión en formato SRI (3 dígitos)."
 *                 example: "001"
 *               cliente:
 *                 type: object
 *                 required:
 *                   - tipo_id
 *                   - nombre
 *                   - identificacion
 *                 properties:
 *                   tipo_id:
 *                     type: string
 *                     description: "Tipo de identificación según catálogo SRI."
 *                     example: "04"
 *                   nombre:
 *                     type: string
 *                     description: "Razón social o nombre del comprador."
 *                     example: "Juan Pérez"
 *                   identificacion:
 *                     type: string
 *                     description: "RUC, cédula o pasaporte del comprador."
 *                     example: "1712345678"
 *               items:
 *                 type: array
 *                 description: "Líneas de detalle de la factura."
 *                 items:
 *                   type: object
 *                   required:
 *                     - descripcion
 *                     - cantidad
 *                     - precio_unitario
 *                   properties:
 *                     descripcion:
 *                       type: string
 *                       example: "Servicio de consultoría"
 *                     cantidad:
 *                       type: number
 *                       example: 2
 *                     precio_unitario:
 *                       type: number
 *                       example: 100.00
 *                     descuento:
 *                       type: number
 *                       nullable: true
 *                       example: 0.00
 *               pagos:
 *                 type: array
 *                 description: "Formas de pago según catálogo SRI."
 *                 items:
 *                   type: object
 *                   required:
 *                     - total
 *                   properties:
 *                     forma_pago:
 *                       type: string
 *                       description: "Código de forma de pago SRI. Por defecto '01' (efectivo)."
 *                       example: "01"
 *                     total:
 *                       type: number
 *                       example: 224.00
 *                     plazo:
 *                       type: string
 *                       nullable: true
 *                       example: "0"
 *                     unidad_tiempo:
 *                       type: string
 *                       nullable: true
 *                       example: "dias"
 *     responses:
 *       201:
 *         description: Factura generada y firmada exitosamente
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
 *                   example: "Factura generada y firmada exitosamente."
 *                 claveAcceso:
 *                   type: string
 *                   description: "Clave de acceso de 49 dígitos generada según algoritmo SRI."
 *                   example: "2406202401179214673900110010010000000011234567813"
 *                 creditos_restantes:
 *                   type: integer
 *                   description: "Saldo de créditos del emisor después de descontar 1."
 *                   example: 9
 *                 xml:
 *                   type: string
 *                   description: "Ruta del XML firmado en MinIO."
 *                   example: "invoices/1792146739001/2406202401179214673900110010010000000011234567813.xml"
 *                 pdf:
 *                   type: string
 *                   description: "Ruta del PDF generado en MinIO."
 *                   example: "invoices/1792146739001/2406202401179214673900110010010000000011234567813.pdf"
 *       400:
 *         description: Campos requeridos faltantes
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
 *                   example: "Los campos 'establecimiento' y 'punto_emision' son requeridos para la secuencia legal."
 *       402:
 *         description: Créditos insuficientes para emitir la factura
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
 *                   example: "Créditos insuficientes."
 *       401:
 *         description: API Key inválida o ausente
 *       404:
 *         description: La combinación establecimiento + punto de emisión no existe o no pertenece al emisor
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
 *                   example: "La combinación Establecimiento [001] y Punto [001] no existe o no te pertenece."
 *       500:
 *         description: Error interno en cualquiera de los tres bloques de procesamiento
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
 *                   example: "Error al firmar: certificado P12 no encontrado."
 */
router.post('/invoice-whatsapp', whatsappServiceAuth, emitirFacturaCore);


module.exports = router;
