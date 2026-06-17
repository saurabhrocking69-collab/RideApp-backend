const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/db');
const razorpay = require('../config/razorpay');
const { sendFCM } = require('../config/firebase');

// POST /api/payment/create-order
router.post('/create-order', async (req, res) => {
  const { amount, ride_id } = req.body;
  try {
    const order = await razorpay.orders.create({ amount: Math.round(amount * 100), currency: 'INR', receipt: 'ride_' + ride_id });
    res.json({ success: true, order_id: order.id, amount: order.amount, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/payment/verify
router.post('/verify', async (req, res) => {
  const { ride_id, razorpay_payment_id, razorpay_order_id, razorpay_signature, payment_id, amount, method } = req.body;
  const pid = razorpay_payment_id || payment_id;
  try {
    if (razorpay_order_id && razorpay_signature && process.env.RAZORPAY_KEY_SECRET) {
      const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${pid}`).digest('hex');
      if (expected !== razorpay_signature) return res.status(400).json({ success: false, error: 'Invalid payment signature' });
    }
    await db.query("INSERT INTO payments (ride_id, amount, method, status) VALUES ($1, $2, $3, 'completed') ON CONFLICT DO NOTHING", [ride_id, amount, method || 'online']);
    res.json({ success: true, message: 'Payment verified!' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/payment/razorpay-webhook
// Uses express.raw middleware — mounted separately in server.js with raw body parser
router.post('/razorpay-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = req.headers['x-razorpay-signature'];
    const expectedSig = crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex');
    if (signature !== expectedSig) return res.status(400).json({ error: 'Invalid webhook signature' });
  }
  try {
    const event = JSON.parse(req.body.toString());
    const payment = event?.payload?.payment?.entity;
    if (!payment) return res.json({ status: 'ignored' });
    if (event.event === 'payment.captured') {
      const paymentId = payment.id;
      const phone = payment.notes?.phone;
      const orderRes = await db.query("SELECT id FROM razorpay_topups WHERE payment_id=$1 AND status='confirmed'", [paymentId]);
      if (orderRes.rows.length === 0 && phone && payment.amount) {
        const rupees = payment.amount / 100;
        const user = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
        if (user.rows[0]) {
          const userId = user.rows[0].id;
          const dup = await db.query("SELECT id FROM razorpay_topups WHERE payment_id=$1", [paymentId]);
          if (dup.rows.length === 0) {
            await db.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
            await db.query('UPDATE customer_wallet SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2', [rupees, userId]);
            await db.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,$3)", [userId, rupees, `Wallet recharge ₹${rupees} via webhook (${paymentId})`]);
            await db.query("INSERT INTO razorpay_topups (user_phone,amount,payment_id,status) VALUES ($1,$2,$3,'confirmed')", [phone, rupees, paymentId]);
            sendFCM(phone, '✅ Wallet Recharge!', `₹${rupees} aapke wallet mein add ho gaya!`, { type: 'wallet_topup', amount: String(rupees) });
          }
        }
      }
    }
    res.json({ status: 'ok' });
  } catch (err) { console.error('Webhook error:', err.message); res.status(500).json({ error: err.message }); }
});

module.exports = router;
