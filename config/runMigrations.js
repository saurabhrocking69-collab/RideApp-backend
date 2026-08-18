'use strict';
const db = require('./db');

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_rides_status          ON rides(status)',
  'CREATE INDEX IF NOT EXISTS idx_rides_status_type     ON rides(status, ride_type)',
  'CREATE INDEX IF NOT EXISTS idx_rides_driver_id       ON rides(driver_id)',
  'CREATE INDEX IF NOT EXISTS idx_rides_passenger_id    ON rides(passenger_id)',
  'CREATE INDEX IF NOT EXISTS idx_rides_created_at      ON rides(created_at)',
];

/* Columns that live queries reference directly. An index being late only makes
   a query slow; a COLUMN being late makes it throw — and `p.call_phone` is read
   by the driver's active-ride lookup on every poll. Creating it lazily inside
   the endpoint that writes it would mean the very first deploy answers every
   driver with an error until someone happens to open that screen. */
const COLUMNS = [
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS call_phone VARCHAR(15)',
];

async function runMigrations() {
  for (const sql of COLUMNS) {
    try {
      await db.query(sql);
    } catch (e) {
      console.error('[MIGRATION] Failed:', sql.slice(0, 60), '—', e.message);
    }
  }
  for (const sql of INDEXES) {
    try {
      await db.query(sql);
    } catch (e) {
      console.error('[MIGRATION] Failed:', sql.slice(0, 60), '—', e.message);
    }
  }
  console.log(`[MIGRATION] ✅ ${COLUMNS.length} column(s) + ${INDEXES.length} ride indexes ensured`);
}

module.exports = { runMigrations };
