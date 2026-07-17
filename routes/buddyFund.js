const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../config/db');
const razorpay = require('../config/razorpay');

// GET /api/buddy-fund/stats
router.get('/stats', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT
        COALESCE(SUM(amount) FILTER (WHERE status='paid'), 0)  AS total_raised,
        COUNT(*)           FILTER (WHERE status='paid')        AS contributor_count
       FROM buddy_fund_contributions`
    );
    res.json({
      total_raised:      parseFloat(r.rows[0].total_raised),
      contributor_count: parseInt(r.rows[0].contributor_count, 10),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/buddy-fund/create-order
router.post('/create-order', async (req, res) => {
  try {
    const { phone, amount } = req.body || {};
    const amt = parseFloat(amount);
    if (!amt || amt < 1 || amt > 10000)
      return res.status(400).json({ error: 'Amount must be between 1 and 10,000' });
    if (!razorpay)
      return res.status(500).json({ error: 'Payment gateway not configured' });

    const order = await razorpay.orders.create({
      amount:   Math.round(amt * 100),
      currency: 'INR',
      receipt:  `buddy_${Date.now()}`,
      notes:    { phone: phone || 'anonymous', type: 'buddy_fund' },
    });

    await db.query(
      `INSERT INTO buddy_fund_contributions
         (contributor_phone, amount, razorpay_order_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [phone || null, amt, order.id]
    );

    res.json({ success: true, order_id: order.id, amount: order.amount, currency: 'INR', key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('[BUDDY_FUND] create-order:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/buddy-fund/verify
router.post('/verify', async (req, res) => {
  try {
    const { phone, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing payment fields' });

    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Invalid payment signature' });

    const upd = await db.query(
      `UPDATE buddy_fund_contributions
          SET status='paid', razorpay_payment_id=$1
        WHERE razorpay_order_id=$2 AND status='pending'
       RETURNING amount`,
      [razorpay_payment_id, razorpay_order_id]
    );
    if (!upd.rows[0]) return res.status(404).json({ error: 'Contribution record not found' });

    const statsR = await db.query(
      `SELECT
        COALESCE(SUM(amount) FILTER (WHERE status='paid'), 0) AS total_raised,
        COUNT(*)           FILTER (WHERE status='paid')       AS contributor_count
       FROM buddy_fund_contributions`
    );

    res.json({
      success:           true,
      amount:            parseFloat(upd.rows[0].amount),
      total_raised:      parseFloat(statsR.rows[0].total_raised),
      contributor_count: parseInt(statsR.rows[0].contributor_count, 10),
    });
  } catch (err) {
    console.error('[BUDDY_FUND] verify:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/buddy-fund/admin/stats — detailed for admin panel
router.get('/admin/stats', async (req, res) => {
  try {
    const overview = await db.query(
      `SELECT
        COALESCE(SUM(amount) FILTER (WHERE status='paid'), 0)  AS total_raised,
        COUNT(*)           FILTER (WHERE status='paid')        AS contributor_count,
        COALESCE(SUM(amount) FILTER (WHERE status='paid' AND DATE(created_at)=CURRENT_DATE), 0) AS today,
        COALESCE(SUM(amount) FILTER (WHERE status='paid' AND DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW())), 0) AS this_month
       FROM buddy_fund_contributions`
    );
    const recent = await db.query(
      `SELECT contributor_phone, amount, created_at
       FROM buddy_fund_contributions WHERE status='paid'
       ORDER BY created_at DESC LIMIT 20`
    );
    res.json({ overview: overview.rows[0], recent: recent.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
