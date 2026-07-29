const express = require('express');
const router = express.Router();
const db = require('../config/db');
const cloudinary = require('../config/cloudinary');
const { sendFCM } = require('../config/firebase');
const { driverLocations, encodeGeohash, haversineKm } = require('../services/matching');
const { maskPhone } = require('../services/phone');
const { emitToRoom, getIO } = require('../config/socket');
const { directFavouriteRideIds } = require('./favourites');
const { setDriverLoc } = require('../services/rideCache');
const { attachAreaNames } = require('../services/zoneNames');

// POST /api/upload
router.post('/upload', async (req, res) => {
  const { image } = req.body;
  try {
    if (!image) return res.status(400).json({ error: 'Image not found' });
    const result = await cloudinary.uploader.upload(image, { folder: 'rideapp_drivers', resource_type: 'image' });
    res.json({ success: true, url: result.secure_url });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
    res.json({ success: true, message: 'Registration submitted! Verification pending.', status: 'pending' });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/driver/login
router.post('/login', async (req, res) => {
  const { phone } = req.body;
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.phone, d.vehicle_type, d.vehicle_no, d.vehicle_brand, d.vehicle_model,
              d.dl_name, d.dl_number, d.aadhaar_number, d.face_photo,
              d.verification_status, d.admin_message, d.rating, d.is_online
       FROM users u JOIN drivers d ON u.id = d.id WHERE u.phone = $1`, [phone]
    );
    if (result.rows.length === 0) return res.json({ success: false, message: 'This number is not registered. Please sign up as a Sppero Buddy first.' });
    const d = result.rows[0];
    const maskedAadhaar = d.aadhaar_number ? 'XXXX XXXX ' + d.aadhaar_number.replace(/\D/g, '').slice(-4) : null;
    res.json({ success: true, driver: { name: d.name || d.dl_name, phone: d.phone, vehicle_type: d.vehicle_type, vehicle_no: d.vehicle_no, vehicle_brand: d.vehicle_brand, vehicle_model: d.vehicle_model, dl_number: d.dl_number, aadhaar_masked: maskedAadhaar, face_photo: d.face_photo, rating: d.rating || 5.0, status: d.verification_status, admin_message: d.admin_message, is_online: d.is_online } });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/driver/toggle-online
router.post('/toggle-online', async (req, res) => {
  const { phone, is_online } = req.body;
  try {
    await db.query(`UPDATE drivers SET is_online = $1 WHERE id = (SELECT id FROM users WHERE phone = $2)`, [is_online, phone]);
    res.json({ success: true });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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

    // Don't serve standard rides to drivers engaged in an active hourly booking
    const hourlyActive = await db.query(
      `SELECT 1 FROM hourly_bookings WHERE driver_phone=$1 AND status IN ('matched','arrived','active') LIMIT 1`,
      [phone]
    );
    if (hourlyActive.rows[0]) return res.json({ ride: null });

    // Broadcast system: driver sees ride if phone in offered_phones OR directly assigned (favourite buddy)
    const assigned = await db.query(
      `SELECT r.*, COALESCE(NULLIF(r.rider_name,''), p.name) AS passenger_name, COALESCE(NULLIF(r.rider_phone,''), p.phone) AS passenger_phone
       FROM rides r JOIN users p ON r.passenger_id::text = p.id::text
       WHERE (
         $1 = ANY(COALESCE(r.offered_phones, '{}'))
         OR r.assigned_to_phone = $1
       )
         AND NOT ($1 = ANY(COALESCE(r.rejected_phones, '{}')))
         AND r.status='requested' AND r.driver_id IS NULL
         AND r.assignment_expires_at > NOW()
       ORDER BY r.assignment_expires_at ASC LIMIT 1`,
      [phone]
    );
    if (assigned.rows[0]) {
      const r = assigned.rows[0];
      const secLeft = Math.max(0, Math.ceil((new Date(r.assignment_expires_at).getTime() - Date.now()) / 1000));
      const tripKm = (r.pickup_lat && r.drop_lat) ? haversineKm(parseFloat(r.pickup_lat), parseFloat(r.pickup_lng), parseFloat(r.drop_lat), parseFloat(r.drop_lng)) : null;
      const isFavRequest = r.assigned_to_phone === phone || directFavouriteRideIds.has(String(r.id));
      return res.json({ ride: { ...r, seconds_to_accept: secLeft, distance: tripKm ? tripKm.toFixed(1) : null, is_favourite_request: isFavRequest }, pending_commission: pendingComm });
    }

    const vehicleType = dr.vehicle_type === 'ultra_luxury' ? 'luxury' : dr.vehicle_type;
    // Fallback: truly orphaned rides (>2 min, no active BullMQ assignment).
    // MUST exclude this driver if they already rejected — offered_phones tracks rejections.
    const fallback = await db.query(
      `SELECT r.*, COALESCE(NULLIF(r.rider_name,''), p.name) AS passenger_name, COALESCE(NULLIF(r.rider_phone,''), p.phone) AS passenger_phone FROM rides r JOIN users p ON r.passenger_id::text = p.id::text
       WHERE r.status='requested' AND r.driver_id IS NULL AND r.ride_type=$1
         AND (r.assigned_to_phone IS NULL OR r.assignment_expires_at < NOW())
         AND r.created_at < NOW() - INTERVAL '2 minutes'
         AND NOT (COALESCE(r.offered_phones, '{}') @> ARRAY[$2::text])
       ORDER BY r.created_at ASC LIMIT 1`, [vehicleType, phone]
    );
    if (fallback.rows[0]) {
      const fb = fallback.rows[0];
      // Mark this driver as assigned so accept-offer endpoint can verify it
      await db.query(
        `UPDATE rides SET assigned_to_phone=$1, assignment_expires_at=NOW()+INTERVAL '30 seconds',
           offered_phones=array_append(COALESCE(offered_phones,'{}'), $1::text)
         WHERE id=$2 AND status='requested' AND driver_id IS NULL AND (assigned_to_phone IS NULL OR assignment_expires_at < NOW())`,
        [phone, fb.id]
      );
      const fbKm = (fb.pickup_lat && fb.drop_lat) ? haversineKm(parseFloat(fb.pickup_lat), parseFloat(fb.pickup_lng), parseFloat(fb.drop_lat), parseFloat(fb.drop_lng)) : null;
      return res.json({ ride: { ...fb, seconds_to_accept: fb.is_scheduled ? 120 : 30, distance: fbKm ? fbKm.toFixed(1) : null }, pending_commission: pendingComm });
    }
    return res.json({ ride: null });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/driver/active-ride
router.get('/active-ride', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(
      `SELECT r.*, COALESCE(NULLIF(r.rider_name,''), p.name) AS passenger_name, COALESCE(NULLIF(r.rider_phone,''), p.phone) AS passenger_phone, d2.vehicle_no
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
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
      const rideId = activeRide.rows[0].id;
      const io = getIO();
      if (io) io.to('ride_' + rideId).emit('driverMoved', { lat: parseFloat(lat), lng: parseFloat(lng) });
      // Redis: fast path for /api/rides/driver-location polling fallback
      setDriverLoc(rideId, parseFloat(lat), parseFloat(lng)).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/driver/upi
router.get('/upi', async (req, res) => {
  const { phone } = req.query;
  try {
    const r = await db.query(`SELECT d.upi_id FROM drivers d JOIN users u ON d.id=u.id WHERE u.phone=$1`, [phone]);
    res.json({ upi_id: r.rows[0]?.upi_id || '' });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/driver/upi
router.post('/upi', async (req, res) => {
  const { phone, upi_id } = req.body;
  try {
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS upi_id VARCHAR(100)');
    const result = await db.query(`UPDATE drivers SET upi_id=$1 WHERE id=(SELECT id FROM users WHERE phone=$2) RETURNING upi_id`, [upi_id, phone]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });
    res.json({ success: true, upi_id: result.rows[0].upi_id });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/driver/bank
router.get('/bank', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_account VARCHAR(50)').catch(() => {});
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20)').catch(() => {});
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_holder VARCHAR(100)').catch(() => {});
    const r = await db.query(
      `SELECT d.bank_account, d.bank_ifsc, d.bank_holder FROM drivers d JOIN users u ON d.id=u.id WHERE u.phone=$1`,
      [phone]
    );
    res.json(r.rows[0] || {});
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/driver/bank
router.post('/bank', async (req, res) => {
  const { phone, bank_account, bank_ifsc, bank_holder } = req.body;
  if (!phone || !bank_account || !bank_ifsc) return res.status(400).json({ error: 'Account number and IFSC required' });
  try {
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_account VARCHAR(50)').catch(() => {});
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_ifsc VARCHAR(20)').catch(() => {});
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS bank_holder VARCHAR(100)').catch(() => {});
    const r = await db.query(
      `UPDATE drivers SET bank_account=$1, bank_ifsc=$2, bank_holder=$3
       WHERE id=(SELECT id FROM users WHERE phone=$4) RETURNING bank_account`,
      [bank_account.trim(), bank_ifsc.trim().toUpperCase(), (bank_holder || '').trim(), phone]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Driver not found' });
    res.json({ success: true });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/driver/target
router.get('/target', async (req, res) => {
  const { phone } = req.query;
  try {
    const target = await db.query('SELECT * FROM driver_targets WHERE active = true LIMIT 1');
    const t = target.rows[0] || { rides_target: 10, bonus_amount: 200 };
    const today = await db.query(
      `SELECT COUNT(*) FROM rides r JOIN users u ON r.driver_id = u.id WHERE u.phone = $1 AND r.status = 'completed' AND r.created_at >= CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM subscription_ride_log srl WHERE srl.ride_id = r.id::text)`, [phone]
    );
    const done = parseInt(today.rows[0].count);
    res.json({ target: t.rides_target, bonus: parseFloat(t.bonus_amount), completed: done, remaining: Math.max(0, t.rides_target - done), achieved: done >= t.rides_target });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/driver/verification-status
router.get('/verification-status', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(`SELECT d.verification_status, d.admin_message FROM drivers d JOIN users u ON d.id = u.id WHERE u.phone = $1`, [phone]);
    if (result.rows.length === 0) return res.json({ status: null });
    res.json({ status: result.rows[0].verification_status, message: result.rows[0].admin_message });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
      return res.json({ suspended: true, minutes_left: minsLeft, message: `You can go online again in ${minsLeft} min` });
    }
    res.json({ suspended: false, cancellation_rate: m.cancellation_rate, acceptance_rate: m.acceptance_rate });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});


// POST /api/driver/payout — creates a pending request; admin approves separately
router.post('/payout', async (req, res) => {
  const { phone, amount, method } = req.body;
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS driver_payouts (
      id SERIAL PRIMARY KEY,
      driver_phone VARCHAR(20) NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      bank_account VARCHAR(50),
      bank_ifsc VARCHAR(20),
      bank_holder VARCHAR(100),
      upi_id VARCHAR(100),
      method VARCHAR(20) DEFAULT 'bank',
      status VARCHAR(20) DEFAULT 'pending',
      admin_note TEXT,
      transaction_ref VARCHAR(100),
      requested_at TIMESTAMP DEFAULT NOW(),
      settled_at TIMESTAMP
    )`);
    const existing = await db.query(
      `SELECT id FROM driver_payouts WHERE driver_phone=$1 AND status='pending'`, [phone]
    );
    if (existing.rows[0]) return res.json({ success: false, message: 'A payout request is already pending — admin will process within 24-48 hours' });
    const drvRes = await db.query(
      `SELECT w.driver_id, w.balance, COALESCE(w.pending_commission, 0) as pending_commission,
         d.bank_account, d.bank_ifsc, d.bank_holder, d.upi_id
       FROM driver_wallet w JOIN users u ON w.driver_id = u.id
       LEFT JOIN drivers d ON d.id = u.id
       WHERE u.phone = $1`, [phone]
    );
    if (!drvRes.rows[0]) return res.status(404).json({ error: 'Driver not found' });
    const { balance, pending_commission, bank_account, bank_ifsc, bank_holder, upi_id } = drvRes.rows[0];
    const amt = parseFloat(amount);
    if (!amt || amt < 100) return res.json({ success: false, message: 'Minimum ₹100 required' });
    if (parseFloat(balance) < amt) return res.json({ success: false, message: 'Insufficient balance', balance: parseFloat(balance) });
    const payMethod = method || (upi_id ? 'upi' : 'bank');
    if (payMethod === 'bank' && !bank_account) return res.json({ success: false, message: 'Please add a bank account first: Profile → Bank Details' });
    await db.query(
      `INSERT INTO driver_payouts (driver_phone, amount, bank_account, bank_ifsc, bank_holder, upi_id, method)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [phone, amt, bank_account || '', bank_ifsc || '', bank_holder || '', upi_id || '', payMethod]
    );
    res.json({
      success: true,
      message: `₹${amt.toFixed(0)} payout request submitted — admin will process within 24-48 hours`,
      pending_amount: amt,
      pending_commission: parseFloat(pending_commission),
    });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/driver/history
router.get('/history', async (req, res) => {
  const { phone } = req.query;
  try {
    const rides = await db.query(
      `SELECT r.id, r.pickup, r.drop_location, r.fare, r.ride_type, r.status, r.created_at, COALESCE(NULLIF(r.rider_name,''), p.name) AS passenger_name
       FROM rides r JOIN users d ON r.driver_id = d.id LEFT JOIN users p ON r.passenger_id = p.id
       WHERE d.phone = $1 AND r.status = 'completed' ORDER BY r.created_at DESC LIMIT 50`, [phone]
    );
    const wallet = await db.query(`SELECT w.balance, w.total_earned FROM driver_wallet w JOIN users d ON w.driver_id = d.id WHERE d.phone = $1`, [phone]);
    res.json({ rides: rides.rows, wallet: wallet.rows[0] || { balance: 0, total_earned: 0 }, total_trips: rides.rows.length });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/driver/commission-status
router.get('/commission-status', async (req, res) => {
  const { phone } = req.query;
  try {
    const w = await db.query(`SELECT COALESCE(pending_commission, 0) as pending_commission FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]);
    const pending = parseFloat(w.rows[0]?.pending_commission || 0);
    const records = await db.query(`SELECT ride_id, fare, commission, payment_method, status, created_at FROM driver_commissions WHERE driver_phone = $1 AND status = 'cash_owed' ORDER BY created_at DESC LIMIT 20`, [phone]);
    res.json({ pending_commission: pending, is_blocked: false, records: records.rows });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/driver/order-history
router.get('/order-history', async (req, res) => {
  const { phone, from, to } = req.query;
  try {
    const driverRes = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (!driverRes.rows[0]) return res.json({ rides: [], summary: { total: 0, completed: 0, cancelled: 0, earnings: 0 } });
    const driverId = driverRes.rows[0].id;
    const fromDate = from || new Date().toISOString().slice(0, 10);
    const toDate = to || fromDate;
    const ridesRes = await db.query(`
      SELECT r.id, r.pickup, r.drop_location, r.fare, r.commission_amount, r.ride_type, r.status, r.created_at, r.payment_method,
             COALESCE(NULLIF(r.rider_name,''), u.name) AS passenger_name, can.cancelled_by
      FROM rides r
      JOIN users u ON r.passenger_id = u.id
      LEFT JOIN cancellations can ON can.ride_id = r.id
      WHERE r.driver_id = $1
        AND r.created_at::date >= $2::date
        AND r.created_at::date <= $3::date
        AND r.status IN ('completed', 'cancelled')
      ORDER BY r.created_at DESC
      LIMIT 200
    `, [driverId, fromDate, toDate]);
    const rides = ridesRes.rows;
    const completed = rides.filter(r => r.status === 'completed');
    const cancelled = rides.filter(r => r.status === 'cancelled');
    // Net earning (fare minus platform commission) — was previously summing
    // raw fare, which overstated what the driver actually took home by their
    // commission % on every ride, shown to them directly as "Earned".
    const earnings = completed.reduce((s, r) => s + Math.max(0, parseFloat(r.fare || 0) - parseFloat(r.commission_amount || 0)), 0);
    res.json({
      rides,
      summary: { total: rides.length, completed: completed.length, cancelled: cancelled.length, earnings: Math.round(earnings) }
    });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/driver/commission-pay
router.post('/commission-pay', async (req, res) => {
  const { phone } = req.body;
  try {
    const w = await db.query(`SELECT COALESCE(pending_commission, 0) as pending_commission FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]);
    const pending = parseFloat(w.rows[0]?.pending_commission || 0);
    if (pending <= 0) return res.json({ success: false, message: 'No pending commission' });
    const razorpay = require('../config/razorpay');
    if (!razorpay) return res.status(500).json({ error: 'Payment gateway not configured' });
    const order = await razorpay.orders.create({ amount: Math.round(pending * 100), currency: 'INR', receipt: `comm_${phone}_${Date.now()}`, notes: { driver_phone: phone, purpose: 'commission_payment' } });
    await db.query(`INSERT INTO driver_commission_payments (driver_phone, amount, payment_id, status) VALUES ($1, $2, $3, 'initiated')`, [phone, pending, order.id]);
    res.json({ success: true, order_id: order.id, amount: order.amount, currency: 'INR', key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
    await db.query(
      `UPDATE driver_wallet SET pending_commission = GREATEST(0, COALESCE(pending_commission,0) - $1)
       WHERE driver_id = (SELECT id FROM users WHERE phone = $2)`,
      [amount, phone]
    );
    const remaining = await db.query(`SELECT COALESCE(pending_commission, 0) as pc FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]);
    const remainingTotal = parseFloat(remaining.rows[0]?.pc || 0);
    if (remainingTotal <= 0)
      await db.query(`UPDATE driver_commissions SET status = 'settled' WHERE driver_phone = $1 AND status = 'cash_owed'`, [phone]).catch(() => {});
    sendFCM(phone, '✅ Commission Paid!', `₹${amount.toFixed(0)} cleared. You can now accept new rides!`, { type: 'commission_cleared' }, { role: 'driver' }).catch(() => {});
    res.json({ success: true, message: 'Payment successful!', pending_commission: remainingTotal });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// ── GET /api/driver/demand-zones — Hot ride zones near driver ──
router.get('/demand-zones', async (req, res) => {
  const { lat, lng } = req.query;
  try {
    const driverLat = parseFloat(lat) || 26.8;
    const driverLng = parseFloat(lng) || 80.9;
    // Active + recent rides grouped by ~2km grid cells
    const r = await db.query(`
      SELECT
        ROUND(pickup_lat::numeric / 0.018) * 0.018 AS zone_lat,
        ROUND(pickup_lng::numeric / 0.018) * 0.018 AS zone_lng,
        COUNT(*) AS ride_count,
        MAX(ride_type) AS top_vehicle,
        ROUND(AVG(COALESCE(fare, 0))) AS avg_fare
      FROM rides
      WHERE created_at > NOW() - INTERVAL '90 minutes'
        AND pickup_lat BETWEEN $1 - 0.35 AND $1 + 0.35
        AND pickup_lng BETWEEN $2 - 0.35 AND $2 + 0.35
        AND pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL
      GROUP BY zone_lat, zone_lng
      HAVING COUNT(*) >= 1
      ORDER BY ride_count DESC
      LIMIT 8
    `, [driverLat, driverLng]);

    const zones = r.rows.map(z => {
      const zLat = parseFloat(z.zone_lat);
      const zLng = parseFloat(z.zone_lng);
      const distKm = haversineKm(driverLat, driverLng, zLat, zLng);
      const count = parseInt(z.ride_count);
      return {
        lat: zLat, lng: zLng,
        ride_count: count,
        top_vehicle: z.top_vehicle || 'any',
        avg_fare: parseInt(z.avg_fare) || 0,
        dist_km: Math.round(distKm * 10) / 10,
        heat: count >= 5 ? 'high' : count >= 3 ? 'medium' : 'low',
      };
    }).sort((a, b) => a.dist_km - b.dist_km);

    await attachAreaNames(zones);

    res.json({ zones, updated_at: new Date().toISOString() });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// ── GET /api/driver/level/:phone — Driver tier + progress ──
router.get('/level/:phone', async (req, res) => {
  try {
    const r = await db.query(`
      SELECT u.id, u.name, d.rating, d.verification_status,
        (SELECT COUNT(*) FROM rides WHERE driver_id = u.id AND payment_status = 'completed') AS completed_rides,
        d.rating AS avg_rating,
        (SELECT COUNT(*) FROM rides WHERE driver_id = u.id AND cancelled_by = 'driver'
          AND created_at > NOW() - INTERVAL '30 days') AS cancels_30d,
        (SELECT COUNT(*) FROM rides WHERE driver_id = u.id
          AND created_at > NOW() - INTERVAL '30 days') AS rides_30d
      FROM users u JOIN drivers d ON d.id = u.id WHERE u.phone = $1`, [req.params.phone]);

    if (!r.rows[0]) return res.status(404).json({ error: 'Driver not found' });
    const d = r.rows[0];
    const completed = parseInt(d.completed_rides) || 0;
    const rating = parseFloat(d.avg_rating) || parseFloat(d.rating) || 4.5;
    const rides30 = parseInt(d.rides_30d) || 0;
    const cancelRate = rides30 > 0 ? (parseInt(d.cancels_30d) / rides30) * 100 : 0;

    const LEVELS = [
      { id: 'platinum', emoji: '💎', name: 'Platinum', minRides: 1000, minRating: 4.8, maxCancel: 5,
        benefits: ['8% commission chhoot', 'Priority matching', 'Featured badge', 'Premium support 24x7', 'Monthly bonus eligible'], color: '#9C27B0' },
      { id: 'gold',     emoji: '🥇', name: 'Gold',     minRides: 500,  minRating: 4.7, maxCancel: 10,
        benefits: ['5% commission chhoot', 'Priority matching', 'Gold badge', 'Priority support'], color: '#F59E0B' },
      { id: 'silver',   emoji: '🥈', name: 'Silver',   minRides: 100,  minRating: 4.5, maxCancel: 20,
        benefits: ['2% commission chhoot', 'Silver badge', 'Priority support'], color: '#64748B' },
      { id: 'bronze',   emoji: '🥉', name: 'Bronze',   minRides: 0,    minRating: 0,   maxCancel: 100,
        benefits: ['Standard commission', 'Basic support'], color: '#CD7F32' },
    ];

    let curIdx = LEVELS.length - 1;
    for (let i = 0; i < LEVELS.length; i++) {
      if (completed >= LEVELS[i].minRides && rating >= LEVELS[i].minRating && cancelRate <= LEVELS[i].maxCancel) {
        curIdx = i; break;
      }
    }
    const cur = LEVELS[curIdx];
    const next = curIdx > 0 ? LEVELS[curIdx - 1] : null;
    const progress = next
      ? Math.min(99, Math.round(((completed - cur.minRides) / (next.minRides - cur.minRides)) * 100))
      : 100;

    res.json({
      level: cur.id, levelName: cur.name, levelEmoji: cur.emoji, levelColor: cur.color,
      nextLevel: next?.id || null, nextLevelName: next?.name || null, nextLevelEmoji: next?.emoji || null,
      progress, nextTarget: next?.minRides || 0,
      completed_rides: completed, avg_rating: Math.round(rating * 10) / 10,
      cancel_rate: Math.round(cancelRate * 10) / 10, rides_this_month: rides30,
      benefits: cur.benefits,
      requirements: next ? { rides: next.minRides, rating: next.minRating, cancel_rate: next.maxCancel } : null,
    });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// ── GET /api/driver/demand-prediction — hourly demand curve for current weekday ──
router.get('/demand-prediction', async (req, res) => {
  const { getDemandPrediction } = require('../services/locationIntelligence');
  try {
    const hourly = await getDemandPrediction();
    const nowHour = new Date().getHours();

    // Find peak windows (top 3 hours)
    const sorted = [...hourly].sort((a, b) => b.rides - a.rides);
    const peakHours = sorted.slice(0, 3).map(h => h.hour).sort((a, b) => a - b);

    // Next upcoming peak (> now)
    const nextPeak = peakHours.find(h => h > nowHour) ?? peakHours[0];
    const minsToNextPeak = nextPeak > nowHour
      ? (nextPeak - nowHour) * 60
      : (24 - nowHour + nextPeak) * 60;

    const fmtHour = h => {
      const ampm = h < 12 ? 'AM' : 'PM';
      const h12 = h % 12 || 12;
      return `${h12}:00 ${ampm}`;
    };

    res.json({
      hourly,
      peak_hours: peakHours,
      next_peak: nextPeak,
      next_peak_label: fmtHour(nextPeak),
      mins_to_next_peak: minsToNextPeak,
      current_hour: nowHour,
      current_intensity: hourly[nowHour]?.intensity || 0,
    });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// ── GET /api/driver/earnings-analytics/:phone ──────────────────────────────
router.get('/earnings-analytics/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await db.query(`SELECT id FROM users WHERE phone = $1`, [phone]);
    if (!user.rows[0]) return res.status(404).json({ error: 'Driver not found' });
    const driverId = user.rows[0].id;

    // Net earning = fare minus this ride's actual stored commission — NOT a
    // flat 0.85 multiplier, which was wrong for subscription drivers (0%
    // commission) and intercity rides (10% not 15%), understating what they
    // actually kept in both cases.
    const NET_EARNED = `COALESCE(SUM(GREATEST(COALESCE(fare, 0) - COALESCE(commission_amount, 0), 0)), 0)`;
    const NET_EARNED_AVG = `COALESCE(AVG(GREATEST(COALESCE(fare, 0) - COALESCE(commission_amount, 0), 0)), 0)`;

    // 7-day daily earnings
    const daily = await db.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'Asia/Kolkata') AS day,
        COUNT(*) AS rides,
        ${NET_EARNED} AS earned
      FROM rides
      WHERE driver_id = $1
        AND payment_status = 'completed'
        AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY day
      ORDER BY day ASC
    `, [driverId]);

    // Hourly earning pattern (last 30 days)
    const hourly = await db.query(`
      SELECT
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata') AS hour,
        COUNT(*) AS rides,
        ${NET_EARNED_AVG} AS avg_earned
      FROM rides
      WHERE driver_id = $1
        AND payment_status = 'completed'
        AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY hour
      ORDER BY hour
    `, [driverId]);

    // This week vs last week
    const weekly = await db.query(`
      SELECT
        CASE WHEN created_at >= date_trunc('week', NOW() AT TIME ZONE 'Asia/Kolkata') THEN 'this' ELSE 'last' END AS week,
        COUNT(*) AS rides,
        ${NET_EARNED} AS earned
      FROM rides
      WHERE driver_id = $1
        AND payment_status = 'completed'
        AND created_at > NOW() - INTERVAL '14 days'
      GROUP BY week
    `, [driverId]);

    // Build 7-day array filling missing days with 0
    const days7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const row = daily.rows.find(r => r.day.toISOString().slice(0, 10) === dayStr);
      days7.push({
        date: dayStr,
        label: i === 0 ? 'Aaj' : i === 1 ? 'Kal' : d.toLocaleDateString('en-IN', { weekday: 'short' }),
        rides: parseInt(row?.rides) || 0,
        earned: Math.round(parseFloat(row?.earned) || 0),
      });
    }

    // Hourly array 0-23
    const hours24 = Array.from({ length: 24 }, (_, h) => {
      const row = hourly.rows.find(r => parseInt(r.hour) === h);
      return { hour: h, rides: parseInt(row?.rides) || 0, avg_earned: Math.round(parseFloat(row?.avg_earned) || 0) };
    });
    const maxEarned = Math.max(...hours24.map(h => h.avg_earned), 1);
    const hoursWithIntensity = hours24.map(h => ({ ...h, intensity: Math.round((h.avg_earned / maxEarned) * 100) }));
    const topHours = [...hoursWithIntensity].sort((a, b) => b.avg_earned - a.avg_earned).slice(0, 3).map(h => h.hour);

    const thisWeek = weekly.rows.find(r => r.week === 'this');
    const lastWeek = weekly.rows.find(r => r.week === 'last');

    res.json({
      days7,
      hours24: hoursWithIntensity,
      top_hours: topHours,
      this_week: { rides: parseInt(thisWeek?.rides) || 0, earned: Math.round(parseFloat(thisWeek?.earned) || 0) },
      last_week: { rides: parseInt(lastWeek?.rides) || 0, earned: Math.round(parseFloat(lastWeek?.earned) || 0) },
    });
  } catch (err) { console.error('[drivers]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

module.exports = router;
