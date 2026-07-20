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

async function addColumn() {
  try {
    await db.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS start_otp VARCHAR(4)
    `);
    console.log('✅ start_otp column added!');
    db.end();
  } catch (e) {
    console.log('Error:', e.message);
    db.end();
  }
}
addColumn();