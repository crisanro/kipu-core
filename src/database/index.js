const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,  // Subido de 2000 a 5000
    keepAlive: true,                // Previene el ECONNRESET
    keepAliveInitialDelayMillis: 10000
});

pool.on('connect', () => {
    // console.log('[Database] Conexión establecida exitosamente');
});

pool.on('error', (err) => {
    console.error('[Database] Error inesperado en el pool:', err.message);
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    connect: () => pool.connect(),
    pool
};