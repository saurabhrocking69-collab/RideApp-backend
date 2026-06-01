const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS scratch_cards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        ride_id UUID,
        reward_amount DECIMAL(10,2),
        is_scratched BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ scratch_cards table ready');
    db.end();
  } catch (e) {
    console.log('Error:', e.message);
    db.end();
  }
}
  