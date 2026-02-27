const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');

/**
 * @openapi
 * /structure/establishments:
 *   get:
 *     summary: Listar establecimientos del emisor
 *     tags: [Structure]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de establecimientos obtenida correctamente
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
 *     summary: Crear un nuevo establecimiento
 *     tags: [Structure]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [codigo]
 *             properties:
 *               codigo:
 *                 type: string
 *                 description: Código de 3 dígitos (ej. 001, 002)
 *               nombre_comercial:
 *                 type: string
 *               direccion:
 *                 type: string
 *     responses:
 *       201:
 *         description: Establecimiento creado correctamente
 *       400:
 *         description: Código inválido o ya registrado
 *       500:
 *         description: Error interno del servidor
 */
router.get('/establishments', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM establecimientos 
             WHERE emisor_id = $1 
             ORDER BY codigo ASC`,
            [req.emisor_id]
        );
        res.json({ ok: true, data: result.rows });
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
 * @route GET /structure/issuing-points
 * Lista puntos de emisión filtrados por emisor (usando JOIN)
 */
router.get('/issuing-points', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT p.*, e.codigo as estab_codigo 
             FROM puntos_emision p
             JOIN establecimientos e ON p.establecimiento_id = e.id
             WHERE e.emisor_id = $1
             ORDER BY e.codigo ASC, p.codigo ASC`,
            [req.emisor_id]
        );
        res.json({ ok: true, data: result.rows });
    } catch (error) {
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
