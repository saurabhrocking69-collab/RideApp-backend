const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
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