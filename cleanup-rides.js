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

async function cleanup() {
  try {
    const result = await db.query(`
      UPDATE rides
      SET status = 'cancelled'
      WHERE status IN ('searching','requested','matched','arrived','started')
    `);
    console.log('✅ Purani rides clean kar di:', result.rowCount, 'rides cancelled');
    db.end();
  } catch (e) {
    console.log('Error:', e.message);
    db.end();
  }
}
cleanup();