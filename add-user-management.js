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
    // Users table mein management columns add
    await db.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP,
        ADD COLUMN IF NOT EXISTS suspend_reason TEXT,
        ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS block_reason TEXT,
        ADD COLUMN IF NOT EXISTS admin_message TEXT,
        ADD COLUMN IF NOT EXISTS last_active TIMESTAMP DEFAULT NOW()
    `);
    console.log('✅ User management columns added');
    console.log('\n🎉 User management ready!');
    db.end();
  } catch (e) {
    console.log('❌ Error:', e.message);
    db.end();
  }
}
setup();