const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const { XMLParser } = require('fast-xml-parser');
const { PassThrough } = require('stream');

/**
 * Genera el documento RIDE (PDF) usando Streams para eficiencia de RAM.
 * Formato fiel al modelo oficial SRI Ecuador 2026.
 */
async function generarPDFStream(xmlString, emisor, estadoFactura = 'FIRMADO', fechaAutorizacionSRI = null) {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        parseTagValue: false,
        trimValues: true,
        numberParseOptions: { leadingZeros: true, skipLike: /\d{10,}/ }
    });

    const xmlObj = parser.parse(xmlString);
    const factura = xmlObj.factura;
    const infoTrib = factura.infoTributaria;
    if (infoTrib.claveAcceso) infoTrib.claveAcceso = String(infoTrib.claveAcceso).trim();

    const infoFac = factura.infoFactura;
    const detalles = Array.isArray(factura.detalles.detalle)
        ? factura.detalles.detalle
        : [factura.detalles.detalle];

    let pagosArr = [];
    if (infoFac.pagos && infoFac.pagos.pago) {
        pagosArr = Array.isArray(infoFac.pagos.pago)
            ? infoFac.pagos.pago
            : [infoFac.pagos.pago];
    }

    let impTotales = [];
    if (infoFac.totalConImpuestos && infoFac.totalConImpuestos.totalImpuesto) {
        impTotales = Array.isArray(infoFac.totalConImpuestos.totalImpuesto)
            ? infoFac.totalConImpuestos.totalImpuesto
            : [infoFac.totalConImpuestos.totalImpuesto];
    }

    let infoAdicional = [];
    if (factura.infoAdicional && factura.infoAdicional.campoAdicional) {
        const campos = factura.infoAdicional.campoAdicional;
        infoAdicional = Array.isArray(campos) ? campos : [campos];
    }

    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    const stream = new PassThrough();
    doc.pipe(stream);

    await renderA4(doc, infoTrib, infoFac, detalles, impTotales, pagosArr, infoAdicional, emisor, estadoFactura, fechaAutorizacionSRI);

    doc.end();
    return stream;
}

