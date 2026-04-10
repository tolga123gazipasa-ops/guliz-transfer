require('dotenv').config();
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME     || 'guliz_transfer',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || '',
    });

pool.on('error', (err) => console.error('PostgreSQL bağlantı hatası:', err));
module.exports = pool;
