const pool = require('../database/index');

// 1. Middleware general para n8n (Consultas de estado, logs, etc.)
function serviceMiddleware(req, res, next) {
    const n8nKey = req.headers['x-n8n-key'];

    if (!n8nKey || n8nKey !== process.env.N8N_API_KEY) {
        return res.status(403).json({ ok: false, mensaje: "Acceso denegado a servicios internos" });
    }

    req.user = { role: 'internal_service' };
    next();
}

// 2. Middleware específico para Facturación por WhatsApp
async function whatsappServiceAuth(req, res, next) {
    const n8nKey = req.headers['x-n8n-key'];
    // Capturamos el número desde el header (n8n lo enviará ahí)
    const whatsapp_number = req.headers['x-whatsapp-number'];

    // Validamos primero la API KEY (Igual que el anterior)
    if (!n8nKey || n8nKey !== process.env.N8N_API_KEY) {
        return res.status(403).json({ ok: false, mensaje: "Acceso denegado a servicios internos" });
    }

    // Validamos que n8n haya enviado el número del cliente
    if (!whatsapp_number) {
        return res.status(400).json({ ok: false, mensaje: "Falta el número de WhatsApp emisor en los headers." });
    }

    try {
        // Buscamos el emisor_id vinculado a ese número en la tabla profiles
        const result = await pool.query(`
            SELECT emisor_id 
            FROM profiles 
            WHERE whatsapp_number = $1
        `, [whatsapp_number]);

        if (result.rowCount === 0) {
            return res.status(404).json({ 
                ok: false, 
                mensaje: "El número de WhatsApp no está vinculado a ninguna cuenta de Kipu." 
            });
        }

        // Inyectamos los datos en el request
        req.user = { role: 'internal_service', source: 'whatsapp' };
        req.emisor_id = result.rows[0].emisor_id; // <--- Esto es lo que usa tu endpoint de factura
        
        next();
    } catch (error) {
        console.error("Error en whatsappServiceAuth:", error);
        res.status(500).json({ ok: false, error: "Error interno verificando identidad de WhatsApp" });
    }
}

module.exports = { 
    serviceAuth: serviceMiddleware, 
    whatsappServiceAuth 
};