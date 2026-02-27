function serviceMiddleware(req, res, next) {
    const n8nKey = req.headers['x-n8n-key'];

    if (!n8nKey || n8nKey !== process.env.N8N_API_KEY) {
        return res.status(403).json({ ok: false, mensaje: "Acceso denegado a servicios internos" });
    }

    req.user = { role: 'internal_service' };
    next();
}

module.exports = { serviceAuth: serviceMiddleware };