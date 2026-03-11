const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');


/**
 * @openapi
 * /dashboard:
 *   get:
 *     summary: Dashboard principal del emisor
 *     tags: [Dashboard]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: fecha_inicio
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *           example: "2025-01-01"
 *       - in: query
 *         name: fecha_fin
 *         required: true
 *         schema:
 *           type: string
 *           format: date
 *           example: "2025-02-14"
 *     responses:
 *       200:
 *         description: Dashboard obtenido correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     health:
 *                       type: object
 *                       properties:
 *                         ruc:
 *                           type: boolean
 *                         ambiente_produccion:
 *                           type: boolean
 *                         firma_electronica:
 *                           type: boolean
 *                         firma_vigente:
 *                           type: boolean
 *                         firma_alerta:
 *                           type: string
 *                           nullable: true
 *                         tiene_establecimiento:
 *                           type: boolean
 *                         tiene_punto_emision:
 *                           type: boolean
 *                     resumen:
 *                       type: object
 *                       properties:
 *                         total_facturas:
 *                           type: integer
 *                         subtotal_iva:
 *                           type: number
 *                         subtotal_0:
 *                           type: number
 *                         valor_iva:
 *                           type: number
 *                         importe_total:
 *                           type: number
 *                     facturas:
 *                       type: array
 *                       items:
 *                         type: object
 *       400:
 *         description: Fechas inválidas o rango mayor a 45 días
 *       500:
 *         description: Error interno del servidor
 */
