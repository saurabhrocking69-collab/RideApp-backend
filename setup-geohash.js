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
    // Geohash cell column - approx 1.2km x 0.6km cells (precision 6)
    await db.query(`
      ALTER TABLE driver_locations
        ADD COLUMN IF NOT EXISTS geocell VARCHAR(12)
    `);
    console.log('✅ geocell column added');

    // Index on geocell for fast lookup
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_driver_geocell ON driver_locations(geocell)
    `);
    console.log('✅ geocell index created');

    // Index on online + vehicle for filtering
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_driver_loc_updated ON driver_locations(updated_at)
    `);
    console.log('✅ updated_at index created');

    console.log('\n🎉 Geohash grid system ready!');
    console.log('Ab driver location store hote waqt geocell calculate hoga');
    console.log('Ride matching sirf nearby cells check karega = FAST even with 50k drivers');
    db.end();
  } catch (e) {
    console.log('❌ Error:', e.message);
    db.end();
  }
}
setup();