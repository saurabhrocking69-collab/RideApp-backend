const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  try {
    const cols = [
      "ADD COLUMN IF NOT EXISTS dl_name VARCHAR(120)",
      "ADD COLUMN IF NOT EXISTS dl_photo TEXT",
      "ADD COLUMN IF NOT EXISTS vehicle_photo TEXT",
      "ADD COLUMN IF NOT EXISTS rc_photo TEXT",
      "ADD COLUMN IF NOT EXISTS aadhaar_number VARCHAR(20)",
      "ADD COLUMN IF NOT EXISTS aadhaar_photo TEXT",
      "ADD COLUMN IF NOT EXISTS face_photo TEXT",
      "ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT 'pending'",
      "ADD COLUMN IF NOT EXISTS admin_message TEXT"
    ];
    for (const c of cols) {
      await db.query(`ALTER TABLE drivers ${c}`);
    }
    console.log('✅ Driver document columns added!');
    db.end();
  } catch (e) {
    console.log('Error:', e.message);
    db.end();
  }
}
setup();