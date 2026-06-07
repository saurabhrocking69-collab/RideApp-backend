const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  try {
    // Rides table mein payment columns add
    await db.query(`
      ALTER TABLE rides
        ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20),
        ADD COLUMN IF NOT EXISTS commission_amount DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS commission_status VARCHAR(20) DEFAULT 'pending'
    `);
    console.log('✅ Payment columns added to rides');

    // Driver pending commission table
    await db.query(`
      CREATE TABLE IF NOT EXISTS driver_commissions (
        id SERIAL PRIMARY KEY,
        driver_phone VARCHAR(15),
        ride_id UUID,
        fare DECIMAL(10,2),
        commission DECIMAL(10,2),
        payment_method VARCHAR(20),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ driver_commissions table ready');

    console.log('\n🎉 Payment flow tables ready!');
    db.end();
  } catch (e) {
    console.log('❌ Error:', e.message);
    db.end();
  }
}
setup();