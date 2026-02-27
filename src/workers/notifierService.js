const axios = require('axios');

/**
 * Servicio centralizado de notificaciones
 */
async function notificarCambioEstado(factura, estado, detalle = null) {
    const webhookUrl = process.env.WEB_HOOK_NOTIFICACIONES;
    if (!webhookUrl) return;

    try {
        await axios.post(webhookUrl, {
            user_id: factura.user_uid,    // <--- ESTE ES EL UID DEL PERFIL
            invoice_id: factura.id,
            clave_acceso: factura.clave_acceso,
            estado: estado,
            mensaje_sri: detalle,
            fecha: new Date().toISOString()
        }, { timeout: 5000 });
        
        console.log(`[Webhook] Notificado UID ${factura.user_uid} sobre ${factura.clave_acceso}`);
    } catch (e) {
        console.error(`[Webhook Error]:`, e.message);
    }
}

module.exports = { notificarCambioEstado };