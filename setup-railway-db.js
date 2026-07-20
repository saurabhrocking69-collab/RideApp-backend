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
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(15) UNIQUE NOT NULL,
        name VARCHAR(100),
        role VARCHAR(10),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS drivers (
        id UUID PRIMARY KEY REFERENCES users(id),
        vehicle_type VARCHAR(20),
        vehicle_no VARCHAR(20) UNIQUE,
        license_no VARCHAR(30) UNIQUE,
        is_verified BOOLEAN DEFAULT false,
        is_online BOOLEAN DEFAULT false,
        rating DECIMAL(3,2) DEFAULT 5.00
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS rides (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        passenger_id UUID REFERENCES users(id),
        driver_id UUID REFERENCES drivers(id),
        pickup TEXT,
        drop_location TEXT,
        ride_type VARCHAR(20),
        fare DECIMAL(10,2),
        status VARCHAR(20) DEFAULT 'searching',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS driver_wallet (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        driver_id UUID UNIQUE REFERENCES drivers(id),
        balance DECIMAL(12,2) DEFAULT 0.00,
        total_earned DECIMAL(12,2) DEFAULT 0.00,
        total_withdrawn DECIMAL(12,2) DEFAULT 0.00,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id UUID REFERENCES rides(id),
        amount DECIMAL(10,2),
        method VARCHAR(20),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ All tables created!');
    db.end();
  } catch(e) {
    console.log('Error:', e.message);
    db.end();
  }
}
setup();