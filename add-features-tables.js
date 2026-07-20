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

async function setup() {
  try {
    // 1. Promo codes table
    await db.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(30) UNIQUE NOT NULL,
        discount_type VARCHAR(10) DEFAULT 'percent',
        discount_value DECIMAL(10,2) NOT NULL,
        max_discount DECIMAL(10,2) DEFAULT 100,
        min_fare DECIMAL(10,2) DEFAULT 0,
        usage_limit INT DEFAULT 1000,
        used_count INT DEFAULT 0,
        active BOOLEAN DEFAULT true,
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ promo_codes table ready');

    // Default promo codes
    await db.query(`
      INSERT INTO promo_codes (code, discount_type, discount_value, max_discount, min_fare)
      VALUES
        ('RIDE50', 'percent', 50, 75, 50),
        ('FLAT20', 'flat', 20, 20, 40),
        ('FIRST100', 'percent', 100, 100, 0)
      ON CONFLICT (code) DO NOTHING
    `);
    console.log('✅ Default promo codes added');

    // 2. Promo usage tracking
    await db.query(`
      CREATE TABLE IF NOT EXISTS promo_usage (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        promo_code VARCHAR(30),
        ride_id UUID,
        discount_applied DECIMAL(10,2),
        used_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ promo_usage table ready');

    // 3. Referral system
    await db.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id UUID REFERENCES users(id),
        referred_id UUID REFERENCES users(id),
        referral_code VARCHAR(20),
        reward_amount DECIMAL(10,2) DEFAULT 50,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ referrals table ready');

    // Add referral_code to users
    await db.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE
    `);
    console.log('✅ users.referral_code added');

    // 4. Chat messages
    await db.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id SERIAL PRIMARY KEY,
        ride_id UUID NOT NULL,
        sender VARCHAR(20) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ chat_messages table ready');

    // 5. Pickup/drop coordinates in rides
    await db.query(`
      ALTER TABLE rides
        ADD COLUMN IF NOT EXISTS pickup_lat DECIMAL(10,7),
        ADD COLUMN IF NOT EXISTS pickup_lng DECIMAL(10,7),
        ADD COLUMN IF NOT EXISTS drop_lat DECIMAL(10,7),
        ADD COLUMN IF NOT EXISTS drop_lng DECIMAL(10,7),
        ADD COLUMN IF NOT EXISTS discount DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS promo_code VARCHAR(30)
    `);
    console.log('✅ rides coordinates + promo columns added');

    // 6. Driver daily targets
    await db.query(`
      CREATE TABLE IF NOT EXISTS driver_targets (
        id SERIAL PRIMARY KEY,
        rides_target INT DEFAULT 10,
        bonus_amount DECIMAL(10,2) DEFAULT 200,
        active BOOLEAN DEFAULT true
      )
    `);
    await db.query(`
      INSERT INTO driver_targets (rides_target, bonus_amount)
      SELECT 10, 200
      WHERE NOT EXISTS (SELECT 1 FROM driver_targets)
    `);
    console.log('✅ driver_targets table ready');

    // 7. Saved places
    await db.query(`
      CREATE TABLE IF NOT EXISTS saved_places (
        id SERIAL PRIMARY KEY,
        user_id UUID REFERENCES users(id),
        label VARCHAR(30),
        address TEXT,
        lat DECIMAL(10,7),
        lng DECIMAL(10,7),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ saved_places table ready');

    // 8. SOS alerts
    await db.query(`
      CREATE TABLE IF NOT EXISTS sos_alerts (
        id SERIAL PRIMARY KEY,
        user_id UUID,
        ride_id UUID,
        lat DECIMAL(10,7),
        lng DECIMAL(10,7),
        type VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ sos_alerts table ready');

    // 9. Admin broadcast notifications
    await db.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        target VARCHAR(20) DEFAULT 'all',
        title VARCHAR(100),
        message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ notifications table ready');

    console.log('\n🎉 SAARE TABLES READY!');
    db.end();
  } catch (e) {
    console.log('❌ Error:', e.message);
    db.end();
  }
}

setup();
