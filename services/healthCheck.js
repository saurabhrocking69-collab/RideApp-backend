'use strict';
/**
 * Platform Health Monitor
 * Runs every 5 minutes, checks critical systems, sends FCM alert on state change.
 * Set ADMIN_ALERT_PHONE in Railway env to receive phone notifications.
 */

const db         = require('../config/db');
const { sendFCM } = require('../config/firebase');

const ADMIN_PHONE  = process.env.ADMIN_ALERT_PHONE || '';
const INTERVAL_MS  = 5 * 60 * 1000;   // 5 minutes
const INIT_DELAY   = 45 * 1000;        // wait 45s after server start before first check

// Track which checks are currently in a failed state (to avoid repeated alerts)
const failing = new Set();

// ─── Individual Checks ────────────────────────────────────────────────────────

async function checkDatabase() {
  await db.query('SELECT 1');
}

async function checkFareSettingsIntegrity() {
  const res = await db.query(
    `SELECT vehicle_type, base_fare, per_km_rate FROM fare_settings`
  );
  const rows = res.rows;

  // Required vehicle types must exist
  const required = ['bike', 'auto', 'car', 'eriksha'];
  const missing = required.filter(v => !rows.find(r => r.vehicle_type === v));
  if (missing.length > 0) throw new Error(`fare_settings rows missing: ${missing.join(', ')}`);

  // No NULL on financial columns
  const nulled = rows.filter(r => r.base_fare == null || r.per_km_rate == null);
  if (nulled.length > 0) throw new Error(`NULL fare values for: ${nulled.map(r => r.vehicle_type).join(', ')}`);
}

async function checkBikeFareCalculation() {
  const res = await db.query(`SELECT base_fare, per_km_rate FROM fare_settings WHERE vehicle_type='bike' LIMIT 1`);
  if (!res.rows[0]) throw new Error('bike row missing in fare_settings');
  const bf  = parseFloat(res.rows[0].base_fare);
  const pkr = parseFloat(res.rows[0].per_km_rate);
  if (isNaN(bf) || isNaN(pkr)) throw new Error(`bike has NaN fare values (base=${res.rows[0].base_fare}, per_km=${res.rows[0].per_km_rate})`);
  const fare = Math.round((bf + 3 * pkr));
  if (isNaN(fare) || fare <= 0) throw new Error(`bike fare calculation = ${fare} for 3km (should be > 0)`);
}

async function checkDriverUpiColumn() {
  await db.query('SELECT upi_id FROM drivers LIMIT 1');
}

async function checkStuckRides() {
  const res = await db.query(
    `SELECT COUNT(*) AS cnt FROM rides
     WHERE status IN ('matched','arrived')
       AND created_at < NOW() - INTERVAL '3 hours'`
  );
  const count = parseInt(res.rows[0].cnt);
  if (count > 3) throw new Error(`${count} rides stuck in matched/arrived for >3 hours`);
}

async function checkScheduledRidesNotStuck() {
  const res = await db.query(
    `SELECT COUNT(*) AS cnt FROM scheduled_rides
     WHERE status = 'pending'
       AND scheduled_at < NOW() - INTERVAL '10 minutes'
       AND scheduled_at > NOW() - INTERVAL '24 hours'`
  );
  const count = parseInt(res.rows[0].cnt);
  if (count > 0) throw new Error(`${count} scheduled rides missed dispatch window (past due, no ride_id)`);
}

// ─── Alert Helpers ────────────────────────────────────────────────────────────

function alert(title, body, data = {}) {
  if (!ADMIN_PHONE) return;
  sendFCM(ADMIN_PHONE, title, body, { type: 'health_alert', ...data }, {}).catch(() => {});
}

// ─── Main Run Loop ────────────────────────────────────────────────────────────

const CHECKS = [
  { id: 'db',             label: 'Database Connection',         fn: checkDatabase },
  { id: 'fare_integrity', label: 'Fare Settings (NULL check)',  fn: checkFareSettingsIntegrity },
  { id: 'fare_calc',      label: 'Bike Fare Calculation',       fn: checkBikeFareCalculation },
  { id: 'upi_column',     label: 'Driver UPI Column',           fn: checkDriverUpiColumn },
  { id: 'stuck_rides',    label: 'Stuck Rides',                 fn: checkStuckRides },
  { id: 'scheduled',      label: 'Scheduled Ride Dispatch',     fn: checkScheduledRidesNotStuck },
];

async function runAllChecks() {
  const newFailures  = [];
  const newRecovered = [];

  for (const check of CHECKS) {
    try {
      await check.fn();
      if (failing.has(check.id)) {
        failing.delete(check.id);
        newRecovered.push(check.label);
      }
    } catch (err) {
      if (!failing.has(check.id)) {
        failing.add(check.id);
        newFailures.push({ label: check.label, error: err.message });
        console.error(`[HEALTH ❌] ${check.label}: ${err.message}`);
      }
    }
  }

  if (newFailures.length > 0) {
    const lines = newFailures.map(f => `❌ ${f.label}\n   ${f.error}`).join('\n');
    alert('🚨 Sppero Platform Issue', lines);
    console.error('[HEALTH] New failures:', newFailures.map(f => f.label));
  }

  if (newRecovered.length > 0) {
    alert('✅ Sppero Platform Recovered', `Back online:\n${newRecovered.map(l => `✅ ${l}`).join('\n')}`);
    console.log('[HEALTH] Recovered:', newRecovered);
  }

  if (newFailures.length === 0 && newRecovered.length === 0) {
    console.log(`[HEALTH ✅] All ${CHECKS.length} checks passed — ${new Date().toISOString()}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns current status of all checks (for /api/health endpoint)
 */
async function getStatus() {
  const results = [];
  for (const check of CHECKS) {
    try {
      await check.fn();
      results.push({ id: check.id, label: check.label, status: 'ok' });
    } catch (err) {
      results.push({ id: check.id, label: check.label, status: 'fail', error: err.message });
    }
  }
  return results;
}

function start() {
  if (!ADMIN_PHONE) {
    console.warn('[HEALTH] ADMIN_ALERT_PHONE env var not set — FCM alerts disabled. Set it in Railway to receive phone notifications.');
  }
  console.log(`[HEALTH] Monitor starting — first check in ${INIT_DELAY / 1000}s, then every ${INTERVAL_MS / 60000} min`);
  setTimeout(() => {
    runAllChecks().catch(e => console.error('[HEALTH] Unexpected error:', e.message));
    setInterval(() => {
      runAllChecks().catch(e => console.error('[HEALTH] Unexpected error:', e.message));
    }, INTERVAL_MS);
  }, INIT_DELAY);
}

module.exports = { start, getStatus, runAllChecks };
