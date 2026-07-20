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