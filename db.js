const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: false
  }
});

// Buat fungsi query yang akan diexport
const query = (text, params) => pool.query(text, params);

// Export semua yang dibutuhkan
module.exports = {
  pool,
  query,
  testConnection: async () => {
    try {
      const client = await pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      return true;
    } catch (err) {
      console.error('Database connection error:', err);
      return false;
    }
  }
};
