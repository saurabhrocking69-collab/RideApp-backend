const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../config/db');
const razorpay = require('../config/razorpay');
const { sendFCM } = require('../config/firebase');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/create-order
// Creates a Razorpay order for ride payment. Returns order_id + key_id.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create-order', async (req, res) => {
  if (!razorpay)
    return res.status(500).json({ success: false, error: 'Payment gateway configured nahi hai — admin se contact karo' });
  const { amount, ride_id } = req.body;
  if (!amount || amount < 1)
    return res.status(400).json({ success: false, error: 'Valid amount chahiye' });
  try {
    const receipt = ('ride_' + String(ride_id)).substring(0, 40);
    const order = await razorpay.orders.create({ amount: Math.round(amount * 100), currency: 'INR', receipt });
    res.json({ success: true, order_id: order.id, amount: order.amount, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/verify
// Verifies Razorpay HMAC signature after ride payment checkout.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify', async (req, res) => {
  const { ride_id, razorpay_payment_id, razorpay_order_id, razorpay_signature, payment_id, amount, method } = req.body;
  const pid = razorpay_payment_id || payment_id;
  try {
    if (razorpay_order_id && razorpay_signature && process.env.RAZORPAY_KEY_SECRET) {
      const expected = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpay_order_id}|${pid}`)
        .digest('hex');
      if (expected !== razorpay_signature)
        return res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }
    await db.query(
      "INSERT INTO payments (ride_id, amount, method, status) VALUES ($1,$2,$3,'completed') ON CONFLICT DO NOTHING",
      [ride_id, amount, method || 'online']
    );
    res.json({ success: true, message: 'Payment verified!' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/razorpay-webhook
// Exported separately so server.js can mount it BEFORE express.json() to
// receive the raw Buffer needed for HMAC signature verification.
// ─────────────────────────────────────────────────────────────────────────────
async function webhookHandler(req, res) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature   = req.headers['x-razorpay-signature'];
    const expectedSig = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
    if (signature !== expectedSig) {
      console.warn('⚠️ Razorpay webhook: invalid signature — rejected');
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }
  }

  let event;
  try {
    // req.body is a raw Buffer here (mounted before express.json in server.js)
    event = JSON.parse(req.body.toString());
  } catch (_e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  try {
    // ── payment.captured → wallet top-up ─────────────────────────────────
    if (event.event === 'payment.captured') {
      const payment = event?.payload?.payment?.entity;
      if (payment) {
        const paymentId   = payment.id;
        const phone       = payment.notes?.phone;
        const paymentType = payment.notes?.type;
        // Skip wallet credit for non-wallet-recharge payments
        if (paymentType === 'buddy_fund' || paymentType === 'subscription') {
          console.log(`ℹ️ Webhook skipping wallet credit for ${paymentType} payment ${paymentId}`);
          return res.json({ status: 'ok' });
        }
        if (phone && payment.amount) {
          // Idempotency: skip if already confirmed
          const dup = await db.query("SELECT id FROM razorpay_topups WHERE payment_id=$1 AND status='confirmed'", [paymentId]);
          if (dup.rows.length === 0) {
            const rupees = payment.amount / 100;
            const user   = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
            if (user.rows[0]) {
              const userId = user.rows[0].id;
              const client = await db.connect();
              try {
                await client.query('BEGIN');
                await client.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
                await client.query('UPDATE customer_wallet SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2', [rupees, userId]);
                await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,$3)",
                  [userId, rupees, `Wallet recharge ₹${rupees} (webhook – ${paymentId})`]);
                await client.query("INSERT INTO razorpay_topups (user_phone,amount,payment_id,status) VALUES ($1,$2,$3,'confirmed')",
                  [phone, rupees, paymentId]);
                await client.query('COMMIT');
                console.log(`✅ Webhook wallet topup: ${phone} +₹${rupees} (${paymentId})`);
                sendFCM(phone, '✅ Wallet Recharged!', `₹${rupees} aapke wallet mein add ho gaya!`,
                  { type: 'wallet_topup', amount: String(rupees) }, { role: 'customer' }).catch(() => {});
              } catch (e) {
                await client.query('ROLLBACK');
                console.error('❌ Webhook wallet topup failed:', e.message);
              } finally { client.release(); }
            }
          }
        }
      }
    }

    // ── payout.processed / failed / reversed → driver payout status ──────
    if (['payout.processed', 'payout.failed', 'payout.reversed'].includes(event.event)) {
      const rp = event?.payload?.payout?.entity;
      if (rp?.id) {
        const poRes = await db.query(
          `SELECT dp.*, u.id AS driver_user_id
           FROM driver_payouts dp
           JOIN users u ON u.phone = dp.driver_phone
           WHERE dp.razorpay_payout_id = $1`,
          [rp.id]
        );
        const po = poRes.rows[0];
        if (po) {
          if (event.event === 'payout.processed') {
            const utr = rp.utr || rp.id;
            await db.query(
              `UPDATE driver_payouts SET status='completed', razorpay_status='processed',
               transaction_ref=$1, settled_at=NOW() WHERE razorpay_payout_id=$2`,
              [utr, rp.id]
            );
            sendFCM(po.driver_phone, '✅ Payout Successful!',
              `₹${parseFloat(po.amount - (po.commission_deducted || 0)).toFixed(0)} aapke ${po.method === 'upi' ? 'UPI' : 'bank account'} mein credit ho gaya! UTR: ${utr}`,
              { type: 'payout_success', utr, payout_id: String(po.id) }, { role: 'driver' }).catch(() => {});
          } else {
            const amt          = parseFloat(po.amount);
            const commDeducted = parseFloat(po.commission_deducted || 0);
            const actualPayout = amt - commDeducted;
            const failReason   = rp.failure_reason || (event.event === 'payout.reversed' ? 'Reversed by bank' : 'Transfer failed');
            await db.query(
              `UPDATE driver_payouts SET status='failed', razorpay_status=$1,
               admin_note=COALESCE(admin_note,'') || $2 WHERE razorpay_payout_id=$3`,
              [rp.status || 'failed', ` | Failure: ${failReason}`, rp.id]
            );
            // Restore wallet balance on payout failure
            await db.query(
              `UPDATE driver_wallet SET balance=balance+$1,
               total_withdrawn=GREATEST(0, total_withdrawn-$2),
               pending_commission=COALESCE(pending_commission,0)+$3
               WHERE driver_id=$4`,
              [amt, actualPayout, commDeducted, po.driver_user_id]
            ).catch(() => {});
            if (commDeducted > 0) {
              await db.query(
                `UPDATE driver_commissions SET status='cash_owed' WHERE driver_phone=$1 AND status='settled'`,
                [po.driver_phone]
              ).catch(() => {});
            }
            sendFCM(po.driver_phone, '❌ Payout Failed',
              `Aapka ₹${parseFloat(amt).toFixed(0)} payout fail ho gaya (${failReason}). Amount wallet mein wapas aa gaya.`,
              { type: 'payout_failed', reason: failReason, payout_id: String(po.id) }, { role: 'driver' }).catch(() => {});
          }
        }
      }
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('❌ Razorpay webhook handler error:', err.message);
    res.status(500).json({ error: 'Payment process mein error — support se contact karo' });
  }
}

// Also mount on the router for completeness (server.js direct mount takes precedence)
router.post('/razorpay-webhook', express.raw({ type: 'application/json' }), webhookHandler);

module.exports = router;
module.exports.webhookHandler = webhookHandler;
