const { DateTime } = require("luxon");
const crypto = require("crypto");
require("dotenv").config();

const ALGORITHM = "aes-256-cbc";
const KEY_VAL = process.env.ENCRYPTION_KEY;

if (!KEY_VAL) {
    console.warn("⚠️ Advertencia: ENCRYPTION_KEY no está configurada. Las contraseñas se manejarán en texto plano.");
}

const ENCRYPTION_KEY = (() => {
    if (!KEY_VAL) {
        console.warn("⚠️ [Crypto] ENCRYPTION_KEY no está configurada. Las contraseñas se manejarán en texto plano.");
        return null;
    }
    const cleanKey = String(KEY_VAL).trim();
    const hash = crypto.createHash('sha256').update(cleanKey).digest();
    const keyFingerprint = crypto.createHash('md5').update(cleanKey).digest('hex').substring(0, 8);

    // --- Autoprueba de integridad en el arranque ---
    try {
        const testText = "Test_123_@";
        const ivTest = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(ALGORITHM, hash, ivTest);
        let enc = cipher.update(testText, 'utf8', 'hex');
        enc += cipher.final('hex');
        const encryptedBody = `${ivTest.toString("hex")}:${enc}`;

        const testParts = encryptedBody.split(":");
        const testIv = Buffer.from(testParts[0], "hex");
        const decipher = crypto.createDecipheriv(ALGORITHM, hash, testIv);
        let dec = decipher.update(testParts[1], 'hex', 'utf8');
        dec += decipher.final('utf8');

        if (dec !== testText) throw new Error("Mismatch en autoprueba");
        console.log(`[Crypto] Sistema listo. Fingerprint: ${keyFingerprint} (Len: ${cleanKey.length}). Autoprueba: OK`);
    } catch (e) {
        console.error(`[Crypto] ERROR CRÍTICO: La configuración de ENCRYPTION_KEY no permite desencriptar datos correctamente: ${e.message}`);
    }

    return hash;
})();

const IV_LENGTH = 16;

// Algoritmo Módulo 11 (Requisito estricto del SRI)
function modulo11(cadena) {
    let suma = 0;
    let factor = 2;
    for (let i = cadena.length - 1; i >= 0; i--) {
        suma += parseInt(cadena.charAt(i)) * factor;
        factor = factor === 7 ? 2 : factor + 1;
    }
    const verificador = 11 - (suma % 11);
    if (verificador === 11) return 0;
    if (verificador === 10) return 1;
    return verificador;
}

function generarClaveAcceso(fecha, tipoComprobante, ruc, ambiente, serie, secuencial, codigoNumerico = null) {
    const ahora = DateTime.now().setZone('America/Guayaquil');

    // 1. Fecha (8 dígitos)
    let finalFecha = (fecha && fecha !== 'now') 
        ? DateTime.fromISO(fecha).toFormat('ddMMyyyy') 
        : ahora.toFormat('ddMMyyyy');

    // 2. Código Numérico (8 dígitos)
    // Usamos 'HHmmssSS' pero aseguramos que Luxon devuelva solo números
    // 'u' en Luxon da el milisegundo del segundo (0-999)
    let codigoFinal = codigoNumerico;
    if (!codigoFinal) {
        // Generamos: Hora(2) + Min(2) + Seg(2) + Miliseg(2)
        const ms = ahora.toFormat('SSS').substring(0, 2); // Tomamos solo 2 dígitos de milisegundos
        codigoFinal = ahora.toFormat('HHmmss') + ms; 
    }

    // 3. Limpieza estricta: Eliminar cualquier cosa que no sea número
    const limpiar = (val) => val.toString().replace(/\D/g, '');

    const p1_fecha = limpiar(finalFecha).substring(0, 8);
    const p2_tipo  = limpiar(tipoComprobante).padStart(2, '0').substring(0, 2);
    const p3_ruc   = limpiar(ruc).substring(0, 13);
    const p4_amb   = limpiar(ambiente).substring(0, 1);
    const p5_serie = limpiar(serie).padStart(6, '0').substring(0, 6);
    const p6_sec   = limpiar(secuencial).padStart(9, '0').substring(0, 9);
    const p7_cod   = limpiar(codigoFinal).padStart(8, '0').substring(0, 8);
    const p8_emi   = "1";

    const clave48 = p1_fecha + p2_tipo + p3_ruc + p4_amb + p5_serie + p6_sec + p7_cod + p8_emi;

    if (clave48.length !== 48) {
        throw new Error(`Clave base inválida: mide ${clave48.length} y debe medir 48. Valor: ${clave48}`);
    }

    // 4. Calcular dígito verificador
    const digitoVerificador = modulo11(clave48);
    const claveFinal = clave48 + digitoVerificador;

    console.log(`[Crypto] ✅ Clave Generada: ${claveFinal} (Longitud: ${claveFinal.length})`);
    return claveFinal;
}


/**
 * Encripta un texto usando AES-256-CBC
 */
function encrypt(text) {
    if (!ENCRYPTION_KEY || !text) return text;
    try {
        const iv = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return `${iv.toString("hex")}:${encrypted}`;
    } catch (e) {
        console.error("[Crypto] Error encriptando:", e.message);
        return text;
    }
}

/**
 * Desencripta un texto usando AES-256-CBC
 */
function decrypt(text) {
    if (!ENCRYPTION_KEY || !text) return text;

    // Si no tiene el formato esperado, asumimos texto plano
    if (typeof text !== 'string' || !text.includes(":")) {
        return text;
    }

    try {
        const parts = text.split(":");
        const ivHex = parts.shift();
        const encryptedHex = parts.join(":"); // Re-unir por si el dato contenía ":"

        if (!ivHex || !encryptedHex) return text;

        const iv = Buffer.from(ivHex, "hex");
        if (iv.length !== IV_LENGTH) {
            console.warn("[Crypto] IV inválido detectado. Devolviendo original.");
            return text;
        }

        const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);

        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } catch (e) {
        console.error(`[Crypto] ERROR DE DESENCRIPTACIÓN (${e.message}): Verifique si se cambió la ENCRYPTION_KEY en el servidor tras subir la firma.`);
        return text;
    }
}



module.exports = { generarClaveAcceso, encrypt, decrypt };