'use strict';
// High-value ride advance payments (fare > ADVANCE_THRESHOLD): customer pays
// 1/3 online at booking; platform holds it, takes its commission from it at
// completion (so the driver never carries a big cash-commission debt), and
// refunds it (minus tiered penalty) on cancellation.
const crypto = require('crypto');
const db = require('../config/db');
const razorpay = require('../config/razorpay');

const ADVANCE_THRESHOLD = 3000;   // fare estimate above this requires an advance
const ADVANCE_FRACTION  = 1 / 3;  // 1/3 upfront

// ── Idempotent schema ─────────────────────────────────────────────────────────
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS advance_amount NUMERIC DEFAULT 0').catch(() => {});
// none | paid | refunded | partial_refund | forfeited | held (post-start dispute)
db.query("ALTER TABLE rides ADD COLUMN IF NOT EXISTS advance_status TEXT DEFAULT 'none'").catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS advance_order_id TEXT').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS advance_payment_id TEXT').catch(() => {});

function advanceForFare(fare) {
  return Math.round((parseFloat(fare) || 0) * ADVANCE_FRACTION);
}
function requiresAdvance(fare) {
  return (parseFloat(fare) || 0) > ADVANCE_THRESHOLD;
}

// Verify a Razorpay payment signature + that the order was actually paid, and
// return the authoritative amount (rupees) captured — never trust the client.
async function verifyAdvancePayment({ order_id, payment_id, signature }) {
  if (!order_id || !payment_id || !signature) return { ok: false, error: 'Missing advance payment fields' };
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${order_id}|${payment_id}`).digest('hex');
  if (expected !== signature) return { ok: false, error: 'Invalid advance payment signature' };
  try {
    const order = await razorpay.orders.fetch(order_id);
    if (order.status !== 'paid') return { ok: false, error: 'Advance not captured yet' };
    return { ok: true, amount: order.amount / 100 };
  } catch (_e) {
    return { ok: false, error: 'Could not verify advance payment' };
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
    [userId, amount, `${note} (ride ${rideId})`]);
  return true;
}

module.exports = {
  ADVANCE_THRESHOLD, ADVANCE_FRACTION,
  advanceForFare, requiresAdvance, verifyAdvancePayment, refundToWallet, razorpay,
};
