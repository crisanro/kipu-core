const express = require('express');
const router = express.Router();
const pool = require('../database/index');
const { authMiddleware } = require('../middlewares/auth');


/**
 * @openapi
 * /structure/establishments:
 *   get:
 *     summary: Listar establecimientos con sus puntos de emisión
 *     tags:
 *       - Establecimientos
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
 * /structure/establishments:
 *   post:
 *     summary: Crear un establecimiento
 *     description: |
 *       Registra un nuevo establecimiento vinculado al emisor autenticado.
 *       El código se normaliza automáticamente a 3 dígitos (ej: 1 → "001").
 *       Si no se proveen `nombre_comercial` o `direccion`, se usan como respaldo
 *       los datos registrados en el perfil del emisor.
 *     tags:
 *       - Establecimientos
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - codigo
 *             properties:
 *               codigo:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 999
 *                 description: "Número del establecimiento. Se formatea a 3 dígitos internamente."
 *                 example: 1
 *               nombre_comercial:
 *                 type: string
 *                 nullable: true
 *                 description: "Si se omite, se usa el nombre_comercial del emisor como respaldo."
 *                 example: "Sucursal Norte"
 *               direccion:
 *                 type: string
 *                 nullable: true
 *                 description: "Si se omite, se usa la dirección_matriz del emisor como respaldo."
 *                 example: "Av. Naciones Unidas E4-17, Quito"
 *     responses:
 *       201:
 *         description: Establecimiento creado correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 mensaje:
 *                   type: string
 *                   example: "Establecimiento creado correctamente."
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                       example: 7
 *                     emisor_id:
 *                       type: integer
 *                       example: 42
 *                     codigo:
 *                       type: string
 *                       description: "Código normalizado a 3 dígitos."
 *                       example: "001"
 *                     nombre_comercial:
 *                       type: string
 *                       example: "Sucursal Norte"
 *                     direccion:
 *                       type: string
 *                       example: "Av. Naciones Unidas E4-17, Quito"
 *       400:
 *         description: Código faltante, inválido o establecimiento duplicado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 mensaje:
 *                   type: string
 *                   example: "El establecimiento 001 ya existe para tu empresa."
 *       401:
 *         description: Token de Firebase inválido o ausente
 *       404:
 *         description: Emisor no encontrado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 mensaje:
 *                   type: string
 *                   example: "Emisor no encontrado."
 *       500:
 *         description: Error interno del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Error interno del servidor."
 */
