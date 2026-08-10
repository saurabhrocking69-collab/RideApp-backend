const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const db       = require('../config/db');
const razorpay = require('../config/razorpay');
const { vehicleCategoryFor, activateQueuedSubscription } = require('../services/subscription');
const userAuth = require('../middleware/userAuth');
const ownPhone = require('../middleware/ownPhone');

// GET /api/subscriptions/plans?vehicle_category=auto
router.get('/plans', async (req, res) => {
  try {
    const { vehicle_category } = req.query;
    const q = vehicle_category
      ? `SELECT * FROM subscription_plans WHERE is_active=true AND vehicle_category=$1 ORDER BY sort_order, ride_count`
      : `SELECT * FROM subscription_plans WHERE is_active=true ORDER BY vehicle_category, sort_order, ride_count`;
    const r = vehicle_category ? await db.query(q, [vehicle_category]) : await db.query(q);
    res.json({ plans: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/subscriptions/my?phone=xxx
// Returns active plan, queued plan, savings so far, and vehicle_category
router.get('/my', userAuth, ownPhone(), async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'phone required' });

    // Get driver vehicle type (drivers.id = users.id, phone is on users)
    const drRes = await db.query(
      `SELECT d.vehicle_type FROM drivers d JOIN users u ON d.id = u.id WHERE u.phone=$1 LIMIT 1`,
      [phone]
    );
    const vehicle_category = drRes.rows[0] ? vehicleCategoryFor(drRes.rows[0].vehicle_type) : null;

    // Active subscription
    const activeRes = await db.query(
      `SELECT ds.*, sp.name AS plan_name, sp.ride_count AS plan_rides
       FROM driver_subscriptions ds
       JOIN subscription_plans sp ON ds.plan_id=sp.id
       WHERE ds.driver_phone=$1 AND ds.status='active' AND ds.rides_remaining>0 AND ds.expires_at>NOW()
       ORDER BY ds.starts_at ASC LIMIT 1`,
      [phone]
    );

    // Queued subscription (next plan)
    const queuedRes = await db.query(
      `SELECT ds.*, sp.name AS plan_name, sp.ride_count AS plan_rides
       FROM driver_subscriptions ds
       JOIN subscription_plans sp ON ds.plan_id=sp.id
       WHERE ds.driver_phone=$1 AND ds.status='queued'
       ORDER BY ds.created_at ASC LIMIT 1`,
      [phone]
    );

    // Total savings (commission saved across all subscriptions)
    const savingsRes = await db.query(
      `SELECT COALESCE(SUM(srl.commission_saved), 0) AS total_saved
       FROM subscription_ride_log srl
       JOIN driver_subscriptions ds ON ds.id=srl.subscription_id
       WHERE ds.driver_phone=$1`,
      [phone]
    );

    res.json({
      vehicle_category,
      active: activeRes.rows[0] || null,
      queued: queuedRes.rows[0] || null,
      total_savings: parseFloat(savingsRes.rows[0].total_saved),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/subscriptions/create-order
// Body: { phone, plan_id }
router.post('/create-order', userAuth, ownPhone(), async (req, res) => {
  try {
    const { phone, plan_id } = req.body || {};
    if (!phone || !plan_id) return res.status(400).json({ error: 'phone aur plan_id required hai' });
    if (!razorpay) return res.status(500).json({ error: 'Payment gateway not configured' });

    // Validate plan
    const planRes = await db.query(`SELECT * FROM subscription_plans WHERE id=$1 AND is_active=true`, [plan_id]);
    if (!planRes.rows[0]) return res.status(404).json({ error: 'Plan not found or inactive' });
    const plan = planRes.rows[0];

    // Check driver vehicle category matches plan category
    const drRes = await db.query(
      `SELECT d.vehicle_type FROM drivers d JOIN users u ON d.id = u.id WHERE u.phone=$1 LIMIT 1`,
      [phone]
    );
    if (!drRes.rows[0]) return res.status(404).json({ error: 'Driver not found' });
    const driverCat = vehicleCategoryFor(drRes.rows[0].vehicle_type);
    if (driverCat !== plan.vehicle_category) {
      return res.status(400).json({ error: `Yeh plan ${plan.vehicle_category} drivers ke liye hai` });
    }

    const amountPaise = Math.round(parseFloat(plan.price) * 100);
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `sub_${phone}_${plan_id}_${Date.now()}`,
      notes: { phone, plan_id: String(plan_id), plan_name: plan.name, type: 'subscription' },
    });

    // Create pending subscription record
    await db.query(
      `INSERT INTO driver_subscriptions (driver_phone, plan_id, vehicle_category, rides_total, rides_remaining, amount_paid, razorpay_order_id, status)
       VALUES ($1, $2, $3, $4, $4, $5, $6, 'pending')`,
      [phone, plan_id, plan.vehicle_category, plan.ride_count, parseFloat(plan.price), order.id]
    );

    res.json({ success: true, order_id: order.id, amount: order.amount, currency: 'INR', key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('[SUBSCRIPTION] create-order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subscriptions/verify
// Body: { phone, razorpay_order_id, razorpay_payment_id, razorpay_signature }
router.post('/verify', userAuth, ownPhone(), async (req, res) => {
  try {
    const { phone, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!phone || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment fields' });
    }

    // Verify HMAC signature
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Invalid payment signature' });

    // Find the pending subscription
    const subRes = await db.query(
      `SELECT * FROM driver_subscriptions WHERE driver_phone=$1 AND razorpay_order_id=$2 AND status='pending' LIMIT 1`,
      [phone, razorpay_order_id]
    );
    if (!subRes.rows[0]) return res.status(404).json({ error: 'Pending subscription not found' });
    const sub = subRes.rows[0];

    // Check if driver already has an active subscription — if yes, queue this one
    const activeRes = await db.query(
      `SELECT id FROM driver_subscriptions WHERE driver_phone=$1 AND status='active' AND rides_remaining>0 AND expires_at>NOW() LIMIT 1`,
      [phone]
    );

    if (activeRes.rows[0]) {
      // Queue this plan to start after current one expires
      await db.query(
        `UPDATE driver_subscriptions SET status='queued', razorpay_payment_id=$1 WHERE id=$2`,
        [razorpay_payment_id, sub.id]
      );
      res.json({ success: true, status: 'queued', message: 'Plan purchased! Will start after your current plan ends.' });
    } else {
      // Activate immediately — use plan's validity_days
      const planRes = await db.query(`SELECT validity_days FROM subscription_plans WHERE id=$1`, [sub.plan_id]);
      const validityDays = parseInt(planRes.rows[0]?.validity_days || 60);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);
      await db.query(
        `UPDATE driver_subscriptions SET status='active', starts_at=$1, expires_at=$2, razorpay_payment_id=$3 WHERE id=$4`,
        [now, expiresAt, razorpay_payment_id, sub.id]
      );
      res.json({ success: true, status: 'active', message: 'Subscription activated! You will now earn at 0% commission.', expires_at: expiresAt });
    }
  } catch (err) {
    console.error('[SUBSCRIPTION] verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Admin-only endpoints ───────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query._ak;
  if (!key || key !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Admin access denied' });
  next();
}

// GET /api/subscriptions/admin/plans — all plans (for admin panel)
router.get('/admin/plans', adminAuth, async (req, res) => {
  try {
    const r = await db.query(`SELECT * FROM subscription_plans ORDER BY vehicle_category, sort_order, ride_count`);
    res.json({ plans: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/subscriptions/admin/plans — create or update plan
router.post('/admin/plans', adminAuth, async (req, res) => {
  try {
    const { id, name, vehicle_category, ride_count, price, original_price, is_active, sort_order, validity_days } = req.body || {};
    const vdays = validity_days ? parseInt(validity_days) : 60;
    if (id) {
      await db.query(
        `UPDATE subscription_plans SET name=$1, vehicle_category=$2, ride_count=$3, price=$4, original_price=$5, is_active=$6, sort_order=$7, validity_days=$8 WHERE id=$9`,
        [name, vehicle_category, ride_count, price, original_price || null, is_active !== false, sort_order || 0, vdays, id]
      );
    } else {
      await db.query(
        `INSERT INTO subscription_plans (name, vehicle_category, ride_count, price, original_price, is_active, sort_order, validity_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [name, vehicle_category, ride_count, price, original_price || null, is_active !== false, sort_order || 0, vdays]
      );
    }
    const r = await db.query(`SELECT * FROM subscription_plans ORDER BY vehicle_category, sort_order, ride_count`);
    res.json({ success: true, plans: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/subscriptions/admin/subscribers — active subscribers
router.get('/admin/subscribers', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT ds.*, sp.name AS plan_name, sp.ride_count AS plan_rides,
              COALESCE(srl.saved, 0) AS total_saved
       FROM driver_subscriptions ds
       JOIN subscription_plans sp ON ds.plan_id=sp.id
       LEFT JOIN (
         SELECT subscription_id, SUM(commission_saved) AS saved FROM subscription_ride_log GROUP BY subscription_id
       ) srl ON srl.subscription_id=ds.id
       WHERE (ds.status='active' AND ds.expires_at > NOW()) OR ds.status='queued'
       ORDER BY ds.created_at DESC`
    );
    const revenue = await db.query(
      `SELECT COALESCE(SUM(amount_paid),0) AS total,
              COALESCE(SUM(CASE WHEN DATE(created_at)=CURRENT_DATE THEN amount_paid ELSE 0 END),0) AS today,
              COALESCE(SUM(CASE WHEN DATE_TRUNC('month',created_at)=DATE_TRUNC('month',NOW()) THEN amount_paid ELSE 0 END),0) AS this_month
       FROM driver_subscriptions WHERE status IN ('active','queued','expired')`
    );
    res.json({ subscribers: r.rows, revenue: revenue.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
