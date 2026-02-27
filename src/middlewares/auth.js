const firebaseAdmin = require('../config/firebase');
const pool = require('../database/index');

async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
        return res.status(401).json({ ok: false, mensaje: "Se requiere sesión activa" });
    }

    try {
        const idToken = authHeader.split(' ')[1]; 
        const decodedToken = await firebaseAdmin.auth().verifyIdToken(idToken);
        
        req.user = { uid: decodedToken.uid, email: decodedToken.email };
        
        const profileRes = await pool.query('SELECT * FROM profiles WHERE id = $1', [decodedToken.uid]);

        if (profileRes.rowCount === 0) {
            req.pending_provision = true;
        } else {
            req.user = { ...req.user, ...profileRes.rows[0] };
            req.emisor_id = profileRes.rows[0].emisor_id;
        }
        return next();
    } catch (error) {
        return res.status(401).json({ ok: false, mensaje: "Token de usuario inválido o expirado" });
    }
}

module.exports = { authMiddleware };