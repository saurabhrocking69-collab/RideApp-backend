const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

async function addColumn() {
  try {
    await db.query(`
      ALTER TABLE rides
      ADD COLUMN IF NOT EXISTS start_otp VARCHAR(4)
    `);
    console.log('✅ start_otp column added!');
    db.end();
  } catch (e) {
    console.log('Error:', e.message);
    db.end();
  }
}
addColumn();