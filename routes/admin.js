const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../config/db');
const { sendFCM } = require('../config/firebase');
const { HOURLY_FARES, setSurge, getSurge } = require('../services/pricing');
const { getIO } = require('../config/socket');

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
      if (status === 'approved') sendFCM(dPhone, '🎉 Sppero Buddy Captain — Approved!', 'Aapke documents verify ho gaye! Ab app mein login karke rides lo.', {}, { role: 'driver' });
      else if (status === 'rejected') sendFCM(dPhone, '❌ Documents Reject Ho Gaye', message || 'Aapke documents mein problem hai.', {}, { role: 'driver' });
      else if (status === 'resubmit') sendFCM(dPhone, '📋 Documents Resubmit Karein', message || 'Admin ne kuch documents dobara maange hain.', {}, { role: 'driver' });
      else if (status === 'suspended') sendFCM(dPhone, '⚠️ Account Suspend Ho Gaya', message || 'Aapka account suspend kar diya gaya hai.', {}, { role: 'driver' });
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

// GET /api/admin/bonus-rules
router.get('/bonus-rules', async (req, res) => {
  try {
    const rules = await db.query(`SELECT * FROM bonus_rules ORDER BY vehicle_type, bonus_type, id`);
    res.json({ rules: rules.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/bonus-rules — create new rule
router.post('/bonus-rules', async (req, res) => {
  const { vehicle_type, bonus_type, config, label, description } = req.body;
  if (!bonus_type || !config || !label) return res.status(400).json({ error: 'bonus_type, config, label required' });
  try {
    const r = await db.query(
      `INSERT INTO bonus_rules (vehicle_type, bonus_type, config, label, description, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *`,
      [vehicle_type || 'all', bonus_type, JSON.stringify(config), label, description || '']
    );
    res.json({ success: true, rule: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/bonus-rules/:id — update rule
router.put('/bonus-rules/:id', async (req, res) => {
  const { id } = req.params;
  const { vehicle_type, bonus_type, config, label, description, is_active } = req.body;
  try {
    const r = await db.query(
      `UPDATE bonus_rules SET
        vehicle_type = COALESCE($1, vehicle_type),
        bonus_type   = COALESCE($2, bonus_type),
        config       = COALESCE($3, config),
        label        = COALESCE($4, label),
        description  = COALESCE($5, description),
        is_active    = COALESCE($6, is_active),
        updated_at   = NOW()
       WHERE id=$7 RETURNING *`,
      [vehicle_type, bonus_type, config ? JSON.stringify(config) : null, label, description, is_active, id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Rule not found' });
    res.json({ success: true, rule: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/admin/bonus-rules/:id — soft delete (deactivate)
router.delete('/bonus-rules/:id', async (req, res) => {
  try {
    await db.query(`UPDATE bonus_rules SET is_active=false, updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/bonus-stats — overview for admin dashboard
router.get('/bonus-stats', async (req, res) => {
  try {
    const [totalPaid, todayPaid, topEarners] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM bonus_ledger WHERE amount > 0`),
      db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM bonus_ledger WHERE amount > 0 AND ref_date=CURRENT_DATE`),
      db.query(`SELECT driver_phone, SUM(amount) AS total FROM bonus_ledger WHERE amount > 0 GROUP BY driver_phone ORDER BY total DESC LIMIT 10`),
    ]);
    res.json({
      total_bonus_paid: parseFloat(totalPaid.rows[0].total),
      today_bonus_paid: parseFloat(todayPaid.rows[0].total),
      top_earners: topEarners.rows,
    });
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
        const fsRate = await client.query(`SELECT hourly_commission_rate FROM fare_settings WHERE vehicle_type=$1 LIMIT 1`, [b.vehicle_type]);
        const commRate = parseFloat(fsRate.rows[0]?.hourly_commission_rate || 12) / 100;
        const commission = Math.round(totalFare * commRate * 100) / 100;
        const driverEarning = Math.round((totalFare - commission) * 100) / 100;
        const driverUser = await client.query('SELECT id FROM users WHERE phone=$1', [b.driver_phone]);
        if (driverUser.rows[0]) await client.query('UPDATE driver_wallet SET balance=balance+$1, total_earned=total_earned+$1 WHERE driver_id=$2', [driverEarning, driverUser.rows[0].id]);
        await client.query(`UPDATE hourly_bookings SET status='completed', ended_at=NOW(), driver_earning=$1, platform_fee=$2, total_fare=$3, payment_status='released', dispute_raised=false WHERE id=$4`, [driverEarning, commission, totalFare, booking_id]);
        await client.query('COMMIT');
        sendFCM(b.driver_phone, '✅ Dispute Resolved in Your Favour', `₹${driverEarning.toFixed(0)} wallet mein add ho gaya!`, {}, { role: 'driver' });
        return res.json({ success: true, resolved: 'driver', driver_earning: driverEarning });
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } else {
      const cu = await db.query('SELECT id FROM users WHERE phone=$1', [b.customer_phone]);
      if (cu.rows[0]) {
        await db.query('UPDATE customer_wallet SET balance=balance+$1 WHERE user_id=$2', [b.base_fare, cu.rows[0].id]);
        await db.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Hourly dispute resolved - full refund')", [cu.rows[0].id, b.base_fare]);
      }
      await db.query("UPDATE hourly_bookings SET status='cancelled', payment_status='refunded', dispute_raised=false WHERE id=$1", [booking_id]);
      sendFCM(b.customer_phone, '✅ Dispute Resolved', `₹${b.base_fare} aapke wallet mein wapas!`, {}, { role: 'customer' });
      sendFCM(b.driver_phone, '❌ Dispute Against You', 'Customer ko refund mil gaya', {}, { role: 'driver' });
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
  const { title, body, target, imageUrl } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'Title aur body zaroori hai' });
  try {
    // Ensure notifications table has the columns we need
    await db.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target TEXT`).catch(() => {});
    await db.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message TEXT`).catch(() => {});
    await db.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS image_url TEXT`).catch(() => {});

    // Distinguish customers vs drivers by which token column is set, NOT by role.
    // (Driver registration overwrites role to 'driver', so role='passenger' would
    //  exclude testers who are on both apps.)
    let usersQuery;
    let fcmRole;
    if (target === 'drivers') {
      usersQuery = `SELECT phone FROM users WHERE driver_fcm_token IS NOT NULL`;
      fcmRole = 'driver';
    } else if (target === 'customers') {
      usersQuery = `SELECT phone FROM users WHERE fcm_token IS NOT NULL`;
      fcmRole = 'customer';
    } else {
      // 'all' — everyone with a customer-app token (driver-app users who also have customer app included)
      usersQuery = `SELECT phone FROM users WHERE fcm_token IS NOT NULL`;
      fcmRole = 'customer';
    }

    const users = await db.query(usersQuery);
    const count = users.rows.length;

    // Insert ONE row with group target — no per-phone loops, no format mismatch issues
    const notifTarget = (target === 'customers') ? 'customers'
                      : (target === 'drivers')   ? 'drivers'
                      :                            'all';
    await db.query(
      `INSERT INTO notifications (target, title, message, image_url, created_at) VALUES ($1, $2, $3, $4, NOW())`,
      [notifTarget, title, body, imageUrl || null]
    ).catch(() => {});

    // Respond immediately (don't block on FCM sends)
    res.json({ success: true, total_targets: count, message: `${count} users ko bheja ja raha hai...` });

    // Send FCM push in background
    let sent = 0, failed = 0;
    for (const u of users.rows) {
      try {
        await sendFCM(
          u.phone, title, body,
          { type: 'broadcast', ...(imageUrl ? { image_url: imageUrl } : {}) },
          { role: fcmRole, channelId: 'default', ...(imageUrl ? { imageUrl } : {}) }
        );
        sent++;
      } catch (_e) { failed++; }
    }
    console.log(`📣 Broadcast done: ${sent}/${count} FCM sent, ${failed} failed (target=${target || 'all'})`);
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

// GET /api/admin/commission-rates
router.get('/commission-rates', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT vehicle_type, commission_rate, hourly_commission_rate FROM fare_settings ORDER BY vehicle_type`
    );
    res.json({ rates: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/commission-rates — update one or all vehicle types
// rate = standard ride commission, hourly_rate = hourly ride commission (both optional individually)
router.post('/commission-rates', async (req, res) => {
  try {
    const { vehicle_type, rate, hourly_rate } = req.body || {};
    const cr  = rate        !== undefined ? parseFloat(rate)        : NaN;
    const hcr = hourly_rate !== undefined ? parseFloat(hourly_rate) : NaN;
    const hasCr  = !isNaN(cr)  && cr  >= 0 && cr  <= 50;
    const hasHcr = !isNaN(hcr) && hcr >= 0 && hcr <= 50;
    if (!hasCr && !hasHcr) return res.status(400).json({ error: 'Rate 0-50 ke beech hona chahiye' });
    if (vehicle_type) {
      if (hasCr && hasHcr) {
        await db.query('UPDATE fare_settings SET commission_rate=$1, hourly_commission_rate=$2 WHERE vehicle_type=$3', [cr, hcr, vehicle_type]);
      } else if (hasCr) {
        await db.query('UPDATE fare_settings SET commission_rate=$1 WHERE vehicle_type=$2', [cr, vehicle_type]);
      } else {
        await db.query('UPDATE fare_settings SET hourly_commission_rate=$1 WHERE vehicle_type=$2', [hcr, vehicle_type]);
      }
    } else {
      if (hasCr && hasHcr) {
        await db.query('UPDATE fare_settings SET commission_rate=$1, hourly_commission_rate=$2', [cr, hcr]);
      } else if (hasCr) {
        await db.query('UPDATE fare_settings SET commission_rate=$1', [cr]);
      } else {
        await db.query('UPDATE fare_settings SET hourly_commission_rate=$1', [hcr]);
      }
    }
    const r = await db.query('SELECT vehicle_type, commission_rate, hourly_commission_rate FROM fare_settings ORDER BY vehicle_type');
    res.json({ success: true, rates: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/fare-settings
router.post('/fare-settings', async (req, res) => {
  const { vehicle_type, base_fare, per_km_rate, night_multiplier, night_start, night_end,
          time_rate, platform_fee, min_fare, per_km_rate_t2, per_km_rate_t3, commission_rate } = req.body;
  const bf  = parseFloat(base_fare);
  const pkr = parseFloat(per_km_rate);
  const nm  = parseFloat(night_multiplier);
  if (!vehicle_type)         return res.status(400).json({ error: 'vehicle_type required' });
  if (isNaN(bf)  || bf  < 0) return res.status(400).json({ error: 'base_fare must be a non-negative number' });
  if (isNaN(pkr) || pkr < 0) return res.status(400).json({ error: 'per_km_rate must be a non-negative number' });
  if (isNaN(nm)  || nm  < 1) return res.status(400).json({ error: 'night_multiplier must be >= 1' });
  const tr   = time_rate       != null ? parseFloat(time_rate)       : null;
  const pf   = platform_fee    != null ? parseFloat(platform_fee)    : null;
  const mf   = min_fare        != null ? parseFloat(min_fare)        : null;
  const pkr2 = per_km_rate_t2  != null ? parseFloat(per_km_rate_t2)  : null;
  const pkr3 = per_km_rate_t3  != null ? parseFloat(per_km_rate_t3)  : null;
  const cr   = commission_rate != null ? parseFloat(commission_rate) : null;
  try {
    await db.query(
      `WITH updated AS (
         UPDATE fare_settings SET
           base_fare=$1, per_km_rate=$2, night_multiplier=$3, night_start=$4, night_end=$5,
           time_rate      = COALESCE($7,  time_rate),
           platform_fee   = COALESCE($8,  platform_fee),
           min_fare       = COALESCE($9,  min_fare),
           per_km_rate_t2 = COALESCE($10, per_km_rate_t2),
           per_km_rate_t3 = COALESCE($11, per_km_rate_t3),
           commission_rate= COALESCE($12, commission_rate),
           updated_at=NOW()
         WHERE vehicle_type=$6 RETURNING 1
       )
       INSERT INTO fare_settings (vehicle_type, base_fare, per_km_rate, night_multiplier, night_start, night_end)
       SELECT $6, $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM updated)`,
      [bf, pkr, nm, night_start || '22:00', night_end || '06:00', vehicle_type, tr, pf, mf, pkr2, pkr3, cr]
    );
    const io = getIO();
    if (io) io.emit('fareSettingsUpdated', { vehicle_type, base_fare: bf, per_km_rate: pkr, night_multiplier: nm, time_rate: tr, platform_fee: pf, min_fare: mf });
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
  const { payout_id, note } = req.body;
  try {
    const p = await db.query(
      `SELECT * FROM driver_payouts WHERE id=$1 AND status IN ('pending','failed')`, [payout_id]
    );
    if (!p.rows[0]) return res.status(400).json({ error: 'Payout nahi mila ya pehle se process ho chuka' });
    const payout = p.rows[0];

    const drvRes = await db.query(
      `SELECT w.driver_id, w.balance, COALESCE(w.pending_commission,0) AS pending_commission, u.name
       FROM driver_wallet w JOIN users u ON w.driver_id=u.id WHERE u.phone=$1`,
      [payout.driver_phone]
    );
    if (!drvRes.rows[0]) return res.status(404).json({ error: 'Driver wallet nahi mili' });
    const { driver_id, balance, pending_commission, name: driverName } = drvRes.rows[0];

    const amt         = parseFloat(payout.amount);
    const commDeduct  = Math.min(parseFloat(pending_commission), amt);
    const actualPayout = amt - commDeduct;

    if (parseFloat(balance) < amt)
      return res.status(400).json({ error: `Wallet balance (₹${parseFloat(balance).toFixed(0)}) payout amount (₹${amt.toFixed(0)}) se kam hai` });

    // 1 — Deduct wallet immediately (reversed by webhook on failure)
    await db.query(
      `UPDATE driver_wallet
       SET balance=balance-$1, total_withdrawn=total_withdrawn+$2,
           pending_commission=GREATEST(0, COALESCE(pending_commission,0)-$3)
       WHERE driver_id=$4`,
      [amt, actualPayout, commDeduct, driver_id]
    );
    if (commDeduct > 0) {
      await db.query(
        `UPDATE driver_commissions SET status='settled' WHERE driver_phone=$1 AND status='cash_owed'`,
        [payout.driver_phone]
      ).catch(() => {});
    }

    // 2 — Auto-transfer via RazorpayX if account is configured
    if (process.env.RAZORPAY_ACCOUNT_NUMBER) {
      const rpPayout = require('../services/razorpayPayout');
      try {
        const contactId      = await rpPayout.ensureContact(payout.driver_phone, driverName);
        const fundAccountId  = await rpPayout.createFundAccount(contactId, payout);
        const rpResult       = await rpPayout.initiatePayout(fundAccountId, actualPayout, payout_id, payout.method);

        await db.query(
          `UPDATE driver_payouts
           SET status='processing', razorpay_payout_id=$1, razorpay_fund_account_id=$2,
               razorpay_status=$3, commission_deducted=$4, admin_note=$5, settled_at=NOW()
           WHERE id=$6`,
          [rpResult.id, fundAccountId, rpResult.status, commDeduct, note || '', payout_id]
        );
        sendFCM(
          payout.driver_phone,
          '⏳ Payout Processing!',
          `₹${actualPayout.toFixed(0)} ka transfer shuru — ${payout.method === 'upi' ? 'UPI' : 'bank'} mein jald credit ho jaayega.`,
          { type: 'payout_processing', payout_id: String(payout_id) },
          { role: 'driver' }
        ).catch(() => {});

        return res.json({
          success: true, razorpay: true,
          actual_payout: actualPayout, commission_deducted: commDeduct,
          razorpay_payout_id: rpResult.id, razorpay_status: rpResult.status,
        });
      } catch (rpErr) {
        // Razorpay call failed — roll back wallet deduction
        await db.query(
          `UPDATE driver_wallet
           SET balance=balance+$1, total_withdrawn=GREATEST(0, total_withdrawn-$2),
               pending_commission=COALESCE(pending_commission,0)+$3
           WHERE driver_id=$4`,
          [amt, actualPayout, commDeduct, driver_id]
        ).catch(() => {});
        if (commDeduct > 0) {
          await db.query(
            `UPDATE driver_commissions SET status='cash_owed' WHERE driver_phone=$1 AND status='settled'`,
            [payout.driver_phone]
          ).catch(() => {});
        }
        return res.status(500).json({ error: rpErr.message });
      }
    }

    // 3 — Fallback: manual mode (RAZORPAY_ACCOUNT_NUMBER not configured)
    await db.query(
      `UPDATE driver_payouts
       SET status='completed', commission_deducted=$1, admin_note=$2, settled_at=NOW()
       WHERE id=$3`,
      [commDeduct, note || '', payout_id]
    );
    sendFCM(
      payout.driver_phone, '✅ Payout Approved!',
      `₹${actualPayout.toFixed(0)} aapke ${payout.method === 'upi' ? 'UPI' : 'bank account'} mein transfer kar diya gaya!`,
      { type: 'payout_approved' },
      { role: 'driver' }
    ).catch(() => {});
    res.json({ success: true, razorpay: false, actual_payout: actualPayout, commission_deducted: commDeduct });
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
      { type: 'payout_rejected' },
      { role: 'driver' }
    ).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════



// ── GET /api/admin/incidents — list all system-detected incidents ──────────────
router.get('/incidents', async (req, res) => {
  const { type, resolved, limit = 50, offset = 0 } = req.query;
  try {
    let where = 'WHERE 1=1';
    const params = [];
    if (type) { where += ` AND i.incident_type=$${params.length+1}`; params.push(type); }
    if (resolved !== undefined && resolved !== '') { where += ` AND i.resolved=$${params.length+1}`; params.push(resolved === 'true'); }

    const result = await db.query(
      `SELECT i.*,
              r.pickup, r.drop_location, r.fare,
              ud.name AS driver_name, ud.phone AS driver_phone,
              uc.name AS customer_name, uc.phone AS customer_phone
       FROM ride_incidents i
       LEFT JOIN rides r ON i.ride_id = r.id::text
       LEFT JOIN users ud ON i.driver_id = ud.id::text
       LEFT JOIN users uc ON i.customer_id = uc.id::text
       ${where}
       ORDER BY i.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );

    const stats = await db.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE incident_type='early_completion') AS early_completions,
        COUNT(*) FILTER (WHERE incident_type='payment_skipped') AS payment_skips,
        COUNT(*) FILTER (WHERE resolved=false) AS unresolved,
        COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '24 hours') AS today
      FROM ride_incidents
    `);

    res.json({ incidents: result.rows, stats: stats.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /api/admin/incidents/:id/resolve ────────────────────────────────────
router.put('/incidents/:id/resolve', async (req, res) => {
  try {
    const { note } = req.body || {};
    await db.query(
      `UPDATE ride_incidents
          SET resolved=true, resolved_at=NOW(),
              metadata = COALESCE(metadata,'{}') || $1::jsonb
        WHERE id=$2`,
      [JSON.stringify({ resolved_note: note || null }), req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/admin/incidents — create manual incident ───────────────────────
router.post('/incidents', async (req, res) => {
  try {
    const { incident_type, ride_id, driver_phone, customer_phone, note, fare } = req.body || {};
    if (!incident_type) return res.status(400).json({ error: 'incident_type required' });

    let driver_id = null, customer_id = null;
    if (driver_phone) {
      const dr = await db.query('SELECT id FROM users WHERE phone=$1', [driver_phone]);
      if (dr.rows[0]) driver_id = String(dr.rows[0].id);
    }
    if (customer_phone) {
      const cu = await db.query('SELECT id FROM users WHERE phone=$1', [customer_phone]);
      if (cu.rows[0]) customer_id = String(cu.rows[0].id);
    }

    const r = await db.query(
      `INSERT INTO ride_incidents (ride_id, incident_type, detected_by, driver_id, customer_id, metadata)
       VALUES ($1, $2, 'admin', $3, $4, $5) RETURNING id`,
      [ride_id || null, incident_type, driver_id, customer_id,
       JSON.stringify({ note: note || null, fare: fare ? parseFloat(fare) : null })]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/admin/customer-profile/:id — trust score + incidents + restrictions ──
router.get('/customer-profile/:id', async (req, res) => {
  try {
    const [user, incidents, restrictions] = await Promise.all([
      db.query('SELECT id,name,phone,trust_score,booking_restricted,booking_restricted_reason FROM users WHERE id=$1', [req.params.id]),
      db.query('SELECT * FROM ride_incidents WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 10', [req.params.id]),
      db.query("SELECT COUNT(*) FROM ride_incidents WHERE customer_id=$1 AND resolved=false", [req.params.id]),
    ]);
    res.json({ user: user.rows[0], incidents: incidents.rows, open_incidents: parseInt(restrictions.rows[0]?.count || 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PUT /api/admin/customer-profile/:id/unrestrict ────────────────────────
router.put('/customer-profile/:id/unrestrict', async (req, res) => {
  try {
    await db.query(
      "UPDATE users SET booking_restricted=false, booking_restricted_reason=NULL, trust_score=LEAST(100,COALESCE(trust_score,0)+20) WHERE id=$1",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Reward Settings ───────────────────────────────────────────────────────────
router.get('/reward-settings', async (req, res) => {
  try {
    const r = await db.query('SELECT key, value, label, updated_at FROM reward_settings ORDER BY key');
    res.json({ settings: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/reward-settings', async (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined || isNaN(Number(value))) return res.status(400).json({ error: 'key and numeric value required' });
  try {
    const r = await db.query(
      `UPDATE reward_settings SET value=$1, updated_at=NOW() WHERE key=$2 RETURNING key, value, label`,
      [Number(value), key]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Setting not found' });
    res.json({ success: true, setting: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Customer Rewards Analytics ─────────────────────────────────────────────────
router.get('/customer-rewards', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT
        u.id,
        u.name,
        u.phone,
        COALESCE(w.balance, 0)                                           AS wallet_balance,
        COUNT(DISTINCT ri.id)                                            AS rides_completed,
        COALESCE(SUM(DISTINCT ri.fare) FILTER (WHERE ri.id IS NOT NULL), 0) AS total_fare_paid,
        COALESCE(sc_sum.total, 0)                                        AS scratch_rewards,
        COALESCE(ref_sum.total, 0)                                       AS referral_rewards
      FROM users u
      LEFT JOIN customer_wallet w      ON w.user_id = u.id
      LEFT JOIN rides ri               ON ri.passenger_id = u.id AND ri.status = 'payment_complete'
      LEFT JOIN (
        SELECT sc.user_id, SUM(sc.reward_amount) AS total
        FROM scratch_cards sc WHERE sc.is_scratched = true GROUP BY sc.user_id
      ) sc_sum ON sc_sum.user_id = u.id
      LEFT JOIN (
        SELECT r2.referred_id AS uid, SUM(r2.reward_amount) AS total
        FROM referrals r2 WHERE r2.status='completed' GROUP BY r2.referred_id
      ) ref_sum ON ref_sum.uid = u.id
      GROUP BY u.id, u.name, u.phone, w.balance, sc_sum.total, ref_sum.total
      ORDER BY rides_completed DESC, total_fare_paid DESC
      LIMIT 200
    `);
    res.json({ customers: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Driver Earnings Detail ─────────────────────────────────────────────────────
router.get('/driver-earnings-detail', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT
        d.phone,
        d.name,
        d.vehicle_type,
        d.is_verified,
        COUNT(DISTINCT ri.id)                                                       AS rides_completed,
        COALESCE(SUM(ri.fare), 0)                                                   AS total_fare_generated,
        COALESCE(SUM(ri.fare * COALESCE(d.commission_rate, 15) / 100.0), 0)        AS platform_commission,
        COALESCE(SUM(ri.fare) - SUM(ri.fare * COALESCE(d.commission_rate,15)/100.0), 0) AS driver_earnings,
        COALESCE(bl.total_bonus, 0)                                                 AS bonus_earned,
        COALESCE(bw.balance, 0)                                                     AS bonus_wallet_balance
      FROM drivers d
      LEFT JOIN users ud              ON ud.phone = d.phone
      LEFT JOIN rides ri              ON ri.driver_id = ud.id AND ri.status = 'payment_complete'
      LEFT JOIN (
        SELECT driver_phone, SUM(amount) AS total_bonus FROM bonus_ledger GROUP BY driver_phone
      ) bl ON bl.driver_phone = d.phone
      LEFT JOIN bonus_wallet bw ON bw.driver_phone = d.phone
      GROUP BY d.phone, d.name, d.vehicle_type, d.is_verified, bl.total_bonus, bw.balance
      ORDER BY total_fare_generated DESC
      LIMIT 200
    `);
    res.json({ drivers: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Referral Detail ────────────────────────────────────────────────────────────
router.get('/referral-detail', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT
        rf.id,
        rf.referral_code,
        rf.reward_amount,
        rf.status,
        rf.created_at,
        u_er.name   AS referrer_name,
        u_er.phone  AS referrer_phone,
        u_ed.name   AS referred_name,
        u_ed.phone  AS referred_phone,
        COUNT(ri.id)::int AS referred_rides_done
      FROM referrals rf
      LEFT JOIN users u_er ON u_er.id = rf.referrer_id
      LEFT JOIN users u_ed ON u_ed.id = rf.referred_id
      LEFT JOIN rides ri   ON ri.passenger_id = rf.referred_id AND ri.status = 'payment_complete'
      GROUP BY rf.id, rf.referral_code, rf.reward_amount, rf.status, rf.created_at,
               u_er.name, u_er.phone, u_ed.name, u_ed.phone
      ORDER BY rf.created_at DESC
      LIMIT 300
    `);
    res.json({ referrals: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/admin/incidents/:id/compensate-driver ─────────────────────────
// Credits the driver's wallet with (fare - commission) for a payment_skipped incident.
router.post('/incidents/:id/compensate-driver', async (req, res) => {
  const { admin_name } = req.body;
  try {
    const incRes = await db.query(
      `SELECT i.*,
              r.fare, r.ride_type,
              fs.commission_rate,
              ud.name AS driver_name, ud.phone AS driver_phone,
              uc.name AS customer_name, uc.phone AS customer_phone
       FROM ride_incidents i
       LEFT JOIN rides r ON i.ride_id = r.id::text
       LEFT JOIN fare_settings fs ON fs.vehicle_type = r.ride_type
       LEFT JOIN users ud ON i.driver_id = ud.id::text
       LEFT JOIN users uc ON i.customer_id = uc.id::text
       WHERE i.id = $1`,
      [req.params.id]
    );
    if (!incRes.rows[0]) return res.status(404).json({ error: 'Incident nahi mila' });
    const inc = incRes.rows[0];

    if (inc.incident_type !== 'payment_skipped')
      return res.status(400).json({ error: 'Sirf payment_skipped incidents ke liye compensation hai' });
    if (inc.resolved)
      return res.status(409).json({ error: 'Yeh incident already resolved hai' });

    // For manual incidents without a ride record, fare may be in metadata
    const meta = inc.metadata || {};
    const fare = parseFloat(inc.fare || meta.fare || 0);
    if (fare <= 0) return res.status(400).json({ error: 'Fare amount nahi mila — ride record check karo ya incident mein fare set karo' });
    if (!inc.driver_id) return res.status(400).json({ error: 'Driver ID nahi mila' });

    const commRate = parseFloat(inc.commission_rate || 15) / 100;
    const commission = Math.round(fare * commRate * 100) / 100;
    const compensation = Math.round((fare - commission) * 100) / 100;

    // Credit driver wallet — driver_id is stored as TEXT, cast to INTEGER for driver_wallet FK
    await db.query(
      `INSERT INTO driver_wallet (driver_id, balance, total_earned)
       VALUES ($1::integer, $2, $3)
       ON CONFLICT (driver_id) DO UPDATE SET
         balance      = driver_wallet.balance + $2,
         total_earned = driver_wallet.total_earned + $3,
         updated_at   = NOW()`,
      [inc.driver_id, compensation, compensation]
    );

    // Mark incident resolved with timestamp
    await db.query('UPDATE ride_incidents SET resolved=true, resolved_at=NOW() WHERE id=$1', [req.params.id]);

    // Notify driver
    if (inc.driver_phone) {
      sendFCM(
        inc.driver_phone,
        '💰 Compensation Credited!',
        `Payment dispute resolved. ₹${compensation} Sppero wallet mein add ho gaye! (Ride ₹${fare} - 15% fee)`,
        { type: 'compensation_credited', amount: String(compensation) },
        { role: 'driver' }
      ).catch(() => {});
    }

    res.json({ success: true, compensation_amount: compensation, driver_name: inc.driver_name || 'Driver' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Startup: ensure ride_incidents table + columns exist ─────────────────────
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ride_incidents (
        id            SERIAL PRIMARY KEY,
        ride_id       TEXT,
        incident_type TEXT NOT NULL,
        driver_id     TEXT,
        customer_id   TEXT,
        detected_by   TEXT DEFAULT 'system',
        metadata      JSONB DEFAULT '{}',
        details       JSONB DEFAULT '{}',
        resolved      BOOLEAN DEFAULT false,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Ensure both column names exist for schema migration safety
    await db.query(`ALTER TABLE ride_incidents ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'`).catch(() => {});
    await db.query(`ALTER TABLE ride_incidents ADD COLUMN IF NOT EXISTS detected_by TEXT DEFAULT 'system'`).catch(() => {});
    await db.query(`ALTER TABLE ride_incidents ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'`).catch(() => {});
    await db.query(`ALTER TABLE ride_incidents ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`).catch(() => {});

    await db.query(`CREATE TABLE IF NOT EXISTS wallet_credits_log (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      user_name TEXT,
      amount NUMERIC NOT NULL,
      note TEXT,
      role TEXT DEFAULT 'customer',
      new_balance NUMERIC,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
  } catch (_) {}
})();

// POST /api/admin/wallet-credit — manually credit customer or driver wallet
router.post('/wallet-credit', async (req, res) => {
  const { phone, amount, note, role = 'customer' } = req.body;
  const amt = parseFloat(amount);
  if (!phone || !amt || amt <= 0) return res.status(400).json({ error: 'phone and amount required' });
  try {
    const user = await db.query('SELECT id, name FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found — phone check karo' });
    const uid = user.rows[0].id;
    const userName = user.rows[0].name || phone;
    let newBalance;

    if (role === 'driver') {
      const drCheck = await db.query('SELECT id FROM drivers WHERE id=$1', [uid]);
      if (!drCheck.rows[0]) return res.status(400).json({ error: 'Yeh number driver nahi hai' });
      await db.query(
        `INSERT INTO driver_wallet (driver_id, balance, total_earned) VALUES ($1, $2, $2)
         ON CONFLICT (driver_id) DO UPDATE SET balance=driver_wallet.balance+$2, total_earned=driver_wallet.total_earned+$2, updated_at=NOW()`,
        [uid, amt]
      );
      const bal = await db.query('SELECT balance FROM driver_wallet WHERE driver_id=$1', [uid]);
      newBalance = parseFloat(bal.rows[0]?.balance || 0);
      sendFCM(phone, '💰 Wallet Credit!', `Admin ne ₹${amt} wallet mein add kiye!${note ? ' (' + note + ')' : ''}`, { type: 'admin_wallet_credit' }, { role: 'driver' }).catch(() => {});
    } else {
      await db.query(
        `INSERT INTO customer_wallet (user_id, balance) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET balance=customer_wallet.balance+$2, updated_at=NOW()`,
        [uid, amt]
      );
      await db.query(`INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'credit',$2,$3)`, [uid, amt, note || 'Admin manual credit']);
      const bal = await db.query('SELECT balance FROM customer_wallet WHERE user_id=$1', [uid]);
      newBalance = parseFloat(bal.rows[0]?.balance || 0);
    }

    await db.query(
      `INSERT INTO wallet_credits_log (phone, user_name, amount, note, role, new_balance) VALUES ($1,$2,$3,$4,$5,$6)`,
      [phone, userName, amt, note || null, role, newBalance]
    ).catch(() => {});

    res.json({ success: true, new_balance: newBalance, user_name: userName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/wallet-credits — recent manual credit history
router.get('/wallet-credits', async (req, res) => {
  try {
    const r = await db.query(`SELECT * FROM wallet_credits_log ORDER BY created_at DESC LIMIT 50`);
    res.json({ credits: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/reset-test-money — ONE-TIME: zero all test-mode balances before live launch
router.post('/reset-test-money', async (req, res) => {
  // Run each reset independently (no transaction) so a missing column in one table
  // doesn't abort and roll back everything else via PostgreSQL transaction abort state.
  const q = (sql) => db.query(sql).then(r => r.rowCount).catch(() => 0);
  try {
    const results = {};
    results.customer_wallets    = await q('UPDATE customer_wallet SET balance = 0, updated_at = NOW()');
    results.transactions        = await q('DELETE FROM transactions');
    results.driver_wallets      = await q('UPDATE driver_wallet SET balance = 0, total_earned = 0, updated_at = NOW()');
    results.driver_commission   = await q('UPDATE driver_wallet SET pending_commission = 0 WHERE pending_commission IS NOT NULL');
    results.bonus_wallets       = await q('UPDATE bonus_wallet SET balance = 0, total_earned = 0, total_redeemed = 0, updated_at = NOW()');
    results.bonus_ledger        = await q('DELETE FROM bonus_ledger');
    results.cashback_events     = await q('DELETE FROM cashback_events');
    results.loyalty_points      = await q('UPDATE customer_loyalty SET total_points = 0, updated_at = NOW()');
    results.referral_rewards    = await q('DELETE FROM referral_rewards');
    results.razorpay_topups     = await q('DELETE FROM razorpay_topups');
    results.commission_payments = await q('DELETE FROM driver_commission_payments');
    results.scratch_cards       = await q('DELETE FROM scratch_cards');
    results.driver_debts        = await q(`UPDATE driver_commissions SET status = 'settled' WHERE status != 'settled'`);
    console.log('🔄 Admin reset-test-money executed:', results);
    res.json({ success: true, message: 'All test money reset to zero. Ready for live launch!', results });
  } catch (err) {
    console.error('reset-test-money error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Cancellation Fee Settings ────────────────────────────────────────────────

// Ensure table exists on startup
db.query(`
  CREATE TABLE IF NOT EXISTS cancellation_settings (
    id                  SERIAL PRIMARY KEY,
    enabled             BOOLEAN DEFAULT true,
    free_cancel_sec     INT     DEFAULT 60,
    base_cancel_fee     INT     DEFAULT 10,
    arrived_cancel_fee  INT     DEFAULT 15,
    wait_fee_free_min   INT     DEFAULT 3,
    wait_fee_per_min    INT     DEFAULT 5,
    updated_at          TIMESTAMP DEFAULT NOW()
  )
`).then(async () => {
  const existing = await db.query('SELECT id FROM cancellation_settings LIMIT 1');
  if (existing.rows.length === 0) {
    await db.query('INSERT INTO cancellation_settings DEFAULT VALUES');
  }
}).catch(() => {});

// GET /api/admin/cancel-settings
router.get('/cancel-settings', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM cancellation_settings ORDER BY id LIMIT 1');
    res.json(r.rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/cancel-settings
router.post('/cancel-settings', async (req, res) => {
  const { enabled, free_cancel_sec, base_cancel_fee, arrived_cancel_fee, wait_fee_free_min, wait_fee_per_min } = req.body;
  try {
    await db.query(`
      UPDATE cancellation_settings SET
        enabled            = COALESCE($1, enabled),
        free_cancel_sec    = COALESCE($2, free_cancel_sec),
        base_cancel_fee    = COALESCE($3, base_cancel_fee),
        arrived_cancel_fee = COALESCE($4, arrived_cancel_fee),
        wait_fee_free_min  = COALESCE($5, wait_fee_free_min),
        wait_fee_per_min   = COALESCE($6, wait_fee_per_min),
        updated_at         = NOW()
      WHERE id = (SELECT id FROM cancellation_settings ORDER BY id LIMIT 1)
    `, [
      enabled !== undefined ? enabled : null,
      free_cancel_sec     != null ? parseInt(free_cancel_sec)     : null,
      base_cancel_fee     != null ? parseInt(base_cancel_fee)     : null,
      arrived_cancel_fee  != null ? parseInt(arrived_cancel_fee)  : null,
      wait_fee_free_min   != null ? parseInt(wait_fee_free_min)   : null,
      wait_fee_per_min    != null ? parseInt(wait_fee_per_min)    : null,
    ]);
    const r = await db.query('SELECT * FROM cancellation_settings ORDER BY id LIMIT 1');
    res.json({ success: true, settings: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/revenue-daily?days=7
router.get('/revenue-daily', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const r = await db.query(`
      WITH daily_rides AS (
        SELECT DATE(created_at) AS date, id AS ride_id, fare
        FROM rides
        WHERE status = 'completed'
          AND created_at >= NOW() - INTERVAL '1 day' * $1
      ),
      latest_comm AS (
        SELECT DISTINCT ON (ride_id) ride_id, commission
        FROM driver_commissions
        ORDER BY ride_id, created_at DESC
      )
      SELECT
        dr.date,
        COUNT(*) AS rides,
        COALESCE(SUM(dr.fare), 0) AS gross_revenue,
        COALESCE(SUM(lc.commission), 0) AS commission
      FROM daily_rides dr
      LEFT JOIN latest_comm lc ON lc.ride_id = dr.ride_id
      GROUP BY dr.date
      ORDER BY dr.date
    `, [days]);
    res.json({ days: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