router.post('/establishments', authMiddleware, async (req, res) => {
    const { codigo, nombre_comercial, direccion } = req.body;
    const emisor_id = req.emisor_id;

    // 1. El único campo estrictamente obligatorio ahora es el código
    if (!codigo) {
        return res.status(400).json({ ok: false, mensaje: "El código del establecimiento es obligatorio." });
    }

    // 2. Normalizar código a 3 dígitos
    const codigoInt = parseInt(codigo);
    if (isNaN(codigoInt) || codigoInt < 1 || codigoInt > 999) {
        return res.status(400).json({ ok: false, mensaje: "Código de establecimiento inválido (1-999)." });
    }
    const codigoFormateado = codigoInt.toString().padStart(3, '0');

    try {
        // 3. Obtener datos del emisor por si acaso faltan datos en el body
        const emisorRes = await pool.query(
            'SELECT nombre_comercial, direccion_matriz FROM emisores WHERE id = $1',
            [emisor_id]
        );

        if (emisorRes.rowCount === 0) {
            return res.status(404).json({ ok: false, mensaje: "Emisor no encontrado." });
        }

        const emisorData = emisorRes.rows[0];

        // 4. Lógica de respaldo (Fallback): Si no viene en el body, usa lo del emisor
        const finalNombre = nombre_comercial || emisorData.nombre_comercial;
        const finalDireccion = direccion || emisorData.direccion_matriz;

        // 5. Insertar establecimiento
        const result = await pool.query(
            `INSERT INTO establecimientos (emisor_id, codigo, nombre_comercial, direccion)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [emisor_id, codigoFormateado, finalNombre, finalDireccion]
        );

        res.status(201).json({ 
            ok: true, 
            mensaje: "Establecimiento creado correctamente.",
            data: result.rows[0] 
        });

    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ 
                ok: false, 
                mensaje: `El establecimiento ${codigoFormateado} ya existe para tu empresa.` 
            });
        }
        console.error(error);
        res.status(500).json({ ok: false, error: "Error interno del servidor." });
    }
});


/**
 * @openapi
 * /structure/emission-points:
 *   post:
 *     summary: Crear un punto de emisión
 *     description: |
 *       Registra un nuevo punto de emisión en un establecimiento específico del emisor autenticado.
 *       Los códigos se reciben ya formateados como strings de 3 dígitos ("001", "002", etc.)
 *       tal como los requiere el SRI. El secuencial arranca en 1 automáticamente.
 *     tags:
 *       - Establecimientos
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - establecimiento_codigo
 *               - codigo
 *             properties:
 *               establecimiento_codigo:
 *                 type: string
 *                 pattern: '^\d{3}$'
 *                 description: "Código del establecimiento en formato SRI (3 dígitos)."
 *                 example: "001"
 *               codigo:
 *                 type: string
 *                 pattern: '^\d{3}$'
 *                 description: "Código del punto de emisión en formato SRI (3 dígitos)."
 *                 example: "001"
 *               nombre:
 *                 type: string
 *                 nullable: true
 *                 description: "Nombre descriptivo del punto. Si se omite se genera automáticamente."
 *                 example: "Caja Principal"
 *     responses:
 *       201:
 *         description: Punto de emisión creado correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: true
 *                 mensaje:
 *                   type: string
 *                   example: "Punto de emisión 001 creado exitosamente para el establecimiento 001."
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                       example: 15
 *                     establecimiento_id:
 *                       type: integer
 *                       example: 7
 *                     codigo:
 *                       type: string
 *                       example: "001"
 *                     secuencial_actual:
 *                       type: integer
 *                       description: "Siempre inicia en 1 para puntos nuevos."
 *                       example: 1
 *                     nombre:
 *                       type: string
 *                       example: "Caja Principal"
 *       400:
 *         description: Campos faltantes o punto de emisión duplicado en ese establecimiento
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 mensaje:
 *                   type: string
 *                   example: "El punto de emisión 001 ya existe dentro del establecimiento 001."
 *       401:
 *         description: Token de Firebase inválido o ausente
 *       404:
 *         description: No existe el establecimiento con ese código para el emisor autenticado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 mensaje:
 *                   type: string
 *                   example: "No existe el establecimiento 001 registrado en tu cuenta."
 *       500:
 *         description: Error interno del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Error interno del servidor."
 */
router.post('/emission-points', authMiddleware, async (req, res) => {
    // Recibimos los códigos tal cual los requiere el SRI (ej: "001")
    const { establecimiento_codigo, codigo, nombre } = req.body;
    const emisor_id = req.emisor_id;

    if (!establecimiento_codigo || !codigo) {
        return res.status(400).json({ ok: false, mensaje: "Los códigos de establecimiento y punto son obligatorios." });
    }

    try {
        // 1. Buscamos el ID interno del establecimiento del emisor usando el código string ("001")
        const estabRes = await pool.query(
            'SELECT id FROM establecimientos WHERE emisor_id = $1 AND codigo = $2',
            [emisor_id, establecimiento_codigo]
        );

        if (estabRes.rowCount === 0) {
            return res.status(404).json({ 
                ok: false, 
                mensaje: `No existe el establecimiento ${establecimiento_codigo} registrado en tu cuenta.` 
            });
        }

        const db_establecimiento_id = estabRes.rows[0].id;

        // 2. Insertamos el punto de emisión
        // Forzamos el secuencial inicial a 1
        const result = await pool.query(
            `INSERT INTO puntos_emision (establecimiento_id, codigo, secuencial_actual, nombre)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [db_establecimiento_id, codigo, 1, nombre || `Punto ${codigo}`]
        );

        res.status(201).json({ 
            ok: true, 
            mensaje: `Punto de emisión ${codigo} creado exitosamente para el establecimiento ${establecimiento_codigo}.`,
            data: result.rows[0] 
        });

    } catch (error) {
        // Error de duplicado: El par (establecimiento_id, codigo) debe ser único
        if (error.code === '23505') {
            return res.status(400).json({ 
                ok: false, 
                mensaje: `El punto de emisión ${codigo} ya existe dentro del establecimiento ${establecimiento_codigo}.` 
            });
        }
        console.error(error);
        res.status(500).json({ ok: false, error: "Error interno del servidor." });
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





