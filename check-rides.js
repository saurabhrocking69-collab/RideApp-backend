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
  SELECT r.id, r.pickup, r.drop_location, r.ride_type, r.status, r.driver_id
  FROM rides r
  WHERE r.status = 'requested'
  ORDER BY r.created_at DESC
  LIMIT 5
`)
.then(r => { console.log('Requested rides:', JSON.stringify(r.rows, null, 2)); db.end(); })
.catch(e => { console.log('Error:', e.message); db.end(); });