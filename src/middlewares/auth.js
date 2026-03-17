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
        
        // Buscamos en la columna CORRECTA: firebase_uid
        const profileRes = await pool.query(
            'SELECT id, emisor_id, email, role FROM profiles WHERE firebase_uid = $1', 
            [decodedToken.uid]
        );

        if (profileRes.rowCount === 0) {
            // El usuario existe en Firebase pero no en nuestra tabla de perfiles
            req.user = { uid: decodedToken.uid, email: decodedToken.email };
            req.pending_provision = true;
        } else {
            const profile = profileRes.rows[0];
            req.user = { 
                uid: decodedToken.uid, 
                profile_id: profile.id, 
                email: profile.email,
                role: profile.role 
            };
            req.emisor_id = profile.emisor_id;
        }
        
        return next();
    } catch (error) {
        // Log para que tú veas el error real en la consola del servidor
        console.error("Error en AuthMiddleware:", error.message);

        // Diferenciar errores para ayudar al frontend
        if (error.code === 'auth/id-token-expired') {
            return res.status(401).json({ ok: false, mensaje: "La sesión ha expirado, por favor vuelve a loguearte" });
        }
        
        return res.status(401).json({ ok: false, mensaje: "Token inválido o error de autenticación" });
    }
}

module.exports = { authMiddleware };