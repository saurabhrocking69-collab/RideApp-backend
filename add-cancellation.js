const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  try {
    // Cancellation log
    await db.query(`
      CREATE TABLE IF NOT EXISTS cancellations (
        id SERIAL PRIMARY KEY,
        ride_id UUID,
        cancelled_by VARCHAR(20),
        reason TEXT,
        seconds_after_book INT,
        seconds_after_accept INT,
        penalty_applied DECIMAL(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ cancellations table ready');

    // Customer metrics
    await db.query(`
      CREATE TABLE IF NOT EXISTS customer_metrics (
        phone VARCHAR(15) PRIMARY KEY,
        total_rides INT DEFAULT 0,
        total_cancels INT DEFAULT 0,
        cancels_today INT DEFAULT 0,
        last_cancel_date DATE,
        trust_score INT DEFAULT 100,
        is_flagged BOOLEAN DEFAULT false
      )
    `);
    console.log('✅ customer_metrics table ready');

    // Driver suspension tracking
    await db.query(`
      ALTER TABLE driver_metrics
        ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP,
        ADD COLUMN IF NOT EXISTS cancels_today INT DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_cancel_date DATE,
        ADD COLUMN IF NOT EXISTS acceptance_rate DECIMAL(5,2) DEFAULT 100,
        ADD COLUMN IF NOT EXISTS cancellation_rate DECIMAL(5,2) DEFAULT 0
    `);
    console.log('✅ driver_metrics suspension columns added');

    console.log('\n🎉 Cancellation system tables ready!');
    db.end();
  } catch (e) {
    console.log('❌ Error:', e.message);
    db.end();
  }
}
setup();