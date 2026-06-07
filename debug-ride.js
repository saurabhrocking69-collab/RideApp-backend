const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

async function debug() {
  try {
    // Latest matched/arrived/started ride
    const ride = await db.query(`
      SELECT r.id, r.passenger_id, r.driver_id, r.status
      FROM rides r
      ORDER BY r.created_at DESC LIMIT 3
    `);
    console.log('=== LATEST RIDES ===');
    ride.rows.forEach(r => console.log(r));

    // Test JOIN directly
    console.log('\n=== JOIN TEST ===');
    const join = await db.query(`
      SELECT r.id, r.status,
             p.name AS passenger_name, p.phone AS passenger_phone,
             d.name AS driver_name, d.phone AS driver_phone
      FROM rides r
      LEFT JOIN users p ON r.passenger_id = p.id
      LEFT JOIN users d ON r.driver_id = d.id
      ORDER BY r.created_at DESC LIMIT 3
    `);
    join.rows.forEach(r => console.log(r));
    db.end();
  } catch (e) {
    console.log('Error:', e.message);
    db.end();
  }
}
debug();