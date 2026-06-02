const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

db.query(`
  SELECT r.id, r.pickup, r.drop_location, r.ride_type, r.status, r.driver_id
  FROM rides r
  WHERE r.status = 'requested'
  ORDER BY r.created_at DESC
  LIMIT 5
`)
.then(r => { console.log('Requested rides:', JSON.stringify(r.rows, null, 2)); db.end(); })
.catch(e => { console.log('Error:', e.message); db.end(); });