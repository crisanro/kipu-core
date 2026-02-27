const { SignedXml } = require('xml-crypto');
const crypto = require('crypto');
const forge = require('node-forge');

/**
 * Selecciona el certificado de firma digital del P12.
 * Prioriza: digitalSignature + nonRepudiation > solo digitalSignature > primer no-CA.
 * Devuelve { cert, localKeyId } para poder cruzar con la llave privada correcta.
 */
function _seleccionarCertDeFirma(p12) {
    const bags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];

    // Prioridad 1: digitalSignature + nonRepudiation (XAdES requerido por el SRI)
    let targetBag = bags.find(b => {
        if (!b.cert || b.cert.cA) return false;
        const ku = b.cert.getExtension('keyUsage');
        return ku && ku.digitalSignature === true && ku.nonRepudiation === true;
    });

    // Prioridad 2: solo digitalSignature
    if (!targetBag) {
        targetBag = bags.find(b => {
            if (!b.cert || b.cert.cA) return false;
            const ku = b.cert.getExtension('keyUsage');
            return ku && ku.digitalSignature === true;
        });
    }

    // Prioridad 3 (fallback): primer no-CA
    if (!targetBag) {
        targetBag = bags.find(b => b.cert && !b.cert.cA);
    }

    if (!targetBag) throw new Error("[Signer] No se encontró certificado de firma digital en el P12.");

    // Extraer localKeyId del cert para cruzarlo con la llave privada
    const localKeyId = targetBag.attributes?.localKeyId
        ? targetBag.attributes.localKeyId[0]
        : null;

    const ku = targetBag.cert.getExtension('keyUsage');
    console.log(`[Signer] ✅ Cert firma: Serial=${targetBag.cert.serialNumber} | CN=${targetBag.cert.subject.getField('CN')?.value} | ds=${ku?.digitalSignature} | nr=${ku?.nonRepudiation} | localKeyId=${localKeyId ? Buffer.from(localKeyId).toString('hex') : 'N/A'}`);

    return { cert: targetBag.cert, localKeyId };
}

/**
 * Selecciona la llave privada que corresponde al certificado de firma.
 * Estrategia 1: cruzar por localKeyId (más preciso).
 * Estrategia 2: buscar "Signing Key" en el friendlyName (específico del BCE).
 * Estrategia 3: si solo hay una llave, usarla directamente.
 */
function _seleccionarLlaveDeFirma(p12, localKeyIdCert) {
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [];

    if (keyBags.length === 0) throw new Error("[Signer] No se encontraron llaves privadas en el P12.");

    // Si solo hay una llave (Security Data, otros), usarla directamente
    if (keyBags.length === 1) {
        console.log(`[Signer] ✅ Llave única encontrada, usándola directamente.`);
        return keyBags[0].key;
    }

    // Estrategia 1: cruzar por localKeyId (BCE tiene localKeyId en certs y llaves)
    if (localKeyIdCert) {
        const certKeyIdHex = Buffer.from(localKeyIdCert).toString('hex');

        const matchById = keyBags.find(bag => {
            const keyId = bag.attributes?.localKeyId?.[0];
            if (!keyId) return false;
            const keyIdHex = Buffer.from(keyId).toString('hex');
            console.log(`[Signer] Comparando localKeyId: cert=${certKeyIdHex} vs key=${keyIdHex}`);
            return keyIdHex === certKeyIdHex;
        });

        if (matchById) {
            console.log(`[Signer] ✅ Llave seleccionada por localKeyId.`);
            return matchById.key;
        }
    }

    // Estrategia 2: buscar "Signing Key" en el friendlyName (BCE SODIgnature)
    const matchByName = keyBags.find(bag => {
        const name = bag.attributes?.friendlyName?.[0] || '';
        return name.toLowerCase().includes('signing key');
    });

    if (matchByName) {
        console.log(`[Signer] ✅ Llave seleccionada por friendlyName "Signing Key".`);
        return matchByName.key;
    }

    // Estrategia 3 (fallback): última llave de la lista
    // (en BCE, el orden es: Decryption Key primero, Signing Key último)
    console.warn(`[Signer] ⚠️ No se pudo cruzar por ID ni nombre, usando última llave como fallback.`);
    return keyBags[keyBags.length - 1].key;
}

