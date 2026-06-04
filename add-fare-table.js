const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

db.query(`
  CREATE TABLE IF NOT EXISTS fare_settings (
    id SERIAL PRIMARY KEY,
    vehicle_type VARCHAR(20) UNIQUE NOT NULL,
    base_fare DECIMAL(10,2) DEFAULT 25,
    per_km_rate DECIMAL(10,2) DEFAULT 12,
    night_multiplier DECIMAL(4,2) DEFAULT 1.5,
    night_start TIME DEFAULT '22:00',
    night_end TIME DEFAULT '06:00',
    updated_at TIMESTAMP DEFAULT NOW()
  );

  INSERT INTO fare_settings (vehicle_type, base_fare, per_km_rate, night_multiplier)
  VALUES
    ('auto',    25, 12, 1.5),
    ('bike',    15,  8, 1.3),
    ('car',     40, 15, 1.8),
    ('eriksha', 20, 10, 1.4)
  ON CONFLICT (vehicle_type) DO NOTHING;
`)
.then(() => { console.log('✅ fare_settings table ready!'); db.end(); })
.catch(e => { console.log('❌ Error:', e.message); db.end(); });