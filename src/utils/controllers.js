const admin = require("firebase-admin");
const emailService = require("../services/mailService");

exports.sendVerification = async (req, res) => {
    try {
        const email = req.user.email;
        if (!email) {
            return res.status(401).json({ ok: false, error: "Token inválido" });
        }

        // ✅ Verificar si el correo ya fue verificado
        const userRecord = await admin.auth().getUserByEmail(email);
        if (userRecord.emailVerified) {
            return res.status(400).json({ ok: false, error: "El correo ya fue verificado." });
        }

        const actionCodeSettings = {
            url: "https://kipu.ec/login",
            handleCodeInApp: false,
        };

        const link = await admin.auth().generateEmailVerificationLink(email, actionCodeSettings);

        await emailService.sendMail({
            to: email,
            subject: "Verifica tu cuenta",
            html: `
                <h2>Bienvenido 👋</h2>
                <p>Haz clic para verificar tu cuenta:</p>
                <a href="${link}" 
                   style="display:inline-block;padding:10px 20px;background:#000;color:#fff;text-decoration:none;border-radius:5px;">
                   Verificar cuenta
                </a>
            `
        });

        return res.json({ ok: true, message: "Correo de verificación enviado" });

    } catch (error) {
        console.error("Error sendVerification:", error);
        return res.status(500).json({ ok: false, error: "Error enviando correo de verificación" });
    }
};


// 🔁 Enviar correo de recuperación de contraseña
exports.sendResetPassword = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                ok: false,
                error: "Email requerido"
            });
        }

        const actionCodeSettings = {
            url: "https://kipu.ec/login",
            handleCodeInApp: false,
        };

        // Generar link con Firebase
        const link = await admin
            .auth()
            .generatePasswordResetLink(email, actionCodeSettings);

        // Enviar correo
        await emailService.sendMail({
            to: email,
            subject: "Recupera tu cuenta",
            html: `
                <h2>Recuperación de contraseña</h2>
                <p>Haz clic para restablecer tu contraseña:</p>
                <a href="${link}" 
                   style="display:inline-block;padding:10px 20px;background:#000;color:#fff;text-decoration:none;border-radius:5px;">
                   Restablecer contraseña
                </a>
            `
        });

        return res.json({
            ok: true,
            message: "Correo de recuperación enviado"
        });

    } catch (error) {
        console.error("Error sendResetPassword:", error);

        return res.status(500).json({
            ok: false,
            error: "Error enviando correo de recuperación"
        });
    }
};