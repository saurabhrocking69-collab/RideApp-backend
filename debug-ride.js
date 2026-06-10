const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

async function debug() {
  try {
    // Kitni stale rides hain?
    const stale = await db.query(`
      SELECT status, COUNT(*) as count
      FROM rides
      WHERE status IN ('requested', 'searching', 'matched', 'arrived', 'started')
      GROUP BY status
    `);
    console.log('=== ACTIVE/STALE RIDES ===');
    stale.rows.forEach(r => console.log(r.status, ':', r.count));

    // Sab stale rides cancel karo (cleanup)
    const result = await db.query(`
      UPDATE rides SET status = 'cancelled'
      WHERE status IN ('requested', 'searching', 'matched', 'arrived', 'started')
    `);
    console.log('\n✅ Cleaned:', result.rowCount, 'stale rides cancelled');
    db.end();
  } catch (e) {
    console.log('Error:', e.message);
    db.end();
  }
}
debug();