/**
 * Firma un XML usando el estándar XAdES-BES con algoritmo SHA-256.
 * Optimizado para el Esquema Offline del SRI Ecuador 2026.
 * Compatible con P12s del BCE (2 llaves) y Security Data (1 llave).
 */
function signInvoiceXmlCustom(xml, certBag, keyBag, p12) {
    // Seleccionar cert y llave correctos internamente (no depender de lo que pase sriService)
    const { cert: certificate, localKeyId } = _seleccionarCertDeFirma(p12);
    const privateKey = _seleccionarLlaveDeFirma(p12, localKeyId);

    if (!certificate || !privateKey) throw new Error("[Signer] Certificado o llave no válidos.");

    const keyPem = forge.pki.privateKeyToPem(privateKey);

    // --- CADENA DE CERTIFICADOS: primero el de firma, luego los demás ---
    let allCertsPem = [];
    try {
        const mainPem = forge.pki.certificateToPem(certificate)
            .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
            .replace(/[\r\n]/g, '');

        allCertsPem.push(mainPem);

        const allBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
        allBags.forEach(bag => {
            const c = bag.cert || bag.attributes?.cert;
            if (!c) return;
            const pem = forge.pki.certificateToPem(c)
                .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
                .replace(/[\r\n]/g, '');
            if (pem !== mainPem) allCertsPem.push(pem);
        });
    } catch (e) {
        allCertsPem = [forge.pki.certificateToPem(certificate)
            .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
            .replace(/[\r\n]/g, '')];
    }

    // --- CONFIGURACIÓN DEL FIRMADOR ---
    const sig = new SignedXml({ privateKey: keyPem });
    sig.key = keyPem;
    sig.signingKey = keyPem;
    sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
    sig.canonicalizationAlgorithm = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";

    // Referencia al comprobante
    sig.addReference({
        xpath: "//*[@id='comprobante']",
        transforms: [
            "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
            "http://www.w3.org/TR/2001/REC-xml-c14n-20010315"
        ],
        digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256"
    });

    // --- XADES: hash y serial del cert de FIRMA ---
    const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
    const certHash = crypto.createHash('sha256').update(certDer, 'binary').digest('base64');

    // IssuerName en orden original del cert (sin reverse)
    const issuerName = certificate.issuer.attributes
        .map(attr => `${attr.shortName}=${attr.value}`)
        .join(', ');

    const serialNumberDec = BigInt('0x' + certificate.serialNumber).toString();

    console.log(`[Signer] XAdES → Serial=${serialNumberDec} | Hash=${certHash}`);

    const signedPropsId = 'SignedProperties-' + crypto.randomBytes(10).toString('hex');

    // Referencia a SignedProperties
    sig.addReference({
        xpath: `//*[@Id='${signedPropsId}']`,
        transforms: ["http://www.w3.org/TR/2001/REC-xml-c14n-20010315"],
        digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
        uri: '#' + signedPropsId
    });

    const signedPropertiesXml = `<xades:SignedProperties Id="${signedPropsId}" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><xades:SignedSignatureProperties><xades:SigningTime>${new Date().toISOString()}</xades:SigningTime><xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${certHash}</ds:DigestValue></xades:CertDigest><xades:IssuerSerial><ds:X509IssuerName>${issuerName}</ds:X509IssuerName><ds:X509SerialNumber>${serialNumberDec}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate></xades:SignedSignatureProperties><xades:SignedDataObjectProperties><xades:DataObjectFormat ObjectReference="#comprobante"><xades:Description>Comprobante de Facturacion</xades:Description><xades:MimeType>text/xml</xades:MimeType></xades:DataObjectFormat></xades:SignedDataObjectProperties></xades:SignedProperties>`;

    const rootXml = `<root>${xml}<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><Object>${signedPropertiesXml}</Object></Signature></root>`;

    // Inyectar Type en la referencia de SignedProperties
    const originalCreateReferences = sig.createReferences.bind(sig);
    sig.createReferences = function (params) {
        let references = originalCreateReferences(params);
        return references.replace(
            `URI="#${signedPropsId}">`,
            `URI="#${signedPropsId}" Type="http://uri.etsi.org/01903#SignedProperties">`
        );
    };

    sig.computeSignature(rootXml);
    let signedRootXml = sig.getSignedXml();

    // Extraer bloque Signature
    const signatureBlockMatch = signedRootXml.match(/<(\w+:)?Signature[\s\S]*?<\/\1Signature>/g);
    let signatureBlock = signatureBlockMatch[signatureBlockMatch.length - 1];

    // Construir KeyInfo con la clave pública del cert de FIRMA
    const prefix = (signatureBlock.match(/<(\w+:)?Signature /) || [])[1] || '';
    const modulus = Buffer.from(privateKey.n.toString(16), 'hex').toString('base64');
    const exponent = Buffer.from(privateKey.e.toString(16), 'hex').toString('base64');

    const x509CertsXml = allCertsPem
        .map(c => `<${prefix}X509Certificate>${c}</${prefix}X509Certificate>`)
        .join('');

    const keyInfoXml = `<${prefix}KeyInfo><${prefix}X509Data>${x509CertsXml}</${prefix}X509Data><${prefix}KeyValue><${prefix}RSAKeyValue><${prefix}Modulus>${modulus}</${prefix}Modulus><${prefix}Exponent>${exponent}</${prefix}Exponent></${prefix}RSAKeyValue></${prefix}KeyValue></${prefix}KeyInfo>`;

    signatureBlock = signatureBlock.replace(
        new RegExp(`</(${prefix})?SignatureValue>`),
        `</${prefix}SignatureValue>${keyInfoXml}`
    );
    signatureBlock = signatureBlock.replace(/<(\w+:)?Signature /, `<$1Signature Id="Signature" `);

    const finalObject = `<${prefix}Object><xades:QualifyingProperties Target="#Signature" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">${signedPropertiesXml}</xades:QualifyingProperties></${prefix}Object>`;
    signatureBlock = signatureBlock.replace(
        new RegExp(`</(${prefix})?Signature>`),
        `${finalObject}</${prefix}Signature>`
    );

    return xml.replace('</factura>', `${signatureBlock}</factura>`);
}

