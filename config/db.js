const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: parseInt(process.env.DB_POOL_MAX || '10'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

db.connect()
  .then(() => console.log('✅ PostgreSQL connected!'))
  .catch(err => console.log('❌ PostgreSQL error:', err.message));

module.exports = db;