async function renderA4(doc, infoTrib, infoFac, detalles, impTotales, pagosArr, infoAdicional, emisor, estadoFactura, fechaAutorizacionSRI) {
    const margin = 30;
    const pageWidth = 535;
    const leftColW = 220;
    const rightColX = margin + leftColW + 10;
    const rightColW = pageWidth - leftColW - 10;

    // ─────────────────────────────────────────────────────────────
    // SECCIÓN 1: CABECERA
    // ─────────────────────────────────────────────────────────────
    const cabeceraH = 170;

    // Columna izquierda — Logo + datos emisor
    doc.rect(margin, 30, leftColW, cabeceraH).stroke();

    // Espacio logo
    doc.rect(margin + 5, 35, leftColW - 10, 55).stroke();
    doc.fontSize(8).font('Helvetica').fillColor('#aaaaaa')
        .text('LOGO', margin + (leftColW / 2) - 8, 58, { align: 'center' });
    doc.fillColor('black');

    // Datos emisor
    doc.fontSize(9).font('Helvetica-Bold')
        .text(infoTrib.razonSocial, margin + 5, 98, { width: leftColW - 10, align: 'center' });

    doc.fontSize(7).font('Helvetica').fillColor('#555555')
        .text(infoTrib.nombreComercial || '', margin + 5, 112, { width: leftColW - 10, align: 'center' });
    doc.fillColor('black');

    doc.fontSize(7).font('Helvetica-Bold').text('Dirección Matriz:', margin + 5, 126);
    doc.font('Helvetica').text(infoTrib.dirMatriz, margin + 5, 135, { width: leftColW - 10 });

    doc.font('Helvetica-Bold').text('Dirección Establecimiento:', margin + 5, 150);
    doc.font('Helvetica').text(
        infoFac.dirEstablecimiento || infoTrib.dirMatriz,
        margin + 5, 159, { width: leftColW - 10 }
    );

    doc.font('Helvetica-Bold').text('Obligado a llevar contabilidad:', margin + 5, 174);
    doc.font('Helvetica').text(infoFac.obligadoContabilidad || 'NO', margin + 148, 174);

    doc.font('Helvetica-Bold').text('Contribuyente Especial Nro:', margin + 5, 184);
    doc.font('Helvetica').text(emisor.contribuyente_especial || '-', margin + 130, 184);

    // Columna derecha — datos comprobante
    doc.rect(rightColX, 30, rightColW, cabeceraH).stroke();

    doc.fontSize(9).font('Helvetica-Bold').text('R.U.C.:', rightColX + 5, 38);
    doc.font('Helvetica').text(infoTrib.ruc, rightColX + 45, 38);

    doc.fontSize(12).font('Helvetica-Bold')
        .text('F A C T U R A', rightColX, 55, { width: rightColW, align: 'center' });

    doc.fontSize(8).font('Helvetica-Bold').text('No.', rightColX + 5, 73);
    doc.font('Helvetica')
        .text(`${infoTrib.estab}-${infoTrib.ptoEmi}-${infoTrib.secuencial}`, rightColX + 22, 73);

    // Línea separadora
    doc.moveTo(rightColX, 85).lineTo(rightColX + rightColW, 85).stroke();

    doc.fontSize(7).font('Helvetica-Bold').text('NÚMERO DE AUTORIZACIÓN', rightColX + 5, 89);
    doc.font('Helvetica')
        .text(infoTrib.claveAcceso, rightColX + 5, 99, { width: rightColW - 65 });

    doc.font('Helvetica-Bold').text('FECHA Y HORA DE AUTORIZACIÓN:', rightColX + 5, 115);
    if (estadoFactura === 'AUTORIZADO') {
        doc.font('Helvetica').fillColor('black')
            .text(fechaAutorizacionSRI || '', rightColX + 5, 125);
    } else {
        doc.font('Helvetica-Bold').fillColor('red')
            .text('PENDIENTE DE AUTORIZACIÓN', rightColX + 5, 125);
    }
    doc.fillColor('black');

    doc.font('Helvetica-Bold').text('AMBIENTE:', rightColX + 5, 138);
    doc.font('Helvetica')
        .text(infoTrib.ambiente === '2' ? 'PRODUCCIÓN' : 'PRUEBAS', rightColX + 52, 138);

    doc.font('Helvetica-Bold').text('EMISIÓN:', rightColX + 5, 148);
    doc.font('Helvetica').text('NORMAL', rightColX + 44, 148);

    // QR — esquina superior derecha
    const qrUrl = `https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/publico/consultas/visualizarComprobante.jsf?claveAcceso=${infoTrib.claveAcceso}`;
    const qrBuffer = await QRCode.toBuffer(qrUrl, { margin: 1, width: 65 });
    doc.image(qrBuffer, rightColX + rightColW - 68, 88, { width: 62 });

    // Código de barras lineal
    doc.font('Helvetica-Bold').fontSize(7).text('CLAVE DE ACCESO:', rightColX + 5, 160);
    try {
        const barcodeBuffer = await bwipjs.toBuffer({
            bcid: 'code128',
            text: infoTrib.claveAcceso,
            scale: 1,
            height: 10,
            includetext: false,
        });
        doc.image(barcodeBuffer, rightColX + 5, 169, { width: rightColW - 10, height: 18 });
    } catch (e) {
        doc.fontSize(6).font('Helvetica')
            .text(infoTrib.claveAcceso, rightColX + 5, 169, { width: rightColW - 10 });
    }
    doc.fontSize(6).font('Helvetica')
        .text(infoTrib.claveAcceso, rightColX + 5, 189, { width: rightColW - 10, align: 'center' });

    // ─────────────────────────────────────────────────────────────
    // SECCIÓN 2: DATOS CLIENTE
    // ─────────────────────────────────────────────────────────────
    let currentY = 210;
    doc.rect(margin, currentY, pageWidth, 42).stroke();

    doc.fontSize(8).font('Helvetica-Bold')
        .text('Razón Social / Nombres y Apellidos:', margin + 5, currentY + 5);
    doc.font('Helvetica')
        .text(infoFac.razonSocialComprador, margin + 178, currentY + 5, { width: 200 });

    doc.font('Helvetica-Bold').text('Identificación:', margin + 5, currentY + 18);
    doc.font('Helvetica').text(infoFac.identificacionComprador, margin + 72, currentY + 18);

    doc.font('Helvetica-Bold').text('Fecha Emisión:', margin + 220, currentY + 18);
    doc.font('Helvetica').text(infoFac.fechaEmision, margin + 294, currentY + 18);

    doc.font('Helvetica-Bold').text('Guía Remisión:', margin + 380, currentY + 18);
    doc.font('Helvetica').text('-', margin + 450, currentY + 18);

    doc.font('Helvetica-Bold').text('Dirección:', margin + 5, currentY + 31);
    doc.font('Helvetica').text(
        infoFac.dirEstablecimiento || '-',
        margin + 55, currentY + 31, { width: 350 }
    );

    // ─────────────────────────────────────────────────────────────
    // SECCIÓN 3: TABLA DETALLES
    // ─────────────────────────────────────────────────────────────
    currentY += 52;

    // Encabezado tabla
    doc.rect(margin, currentY, pageWidth, 18).fill('#e0e0e0').stroke();
    doc.fillColor('black').font('Helvetica-Bold').fontSize(7);

    // Definición de columnas
    const C = {
        cod:    { x: margin + 2,   w: 60  },
        cant:   { x: margin + 64,  w: 28  },
        desc:   { x: margin + 94,  w: 210 },
        pu:     { x: margin + 306, w: 65  },
        dsc:    { x: margin + 373, w: 55  },
        total:  { x: margin + 430, w: 105 },
    };

    doc.text('Cód. Principal', C.cod.x,   currentY + 6, { width: C.cod.w });
    doc.text('Cant',           C.cant.x,  currentY + 6, { width: C.cant.w,  align: 'center' });
    doc.text('Descripción',    C.desc.x,  currentY + 6, { width: C.desc.w });
    doc.text('P. Unitario',    C.pu.x,    currentY + 6, { width: C.pu.w,    align: 'right' });
    doc.text('Descuento',      C.dsc.x,   currentY + 6, { width: C.dsc.w,   align: 'right' });
    doc.text('Precio Total',   C.total.x, currentY + 6, { width: C.total.w, align: 'right' });

    currentY += 18;
    doc.font('Helvetica').fontSize(7);

    detalles.forEach((item, i) => {
        const descH = doc.heightOfString(item.descripcion || '', { width: C.desc.w });
        const rowH = Math.max(descH, 13) + 5;

        // Filas alternadas
        if (i % 2 === 0) {
            doc.rect(margin, currentY, pageWidth, rowH).fill('#f9f9f9').stroke();
        } else {
            doc.rect(margin, currentY, pageWidth, rowH).stroke();
        }
        doc.fillColor('black');

        doc.text(item.codigoPrincipal || '',                        C.cod.x,   currentY + 3, { width: C.cod.w });
        doc.text(parseFloat(item.cantidad).toFixed(2),              C.cant.x,  currentY + 3, { width: C.cant.w,  align: 'center' });
        doc.text(item.descripcion || '',                            C.desc.x,  currentY + 3, { width: C.desc.w });
        doc.text(parseFloat(item.precioUnitario).toFixed(2),        C.pu.x,    currentY + 3, { width: C.pu.w,    align: 'right' });
        doc.text(parseFloat(item.descuento || 0).toFixed(2),        C.dsc.x,   currentY + 3, { width: C.dsc.w,   align: 'right' });
        doc.text(parseFloat(item.precioTotalSinImpuesto).toFixed(2),C.total.x, currentY + 3, { width: C.total.w, align: 'right' });

        currentY += rowH;
    });

    // ─────────────────────────────────────────────────────────────
    // SECCIÓN 4: PIE — Info adicional + Formas de pago + Totales
    // ─────────────────────────────────────────────────────────────
    currentY = Math.max(currentY + 15, 540);

    const leftFooterW = 300;
    const rightFooterX = margin + leftFooterW + 10;
    const rightFooterW = pageWidth - leftFooterW - 10;

    // Calcular totales
    let base0 = 0, baseIVA = 0, valorIVA = 0, tarifaIVA = '15';
    impTotales.forEach(imp => {
        const base  = parseFloat(imp.baseImponible || 0);
        const valor = parseFloat(imp.valor || 0);
        if (String(imp.codigoPorcentaje) === '0') {
            base0 += base;
        } else {
            baseIVA += base;
            valorIVA += valor;
            tarifaIVA = String(imp.tarifa || '15');
        }
    });

    // ── Totales (columna derecha) — van primero para alinear con info adicional ──
    const drawTotalRow = (label, val, y, bold = false, highlight = false) => {
        if (highlight) {
            doc.rect(rightFooterX, y, rightFooterW, 14).fill('#d0d0d0').stroke();
            doc.fillColor('black');
        } else {
            doc.rect(rightFooterX, y, rightFooterW, 14).stroke();
        }
        const labelW = rightFooterW - 60;
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7)
            .text(label, rightFooterX + 4, y + 4, { width: labelW });
        doc.text(
            typeof val === 'number' ? val.toFixed(2) : parseFloat(val || 0).toFixed(2),
            rightFooterX + labelW + 2, y + 4,
            { width: 54, align: 'right' }
        );
    };

    let ty = currentY;
    drawTotalRow(`SUBTOTAL ${tarifaIVA}%`,       baseIVA,                                   ty); ty += 14;
    drawTotalRow('SUBTOTAL IVA 0%',               base0,                                     ty); ty += 14;
    drawTotalRow('SUBTOTAL NO OBJETO IVA',         0,                                         ty); ty += 14;
    drawTotalRow('SUBTOTAL EXENTO IVA',            0,                                         ty); ty += 14;
    drawTotalRow('SUBTOTAL SIN IMPUESTOS',         parseFloat(infoFac.totalSinImpuestos || 0), ty); ty += 14;
    drawTotalRow('DESCUENTO',                      parseFloat(infoFac.totalDescuento    || 0), ty); ty += 14;
    drawTotalRow('ICE',                            0,                                         ty); ty += 14;
    drawTotalRow(`IVA ${tarifaIVA}%`,             valorIVA,                                  ty); ty += 14;
    drawTotalRow('IRBPNR',                         0,                                         ty); ty += 14;
    drawTotalRow('PROPINA',                        0,                                         ty); ty += 14;
    drawTotalRow('VALOR TOTAL',                    parseFloat(infoFac.importeTotal      || 0), ty, true, true); ty += 14;
    drawTotalRow('VALOR TOTAL SIN SUBSIDIO',       parseFloat(infoFac.importeTotal      || 0), ty, true, true); ty += 14;
    drawTotalRow('AHORRO POR SUBSIDIO:',           0,                                         ty, false, false);

    // ── Información adicional (columna izquierda) ──
    let infoY = currentY;
    doc.fontSize(8).font('Helvetica-Bold').text('Información Adicional', margin, infoY - 12);

    if (infoAdicional.length > 0) {
        const infoBoxH = infoAdicional.length * 14 + 8;
        doc.rect(margin, infoY, leftFooterW, infoBoxH).stroke();
        infoAdicional.forEach(campo => {
            const nombre = campo['@_nombre'] || campo.nombre || '';
            const valor  = campo['#text']    || campo.valor  || String(campo) || '';
            doc.fontSize(7).font('Helvetica-Bold')
                .text(`${nombre}`, margin + 5, infoY + 4, { width: 80 });
            doc.font('Helvetica')
                .text(String(valor), margin + 90, infoY + 4, { width: leftFooterW - 95 });
            infoY += 14;
        });
        infoY += 8;
    }

    // ── Formas de pago ──
    doc.fontSize(8).font('Helvetica-Bold').text('Forma de Pago', margin, infoY + 4);
    infoY += 16;

    // Encabezado tabla pagos
    doc.rect(margin, infoY, leftFooterW, 14).fill('#e0e0e0').stroke();
    doc.fillColor('black').fontSize(7).font('Helvetica-Bold');
    doc.text('Forma de Pago', margin + 5, infoY + 4, { width: leftFooterW - 70 });
    doc.text('Valor', margin + leftFooterW - 60, infoY + 4, { width: 55, align: 'right' });
    infoY += 14;

    pagosArr.forEach(pago => {
        doc.rect(margin, infoY, leftFooterW, 14).stroke();
        const formaPagoDesc = pago.formaPago === '01'
            ? 'SIN UTILIZACION DEL SISTEMA FINANCIERO'
            : 'OTROS CON UTILIZACION DEL SISTEMA FINANCIERO';
        doc.fontSize(7).font('Helvetica')
            .text(formaPagoDesc, margin + 5, infoY + 4, { width: leftFooterW - 70 });
        doc.text(
            `$${parseFloat(pago.total).toFixed(2)}`,
            margin + leftFooterW - 60, infoY + 4,
            { width: 55, align: 'right' }
        );
        infoY += 14;
    });
}

module.exports = { generarPDFStream };