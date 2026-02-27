const crypto = require('crypto');
const pool = require('../database');

async function apiKeyMiddleware(req, res, next) {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return res.status(401).json({ ok: false, error: "API Key faltante" });
    }

    try {
        const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
        
        const keyRes = await pool.query(
            'SELECT emisor_id, nombre FROM api_keys WHERE key_hash = $1 AND revoked = false', 
            [keyHash]
        );

        if (keyRes.rowCount === 0) {
            return res.status(403).json({ ok: false, error: "API Key inválida o revocada" });
        }

        req.emisor_id = keyRes.rows[0].emisor_id;
        req.user = { role: 'external_app', app_name: keyRes.rows[0].nombre };
        
        // Actualizar último uso sin bloquear la respuesta
        pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1', [keyHash]);
        
        return next();
    } catch (error) {
        return res.status(500).json({ ok: false, error: "Error validando API Key" });
    }
}

module.exports = { apiKeyAuth: apiKeyMiddleware };