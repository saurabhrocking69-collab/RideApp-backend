const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});
db.query(`
  SELECT u.name, u.phone, d.vehicle_type, d.verification_status, d.is_online
  FROM drivers d
  JOIN users u ON d.id = u.id
  WHERE u.phone = '7854236984'
`).then(r => {
  console.log(JSON.stringify(r.rows, null, 2));
  db.end();
}).catch(e => {
  console.log('Error:', e.message);
  db.end();
});