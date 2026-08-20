'use strict';
// High-value ride advance payments (fare > ADVANCE_THRESHOLD): customer pays
// 1/3 online at booking; platform holds it, takes its commission from it at
// completion (so the driver never carries a big cash-commission debt), and
// refunds it (minus tiered penalty) on cancellation.
const crypto = require('crypto');
const db = require('../config/db');
const { shortRideId } = require('./rideId');
const razorpay = require('../config/razorpay');

const ADVANCE_THRESHOLD = 3000;   // fare estimate above this requires an advance
const ADVANCE_FRACTION  = 1 / 3;  // 1/3 upfront

// ── Idempotent schema ─────────────────────────────────────────────────────────
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS advance_amount NUMERIC DEFAULT 0').catch(() => {});
// none | paid | refunded | partial_refund | forfeited | held (post-start dispute)
db.query("ALTER TABLE rides ADD COLUMN IF NOT EXISTS advance_status TEXT DEFAULT 'none'").catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS advance_order_id TEXT').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS advance_payment_id TEXT').catch(() => {});
/* One paid advance backs exactly one ride. Without this a rider could pay a
   single advance and attach the same order_id to booking after booking — the
   verify step only ever asked whether the order was paid, never whether it had
   already been spent. The index is the guard that actually holds, because two
   simultaneous bookings racing on the same order cannot both insert.
   If this ever fails to build, rides already share an order id and that is
   worth knowing loudly rather than swallowing. */
db.query(`CREATE UNIQUE INDEX IF NOT EXISTS rides_advance_order_id_uniq
            ON rides (advance_order_id) WHERE advance_order_id IS NOT NULL`)
  .catch(e => console.error('[advance] advance_order_id unique index NOT created — check for rides already sharing one:', e.message));

// Emergency mid-trip cancellations → funds held, admin adjudicates within 2 days.
db.query(`
  CREATE TABLE IF NOT EXISTS ride_disputes (
    id             SERIAL PRIMARY KEY,
    ride_id        TEXT NOT NULL,
    customer_phone TEXT,
    driver_phone   TEXT,
    reason         TEXT,
    held_advance   NUMERIC DEFAULT 0,
    fare           NUMERIC DEFAULT 0,
    status         TEXT DEFAULT 'pending',   -- pending | resolved | auto_refunded
    admin_penalty  NUMERIC,
    admin_refund   NUMERIC,
    driver_credit  NUMERIC,
    admin_note     TEXT,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    resolved_at    TIMESTAMPTZ
  )
`).catch(() => {});
// 'emergency_cancel' (default, existing) | 'parcel_not_delivered' — lets the
// admin portal tell the two dispute shapes apart in the same table/list.
db.query("ALTER TABLE ride_disputes ADD COLUMN IF NOT EXISTS dispute_type TEXT DEFAULT 'emergency_cancel'").catch(() => {});
// Where the driver (and therefore the package) was when the complaint was
// filed. driver_locations only keeps a current position per phone and is
// overwritten continuously, so this snapshot is the only durable record of it
// by the time an admin reviews the case.
db.query('ALTER TABLE ride_disputes ADD COLUMN IF NOT EXISTS driver_lat NUMERIC').catch(() => {});
db.query('ALTER TABLE ride_disputes ADD COLUMN IF NOT EXISTS driver_lng NUMERIC').catch(() => {});
db.query('ALTER TABLE ride_disputes ADD COLUMN IF NOT EXISTS driver_seen_at TIMESTAMPTZ').catch(() => {});

// Credit a driver's wallet (used when admin awards the driver part of a dispute).
async function creditDriverWallet(client, driverPhone, amount, note, rideId = null) {
  const q = client || db;
  const u = await q.query('SELECT id FROM users WHERE phone=$1', [driverPhone]);
  if (!u.rows[0]) return false;
  const driverId = u.rows[0].id;
  await q.query('INSERT INTO driver_wallet (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING', [driverId]);
  await q.query('UPDATE driver_wallet SET balance = balance + $1, total_earned = total_earned + $1 WHERE driver_id = $2', [amount, driverId]);
  // Ledger line for the driver's wallet history. Until this existed, every
  // caller passed a descriptive `note` that was accepted and silently
  // dropped: the balance moved with nothing anywhere explaining why, so the
  // driver app could only ever show an aggregate, never a statement.
  await logDriverTxn(q, driverPhone, 'credit', amount, note, rideId);
  return true;
}