router.get('/dashboard', authMiddleware, async (req, res) => {
    try {
        const { fecha_inicio, fecha_fin } = req.query;

        // --- Validación de fechas ---
        if (!fecha_inicio || !fecha_fin) {
            return res.status(400).json({ ok: false, error: 'fecha_inicio y fecha_fin son requeridas' });
        }

        const inicio = new Date(fecha_inicio);
        const fin    = new Date(fecha_fin);

        if (isNaN(inicio) || isNaN(fin)) {
            return res.status(400).json({ ok: false, error: 'Formato de fecha inválido, use YYYY-MM-DD' });
        }

        if (fin < inicio) {
            return res.status(400).json({ ok: false, error: 'fecha_fin no puede ser menor a fecha_inicio' });
        }

        const diffDays = (fin - inicio) / (1000 * 60 * 60 * 24);
        if (diffDays > 45) {
            return res.status(400).json({ ok: false, error: 'El rango máximo permitido es de 45 días' });
        }

        // --- Queries en paralelo ---
        const [emisorResult, estabResult, facturasResult] = await Promise.all([

            // 1. Datos del emisor
            pool.query(
                `SELECT ruc, ambiente, p12_path, p12_expiration
                 FROM emisores
                 WHERE id = $1`,
                [req.emisor_id]
            ),

            // 2. Conteo de establecimientos y puntos de emisión
            pool.query(
                `SELECT
                    COUNT(DISTINCT e.id)  AS total_establecimientos,
                    COUNT(DISTINCT p.id)  AS total_puntos
                 FROM establecimientos e
                 LEFT JOIN puntos_emision p ON p.establecimiento_id = e.id
                 WHERE e.emisor_id = $1`,
                [req.emisor_id]
            ),

            // 3. Facturas en el rango
            pool.query(
                `SELECT
                    i.id,
                    i.secuencial,
                    i.clave_acceso,
                    i.fecha_emision,
                    i.estado,
                    i.identificacion_comprador,
                    i.razon_social_comprador,
                    i.subtotal_iva,
                    i.subtotal_0,
                    i.valor_iva,
                    i.importe_total,
                    e.codigo  AS estab_codigo,
                    p.codigo  AS punto_codigo
                 FROM invoices i
                 JOIN puntos_emision p  ON i.punto_emision_id = p.id
                 JOIN establecimientos e ON p.establecimiento_id = e.id
                 WHERE i.emisor_id    = $1
                   AND i.fecha_emision BETWEEN $2 AND $3
                 ORDER BY i.fecha_emision DESC, i.secuencial DESC`,
                [req.emisor_id, fecha_inicio, fecha_fin]
            )
        ]);

        // --- Health checks del emisor ---
        const emisor = emisorResult.rows[0];
        const estab  = estabResult.rows[0];
        const hoy    = new Date();
        hoy.setHours(0, 0, 0, 0);

        let firma_vigente = false;
        let firma_alerta  = null;

        if (emisor.p12_expiration) {
            const expiracion = new Date(emisor.p12_expiration);
            firma_vigente = expiracion > hoy;

            if (firma_vigente) {
                const diasRestantes = Math.ceil((expiracion - hoy) / (1000 * 60 * 60 * 24));
                if (diasRestantes <= 30) {
                    firma_alerta = `Tu firma electrónica caduca en ${diasRestantes} día${diasRestantes === 1 ? '' : 's'}`;
                }
            } else {
                firma_alerta = 'Tu firma electrónica ha caducado';
            }
        }

        const health = {
            ruc:                  !!emisor.ruc,
            ambiente_produccion:  emisor.ambiente === '2',
            firma_electronica:    !!emisor.p12_path,
            firma_vigente,
            firma_alerta,
            tiene_establecimiento: parseInt(estab.total_establecimientos) > 0,
            tiene_punto_emision:   parseInt(estab.total_puntos) > 0,
        };

        // --- Resumen de totales ---
        const facturas = facturasResult.rows;
        const resumen = facturas.reduce((acc, f) => {
            acc.subtotal_iva  += parseFloat(f.subtotal_iva  || 0);
            acc.subtotal_0    += parseFloat(f.subtotal_0    || 0);
            acc.valor_iva     += parseFloat(f.valor_iva     || 0);
            acc.importe_total += parseFloat(f.importe_total || 0);
            return acc;
        }, { total_facturas: facturas.length, subtotal_iva: 0, subtotal_0: 0, valor_iva: 0, importe_total: 0 });

        // Redondear a 2 decimales
        for (const key of ['subtotal_iva', 'subtotal_0', 'valor_iva', 'importe_total']) {
            resumen[key] = Math.round(resumen[key] * 100) / 100;
        }

        res.json({ ok: true, data: { health, resumen, facturas } });

    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});


/**
 * @openapi
 * /structure/establishments:
 *   get:
 *     summary: Listar establecimientos con sus puntos de emisión
 *     tags: [Structure]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de establecimientos con puntos de emisión anidados
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       codigo:
 *                         type: string
 *                         example: "001"
 *                       nombre_comercial:
 *                         type: string
 *                       direccion:
 *                         type: string
 *                       puntos_emision:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: integer
 *                             codigo:
 *                               type: string
 *                               example: "001"
 *                             descripcion:
 *                               type: string
 *       500:
 *         description: Error interno del servidor
 */
router.get('/establishments', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT 
                e.id                AS estab_id,
                e.codigo            AS estab_codigo,
                e.nombre_comercial,
                e.direccion,
                e.is_active         AS estab_activo,
                p.id                AS punto_id,
                p.codigo            AS punto_codigo,
                p.nombre            AS punto_nombre,
                p.secuencial_actual,
                p.is_active         AS punto_activo
             FROM establecimientos e
             LEFT JOIN puntos_emision p ON p.establecimiento_id = e.id
             WHERE e.emisor_id = $1
             ORDER BY e.codigo ASC, p.codigo ASC`,
            [req.emisor_id]
        );

        const map = new Map();
        for (const row of result.rows) {
            if (!map.has(row.estab_id)) {
                map.set(row.estab_id, {
                    id:              row.estab_id,
                    codigo:          row.estab_codigo,
                    nombre_comercial: row.nombre_comercial,
                    direccion:       row.direccion,
                    is_active:       row.estab_activo,
                    puntos_emision:  []
                });
            }
            if (row.punto_id) {
                map.get(row.estab_id).puntos_emision.push({
                    id:                row.punto_id,
                    codigo:            row.punto_codigo,
                    nombre:            row.punto_nombre,
                    secuencial_actual: row.secuencial_actual,
                    is_active:         row.punto_activo
                });
            }
        }

        res.json({ ok: true, data: [...map.values()] });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

/**
 * @openapi
 * /structure/issuing-points:
 *   get:
 *     summary: Listar puntos de emisión del emisor
 *     tags: [Structure]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de puntos de emisión obtenida correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *       500:
 *         description: Error interno del servidor
 *   post:
 *     summary: Crear un nuevo punto de emisión
 *     tags: [Structure]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [establecimiento_id, codigo, nombre]
 *             properties:
 *               establecimiento_id:
 *                 type: integer
 *                 description: ID del establecimiento al que pertenece
 *               codigo:
 *                 type: string
 *                 description: Código de 3 dígitos (ej. 001, 100)
 *               nombre:
 *                 type: string
 *                 description: Nombre del punto de emisión (ej. Caja Principal)
 *     responses:
 *       201:
 *         description: Punto de emisión creado correctamente
 *       400:
 *         description: Código inválido
 *       403:
 *         description: Establecimiento no válido para este usuario
 *       500:
 *         description: Error interno del servidor
 */
router.post('/establishments', authMiddleware, async (req, res) => {
    const { codigo, nombre_comercial, direccion } = req.body;
    
    // Validación de formato SRI: 3 dígitos (001, 002, etc.)
    if (!/^\d{3}$/.test(codigo)) {
        return res.status(400).json({ ok: false, mensaje: "El código de establecimiento debe tener 3 dígitos." });
    }

    try {
        const result = await pool.query(
            `INSERT INTO establecimientos (emisor_id, codigo, nombre_comercial, direccion)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [req.emisor_id, codigo, nombre_comercial, direccion]
        );
        res.status(201).json({ ok: true, data: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ ok: false, mensaje: "Este código de establecimiento ya está registrado." });
        }
        res.status(500).json({ ok: false, error: error.message });
    }
});