/**
 * Valida un archivo P12 y extrae los datos del emisor.
 */
function validarP12(p12Buffer, password, rucEmisor) {
    try {
        const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

        const { cert } = _seleccionarCertDeFirma(p12);

        let rucDetectado = '';
        const OIDS_RUC = [
            '1.3.6.1.4.1.37947.3.11', // BCE
            '1.3.6.1.4.1.37746.3.11'  // Security Data
        ];

        for (const oid of OIDS_RUC) {
            const ext = cert.getExtension({ id: oid });
            if (ext) {
                const decoded = forge.asn1.fromDer(ext.value);
                const match = JSON.stringify(decoded).match(/\d{13}/);
                if (match) { rucDetectado = match[0]; break; }
            }
        }

        if (!rucDetectado) {
            const serialAttr = cert.subject.attributes.find(a =>
                a.name === 'serialNumber' || a.shortName === 'SN'
            );
            if (serialAttr) {
                const match = serialAttr.value.match(/\d{13}/);
                rucDetectado = match ? match[0] : '';
            }
        }

        if (!rucDetectado) return { ok: false, mensaje: "No se pudo extraer un RUC válido de la firma." };

        if (rucEmisor && rucDetectado !== rucEmisor) {
            return { ok: false, mensaje: `Firma de RUC ${rucDetectado} no coincide con tu RUC ${rucEmisor}.` };
        }

        const fechaVencimiento = cert.validity.notAfter;

        return {
            ok: true,
            expiration: fechaVencimiento,
            datos: {
                ruc: rucDetectado,
                titular: cert.subject.getField('CN')?.value,
                vence: fechaVencimiento,
                estaCaducado: new Date() > fechaVencimiento,
                certificadora: cert.issuer.getField('CN')?.value
            }
        };

    } catch (e) {
        console.error("[validarP12 Error]", e.message);
        const msg = e.message.includes('password') ? "Contraseña incorrecta." : "Archivo P12 inválido.";
        return { ok: false, mensaje: msg };
    }
}

module.exports = { validarP12, signInvoiceXmlCustom };