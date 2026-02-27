const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { XMLParser } = require('fast-xml-parser');
const { PassThrough } = require('stream');

/**
 * Genera el documento RIDE (PDF) usando Streams para eficiencia de RAM.
 * @param {string} xmlString - XML de la factura.
 * @param {Object} emisor - Datos del emisor.
 * @param {string} estadoFactura - Estado actual (FIRMADO, RECIBIDA, AUTORIZADO).
 * @param {string} fechaAutorizacionSRI - Fecha devuelta por el SRI.
 * @returns {Stream} Un stream legible del PDF.
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
    const detalles = Array.isArray(factura.detalles.detalle) ? factura.detalles.detalle : [factura.detalles.detalle];

    let pagosArr = [];
    if (infoFac.pagos && infoFac.pagos.pago) {
        pagosArr = Array.isArray(infoFac.pagos.pago) ? infoFac.pagos.pago : [infoFac.pagos.pago];
    }

    let impTotales = [];
    if (infoFac.totalConImpuestos && infoFac.totalConImpuestos.totalImpuesto) {
        impTotales = Array.isArray(infoFac.totalConImpuestos.totalImpuesto) ? infoFac.totalConImpuestos.totalImpuesto : [infoFac.totalConImpuestos.totalImpuesto];
    }

    // CREACIÓN DEL STREAM
    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    const stream = new PassThrough(); // Este es el "tubo" por donde viajará el PDF
    doc.pipe(stream);

    // Renderizado (Asíncrono para permitir flujo de datos)
    await renderA4(doc, infoTrib, infoFac, detalles, impTotales, pagosArr, emisor, estadoFactura, fechaAutorizacionSRI);

    doc.end();
    return stream; // Retornamos el stream, no el buffer completo
}

async function renderA4(doc, infoTrib, infoFac, detalles, impTotales, pagosArr, emisor, estadoFactura, fechaAutorizacionSRI) {
    const margin = 30;
    const colWidth = 260;

    // --- COLUMNA IZQUIERDA (EMISOR) ---
    doc.rect(margin, 30, colWidth, 100).stroke();
    doc.fontSize(10).font('Helvetica-Bold').text("LOGO", margin + 110, 75);

    let currentY = 140;
    doc.rect(margin, currentY, colWidth, 100).stroke();
    doc.fontSize(10).font('Helvetica-Bold').text(infoTrib.razonSocial, margin + 5, currentY + 10, { width: colWidth - 10 });

    doc.fontSize(8).font('Helvetica-Bold').text("Dirección Matriz:", margin + 5, currentY + 30);
    doc.font('Helvetica').text(infoTrib.dirMatriz, margin + 5, currentY + 40, { width: colWidth - 10 });

    doc.font('Helvetica-Bold').text("Dirección Establecimiento:", margin + 5, currentY + 60);
    doc.font('Helvetica').text(infoFac.dirEstablecimiento || infoTrib.dirMatriz, margin + 5, currentY + 70, { width: colWidth - 10 });

    doc.font('Helvetica-Bold').text("Obligado a llevar contabilidad:", margin + 5, currentY + 90);
    doc.font('Helvetica').text(infoFac.obligadoContabilidad || 'NO', margin + 140, currentY + 90);

    // --- COLUMNA DERECHA (COMPROBANTE) ---
    const rightColX = margin + colWidth + 20;
    const rightColWidth = 260;
    doc.rect(rightColX, 30, rightColWidth, 210).stroke();

    doc.fontSize(12).font('Helvetica-Bold').text(`R.U.C.:`, rightColX + 5, 45);
    doc.text(infoTrib.ruc, rightColX + 50, 45);

    doc.fontSize(14).text(`FACTURA`, rightColX + 5, 65);
    doc.fontSize(10).text(`No. ${infoTrib.estab}-${infoTrib.ptoEmi}-${infoTrib.secuencial}`, rightColX + 5, 85);

    doc.fontSize(9).text(`NÚMERO DE AUTORIZACIÓN:`, rightColX + 5, 105);
    doc.fontSize(8).font('Helvetica').text(infoTrib.claveAcceso, rightColX + 5, 118, { width: rightColWidth - 10 });

    doc.font('Helvetica-Bold').fontSize(9).text(`FECHA Y HORA DE AUTORIZACIÓN:`, rightColX + 5, 135);
    
    if (estadoFactura === 'AUTORIZADO') {
        doc.font('Helvetica').fillColor('black').text(fechaAutorizacionSRI || new Date().toLocaleString(), rightColX + 5, 145);
    } else {
        doc.font('Helvetica-Bold').fillColor('red').text(`PENDIENTE DE AUTORIZACIÓN`, rightColX + 5, 145);
    }
    doc.fillColor('black');

    doc.font('Helvetica-Bold').text(`AMBIENTE:`, rightColX + 5, 160);
    doc.font('Helvetica').text(infoTrib.ambiente === '1' ? 'PRUEBAS' : 'PRODUCCIÓN', rightColX + 60, 160);

    doc.font('Helvetica-Bold').text(`EMISIÓN:`, rightColX + 5, 175);
    doc.font('Helvetica').text('NORMAL', rightColX + 60, 175);

    doc.font('Helvetica-Bold').text(`CLAVE DE ACCESO:`, rightColX + 5, 190);
    
    // QR MEJORADO: URL DE CONSULTA RÁPIDA (RECOMENDACIÓN SRI 2026)
    const qrUrl = `https://srienlinea.sri.gob.ec/comprobantes-electronicos-internet/publico/consultas/visualizarComprobante.jsf?claveAcceso=${infoTrib.claveAcceso}`;
    const qrBuffer = await QRCode.toBuffer(qrUrl, { margin: 1, width: 80 });
    doc.image(qrBuffer, rightColX + 175, 155, { width: 75 });
    
    doc.fontSize(7).font('Helvetica').text(infoTrib.claveAcceso, rightColX + 5, 205, { width: rightColWidth - 10 });

    // --- INFO CLIENTE ---
    currentY = 250;
    doc.rect(margin, currentY, 540, 50).stroke();
    doc.fontSize(9).font('Helvetica-Bold').text("Razón Social / Nombres y Apellidos:", margin + 10, currentY + 10);
    doc.font('Helvetica').text(infoFac.razonSocialComprador, margin + 170, currentY + 10);
    doc.font('Helvetica-Bold').text("Identificación:", margin + 10, currentY + 25);
    doc.font('Helvetica').text(infoFac.identificacionComprador, margin + 80, currentY + 25);
    doc.font('Helvetica-Bold').text("Fecha Emisión:", margin + 10, currentY + 40);
    doc.font('Helvetica').text(infoFac.fechaEmision, margin + 80, currentY + 40);

    // --- TABLA DETALLES ---
    currentY = 310;
    doc.rect(margin, currentY, 540, 20).fill('#f2f2f2').stroke();
    doc.fillColor('black').font('Helvetica-Bold').fontSize(8);
    doc.text("Código", margin + 5, currentY + 6);
    doc.text("Cant", margin + 60, currentY + 6);
    doc.text("Descripción", margin + 100, currentY + 6);
    doc.text("P. Unitario", margin + 350, currentY + 6, { width: 60, align: 'right' });
    doc.text("Descuento", margin + 420, currentY + 6, { width: 50, align: 'right' });
    doc.text("Precio Total", margin + 480, currentY + 6, { width: 55, align: 'right' });

    currentY += 25;
    doc.font('Helvetica').fontSize(8);
    detalles.forEach(item => {
        doc.text(item.codigoPrincipal || '', margin + 5, currentY);
        doc.text(parseFloat(item.cantidad).toFixed(2), margin + 60, currentY);
        doc.text(item.descripcion, margin + 100, currentY, { width: 240 });
        doc.text(parseFloat(item.precioUnitario).toFixed(2), margin + 350, currentY, { width: 60, align: 'right' });
        doc.text(parseFloat(item.descuento || 0).toFixed(2), margin + 420, currentY, { width: 50, align: 'right' });
        doc.text(parseFloat(item.precioTotalSinImpuesto).toFixed(2), margin + 480, currentY, { width: 55, align: 'right' });
        currentY += Math.max(doc.heightOfString(item.descripcion, { width: 240 }), 15) + 5;
        doc.moveTo(margin, currentY - 2).lineTo(margin + 540, currentY - 2).strokeColor('#eeeeee').stroke().strokeColor('black');
    });

    // --- PIE DE PÁGINA ---
    const footerY = Math.max(currentY + 20, 500);
    doc.fontSize(9).font('Helvetica-Bold').text("Información Adicional / Formas de Pago", margin, footerY);
    doc.rect(margin, footerY + 15, colWidth, 80).stroke();
    let py = footerY + 25;
    pagosArr.forEach(pago => {
        let desc = pago.formaPago === '01' ? "SIN UTILIZACION DEL SISTEMA FINANCIERO" : "OTROS CON UTILIZACION DEL SISTEMA FINANCIERO";
        doc.fontSize(7).font('Helvetica').text(`${desc}:`, margin + 5, py);
        doc.text(`$${parseFloat(pago.total).toFixed(2)}`, margin + 200, py, { width: 50, align: 'right' });
        py += 12;
    });

    // Cuadro Totales
    const totalsX = margin + colWidth + 20;
    let base0 = 0, baseIVA = 0, valorIVA = 0, tarifaIVA = "15";
    impTotales.forEach(imp => {
        const base = parseFloat(imp.baseImponible || 0);
        const valor = parseFloat(imp.valor || 0);
        if (imp.codigoPorcentaje === '0') base0 += base;
        else { baseIVA += base; valorIVA += valor; tarifaIVA = imp.tarifa || "15"; }
    });

    const drawRow = (label, val, y, bold = false) => {
        doc.rect(totalsX, y, 170, 15).stroke();
        doc.rect(totalsX + 170, y, 70, 15).stroke();
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).text(label, totalsX + 5, y + 4);
        doc.text(parseFloat(val).toFixed(2), totalsX + 175, y + 4, { width: 60, align: 'right' });
    };

    let ty = footerY + 15;
    drawRow(`SUBTOTAL ${tarifaIVA}%`, baseIVA, ty); ty += 15;
    drawRow("SUBTOTAL 0%", base0, ty); ty += 15;
    drawRow("SUBTOTAL SIN IMPUESTOS", infoFac.totalSinImpuestos, ty); ty += 15;
    drawRow("TOTAL DESCUENTO", infoFac.totalDescuento || "0.00", ty); ty += 15;
    drawRow(`IVA ${tarifaIVA}%`, valorIVA, ty); ty += 15;
    drawRow("VALOR TOTAL", infoFac.importeTotal, ty, true);
}

module.exports = { generarPDFStream };