/**
 * @route POST /structure/issuing-points
 * Crea un nuevo punto de emisión (Caja) para un local específico
 */
router.post('/issuing-points', authMiddleware, async (req, res) => {
    const { establecimiento_id, codigo, nombre } = req.body;

    if (!/^\d{3}$/.test(codigo)) {
        return res.status(400).json({ ok: false, mensaje: "El código de punto de emisión debe tener 3 dígitos." });
    }

    try {
        // Verificamos primero que el establecimiento pertenezca al emisor logueado
        const checkOwner = await pool.query(
            "SELECT id FROM establecimientos WHERE id = $1 AND emisor_id = $2",
            [establecimiento_id, req.emisor_id]
        );

        if (checkOwner.rowCount === 0) {
            return res.status(403).json({ ok: false, mensaje: "Establecimiento no válido para este usuario." });
        }

        const result = await pool.query(
            `INSERT INTO puntos_emision (establecimiento_id, codigo, nombre, secuencial_actual)
             VALUES ($1, $2, $3, 0)
             RETURNING *`,
            [establecimiento_id, codigo, nombre]
        );
        res.status(201).json({ ok: true, data: result.rows[0] });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

module.exports = router;

/**
 * @openapi
 * /structure/tree:
 *   get:
 *     summary: Obtener jerarquía completa (Establecimientos > Puntos de Emisión)
 *     tags: [Structure]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Árbol de estructura del emisor
 *       500:
 *         description: Error interno
 */
router.get('/tree', authMiddleware, async (req, res) => {
  const query = `
    SELECT
      e.id            AS estab_id,
      e.codigo        AS estab_codigo,
      e.nombre_comercial,
      e.direccion,
      p.id            AS punto_id,
      p.codigo        AS punto_codigo,
      p.nombre        AS punto_nombre,
      p.secuencial_actual
    FROM establecimientos e
    LEFT JOIN puntos_emision p ON e.id = p.establecimiento_id
    WHERE e.emisor_id = $1
    ORDER BY e.codigo ASC, p.codigo ASC
  `;

  try {
    const { rows } = await pool.query(query, [req.emisor_id]);

    const tree = rows.reduce((acc, row) => {
      let estab = acc.find(t => t.id === row.estab_id);

      if (!estab) {
        estab = {
          id:              row.estab_id,
          codigo:          row.estab_codigo,
          nombre_comercial: row.nombre_comercial,
          direccion:       row.direccion,
          puntos:          [],
        };
        acc.push(estab);
      }

      if (row.punto_id) {
        estab.puntos.push({
          id:         row.punto_id,
          codigo:     row.punto_codigo,
          nombre:     row.punto_nombre,
          secuencial: row.secuencial_actual,
        });
      }

      return acc;
    }, []);

    res.json({ ok: true, data: tree });

  } catch (error) {
    console.error('[GET /structure/tree]', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});



/**
 * @openapi
 * /structure/validate:
 *   post:
 *     summary: Validar si existe una combinación de establecimiento y punto de emisión
 *     tags: [Structure]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [estab_codigo, punto_codigo]
 *             properties:
 *               estab_codigo: { type: string, example: "001" }
 *               punto_codigo: { type: string, example: "001" }
 *     responses:
 *       200:
 *         description: Combinación válida
 *       404:
 *         description: Combinación no encontrada
 *       500:
 *         description: Error interno
 */
router.post('/validate', authMiddleware, async (req, res) => {
  const { estab_codigo, punto_codigo } = req.body;

  if (!estab_codigo || !punto_codigo) {
    return res.status(400).json({
      ok: false,
      error: 'estab_codigo y punto_codigo son requeridos.',
    });
  }

  const query = `
    SELECT
      p.id,
      p.secuencial_actual,
      e.direccion
    FROM puntos_emision p
    JOIN establecimientos e ON p.establecimiento_id = e.id
    WHERE e.emisor_id = $1
      AND e.codigo    = $2
      AND p.codigo    = $3
  `;

  try {
    const { rows, rowCount } = await pool.query(query, [req.emisor_id, estab_codigo, punto_codigo]);

    if (rowCount === 0) {
      return res.status(404).json({
        ok: false,
        error: 'La combinación de establecimiento y punto de emisión no existe para este emisor.',
      });
    }

    res.json({ ok: true, mensaje: 'Estructura válida', data: rows[0] });

  } catch (error) {
    console.error('[POST /structure/validate]', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }

});




