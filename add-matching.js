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

async function setup() {
  try {
    // Driver live location table
    await db.query(`
      CREATE TABLE IF NOT EXISTS driver_locations (
        phone VARCHAR(15) PRIMARY KEY,
        lat DECIMAL(10,7),
        lng DECIMAL(10,7),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ driver_locations table ready');

    // Driver metrics for matching
    await db.query(`
      CREATE TABLE IF NOT EXISTS driver_metrics (
        phone VARCHAR(15) PRIMARY KEY,
        rides_offered INT DEFAULT 0,
        rides_accepted INT DEFAULT 0,
        rides_cancelled INT DEFAULT 0,
        idle_since TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ driver_metrics table ready');

    console.log('\n🎉 Matching tables ready!');
    db.end();
  } catch (e) {
    console.log('❌ Error:', e.message);
    db.end();
  }
}
setup();