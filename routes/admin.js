const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../config/db');
const { sendFCM } = require('../config/firebase');
const { HOURLY_FARES, setSurge, getSurge } = require('../services/pricing');

// GET /api/admin/stats
router.get('/stats', async (req, res) => {
  try {
    const [users, drivers, rides, completed, revenue, todayRides, todayRevenue, hourlyCount] = await Promise.all([
      db.query("SELECT COUNT(*) FROM users WHERE NOT EXISTS (SELECT 1 FROM drivers d WHERE d.id = users.id)"),
      db.query('SELECT COUNT(*) FROM drivers'),
      db.query('SELECT COUNT(*) FROM rides'),
      db.query("SELECT COUNT(*) FROM rides WHERE status = 'completed'"),
      db.query("SELECT COALESCE(SUM(fare),0) AS total FROM rides WHERE status = 'completed'"),
      db.query("SELECT COUNT(*) FROM rides WHERE DATE(created_at) = CURRENT_DATE"),
      db.query("SELECT COALESCE(SUM(fare),0) AS total FROM rides WHERE status='completed' AND DATE(created_at)=CURRENT_DATE"),
      db.query("SELECT COUNT(*) FROM hourly_bookings WHERE status='completed'").catch(() => ({ rows: [{ count: 0 }] })),
    ]);
    res.json({
      total_customers: parseInt(users.rows[0].count),
      total_drivers:   parseInt(drivers.rows[0].count),
      total_rides:     parseInt(rides.rows[0].count),
      completed_rides: parseInt(completed.rows[0].count),
      total_revenue:   parseFloat(revenue.rows[0].total),
      today_rides:     parseInt(todayRides.rows[0].count),
      today_revenue:   parseFloat(todayRevenue.rows[0].total),
      total_hourly:    parseInt(hourlyCount.rows[0].count),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/rides
router.get('/rides', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.pickup, r.drop_location, r.fare, r.ride_type, r.status, r.created_at, r.rating, r.review,
              p.name AS passenger_name, p.phone AS passenger_phone, d.name AS driver_name
       FROM rides r LEFT JOIN users p ON r.passenger_id = p.id LEFT JOIN users d ON r.driver_id = d.id
       ORDER BY r.created_at DESC LIMIT 100`
    );
    res.json({ rides: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/drivers
router.get('/drivers', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.name, u.phone, d.vehicle_type, d.vehicle_no, d.is_online, d.rating,
              COALESCE(w.balance, 0) AS balance, COALESCE(w.total_earned, 0) AS total_earned
       FROM drivers d JOIN users u ON d.id = u.id LEFT JOIN driver_wallet w ON d.id = w.driver_id ORDER BY u.name`
    );
    res.json({ drivers: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/customers
router.get('/customers', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.name, u.phone, u.created_at, COUNT(r.id) AS total_rides, COALESCE(w.balance, 0) AS wallet_balance
       FROM users u LEFT JOIN rides r ON r.passenger_id = u.id LEFT JOIN customer_wallet w ON w.user_id = u.id
       WHERE NOT EXISTS (SELECT 1 FROM drivers d WHERE d.id = u.id)
       GROUP BY u.id, u.name, u.phone, u.created_at, w.balance ORDER BY u.created_at DESC`
    );
    res.json({ customers: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/driver-verifications
router.get('/driver-verifications', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.phone, d.vehicle_type, d.vehicle_brand, d.vehicle_model, d.vehicle_no,
              d.dl_name, d.dl_number, d.dl_photo, d.vehicle_photo, d.rc_photo, d.aadhaar_number,
              d.aadhaar_photo, d.face_photo, d.verification_status, d.admin_message
       FROM drivers d JOIN users u ON d.id = u.id
       ORDER BY CASE d.verification_status WHEN 'pending' THEN 1 WHEN 'resubmit' THEN 2 WHEN 'rejected' THEN 3 WHEN 'approved' THEN 4 ELSE 5 END, u.name`
    );
    res.json({ drivers: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/verify-driver
router.post('/verify-driver', async (req, res) => {
  const { driver_id, status, message } = req.body;
  if (!['approved','rejected','suspended','resubmit'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    await db.query('UPDATE drivers SET verification_status = $1, admin_message = $2 WHERE id::text = $3::text', [status, message || null, String(driver_id)]);
    const dr = await db.query('SELECT u.phone FROM drivers d JOIN users u ON d.id=u.id WHERE d.id::text = $1::text', [String(driver_id)]);
    if (dr.rows[0]) {
      const dPhone = dr.rows[0].phone;
      if (status === 'approved') sendFCM(dPhone, '🎉 Sppero Buddy Captain — Approved!', 'Aapke documents verify ho gaye! Ab app mein login karke rides lo.');
      else if (status === 'rejected') sendFCM(dPhone, '❌ Documents Reject Ho Gaye', message || 'Aapke documents mein problem hai.');
      else if (status === 'resubmit') sendFCM(dPhone, '📋 Documents Resubmit Karein', message || 'Admin ne kuch documents dobara maange hain.');
      else if (status === 'suspended') sendFCM(dPhone, '⚠️ Account Suspend Ho Gaya', message || 'Aapka account suspend kar diya gaya hai.');
    }
    res.json({ success: true, message: `Driver ${status} ho gaya` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/notify
router.post('/notify', async (req, res) => {
  const { target, title, message } = req.body;
  try {
    await db.query('INSERT INTO notifications (target, title, message) VALUES ($1,$2,$3)', [target || 'all', title, message]);
    res.json({ success: true, message: 'Notification bheja gaya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/analytics
router.get('/analytics', async (req, res) => {
  try {
    const daily = await db.query(`SELECT DATE(created_at) AS day, COUNT(*) AS rides, COALESCE(SUM(fare),0) AS revenue FROM rides WHERE status = 'completed' AND created_at >= CURRENT_DATE - INTERVAL '7 days' GROUP BY DATE(created_at) ORDER BY day`);
    const byType = await db.query(`SELECT ride_type, COUNT(*) AS count FROM rides WHERE status = 'completed' GROUP BY ride_type`);
    res.json({ daily: daily.rows, by_type: byType.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/set-target
router.post('/set-target', async (req, res) => {
  const { rides_target, bonus_amount } = req.body;
  try {
    await db.query('UPDATE driver_targets SET active = false');
    await db.query('INSERT INTO driver_targets (rides_target, bonus_amount, active) VALUES ($1,$2,true)', [rides_target, bonus_amount]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/cancellation-stats
router.get('/cancellation-stats', async (req, res) => {
  try {
    const byType = await db.query(`SELECT cancelled_by, COUNT(*) AS count FROM cancellations GROUP BY cancelled_by`);
    const topReasons = await db.query(`SELECT reason, COUNT(*) AS count FROM cancellations WHERE reason != '' GROUP BY reason ORDER BY count DESC LIMIT 5`);
    const flaggedCustomers = await db.query(`SELECT phone, total_cancels, trust_score FROM customer_metrics WHERE is_flagged = true ORDER BY total_cancels DESC LIMIT 10`);
    const highCancelDrivers = await db.query(`SELECT phone, rides_cancelled, cancellation_rate FROM driver_metrics WHERE cancellation_rate > 15 ORDER BY cancellation_rate DESC LIMIT 10`);
    res.json({ by_type: byType.rows, top_reasons: topReasons.rows, flagged_customers: flaggedCustomers.rows, high_cancel_drivers: highCancelDrivers.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const users = await db.query(
      `SELECT u.*, COALESCE(r.total_rides, 0) as total_rides, COALESCE(r.total_fare, 0) as total_fare, cm.trust_score, cm.total_cancels, cm.is_flagged
       FROM users u
       LEFT JOIN (SELECT passenger_id, COUNT(*) as total_rides, SUM(fare) as total_fare FROM rides WHERE status = 'completed' GROUP BY passenger_id) r ON u.id = r.passenger_id
       LEFT JOIN customer_metrics cm ON u.phone = cm.phone
       WHERE NOT EXISTS (SELECT 1 FROM drivers d WHERE d.id = u.id) ORDER BY u.created_at DESC`
    );
    res.json({ users: users.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users/suspend
router.post('/users/suspend', async (req, res) => {
  const { phone, hours, reason } = req.body;
  try {
    const suspendedUntil = hours ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
    await db.query(`UPDATE users SET is_suspended = true, suspended_until = $1, suspend_reason = $2 WHERE phone = $3`, [suspendedUntil, reason || 'Admin action', phone]);
    res.json({ success: true, message: hours ? `${hours} ghante ke liye suspend kiya` : 'Suspend kiya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users/unsuspend
router.post('/users/unsuspend', async (req, res) => {
  const { phone } = req.body;
  try {
    await db.query(`UPDATE users SET is_suspended = false, suspended_until = NULL, suspend_reason = NULL WHERE phone = $1`, [phone]);
    res.json({ success: true, message: 'Unsuspend kiya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users/block
router.post('/users/block', async (req, res) => {
  const { phone, reason } = req.body;
  try {
    await db.query(`UPDATE users SET is_blocked = true, block_reason = $1 WHERE phone = $2`, [reason || 'Admin action', phone]);
    res.json({ success: true, message: 'Block kiya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users/unblock
router.post('/users/unblock', async (req, res) => {
  const { phone } = req.body;
  try {
    await db.query(`UPDATE users SET is_blocked = false, block_reason = NULL WHERE phone = $1`, [phone]);
    res.json({ success: true, message: 'Unblock kiya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/users/message
router.post('/users/message', async (req, res) => {
  const { phone, message } = req.body;
  try {
    await db.query(`UPDATE users SET admin_message = $1 WHERE phone = $2`, [message, phone]);
    try { await db.query(`INSERT INTO notifications (user_phone, title, body, created_at) VALUES ($1, 'Admin Message', $2, NOW())`, [phone, message]); } catch (_e) {}
    res.json({ success: true, message: 'Message bheja gaya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/commissions
router.get('/commissions', async (req, res) => {
  try {
    const [collected, pending, wallets, recent] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM driver_commission_payments WHERE status='paid'`),
      db.query(`SELECT COALESCE(SUM(pending_commission),0) as total, COUNT(*) as count FROM driver_wallet WHERE pending_commission > 0`),
      db.query(`SELECT u.name, u.phone, w.pending_commission, w.total_earned FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE w.pending_commission > 0 ORDER BY w.pending_commission DESC LIMIT 20`),
      db.query(`SELECT dcp.*, u.name, u.phone FROM driver_commission_payments dcp JOIN users u ON dcp.driver_phone = u.phone ORDER BY dcp.created_at DESC LIMIT 20`).catch(() => ({ rows: [] })),
    ]);
    res.json({ collected: collected.rows[0], pending: pending.rows[0], pending_drivers: wallets.rows, recent: recent.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const [users, drivers, rides, revenue, wallets, hourly, topups] = await Promise.all([
      db.query("SELECT COUNT(*) AS total FROM users u WHERE NOT EXISTS (SELECT 1 FROM drivers d WHERE d.id = u.id)"),
      db.query("SELECT COUNT(*) AS total, COUNT(CASE WHEN is_online THEN 1 END) AS online FROM drivers"),
      db.query("SELECT COUNT(*) AS total, COUNT(CASE WHEN status='completed' THEN 1 END) AS completed, COALESCE(SUM(CASE WHEN status='completed' THEN fare END),0) AS gross_revenue FROM rides"),
      db.query("SELECT COALESCE(SUM(commission_amount),0) AS platform_commission FROM rides WHERE status='completed'"),
      db.query("SELECT (SELECT COALESCE(SUM(balance),0) FROM customer_wallet) AS customer_wallets, (SELECT COALESCE(SUM(balance),0) FROM driver_wallet) AS driver_wallets"),
      db.query("SELECT COUNT(*) AS total, COUNT(CASE WHEN status='completed' THEN 1 END) AS completed, COALESCE(SUM(CASE WHEN status='completed' THEN total_fare END),0) AS hourly_revenue FROM hourly_bookings").catch(() => ({ rows: [{ total: 0, completed: 0, hourly_revenue: 0 }] })),
      db.query("SELECT COALESCE(SUM(amount),0) AS total FROM razorpay_topups WHERE status IN ('confirmed','unverified')").catch(() => ({ rows: [{ total: 0 }] })),
    ]);
    res.json({
      customers: parseInt(users.rows[0].total),
      drivers: { total: parseInt(drivers.rows[0].total), online: parseInt(drivers.rows[0].online) },
      rides: { total: parseInt(rides.rows[0].total), completed: parseInt(rides.rows[0].completed), gross_revenue: parseFloat(rides.rows[0].gross_revenue) },
      hourly: { total: parseInt(hourly.rows[0].total), completed: parseInt(hourly.rows[0].completed), revenue: parseFloat(hourly.rows[0].hourly_revenue) },
      platform_commission: parseFloat(revenue.rows[0].platform_commission),
      wallets: { customer_total: parseFloat(wallets.rows[0]?.customer_wallets || 0), driver_total: parseFloat(wallets.rows[0]?.driver_wallets || 0) },
      topup_total: parseFloat(topups.rows[0].total),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/all-transactions
router.get('/all-transactions', async (req, res) => {
  const { limit = 100, offset = 0, type } = req.query;
  try {
    let q = `SELECT t.id, t.type, t.amount, t.description, t.created_at, u.name, u.phone FROM transactions t JOIN users u ON t.user_id=u.id`;
    const params = [];
    if (type) { q += ` WHERE t.type=$1`; params.push(type); }
    q += ` ORDER BY t.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const result = await db.query(q, params);
    const count = await db.query(`SELECT COUNT(*) FROM transactions${type ? " WHERE type=$1" : ""}`, type ? [type] : []);
    res.json({ transactions: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/topups
router.get('/topups', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM razorpay_topups ORDER BY created_at DESC LIMIT 200');
    res.json({ topups: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/topups/verify/:id
router.post('/topups/verify/:id', async (req, res) => {
  try {
    await db.query("UPDATE razorpay_topups SET status='verified' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/hourly-disputes
router.get('/hourly-disputes', async (req, res) => {
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE dispute_raised=true ORDER BY id DESC");
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/resolve-dispute
router.post('/resolve-dispute', async (req, res) => {
  const { booking_id, favour } = req.body;
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id=$1 AND dispute_raised=true', [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'Disputed booking nahi mila' });
    const b = r.rows[0];
    if (favour === 'driver') {
      const { HOURLY_FARES: HF, getSurge: GS } = require('../services/pricing');
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const extraKm = Math.max(0, (b.actual_km || 0) - parseFloat(b.km_included));
        const extraCharge = extraKm * (HF[b.vehicle_type]?.extra || 8);
        const totalFare = parseFloat(b.base_fare) + extraCharge;
        const commission = Math.round(totalFare * 0.12 * 100) / 100;
        const driverEarning = Math.round((totalFare - commission) * 100) / 100;
        const driverUser = await client.query('SELECT id FROM users WHERE phone=$1', [b.driver_phone]);
        if (driverUser.rows[0]) await client.query('UPDATE driver_wallet SET balance=balance+$1, total_earned=total_earned+$1 WHERE driver_id=$2', [driverEarning, driverUser.rows[0].id]);
        await client.query(`UPDATE hourly_bookings SET status='completed', ended_at=NOW(), driver_earning=$1, platform_fee=$2, total_fare=$3, payment_status='released', dispute_raised=false WHERE id=$4`, [driverEarning, commission, totalFare, booking_id]);
        await client.query('COMMIT');
        sendFCM(b.driver_phone, '✅ Dispute Resolved in Your Favour', `₹${driverEarning.toFixed(0)} wallet mein add ho gaya!`);
        return res.json({ success: true, resolved: 'driver', driver_earning: driverEarning });
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } else {
      const cu = await db.query('SELECT id FROM users WHERE phone=$1', [b.customer_phone]);
      if (cu.rows[0]) {
        await db.query('UPDATE customer_wallet SET balance=balance+$1 WHERE user_id=$2', [b.base_fare, cu.rows[0].id]);
        await db.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Hourly dispute resolved - full refund')", [cu.rows[0].id, b.base_fare]);
      }
      await db.query("UPDATE hourly_bookings SET status='cancelled', payment_status='refunded', dispute_raised=false WHERE id=$1", [booking_id]);
      sendFCM(b.customer_phone, '✅ Dispute Resolved', `₹${b.base_fare} aapke wallet mein wapas!`);
      sendFCM(b.driver_phone, '❌ Dispute Against You', 'Customer ko refund mil gaya');
      return res.json({ success: true, resolved: 'customer', refunded: b.base_fare });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM marketing_campaigns ORDER BY created_at DESC');
    res.json({ campaigns: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/campaigns
router.post('/campaigns', async (req, res) => {
  const { title, body, target, type, promo_code, cta_label, expires_at } = req.body;
  if (!title) return res.status(400).json({ error: 'Title zaroori hai' });
  try {
    const r = await db.query(
      `INSERT INTO marketing_campaigns (title,body,target,type,promo_code,cta_label,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, body || '', target || 'all', type || 'banner', promo_code || null, cta_label || null, expires_at || null]
    );
    res.json({ success: true, campaign: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/campaigns/toggle/:id
router.post('/campaigns/toggle/:id', async (req, res) => {
  try {
    const r = await db.query('UPDATE marketing_campaigns SET active=NOT active WHERE id=$1 RETURNING active', [req.params.id]);
    res.json({ success: true, active: r.rows[0]?.active });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/campaigns/:id
router.delete('/campaigns/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM marketing_campaigns WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/notify-all
router.post('/notify-all', async (req, res) => {
  const { title, body, target } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title aur body zaroori hai' });
  try {
    let roleFilter = '';
    if (target === 'customers') roleFilter = "WHERE role='passenger'";
    else if (target === 'drivers') roleFilter = "WHERE role='driver'";
    const users = await db.query(`SELECT phone, fcm_token FROM users ${roleFilter} WHERE fcm_token IS NOT NULL`);
    res.json({ success: true, total_targets: users.rows.length, message: 'Notification bheja ja raha hai...' });
    let sent = 0, failed = 0;
    for (const u of users.rows) {
      try { await sendFCM(u.phone, title, body); sent++; } catch (_e) { failed++; }
    }
    console.log(`📣 Broadcast done: ${sent} sent, ${failed} failed`);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/referrals
router.get('/referrals', async (req, res) => {
  try {
    const [total, completed, totalReward, topReferrers, recent] = await Promise.all([
      db.query('SELECT COUNT(*) AS cnt FROM referrals'),
      db.query("SELECT COUNT(*) AS cnt FROM referrals WHERE status='completed'"),
      db.query("SELECT COALESCE(SUM(reward_amount),0) AS total FROM referrals WHERE status='completed'"),
      db.query(`SELECT u.name, u.phone, COUNT(r.id) AS referrals, SUM(r.reward_amount) AS earned FROM referrals r JOIN users u ON r.referrer_id=u.id WHERE r.status='completed' GROUP BY u.id,u.name,u.phone ORDER BY referrals DESC LIMIT 20`),
      db.query(`SELECT r.*, u1.name AS referrer_name, u1.phone AS referrer_phone, u2.name AS referred_name, u2.phone AS referred_phone FROM referrals r JOIN users u1 ON r.referrer_id=u1.id JOIN users u2 ON r.referred_id=u2.id ORDER BY r.created_at DESC LIMIT 50`),
    ]);
    res.json({ total: parseInt(total.rows[0].cnt), completed: parseInt(completed.rows[0].cnt), total_reward: parseFloat(totalReward.rows[0].total), top_referrers: topReferrers.rows, recent: recent.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/fare-settings
router.post('/fare-settings', async (req, res) => {
  const { vehicle_type, base_fare, per_km_rate, night_multiplier, night_start, night_end } = req.body;
  try {
    await db.query(
      `WITH updated AS (UPDATE fare_settings SET base_fare=$1, per_km_rate=$2, night_multiplier=$3, night_start=$4, night_end=$5, updated_at=NOW() WHERE vehicle_type=$6 RETURNING 1)
       INSERT INTO fare_settings (vehicle_type, base_fare, per_km_rate, night_multiplier, night_start, night_end) SELECT $6, $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM updated)`,
      [base_fare, per_km_rate, night_multiplier, night_start, night_end, vehicle_type]
    );
    res.json({ success: true, message: 'Fare updated!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/promos
router.get('/promos', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
    res.json({ promos: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/promos
router.post('/promos', async (req, res) => {
  const { code, discount_type, discount_value, max_discount, min_fare, usage_limit } = req.body;
  try {
    await db.query(
      `INSERT INTO promo_codes (code, discount_type, discount_value, max_discount, min_fare, usage_limit) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET discount_type=$2, discount_value=$3, max_discount=$4, min_fare=$5, usage_limit=$6, active=true`,
      [code.toUpperCase(), discount_type, discount_value, max_discount || 100, min_fare || 0, usage_limit || 1000]
    );
    res.json({ success: true, message: 'Promo code saved!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/promos/toggle
router.post('/promos/toggle', async (req, res) => {
  const { code, active } = req.body;
  try {
    await db.query('UPDATE promo_codes SET active = $1 WHERE code = $2', [active, code]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/surge
router.post('/surge', (req, res) => {
  const { multiplier } = req.body;
  if (!multiplier || multiplier < 1 || multiplier > 3) return res.status(400).json({ error: '1.0 to 3.0 ke beech rakho' });
  setSurge(parseFloat(multiplier));
  res.json({ success: true, surge: getSurge() });
});

// POST /api/admin/hourly-fares
router.post('/hourly-fares', (req, res) => {
  const { vehicle_type, package_hours, fare, km } = req.body;
  if (!HOURLY_FARES[vehicle_type]) return res.status(400).json({ error: 'Invalid vehicle type' });
  if (!HOURLY_FARES[vehicle_type][package_hours]) HOURLY_FARES[vehicle_type][package_hours] = {};
  if (fare) HOURLY_FARES[vehicle_type][package_hours].fare = fare;
  if (km) HOURLY_FARES[vehicle_type][package_hours].km = km;
  res.json({ success: true, updated: HOURLY_FARES[vehicle_type][package_hours] });
});

// GET /admin — serve admin portal HTML
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin-portal.html'));
});

// GET /api/admin/driver-financials
router.get('/driver-financials', async (req, res) => {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS driver_payouts (
      id SERIAL PRIMARY KEY, driver_phone VARCHAR(20), amount DECIMAL(10,2),
      bank_account VARCHAR(50), bank_ifsc VARCHAR(20), bank_holder VARCHAR(100),
      upi_id VARCHAR(100), method VARCHAR(20) DEFAULT 'bank',
      status VARCHAR(20) DEFAULT 'pending', admin_note TEXT,
      transaction_ref VARCHAR(100), requested_at TIMESTAMP DEFAULT NOW(), settled_at TIMESTAMP
    )`);
    await db.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_account VARCHAR(50)`).catch(() => {});
    await db.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20)`).catch(() => {});
    await db.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_holder VARCHAR(100)`).catch(() => {});
    await db.query(`ALTER TABLE drivers ADD COLUMN IF NOT EXISTS upi_id VARCHAR(100)`).catch(() => {});
    const rows = await db.query(`
      SELECT u.name, u.phone,
        d.vehicle_type, d.vehicle_no, d.rating, d.verification_status,
        d.bank_account, d.bank_ifsc, d.bank_holder, d.upi_id,
        COALESCE(w.balance, 0) AS wallet_balance,
        COALESCE(w.total_earned, 0) AS total_earned,
        COALESCE(w.total_withdrawn, 0) AS total_withdrawn,
        COALESCE(w.pending_commission, 0) AS pending_commission,
        (SELECT COUNT(*) FROM rides r2 JOIN users u2 ON r2.driver_id=u2.id WHERE u2.phone=u.phone AND r2.status='completed') AS total_rides,
        (SELECT COUNT(*) FROM driver_payouts dp WHERE dp.driver_phone=u.phone AND dp.status='pending') AS pending_payouts
      FROM users u JOIN drivers d ON u.id=d.id
      LEFT JOIN driver_wallet w ON w.driver_id=u.id
      ORDER BY COALESCE(w.balance,0) DESC
    `);
    res.json({ drivers: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/driver-payouts?status=pending|completed|rejected|all
router.get('/driver-payouts', async (req, res) => {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS driver_payouts (
      id SERIAL PRIMARY KEY, driver_phone VARCHAR(20), amount DECIMAL(10,2),
      bank_account VARCHAR(50), bank_ifsc VARCHAR(20), bank_holder VARCHAR(100),
      upi_id VARCHAR(100), method VARCHAR(20) DEFAULT 'bank',
      status VARCHAR(20) DEFAULT 'pending', admin_note TEXT,
      transaction_ref VARCHAR(100), requested_at TIMESTAMP DEFAULT NOW(), settled_at TIMESTAMP
    )`);
    const { status } = req.query;
    const where = (status && status !== 'all') ? 'WHERE dp.status=$1' : '';
    const params = (status && status !== 'all') ? [status] : [];
    const rows = await db.query(`
      SELECT dp.*, u.name AS driver_name, d.vehicle_type, d.vehicle_no,
        COALESCE(w.balance, 0) AS wallet_balance,
        COALESCE(w.pending_commission, 0) AS pending_commission
      FROM driver_payouts dp
      JOIN users u ON u.phone = dp.driver_phone
      LEFT JOIN drivers d ON d.id = u.id
      LEFT JOIN driver_wallet w ON w.driver_id = u.id
      ${where}
      ORDER BY dp.requested_at DESC LIMIT 200
    `, params);
    res.json({ payouts: rows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/payout-approve
router.post('/payout-approve', async (req, res) => {
  const { payout_id, transaction_ref, note } = req.body;
  try {
    const p = await db.query(`SELECT * FROM driver_payouts WHERE id=$1 AND status='pending'`, [payout_id]);
    if (!p.rows[0]) return res.status(400).json({ error: 'Payout nahi mila ya pehle se process ho chuka' });
    const payout = p.rows[0];
    const drvRes = await db.query(
      `SELECT w.driver_id, w.balance, COALESCE(w.pending_commission, 0) AS pending_commission
       FROM driver_wallet w JOIN users u ON w.driver_id=u.id WHERE u.phone=$1`,
      [payout.driver_phone]
    );
    if (!drvRes.rows[0]) return res.status(404).json({ error: 'Driver wallet nahi mili' });
    const { driver_id, balance, pending_commission } = drvRes.rows[0];
    const amt = parseFloat(payout.amount);
    if (parseFloat(balance) < amt) return res.status(400).json({ error: `Wallet balance (₹${parseFloat(balance).toFixed(0)}) payout amount (₹${amt.toFixed(0)}) se kam hai` });
    const commDeduct = Math.min(parseFloat(pending_commission), amt);
    const actualPayout = amt - commDeduct;
    await db.query(
      `UPDATE driver_wallet SET balance=balance-$1, total_withdrawn=total_withdrawn+$2,
       pending_commission=GREATEST(0, COALESCE(pending_commission,0)-$3) WHERE driver_id=$4`,
      [amt, actualPayout, commDeduct, driver_id]
    );
    if (commDeduct > 0) await db.query(
      `UPDATE driver_commissions SET status='settled' WHERE driver_phone=$1 AND status='cash_owed'`,
      [payout.driver_phone]
    ).catch(() => {});
    await db.query(
      `UPDATE driver_payouts SET status='completed', transaction_ref=$1, admin_note=$2, settled_at=NOW() WHERE id=$3`,
      [transaction_ref || '', note || '', payout_id]
    );
    sendFCM(payout.driver_phone, '✅ Payout Approved!',
      `₹${actualPayout.toFixed(0)} aapke ${payout.method === 'upi' ? 'UPI' : 'bank account'} mein transfer kar diya gaya!`,
      { type: 'payout_approved' }
    ).catch(() => {});
    res.json({ success: true, actual_payout: actualPayout, commission_deducted: commDeduct });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/payout-reject
router.post('/payout-reject', async (req, res) => {
  const { payout_id, note } = req.body;
  try {
    const r = await db.query(
      `UPDATE driver_payouts SET status='rejected', admin_note=$1, settled_at=NOW()
       WHERE id=$2 AND status='pending' RETURNING driver_phone, amount`,
      [note || 'Admin ne reject kiya', payout_id]
    );
    if (!r.rows[0]) return res.status(400).json({ error: 'Payout nahi mila ya pehle se process ho chuka' });
    sendFCM(r.rows[0].driver_phone, '❌ Payout Rejected',
      note || 'Payout reject ho gaya — support se contact karo',
      { type: 'payout_rejected' }
    ).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
