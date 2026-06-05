const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  try {
    // PostGIS extension enable karo
    await db.query('CREATE EXTENSION IF NOT EXISTS postgis');
    console.log('✅ PostGIS extension enabled!');

    // Test - version check
    const v = await db.query('SELECT PostGIS_Version()');
    console.log('PostGIS version:', v.rows[0].postgis_version);

    // driver_locations mein geography point add karo
    await db.query(`
      ALTER TABLE driver_locations 
        ADD COLUMN IF NOT EXISTS geo GEOGRAPHY(POINT, 4326)
    `);
    console.log('✅ geo column added to driver_locations');

    // Spatial index — yeh milliseconds search ke liye
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_driver_geo ON driver_locations USING GIST(geo)
    `);
    console.log('✅ Spatial GIST index created');

    console.log('\n🎉 PostGIS ready for production-scale matching!');
    db.end();
  } catch (e) {
    console.log('❌ Error:', e.message);
    console.log('\nAgar PostGIS nahi mila toh hum manual haversine use karenge (thoda slow but works)');
    db.end();
  }
}
setup();