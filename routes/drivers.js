const express = require('express');
const router = express.Router();
const db = require('../config/db');
const cloudinary = require('../config/cloudinary');
const { sendFCM } = require('../config/firebase');
const { driverLocations, encodeGeohash, haversineKm } = require('../services/matching');
const { maskPhone } = require('../services/phone');
const { BONUS_TIERS } = require('../services/pricing');
const { emitToRoom, getIO } = require('../config/socket');
const { directFavouriteRideIds } = require('./favourites');

// POST /api/upload
router.post('/upload', async (req, res) => {
  const { image } = req.body;
  try {
    if (!image) return res.status(400).json({ error: 'Image nahi mili' });
    const result = await cloudinary.uploader.upload(image, { folder: 'rideapp_drivers', resource_type: 'image' });
    res.json({ success: true, url: result.secure_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/register (legacy)
router.post('/register', async (req, res) => {
  const { phone, name, vehicle_type, vehicle_no, license_no } = req.body;
  try {
    let user = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0)
      user = await db.query("INSERT INTO users (phone, name, role) VALUES ($1, $2, 'driver') RETURNING *", [phone, name]);
    const userId = user.rows[0].id;
    const driver = await db.query('INSERT INTO drivers (id, vehicle_type, vehicle_no, license_no) VALUES ($1, $2, $3, $4) RETURNING *', [userId, vehicle_type, vehicle_no, license_no]);
    await db.query('INSERT INTO driver_wallet (driver_id) VALUES ($1)', [userId]);
    res.json({ message: 'Driver registered!', driver: driver.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/register-buddy
router.post('/register-buddy', async (req, res) => {
  const { phone, name, vehicle_type, vehicle_no, vehicle_brand, vehicle_model, dl_name, dl_number, dl_photo, vehicle_photo, rc_photo, aadhaar_number, aadhaar_photo, face_photo } = req.body;
  try {
    let user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    let userId;
    if (user.rows.length === 0) {
      const newUser = await db.query("INSERT INTO users (name, phone, role) VALUES ($1, $2, 'driver') RETURNING id", [name || dl_name, phone]);
      userId = newUser.rows[0].id;
    } else {
      userId = user.rows[0].id;
      await db.query("UPDATE users SET role = 'driver', name = $1 WHERE id = $2", [name || dl_name, userId]);
    }
    const existing = await db.query('SELECT id FROM drivers WHERE id = $1', [userId]);
    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO drivers (id, vehicle_type, vehicle_brand, vehicle_model, vehicle_no, dl_name, dl_number, dl_photo, vehicle_photo, rc_photo, aadhaar_number, aadhaar_photo, face_photo, verification_status, is_online, rating)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',false,5.0)`,
        [userId, vehicle_type, vehicle_brand || null, vehicle_model || null, vehicle_no || null, dl_name, dl_number || null, dl_photo, vehicle_photo, rc_photo || null, aadhaar_number, aadhaar_photo, face_photo]
      );
    } else {
      await db.query(
        `UPDATE drivers SET vehicle_type=$2, vehicle_brand=$3, vehicle_model=$4, vehicle_no=$5, dl_name=$6, dl_number=$7, dl_photo=$8, vehicle_photo=$9, rc_photo=$10, aadhaar_number=$11, aadhaar_photo=$12, face_photo=$13, verification_status='pending', admin_message=NULL WHERE id=$1`,
        [userId, vehicle_type, vehicle_brand || null, vehicle_model || null, vehicle_no || null, dl_name, dl_number || null, dl_photo, vehicle_photo, rc_photo || null, aadhaar_number, aadhaar_photo, face_photo]
      );
    }
    await db.query('INSERT INTO driver_wallet (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING', [userId]);
    res.json({ success: true, message: 'Registration submit ho gaya! Verification pending.', status: 'pending' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/login
router.post('/login', async (req, res) => {
  const { phone } = req.body;
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.phone, d.vehicle_type, d.vehicle_no, d.dl_name, d.verification_status, d.admin_message, d.rating
       FROM users u JOIN drivers d ON u.id = d.id WHERE u.phone = $1`, [phone]
    );
    if (result.rows.length === 0) return res.json({ success: false, message: 'Yeh number registered nahi hai. Pehle Sppero Buddy banein.' });
    const d = result.rows[0];
    res.json({ success: true, driver: { name: d.name || d.dl_name, phone: d.phone, vehicle_type: d.vehicle_type, vehicle_no: d.vehicle_no, rating: d.rating || 5.0, status: d.verification_status, admin_message: d.admin_message } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/toggle-online
router.post('/toggle-online', async (req, res) => {
  const { phone, is_online } = req.body;
  try {
    await db.query(`UPDATE drivers SET is_online = $1 WHERE id = (SELECT id FROM users WHERE phone = $2)`, [is_online, phone]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/pending-ride
router.get('/pending-ride', async (req, res) => {
  const { phone } = req.query;
  try {
    // Run 3 independent queries in parallel — saves ~300ms vs sequential
    const [susp, commWallet, drRes] = await Promise.all([
      db.query('SELECT suspended_until FROM driver_metrics WHERE phone=$1', [phone]),
      db.query(`SELECT COALESCE(w.pending_commission, 0) as pending_commission FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]).catch(() => ({ rows: [] })),
      db.query(`SELECT d.vehicle_type, d.verification_status, d.is_online FROM drivers d JOIN users u ON d.id = u.id WHERE u.phone=$1`, [phone]),
    ]);

    if (susp.rows[0]?.suspended_until && new Date(susp.rows[0].suspended_until) > new Date())
      return res.json({ ride: null, suspended: true });

    const pendingComm = parseFloat(commWallet.rows[0]?.pending_commission || 0);

    if (!drRes.rows[0]) return res.json({ ride: null });
    const dr = drRes.rows[0];
    if (dr.verification_status !== 'approved') return res.json({ ride: null, not_approved: true });
    if (!dr.is_online) return res.json({ ride: null });

    const assigned = await db.query(
      `SELECT r.*, p.name AS passenger_name, p.phone AS passenger_phone
       FROM rides r JOIN users p ON r.passenger_id = p.id
       WHERE r.assigned_to_phone=$1 AND r.status='requested' AND r.driver_id IS NULL AND r.assignment_expires_at > NOW() LIMIT 1`,
      [phone]
    );
    if (assigned.rows[0]) {
      const r = assigned.rows[0];
      const secLeft = Math.max(0, Math.ceil((new Date(r.assignment_expires_at).getTime() - Date.now()) / 1000));
      const tripKm = (r.pickup_lat && r.drop_lat) ? haversineKm(parseFloat(r.pickup_lat), parseFloat(r.pickup_lng), parseFloat(r.drop_lat), parseFloat(r.drop_lng)) : null;
      return res.json({ ride: { ...r, seconds_to_accept: secLeft, distance: tripKm ? tripKm.toFixed(1) : null, is_favourite_request: directFavouriteRideIds.has(String(r.id)) }, pending_commission: pendingComm });
    }

    const vehicleType = dr.vehicle_type === 'ultra_luxury' ? 'luxury' : dr.vehicle_type;
    const fallback = await db.query(
      `SELECT r.*, p.name AS passenger_name, p.phone AS passenger_phone FROM rides r JOIN users p ON r.passenger_id = p.id
       WHERE r.status='requested' AND r.driver_id IS NULL AND r.ride_type=$1
         AND (r.assigned_to_phone IS NULL OR r.assignment_expires_at < NOW()) AND r.created_at < NOW() - INTERVAL '2 minutes'
       ORDER BY r.created_at ASC LIMIT 1`, [vehicleType]
    );
    if (fallback.rows[0]) {
      const fb = fallback.rows[0];
      const fbKm = (fb.pickup_lat && fb.drop_lat) ? haversineKm(parseFloat(fb.pickup_lat), parseFloat(fb.pickup_lng), parseFloat(fb.drop_lat), parseFloat(fb.drop_lng)) : null;
      return res.json({ ride: { ...fb, distance: fbKm ? fbKm.toFixed(1) : null }, pending_commission: pendingComm });
    }
    return res.json({ ride: null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/active-ride
router.get('/active-ride', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(
      `SELECT r.*, p.name AS passenger_name, p.phone AS passenger_phone, d2.vehicle_no
       FROM rides r JOIN users d ON r.driver_id = d.id LEFT JOIN users p ON r.passenger_id::text = p.id::text LEFT JOIN drivers d2 ON r.driver_id = d2.id
       WHERE d.phone = $1 AND r.status IN ('matched','arrived','started') ORDER BY r.created_at DESC LIMIT 1`,
      [phone]
    );
    const ride = result.rows[0] || null;
    if (ride?.passenger_phone) {
      ride.passenger_phone_masked = maskPhone(ride.passenger_phone);
      delete ride.passenger_phone;
    }
    res.json({ ride });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/update-location
router.post('/update-location', async (req, res) => {
  const { phone, lat, lng } = req.body;
  try {
    driverLocations[phone] = { lat, lng, updated: Date.now() };
    const geocell = encodeGeohash(parseFloat(lat), parseFloat(lng), 6);
    await db.query(
      `INSERT INTO driver_locations (phone, lat, lng, geocell, updated_at) VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (phone) DO UPDATE SET lat = $2, lng = $3, geocell = $4, updated_at = NOW()`,
      [phone, lat, lng, geocell]
    );
    const activeRide = await db.query(`SELECT r.id FROM rides r JOIN users u ON r.driver_id=u.id WHERE u.phone=$1 AND r.status IN ('matched','arrived','started') LIMIT 1`, [phone]);
    if (activeRide.rows[0]) {
      const io = getIO();
      if (io) io.to('ride_' + activeRide.rows[0].id).emit('driverMoved', { lat: parseFloat(lat), lng: parseFloat(lng) });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/upi
router.get('/upi', async (req, res) => {
  const { phone } = req.query;
  try {
    const r = await db.query(`SELECT d.upi_id FROM drivers d JOIN users u ON d.id=u.id WHERE u.phone=$1`, [phone]);
    res.json({ upi_id: r.rows[0]?.upi_id || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/upi
router.post('/upi', async (req, res) => {
  const { phone, upi_id } = req.body;
  try {
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS upi_id VARCHAR(100)');
    const result = await db.query(`UPDATE drivers SET upi_id=$1 WHERE id=(SELECT id FROM users WHERE phone=$2) RETURNING upi_id`, [upi_id, phone]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Driver nahi mila' });
    res.json({ success: true, upi_id: result.rows[0].upi_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/bank
router.get('/bank', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone chahiye' });
  try {
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_account VARCHAR(50)').catch(() => {});
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20)').catch(() => {});
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_holder VARCHAR(100)').catch(() => {});
    const r = await db.query(
      `SELECT d.bank_account, d.bank_ifsc, d.bank_holder FROM drivers d JOIN users u ON d.id=u.id WHERE u.phone=$1`,
      [phone]
    );
    res.json(r.rows[0] || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/bank
router.post('/bank', async (req, res) => {
  const { phone, bank_account, bank_ifsc, bank_holder } = req.body;
  if (!phone || !bank_account || !bank_ifsc) return res.status(400).json({ error: 'Account number aur IFSC chahiye' });
  try {
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_account VARCHAR(50)').catch(() => {});
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20)').catch(() => {});
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_holder VARCHAR(100)').catch(() => {});
    const r = await db.query(
      `UPDATE drivers SET bank_account=$1, bank_ifsc=$2, bank_holder=$3
       WHERE id=(SELECT id FROM users WHERE phone=$4) RETURNING bank_account`,
      [bank_account.trim(), bank_ifsc.trim().toUpperCase(), (bank_holder || '').trim(), phone]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Driver nahi mila' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/target
router.get('/target', async (req, res) => {
  const { phone } = req.query;
  try {
    const target = await db.query('SELECT * FROM driver_targets WHERE active = true LIMIT 1');
    const t = target.rows[0] || { rides_target: 10, bonus_amount: 200 };
    const today = await db.query(
      `SELECT COUNT(*) FROM rides r JOIN users u ON r.driver_id = u.id WHERE u.phone = $1 AND r.status = 'completed' AND r.created_at >= CURRENT_DATE`, [phone]
    );
    const done = parseInt(today.rows[0].count);
    res.json({ target: t.rides_target, bonus: parseFloat(t.bonus_amount), completed: done, remaining: Math.max(0, t.rides_target - done), achieved: done >= t.rides_target });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/verification-status
router.get('/verification-status', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(`SELECT d.verification_status, d.admin_message FROM drivers d JOIN users u ON d.id = u.id WHERE u.phone = $1`, [phone]);
    if (result.rows.length === 0) return res.json({ status: null });
    res.json({ status: result.rows[0].verification_status, message: result.rows[0].admin_message });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/check-suspension
router.get('/check-suspension', async (req, res) => {
  const { phone } = req.query;
  try {
    const dm = await db.query('SELECT suspended_until, cancellation_rate, acceptance_rate FROM driver_metrics WHERE phone = $1', [phone]);
    if (dm.rows.length === 0) return res.json({ suspended: false });
    const m = dm.rows[0];
    if (m.suspended_until && new Date(m.suspended_until) > new Date()) {
      const minsLeft = Math.ceil((new Date(m.suspended_until) - new Date()) / 60000);
      return res.json({ suspended: true, minutes_left: minsLeft, message: `${minsLeft} min baad online ho sakte ho` });
    }
    res.json({ suspended: false, cancellation_rate: m.cancellation_rate, acceptance_rate: m.acceptance_rate });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/track-metric
router.post('/track-metric', async (req, res) => {
  const { phone, action } = req.body;
  try {
    let dm = await db.query('SELECT * FROM driver_metrics WHERE phone = $1', [phone]);
    if (dm.rows.length === 0) await db.query('INSERT INTO driver_metrics (phone) VALUES ($1)', [phone]);
    if (action === 'offered') await db.query('UPDATE driver_metrics SET rides_offered = rides_offered + 1 WHERE phone = $1', [phone]);
    if (action === 'accepted') {
      await db.query('UPDATE driver_metrics SET rides_accepted = rides_accepted + 1, idle_since = NOW() WHERE phone = $1', [phone]);
      const m = (await db.query('SELECT rides_offered, rides_accepted FROM driver_metrics WHERE phone = $1', [phone])).rows[0];
      if (m && m.rides_offered > 0) {
        const accRate = (m.rides_accepted / m.rides_offered) * 100;
        await db.query('UPDATE driver_metrics SET acceptance_rate = $1 WHERE phone = $2', [Math.min(100, accRate).toFixed(2), phone]);
      }
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/bonus-today
router.get('/bonus-today', async (req, res) => {
  const { phone } = req.query;
  try {
    const rides = await db.query(`SELECT COUNT(*) as cnt FROM rides r JOIN users u ON r.driver_id=u.id WHERE u.phone=$1 AND r.status='completed' AND DATE(r.created_at)=CURRENT_DATE`, [phone]);
    const ridesCount = parseInt(rides.rows[0].cnt);
    const claimed = await db.query(`SELECT bonus_tier FROM driver_bonus_claims WHERE driver_phone=$1 AND claim_date=CURRENT_DATE`, [phone]);
    const claimedTiers = claimed.rows.map(r => r.bonus_tier);
    const available = BONUS_TIERS.filter(t => ridesCount >= t.rides && !claimedTiers.includes(t.tier));
    const next = BONUS_TIERS.find(t => ridesCount < t.rides);
    res.json({ rides_today: ridesCount, available_bonuses: available, claimed_tiers: claimedTiers, next_target: next || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/bonus-claim
router.post('/bonus-claim', async (req, res) => {
  const { phone, tier } = req.body;
  const tierInfo = BONUS_TIERS.find(t => t.tier === tier);
  if (!tierInfo) return res.status(400).json({ error: 'Invalid tier' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const rides = await client.query(`SELECT COUNT(*) as cnt FROM rides r JOIN users u ON r.driver_id=u.id WHERE u.phone=$1 AND r.status='completed' AND DATE(r.created_at)=CURRENT_DATE`, [phone]);
    if (parseInt(rides.rows[0].cnt) < tierInfo.rides) { await client.query('ROLLBACK'); return res.json({ success: false, error: `${tierInfo.rides} rides chahiye` }); }
    await client.query(`INSERT INTO driver_bonus_claims (driver_phone, claim_date, rides_at_claim, bonus_tier, bonus_amount) VALUES ($1, CURRENT_DATE, $2, $3, $4)`, [phone, parseInt(rides.rows[0].cnt), tier, tierInfo.bonus]);
    const u = await client.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (u.rows[0]) {
      await client.query('UPDATE driver_wallet SET balance=balance+$1, total_earned=total_earned+$1 WHERE driver_id=$2', [tierInfo.bonus, u.rows[0].id]);
      await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Daily bonus reward')", [u.rows[0].id, tierInfo.bonus]);
    }
    await client.query('COMMIT');
    res.json({ success: true, bonus_amount: tierInfo.bonus, message: `₹${tierInfo.bonus} bonus wallet mein add ho gaya!` });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.json({ success: false, error: 'Is tier ka bonus aaj already claim hua' });
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/driver/payout
router.post('/payout', async (req, res) => {
  const { phone, amount } = req.body;
  try {
    const driver = await db.query(`SELECT w.driver_id, w.balance, COALESCE(w.pending_commission, 0) as pending_commission FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]);
    if (!driver.rows[0]) return res.status(404).json({ error: 'Driver nahi mila' });
    const balance = parseFloat(driver.rows[0].balance);
    const pendingCommission = parseFloat(driver.rows[0].pending_commission);
    if (balance < amount) return res.json({ success: false, message: 'Balance kam hai', balance });
    const commDeduct = Math.min(pendingCommission, amount);
    const actualPayout = amount - commDeduct;
    const result = await db.query(
      `UPDATE driver_wallet SET balance = balance - $1, total_withdrawn = total_withdrawn + $2, pending_commission = GREATEST(0, COALESCE(pending_commission, 0) - $3) WHERE driver_id = $4 RETURNING balance, pending_commission`,
      [amount, actualPayout, commDeduct, driver.rows[0].driver_id]
    );
    if (commDeduct > 0) await db.query(`UPDATE driver_commissions SET status = 'settled' WHERE driver_phone = $1 AND status = 'cash_owed'`, [phone]).catch(() => {});
    const newPending = parseFloat(result.rows[0].pending_commission);
    res.json({ success: true, balance: parseFloat(result.rows[0].balance), actual_payout: actualPayout, commission_deducted: commDeduct, pending_commission: newPending, message: commDeduct > 0 ? `Payout bhej di! ₹${commDeduct.toFixed(0)} commission platform ne rakha.` : 'Payout request submitted!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/history
router.get('/history', async (req, res) => {
  const { phone } = req.query;
  try {
    const rides = await db.query(
      `SELECT r.id, r.pickup, r.drop_location, r.fare, r.ride_type, r.status, r.created_at, p.name AS passenger_name
       FROM rides r JOIN users d ON r.driver_id = d.id LEFT JOIN users p ON r.passenger_id = p.id
       WHERE d.phone = $1 AND r.status = 'completed' ORDER BY r.created_at DESC LIMIT 50`, [phone]
    );
    const wallet = await db.query(`SELECT w.balance, w.total_earned FROM driver_wallet w JOIN users d ON w.driver_id = d.id WHERE d.phone = $1`, [phone]);
    res.json({ rides: rides.rows, wallet: wallet.rows[0] || { balance: 0, total_earned: 0 }, total_trips: rides.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/commission-status
router.get('/commission-status', async (req, res) => {
  const { phone } = req.query;
  try {
    const w = await db.query(`SELECT COALESCE(pending_commission, 0) as pending_commission FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]);
    const pending = parseFloat(w.rows[0]?.pending_commission || 0);
    const records = await db.query(`SELECT ride_id, fare, commission, payment_method, status, created_at FROM driver_commissions WHERE driver_phone = $1 AND status = 'cash_owed' ORDER BY created_at DESC LIMIT 20`, [phone]);
    res.json({ pending_commission: pending, is_blocked: false, records: records.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/driver/commission-history
router.get('/commission-history', async (req, res) => {
  const { phone } = req.query;
  try {
    const walletRow = await db.query(`SELECT COALESCE(w.pending_commission, 0) as pending_commission, COALESCE(w.balance, 0) as balance, COALESCE(w.total_earned, 0) as total_earned FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]);
    const commRows = await db.query(`SELECT dc.id, dc.ride_id, dc.fare, dc.commission, dc.payment_method, dc.status, dc.created_at FROM driver_commissions dc WHERE dc.driver_phone = $1 ORDER BY dc.created_at DESC LIMIT 50`, [phone]);
    const payRows = await db.query(`SELECT id, amount, payment_id, status, created_at FROM driver_commission_payments WHERE driver_phone = $1 ORDER BY created_at DESC LIMIT 20`, [phone]);
    const records = commRows.rows;
    const totalCommission = records.reduce((s, r) => s + parseFloat(r.commission), 0);
    const settledCommission = records.filter(r => ['settled', 'collected', 'auto_settled'].includes(r.status)).reduce((s, r) => s + parseFloat(r.commission), 0);
    const pendingCommission = parseFloat(walletRow.rows[0]?.pending_commission || 0);
    res.json({ pending_commission: pendingCommission, total_commission: Math.round(totalCommission * 100) / 100, settled_commission: Math.round(settledCommission * 100) / 100, wallet_balance: parseFloat(walletRow.rows[0]?.balance || 0), total_earned: parseFloat(walletRow.rows[0]?.total_earned || 0), records, payments: payRows.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/commission-pay
router.post('/commission-pay', async (req, res) => {
  const { phone } = req.body;
  try {
    const w = await db.query(`SELECT COALESCE(pending_commission, 0) as pending_commission FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]);
    const pending = parseFloat(w.rows[0]?.pending_commission || 0);
    if (pending <= 0) return res.json({ success: false, message: 'Koi pending commission nahi hai' });
    const razorpay = require('../config/razorpay');
    if (!razorpay) return res.status(500).json({ error: 'Payment gateway not configured' });
    const order = await razorpay.orders.create({ amount: Math.round(pending * 100), currency: 'INR', receipt: `comm_${phone}_${Date.now()}`, notes: { driver_phone: phone, purpose: 'commission_payment' } });
    await db.query(`INSERT INTO driver_commission_payments (driver_phone, amount, payment_id, status) VALUES ($1, $2, $3, 'initiated')`, [phone, pending, order.id]);
    res.json({ success: true, order_id: order.id, amount: order.amount, currency: 'INR', key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/driver/commission-pay-verify
router.post('/commission-pay-verify', async (req, res) => {
  const { phone, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const crypto = require('crypto');
  try {
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing payment fields' });
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'Invalid payment signature' });
    const payRow = await db.query(`SELECT amount FROM driver_commission_payments WHERE payment_id = $1 AND driver_phone = $2`, [razorpay_order_id, phone]);
    if (!payRow.rows[0]) return res.status(400).json({ error: 'Order not found' });
    const amount = parseFloat(payRow.rows[0].amount);
    await db.query(`UPDATE driver_commission_payments SET status = 'paid', payment_id = $1 WHERE payment_id = $2 AND driver_phone = $3`, [razorpay_payment_id, razorpay_order_id, phone]);
    await db.query(`UPDATE driver_wallet SET pending_commission = GREATEST(0, COALESCE(pending_commission, 0) - $1) WHERE driver_id = (SELECT id FROM users WHERE phone = $2)`, [amount, phone]);
    const remaining = await db.query(`SELECT COALESCE(pending_commission, 0) as pc FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]);
    if (parseFloat(remaining.rows[0]?.pc || 0) <= 0)
      await db.query(`UPDATE driver_commissions SET status = 'settled' WHERE driver_phone = $1 AND status = 'cash_owed'`, [phone]).catch(() => {});
    sendFCM(phone, '✅ Commission Paid!', `₹${amount.toFixed(0)} commission clear ho gaya. Ab aap nayi rides le sakte hain!`, { type: 'commission_cleared' }).catch(() => {});
    res.json({ success: true, message: 'Commission paid!', pending_commission: parseFloat(remaining.rows[0]?.pc || 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
