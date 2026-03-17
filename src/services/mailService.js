const nodemailer = require('nodemailer');
require('dotenv').config();

class EmailService {
    constructor() {
        if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
            console.warn("⚠️ SMTP no configurado. El servicio de correo estará deshabilitado.");
            this.enabled = false;
            return;
        }

        this.enabled = true;

        // Configuración única del transporter (igual a tu archivo original que ya funciona)
        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || "587"),
            secure: process.env.SMTP_PORT === "465", // true solo si usas 465
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
            tls: {
                rejectUnauthorized: false
            }
        });
    }

    // ─── MÉTODO BASE ─────────────────────────────────────────────────────────────
    // Todos los demás métodos pasan por aquí
    async sendMail({ to, subject, html, attachments = [] }) {
        if (!this.enabled) {
            console.warn("⚠️ SMTP deshabilitado. Saltando envío de correo.");
            return { exito: false, mensaje: "SMTP no configurado" };
        }

        try {
            const info = await this.transporter.sendMail({
                from: process.env.SMTP_FROM || process.env.SMTP_USER,
                to,
                subject,
                html,
                attachments
            });

            console.log(`[Email] Enviado a ${to}: ${info.messageId}`);
            return { exito: true, messageId: info.messageId };

        } catch (error) {
            console.error(`[Email] Error enviando a ${to}:`, error);
            return { exito: false, error: error.message };
        }
    }

    // ─── AUTH ─────────────────────────────────────────────────────────────────────

    async sendVerificationEmail(to, link) {
        return this.sendMail({
            to,
            subject: "Verifica tu cuenta - Kipu",
            html: `
                <div style="font-family: Arial, sans-serif; color: #333;">
                    <h2>Bienvenido 👋</h2>
                    <p>Haz clic en el botón para verificar tu cuenta:</p>
                    <a href="${link}" 
                       style="display:inline-block;padding:12px 24px;background:#007bff;color:#fff;border-radius:5px;text-decoration:none;">
                       Verificar cuenta
                    </a>
                    <hr>
                    <small>Si no creaste esta cuenta, ignora este mensaje.</small>
                </div>
            `
        });
    }

    async sendResetPasswordEmail(to, link) {
        return this.sendMail({
            to,
            subject: "Recupera tu contraseña - Kipu",
            html: `
                <div style="font-family: Arial, sans-serif; color: #333;">
                    <h2>Recuperación de contraseña</h2>
                    <p>Haz clic en el botón para restablecer tu contraseña:</p>
                    <a href="${link}" 
                       style="display:inline-block;padding:12px 24px;background:#007bff;color:#fff;border-radius:5px;text-decoration:none;">
                       Restablecer contraseña
                    </a>
                    <p>Este enlace expira en 1 hora.</p>
                    <hr>
                    <small>Si no solicitaste esto, ignora este mensaje.</small>
                </div>
            `
        });
    }

    // ─── COMPROBANTES ─────────────────────────────────────────────────────────────

    async enviarComprobante(emailCliente, xmlBuffer, pdfBuffer, facturaInfo) {
        return this.sendMail({
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
        });
    }

    // ─── ALERTAS ──────────────────────────────────────────────────────────────────

    async enviarAlertaCreditos(email, balance) {
        return this.sendMail({
            to: email,
            subject: "⚠️ Alerta de Créditos Bajos - Kipu",
            html: `
                <div style="font-family: Arial, sans-serif; color: #333;">
                    <h2 style="color: #d9534f;">¡Atención! Sus créditos se están agotando</h2>
                    <p>Le informamos que actualmente solo le quedan <strong>${balance} créditos</strong> disponibles en su cuenta.</p>
                    <p>Para evitar interrupciones en su facturación electrónica, le recomendamos recargar créditos lo antes posible.</p>
                    <br>
                    <p>Si tiene activada la recarga automática, el sistema intentará realizar la compra en breve.</p>
                    <hr>
                    <small>Kipu - Sistema de Notificaciones Automáticas</small>
                </div>
            `
        });
    }
}

module.exports = new EmailService();
















/*

const nodemailer = require('nodemailer');
require('dotenv').config();

async function enviarComprobante(emailCliente, xmlBuffer, pdfBuffer, facturaInfo) {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
        console.warn("⚠️ SMTP no configurado. Saltando envío de correo.");
        return { exito: false, mensaje: "SMTP no configurado" };
    }

    const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: 587,
        secure: false, // 👈 IMPORTANTE (no SSL)
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
        tls: {
            rejectUnauthorized: false // opcional (evita errores locales)
        }
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
**/