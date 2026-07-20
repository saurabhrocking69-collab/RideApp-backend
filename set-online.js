require('dotenv').config();
if (!process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) {
  console.error('\u274c Set DATABASE_PUBLIC_URL or DATABASE_URL in your environment before running this script.');
  process.exit(1);
}
const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

db.query(`UPDATE drivers SET is_online = true`)
  .then(r => { console.log('✅ Saare drivers online:', r.rowCount, 'rows'); db.end(); })
  .catch(e => { console.log('❌ Error:', e.message); db.end(); });