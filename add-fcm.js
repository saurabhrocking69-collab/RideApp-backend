const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  try {
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT`);
    console.log('✅ FCM token column added');
    db.end();
  } catch (e) {
    console.log('❌ Error:', e.message);
    db.end();
  }
}
setup();