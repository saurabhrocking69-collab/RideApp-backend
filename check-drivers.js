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
    // Get all columns of drivers table
    const cols = await db.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'drivers' 
      ORDER BY ordinal_position
    `);
    console.log('=== DRIVERS TABLE COLUMNS ===');
    cols.rows.forEach(c => console.log(`  ${c.column_name} (${c.data_type})`));

    // Get sample data
    console.log('\n=== SAMPLE DATA (first 5 drivers) ===');
    const data = await db.query('SELECT * FROM drivers LIMIT 5');
    data.rows.forEach(d => {
      console.log(JSON.stringify(d, null, 2));
      console.log('---');
    });
    db.end();
  } catch (e) {
    console.log('Error:', e.message);
    db.end();
  }
}
check();