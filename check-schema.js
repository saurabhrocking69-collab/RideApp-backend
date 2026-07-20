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

async function check() {
  try {
    const users = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position`);
    console.log('=== USERS COLUMNS ===');
    console.log(users.rows.map(c => c.column_name).join(', '));

    const rides = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'rides' ORDER BY ordinal_position`);
    console.log('\n=== RIDES COLUMNS ===');
    console.log(rides.rows.map(c => c.column_name).join(', '));

    const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
    console.log('\n=== ALL TABLES ===');
    console.log(tables.rows.map(t => t.table_name).join(', '));

    db.end();
  } catch (e) {
    console.log('Error:', e.message);
    db.end();
  }
}
check();