// ── Driver wallet ledger ────────────────────────────────────────────────────
// Keyed on driver_phone (TEXT), matching driver_commissions, rather than a
// driver_id FK — the two credit paths resolve the driver differently and the
// id column type isn't consistent across environments, so the phone is the
// one join key every driver-facing query already uses.
db.query(`
  CREATE TABLE IF NOT EXISTS driver_transactions (
    id           SERIAL PRIMARY KEY,
    driver_phone TEXT NOT NULL,
    type         TEXT NOT NULL,              -- 'credit' | 'debit'
    amount       NUMERIC NOT NULL,
    description  TEXT,
    ride_id      INTEGER,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => db.query('CREATE INDEX IF NOT EXISTS idx_driver_txn_phone ON driver_transactions (driver_phone, created_at DESC)')).catch(() => {});

async function logDriverTxn(client, driverPhone, type, amount, description, rideId = null) {
  if (!driverPhone || !(parseFloat(amount) > 0)) return;
  const q = client || db;
  // This runs inside the caller's payment transaction. In Postgres a failed
  // statement aborts the WHOLE transaction — every later statement, including
  // the COMMIT, then fails — so simply catching the error here would NOT keep
  // a broken history line from killing the payment that wraps it. The
  // savepoint confines the damage: on failure we roll back just this insert
  // and the outer transaction stays usable and commits normally. The balance
  // update is the source of truth; this is only the readable trail.
  const inTxn = !!client;
  try {
    if (inTxn) await q.query('SAVEPOINT driver_txn_log');
    await q.query(
      'INSERT INTO driver_transactions (driver_phone, type, amount, description, ride_id) VALUES ($1,$2,$3,$4,$5)',
      [driverPhone, type, amount, description || null, rideId]
    );
    if (inTxn) await q.query('RELEASE SAVEPOINT driver_txn_log');
  } catch (e) {
    if (inTxn) await q.query('ROLLBACK TO SAVEPOINT driver_txn_log').catch(() => {});
    console.error('[wallet] driver txn log failed:', e.message);
  }
}

function advanceForFare(fare) {
  return Math.round((parseFloat(fare) || 0) * ADVANCE_FRACTION);
}
function requiresAdvance(fare) {
  return (parseFloat(fare) || 0) > ADVANCE_THRESHOLD;
}

// Verify a Razorpay payment signature + that the order was actually paid, and
// return the authoritative amount (rupees) captured — never trust the client.
async function verifyAdvancePayment({ order_id, payment_id, signature, expectAtLeast = 0 }) {
  if (!order_id || !payment_id || !signature) return { ok: false, error: 'Missing advance payment fields' };
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${order_id}|${payment_id}`).digest('hex');
  if (expected !== signature) return { ok: false, error: 'Invalid advance payment signature' };
  try {
    const order = await razorpay.orders.fetch(order_id);
    if (order.status !== 'paid') return { ok: false, error: 'Advance not captured yet' };
    const paid = order.amount / 100;

    /* Is it ENOUGH? This used to stop at "an order was paid" and hand the
       amount back unchecked. /api/advance/order builds the order from a fare
       the CLIENT states, so someone could ask for an order on a ₹3,001 trip
       (advance ₹1,000), pay that, and then book a ride the server prices at
       ₹20,000 — where the advance owed is ₹6,667 — and the booking went
       through on the ₹1,000. The caller passes what it actually expects, and
       the amount is measured against that. */
    if (expectAtLeast > 0 && paid + 1 < expectAtLeast) {
      return {
        ok: false,
        error: `This trip needs an advance of ₹${Math.round(expectAtLeast)} — ₹${Math.round(paid)} was paid`,
        amount: paid, required: Math.round(expectAtLeast),
      };
    }

    /* Has it been spent already? Nothing checked, and advance_order_id had no
       unique index, so one paid advance could be attached to ride after ride:
       pay ₹1,000 once and keep booking high-value trips with the same
       order/payment/signature. The index below is the real guard (it is atomic,
       so two simultaneous bookings cannot both win); this lookup exists to give
       a person a sentence they can understand instead of a constraint error. */
    const used = await db.query('SELECT 1 FROM rides WHERE advance_order_id = $1 LIMIT 1', [order_id]);
    if (used.rows[0]) return { ok: false, error: 'That advance payment has already been used for another booking' };

    return { ok: true, amount: paid };
  } catch (_e) {
    return { ok: false, error: 'Could not verify advance payment' };
  }
}

// Verify a Razorpay payment for the FULL amount (no advance fraction) — used
// by parcel booking-time escrow payment. Same signature/capture verification
// as verifyAdvancePayment, just without the 1/3 math.
async function verifyOnlinePayment({ order_id, payment_id, signature, expectAtLeast = 0 }) {
  if (!order_id || !payment_id || !signature) return { ok: false, error: 'Missing payment fields' };
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${order_id}|${payment_id}`).digest('hex');
  if (expected !== signature) return { ok: false, error: 'Invalid payment signature' };
  try {
    const order = await razorpay.orders.fetch(order_id);
    if (order.status !== 'paid') return { ok: false, error: 'Payment not captured yet' };
    const paid = order.amount / 100;
    // Same two gaps as the advance path: was it enough, and was it already
    // spent on another booking. See verifyAdvancePayment for the detail.
    if (expectAtLeast > 0 && paid + 1 < expectAtLeast) {
      return {
        ok: false,
        error: `This booking needs ₹${Math.round(expectAtLeast)} — ₹${Math.round(paid)} was paid`,
        amount: paid, required: Math.round(expectAtLeast),
      };
    }
    const used = await db.query('SELECT 1 FROM rides WHERE advance_order_id = $1 LIMIT 1', [order_id]);
    if (used.rows[0]) return { ok: false, error: 'That payment has already been used for another booking' };
    return { ok: true, amount: paid };
  } catch (_e) {
    return { ok: false, error: 'Could not verify payment' };
  }
}

// Credit a refund to the customer's wallet (used by cancellation tiers).
// Runs inside the caller's transaction client when provided.
async function refundToWallet(client, customerPhone, amount, rideId, note) {
  const q = client || db;
  const u = await q.query('SELECT id FROM users WHERE phone=$1', [customerPhone]);
  if (!u.rows[0]) return false;
  const userId = u.rows[0].id;
  await q.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  await q.query('UPDATE customer_wallet SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2', [amount, userId]);
  await q.query("INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'credit',$2,$3)",
    [userId, amount, `${note} (${shortRideId(rideId)})`]);
  return true;
}

module.exports = {
  ADVANCE_THRESHOLD, ADVANCE_FRACTION,
  advanceForFare, requiresAdvance, verifyAdvancePayment, verifyOnlinePayment, refundToWallet, creditDriverWallet, logDriverTxn, razorpay,
};
