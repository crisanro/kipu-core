const nodemailer = require('nodemailer');
require('dotenv').config();

async function enviarComprobante(emailCliente, xmlBuffer, pdfBuffer, facturaInfo) {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
        console.warn("⚠️ SMTP no configurado. Saltando envío de correo.");
        return { exito: false, mensaje: "SMTP no configurado" };
    }

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || "465"),
        secure: process.env.SMTP_PORT === "465",
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });

    const mailOptions = {
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: emailCliente,
        subject: `Factura Electrónica - ${facturaInfo.razonSocialEmisor} - ${facturaInfo.secuencial}`,
        html: `
            <div style="font-family: Arial, sans-serif; color: #333;">
                <h2>Estimado/a cliente, ${facturaInfo.nombreCliente}</h2>
                <p>Adjunto a este correo encontrará su comprobante electrónico autorizado por el SRI.</p>
                <div style="background-color: #f4f4f4; padding: 15px; border-radius: 5px; border-left: 5px solid #007bff;">
                    <p><strong>Emisor:</strong> ${facturaInfo.razonSocialEmisor}</p>
                    <p><strong>Número de Comprobante:</strong> ${facturaInfo.secuencial}</p>
                    <p><strong>Clave de Acceso:</strong> ${facturaInfo.claveAcceso}</p>
                    <p><strong>Total:</strong> $${facturaInfo.total}</p>
                </div>
                <p style="margin-top: 20px;">Gracias por su preferencia.</p>
                <hr>
                <small>Este es un correo automático, por favor no responda a este mensaje.</small>
            </div>
        `,
        attachments: [
            {
                filename: `Factura_${facturaInfo.claveAcceso}.xml`,
                content: xmlBuffer
            },
            {
                filename: `Factura_${facturaInfo.claveAcceso}.pdf`,
                content: pdfBuffer
            }
        ]
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] Mensaje enviado a ${emailCliente}: ${info.messageId}`);
        return { exito: true, messageId: info.messageId };
    } catch (error) {
        console.error(`[Email] Error enviando a ${emailCliente}:`, error);
        return { exito: false, error: error.message };
    }
}

async function enviarAlertaCreditos(email, balance) {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return;

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || "465"),
        secure: process.env.SMTP_PORT === "465",
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });

    const mailOptions = {
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: `⚠️ Alerta de Créditos Bajos - Facturador SRI`,
        html: `
            <div style="font-family: Arial, sans-serif; color: #333;">
                <h2 style="color: #d9534f;">¡Atención! Sus créditos se están agotando</h2>
                <p>Le informamos que actualmente solo le quedan <strong>${balance} créditos</strong> disponibles en su cuenta.</p>
                <p>Para evitar interrupciones en su facturación electrónica, le recomendamos recargar créditos lo antes posible.</p>
                <br>
                <p>Si tiene activada la recarga automática, el sistema intentará realizar la compra en breve.</p>
                <hr>
                <small>Facturador SRI - Sistema de Notificaciones Automáticas</small>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`[Email] Alerta de créditos enviada a ${email} (Balance: ${balance})`);
    } catch (error) {
        console.error(`[Email] Error enviando alerta a ${email}:`, error);
    }
}

module.exports = { enviarComprobante, enviarAlertaCreditos };
