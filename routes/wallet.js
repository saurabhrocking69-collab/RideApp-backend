const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../config/db');
const razorpay = require('../config/razorpay');
const { sendFCM } = require('../config/firebase');

// GET /api/wallet/balance
router.get('/balance', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ balance: 0 });
    const userId = user.rows[0].id;
    let wallet = await db.query('SELECT balance FROM customer_wallet WHERE user_id = $1', [userId]);
    if (wallet.rows.length === 0) {
      await db.query('INSERT INTO customer_wallet (user_id) VALUES ($1)', [userId]);
      return res.json({ balance: 0 });
    }
    res.json({ balance: parseFloat(wallet.rows[0].balance) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/wallet/add — internal only (admin/webhook). Must supply x-internal-secret header.
router.post('/add', async (req, res) => {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || req.headers['x-internal-secret'] !== secret)
    return res.status(401).json({ error: 'Unauthorized' });
  const { phone, amount } = req.body;
  if (!phone || !amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0)
    return res.status(400).json({ error: 'Invalid phone or amount' });
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User nahi mila' });
    const userId = user.rows[0].id;
    await db.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const result = await db.query('UPDATE customer_wallet SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance', [amount, userId]);
    await db.query("INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'credit', $2, 'Wallet recharge')", [userId, amount]);
    res.json({ success: true, balance: parseFloat(result.rows[0].balance) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/wallet/pay
router.post('/pay', async (req, res) => {
  const { phone, amount, ride_id } = req.body;
  const client = await db.connect();
  try {
    const user = await client.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) { client.release(); return res.status(404).json({ error: 'User nahi mila' }); }
    const userId = user.rows[0].id;
    await client.query('BEGIN');
    const wallet = await client.query('SELECT balance FROM customer_wallet WHERE user_id = $1 FOR UPDATE', [userId]);
    const balance = wallet.rows[0] ? parseFloat(wallet.rows[0].balance) : 0;
    if (balance < amount) {
      await client.query('ROLLBACK');
      client.release();
      return res.json({ success: false, message: 'Wallet mein paisa kam hai', balance });
    }
    const result = await client.query(
      'UPDATE customer_wallet SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance',
      [amount, userId]
    );
    await client.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'debit', $2, 'Ride payment')",
      [userId, amount]
    );
    await client.query(
      "INSERT INTO payments (ride_id, amount, method, status) VALUES ($1, $2, 'wallet', 'completed') ON CONFLICT DO NOTHING",
      [ride_id, amount]
    );
    await client.query('COMMIT');
    res.json({ success: true, balance: parseFloat(result.rows[0].balance) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/wallet/transactions
router.get('/transactions', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ transactions: [] });
    const result = await db.query('SELECT type, amount, description, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [user.rows[0].id]);
    res.json({ transactions: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/wallet/topup/order
router.post('/topup/order', async (req, res) => {
  const { phone, amount } = req.body;
  const paise = Math.round(parseFloat(amount || 0) * 100);
  if (paise < 100) return res.status(400).json({ error: 'Minimum ₹1 chahiye' });
  if (!razorpay) return res.status(500).json({ error: 'Payment gateway not configured' });
  try {
    const user = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User nahi mila' });
    const order = await razorpay.orders.create({ amount: paise, currency: 'INR', receipt: `topup_${phone}_${Date.now()}`, notes: { phone, purpose: 'wallet_topup' } });
    res.json({ success: true, order_id: order.id, amount: order.amount, currency: 'INR', key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/wallet/topup/verify
router.post('/topup/verify', async (req, res) => {
  const { phone, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ error: 'Missing payment fields' });
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
  if (expected !== razorpay_signature) return res.status(400).json({ error: 'Invalid payment signature' });

  // Fetch authoritative amount from Razorpay — never trust client-supplied amount
  let rupees;
  try {
    if (!razorpay) return res.status(500).json({ error: 'Payment gateway not configured' });
    const rzpOrder = await razorpay.orders.fetch(razorpay_order_id);
    rupees = rzpOrder.amount / 100; // Razorpay returns paise
  } catch (_e) {
    return res.status(500).json({ error: 'Could not verify payment amount' });
  }

  const client = await db.connect();
  try {
    // BEGIN first — dup check inside transaction prevents race condition
    await client.query('BEGIN');
    const dup = await client.query("SELECT id, amount FROM razorpay_topups WHERE payment_id=$1 AND status='confirmed'", [razorpay_payment_id]);
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      // Webhook already credited this payment — return success so app updates balance + history
      const confirmedAmount = parseFloat(dup.rows[0].amount);
      const user2 = await client.query('SELECT id FROM users WHERE phone=$1', [phone]);
      const w2 = user2.rows[0]
        ? await client.query('SELECT balance FROM customer_wallet WHERE user_id=$1', [user2.rows[0].id])
        : null;
      return res.json({ success: true, balance: parseFloat(w2?.rows[0]?.balance || 0), message: `₹${confirmedAmount} wallet mein add ho gaya!` });
    }
    const user = await client.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User nahi mila' }); }
    const userId = user.rows[0].id;
    await client.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const w = await client.query('UPDATE customer_wallet SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 RETURNING balance', [rupees, userId]);
    await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,$3)", [userId, rupees, `Wallet recharge ₹${rupees} (${razorpay_payment_id})`]);
    await client.query("INSERT INTO razorpay_topups (user_phone,amount,payment_id,status) VALUES ($1,$2,$3,'confirmed')", [phone, rupees, razorpay_payment_id]);
    await client.query('COMMIT');
    res.json({ success: true, balance: parseFloat(w.rows[0].balance), message: `₹${rupees} wallet mein add ho gaya!` });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// GET /api/wallet/customer/detail
router.get('/customer/detail', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id, name FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) return res.json({ balance: 0, transactions: [] });
    const userId = user.rows[0].id;
    const w = await db.query('SELECT balance FROM customer_wallet WHERE user_id=$1', [userId]);
    const txns = await db.query('SELECT id, type, amount, description, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [userId]);
    const stats = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END),0) AS total_credited,
              COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END),0) AS total_spent,
              COALESCE(SUM(CASE WHEN type='credit' AND description LIKE '%reward%' THEN amount ELSE 0 END),0) AS total_rewards,
              COALESCE(SUM(CASE WHEN type='credit' AND description LIKE '%Referral%' THEN amount ELSE 0 END),0) AS referral_earned,
              COALESCE(SUM(CASE WHEN type='credit' AND description LIKE '%refund%' THEN amount ELSE 0 END),0) AS total_refunds
       FROM transactions WHERE user_id=$1`, [userId]
    );
    res.json({ name: user.rows[0].name, balance: parseFloat(w.rows[0]?.balance || 0), transactions: txns.rows, stats: stats.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/wallet/driver/detail
router.get('/driver/detail', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT u.id, u.name, d.vehicle_type, d.vehicle_no FROM users u JOIN drivers d ON u.id=d.id WHERE u.phone=$1', [phone]);
    if (!user.rows[0]) return res.json({ balance: 0, transactions: [] });
    const driverId = user.rows[0].id;
    const w = await db.query('SELECT balance, total_earned, COALESCE(total_withdrawn,0) AS total_withdrawn FROM driver_wallet WHERE driver_id=$1', [driverId]);
    const rides = await db.query(
      `SELECT r.id, r.fare, r.payment_method, r.ride_type, r.created_at, p.name AS passenger_name
       FROM rides r JOIN users d ON r.driver_id=d.id LEFT JOIN users p ON r.passenger_id=p.id
       WHERE d.phone=$1 AND r.status='completed' ORDER BY r.created_at DESC LIMIT 50`, [phone]
    );
    const hourly = await db.query(
      `SELECT id, base_fare, total_fare, driver_earning, vehicle_type, package_hours, customer_phone, created_at
       FROM hourly_bookings WHERE driver_phone=$1 AND status='completed' ORDER BY created_at DESC LIMIT 30`, [phone]
    );
    const payouts = await db.query(
      `SELECT amount, created_at FROM driver_commissions WHERE driver_phone=$1 ORDER BY created_at DESC LIMIT 20`, [phone]
    ).catch(() => ({ rows: [] }));
    res.json({
      name: user.rows[0].name, vehicle_type: user.rows[0].vehicle_type, vehicle_no: user.rows[0].vehicle_no,
      wallet: { balance: parseFloat(w.rows[0]?.balance||0), total_earned: parseFloat(w.rows[0]?.total_earned||0), total_withdrawn: parseFloat(w.rows[0]?.total_withdrawn||0) },
      rides: rides.rows, hourly: hourly.rows, payouts: payouts.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
