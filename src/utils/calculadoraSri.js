// src/calculadoraSri.js

// Mapeo de códigos SRI actualizado al 2026
const CODIGOS_IVA = {
    0:  { codigo: '2', codigoPorcentaje: '0' }, // 0%
    12: { codigo: '2', codigoPorcentaje: '2' }, // 12%
    15: { codigo: '2', codigoPorcentaje: '4' }, // 15% (Esencial para evitar tu error)
    5:  { codigo: '2', codigoPorcentaje: '5' }  // 5% (Construcción)
};

/**
 * Recibe items simples y devuelve la estructura compleja del SRI
 */
function calcularTotalesEImpuestos(items) {
    let totalSinImpuestos = 0;
    let totalDescuento = 0;
    const impuestosAcumulados = {};

    const detallesXml = items.map(item => {
        const cantidad = parseFloat(item.cantidad);
        const precioUnitario = parseFloat(item.precioUnitario || item.precio || 0);
        const descuento = parseFloat(item.descuento || 0);

        const precioTotalSinImpuesto = (cantidad * precioUnitario) - descuento;
        totalSinImpuestos += precioTotalSinImpuesto;
        totalDescuento += descuento;

        // --- LÓGICA DE NORMALIZACIÓN DE TARIFA ---
        let tarifaRaw = 0;
        if (item.tarifaIva !== undefined) {
            tarifaRaw = parseFloat(item.tarifaIva);
        } else if (item.impuestos && item.impuestos.length > 0) {
            tarifaRaw = parseFloat(item.impuestos[0].tarifa || 0);
        }

        // Si mandas 0.15, lo convertimos a 15. Si mandas 15, se queda en 15.
        const tarifa = (tarifaRaw > 0 && tarifaRaw < 1) ? tarifaRaw * 100 : tarifaRaw;

        // Buscamos en el mapa. Si no existe (ej. mandaste 50), por seguridad cae en IVA 0
        const infoSri = CODIGOS_IVA[tarifa] || CODIGOS_IVA[0];
        
        const valorImpuesto = precioTotalSinImpuesto * (tarifa / 100);

        // Acumular para el bloque <totalConImpuestos>
        if (!impuestosAcumulados[tarifa]) {
            impuestosAcumulados[tarifa] = {
                codigo: infoSri.codigo,
                codigoPorcentaje: infoSri.codigoPorcentaje,
                baseImponible: 0,
                valor: 0,
                tarifa: tarifa
            };
        }
        impuestosAcumulados[tarifa].baseImponible += precioTotalSinImpuesto;
        impuestosAcumulados[tarifa].valor += valorImpuesto;

        return {
            codigoPrincipal: item.codigoPrincipal || item.codigo,
            descripcion: item.descripcion || item.nombre,
            cantidad: cantidad.toFixed(2),
            precioUnitario: precioUnitario.toFixed(2),
            descuento: descuento.toFixed(2),
            precioTotalSinImpuesto: precioTotalSinImpuesto.toFixed(2),
            impuestos: { // El SRI espera un objeto o array dependiendo del parser, usualmente objeto
                impuesto: {
                    codigo: infoSri.codigo,
                    codigoPorcentaje: infoSri.codigoPorcentaje,
                    tarifa: tarifa.toString(),
                    baseImponible: precioTotalSinImpuesto.toFixed(2),
                    valor: valorImpuesto.toFixed(2)
                }
            }
        };
    });

    const totalConImpuestosXml = Object.values(impuestosAcumulados).map(imp => ({
        codigo: imp.codigo,
        codigoPorcentaje: imp.codigoPorcentaje,
        baseImponible: imp.baseImponible.toFixed(2),
        valor: imp.valor.toFixed(2)
    }));

    const totalIvaGeneral = Object.values(impuestosAcumulados).reduce((sum, imp) => sum + imp.valor, 0);
    const importeTotal = totalSinImpuestos + totalIvaGeneral;

    let subtotal_0 = 0;
    let subtotal_iva = 0;
    Object.values(impuestosAcumulados).forEach(imp => {
        if (imp.tarifa === 0) {
            subtotal_0 += imp.baseImponible;
        } else {
            subtotal_iva += imp.baseImponible;
        }
    });

    return {
        detallesXml,
        totalConImpuestosXml,
        totales: {
            totalSinImpuestos: totalSinImpuestos.toFixed(2),
            totalDescuento: totalDescuento.toFixed(2),
            importeTotal: importeTotal.toFixed(2),
            totalIva: totalIvaGeneral.toFixed(2),
            subtotal_0: subtotal_0.toFixed(2),
            subtotal_iva: subtotal_iva.toFixed(2)
        }
    };
}

module.exports = { calcularTotalesEImpuestos };