'use strict';
const db = require('./db');

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_rides_status          ON rides(status)',
  'CREATE INDEX IF NOT EXISTS idx_rides_status_type     ON rides(status, ride_type)',
  'CREATE INDEX IF NOT EXISTS idx_rides_driver_id       ON rides(driver_id)',
  'CREATE INDEX IF NOT EXISTS idx_rides_passenger_id    ON rides(passenger_id)',
  'CREATE INDEX IF NOT EXISTS idx_rides_created_at      ON rides(created_at)',
];

async function runMigrations() {
  for (const sql of INDEXES) {
    try {
      await db.query(sql);
    } catch (e) {
      console.error('[MIGRATION] Failed:', sql.slice(0, 60), '—', e.message);
    }
  }
  console.log(`[MIGRATION] ✅ ${INDEXES.length} ride indexes ensured`);
}

module.exports = { runMigrations };
