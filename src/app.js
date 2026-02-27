const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const cron = require('node-cron');
require('dotenv').config();

// 1. IMPORTACIÓN DE WORKERS (Desestructurados correctamente)
const { enviarFacturasAlSRI, autorizarFacturasSRI } = require('./workers/authWorker');

const app = express();
const PORT = process.env.PORT || 3000;
// --- 1. DECLARACIÓN DEL ROUTER PRINCIPAL ---
const mainRouter = express.Router();
// --- CONFIGURACIÓN DE CRON JOBS ---

// Job 1: Enviar facturas FIRMADAS al SRI (Cada 20 segundos)
cron.schedule('*/20 * * * * *', async () => {
    try {
        await enviarFacturasAlSRI();
    } catch (err) {
        console.error('❌ Error en Cron de Envío:', err.message);
    }
});

// Job 2: Autorizar facturas RECIBIDAS (Cada minuto)
cron.schedule('* * * * *', async () => {
    //console.log('🤖 Revisando facturas pendientes de autorización...');
    try {
        await autorizarFacturasSRI();
    } catch (err) {
        console.error('❌ Error en Cron de Autorización:', err.message);
    }
});

// --- MIDDLEWARES GLOBALES ---
app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true // Corregido: antes decía 'credentialworkerss'
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// --- MIDDLEWARES GLOBALES ---
// Logger para monitorear peticiones
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// --- MIDDLEWARES GLOBALES ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- SUPER LOGGER DE DESARROLLO ---
/*
app.use((req, res, next) => {
    // Ignoramos los logs aburridos de Swagger para no ensuciar la consola
    if (req.originalUrl.startsWith('/api-docs')) return next();

    const start = Date.now();
    console.log(`\n======================================================`);
    console.log(`🚀 [REQUEST] ${req.method} ${req.originalUrl}`);

    // 1. Mostrar la Solicitud (Qué envió el cliente)
    if (req.body && Object.keys(req.body).length > 0) {
        console.log(`📥 [REQ BODY]`, JSON.stringify(req.body, null, 2));
    }

    // Si hay un Token, mostramos que sí llegó (pero cortado para no hacer spam)
    if (req.headers.authorization) {
        const token = req.headers.authorization.substring(0, 20) + '...';
        console.log(`🔑 [AUTH] Token recibido: ${token}`);
    }

    // 2. Interceptar la Respuesta para ver qué devuelve tu código
    const originalJson = res.json;
    const originalSend = res.send;

    // Interceptamos res.json
    res.json = function (data) {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const statusIcon = status >= 400 ? '❌ [ERROR]' : '✅ [SUCCESS]';
        
        console.log(`📤 [RESPONSE] ${statusIcon} Status: ${status} | Tiempo: ${duration}ms`);
        console.log(`📄 [RES DATA]`, JSON.stringify(data, null, 2));
        console.log(`======================================================\n`);

        return originalJson.apply(res, arguments);
    };

    // Interceptamos res.send (por si algún error manda un texto en vez de JSON)
    res.send = function (body) {
        if (typeof body === 'string') {
            const duration = Date.now() - start;
            const status = res.statusCode;
            const statusIcon = status >= 400 ? '❌ [ERROR]' : '✅ [SUCCESS]';
            
            console.log(`📤 [RESPONSE] ${statusIcon} Status: ${status} | Tiempo: ${duration}ms`);
            console.log(`📄 [RES TEXT] ${body}`);
            console.log(`======================================================\n`);
        }
        return originalSend.apply(res, arguments);
    };

    next();
});
*/
// --- SWAGGER CONFIGURATION ---
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'API de Facturación SRI Pro (2026)',
            version: '2.0.0',
            description: 'Motor modular de facturación electrónica con Firebase Auth y PostgreSQL Nativo.',
        },
        servers: [
            { 
                url: `https://core.kipu.ec/api/v1`, 
                description: 'Servidor de Producción' 
            },
            { 
                url: `http://localhost:${PORT}/api/v1`, 
                description: 'Servidor Local (Desarrollo)' 
            }
        ],
        components: {
            securitySchemes: {
                bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
                apiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
                n8nKeyAuth: { type: 'apiKey', in: 'header', name: 'x-n8n-key' }
            },
        },
    },
    apis: ["./src/routes/*.js"], // Escanea los JSDoc en la carpeta de rutas
};
let swaggerSpec;
try {
    swaggerSpec = swaggerJsdoc(swaggerOptions);
} catch (err) {
    console.error('⚠️ Error en la sintaxis de Swagger (YAML):', err.message);
    swaggerSpec = { openapi: '3.0.0', info: { title: 'Error en Docs' }, paths: {} };
}
mainRouter.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));


// --- REGISTRO DE RUTAS MODULARES ---

// 1. Autenticación (Firebase JWT + Sync JIT)
mainRouter.use('/auth', require('./routes/auth'));

// 2. Facturación (Emisión, Historial, Stats)
mainRouter.use('/invoices', require('./routes/invoices'));

// 3. Emisor (Perfil, P12, Configuración ambiente)
mainRouter.use('/emitter', require('./routes/emitter'));

// 4. Estructura (Establecimientos y Puntos de Emisión)
mainRouter.use('/structure', require('./routes/structure'));

// 5. Administración (Recargas de créditos vía n8n)
mainRouter.use('/admin', require('./routes/admin'));

// 5. Administración (Recargas de créditos vía n8n)
mainRouter.use('/keys', require('./routes/apiKeys'));

// 5. Administración (Recargas de créditos vía n8n)
mainRouter.use('/integrations', require('./routes/integracion'));

// 6. Público (Descargas de PDF/XML sin token y Tracking)
mainRouter.use('/public', require('./routes/public'));

// --- DIAGNÓSTICOS Y SALUD ---
mainRouter.get('/health', (req, res) => res.json({ 
    status: 'OK', 
    uptime: process.uptime(),
    timestamp: new Date() 
}));

// Endpoint de diagnóstico para encriptación (útil en desarrollo)
mainRouter.get('/diag/crypto', async (req, res) => {
    const { test } = req.query;
    if (!test) return res.json({ ok: false, mensaje: "Envíe ?test=texto" });
    const { encrypt, decrypt } = require('./utils/cryptoUtils');
    const enc = encrypt(test);
    const dec = decrypt(enc);
    res.json({ match: test === dec, env_key_set: !!process.env.ENCRYPTION_KEY });
});

// --- 2. LA MAGIA: CONECTAR EL ROUTER A LA APP CON EL PREFIJO ---
app.use('/api/v1', mainRouter);

// --- MANEJO DE ERRORES 404 ---
app.use((req, res) => {
    console.warn(`[404] Ruta no encontrada: ${req.method} ${req.url}`);
    res.status(404).json({ ok: false, mensaje: "Ruta no encontrada o no implementada" });
});
app.use((err, req, res, next) => {
  console.error("❌ ERROR DETECTADO:", err.stack);
  res.status(500).json({ ok: false, error: 'Algo salió mal en el servidor' });
});
// --- ARRANQUE DEL SERVIDOR ---
app.listen(PORT, () => {
    console.log(`
    ---------------------------------------------------
    🚀 BACKEND SRI MODULARIZADO LISTO
    ---------------------------------------------------
    📚 Documentación: https://kipu.ec/api-docs
    📚 Documentación: http://localhost:${PORT}/api-docs
    ---------------------------------------------------
    `);
});


module.exports = app;
