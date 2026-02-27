const { Pool } = require('pg');
require('dotenv').config();

// El Pool gestiona múltiples conexiones para que no se sature tu RAM de 8GB
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Configuraciones de optimización para servidores con recursos limitados
    max: 10, 
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
    console.log('[Database] Conexión establecida exitosamente');
});

pool.on('error', (err) => {
    console.error('[Database] Error inesperado en el pool:', err);
});

module.exports = {
    // Para consultas rápidas de una sola línea
    query: (text, params) => pool.query(text, params),
    
    // Para transacciones seguras (BEGIN, COMMIT, ROLLBACK)
    connect: () => pool.connect(), 
    
    // Exportamos el pool completo por si se necesita en otro lado
    pool

};
