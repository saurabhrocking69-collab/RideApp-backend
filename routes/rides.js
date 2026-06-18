const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sendFCM } = require('../config/firebase');
const { emitToRoom } = require('../config/socket');
const { assignRideToNextDriver } = require('../workers/rideWorker');
const { driverLocations } = require('../services/matching');
const { maskPhone } = require('../services/phone');
const { haversineKm } = require('../services/matching');
const { directFavouriteRideIds } = require('./favourites');

function emitRideUpdate(rideId, data) {
  emitToRoom('ride_' + rideId, 'rideUpdate', { rideId, ...data });
}

async function addLoyaltyPoints(userId, points) {
  try {
    await db.query(
      'INSERT INTO customer_loyalty (user_id, total_points) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET total_points=customer_loyalty.total_points+$2, updated_at=NOW()',
      [userId, points]
    );
  } catch (_e) {}
}

// POST /api/rides/book
router.post('/book', async (req, res) => {
  const { passenger_phone, pickup, drop_location, ride_type, pickup_lat, pickup_lng, drop_lat, drop_lng, discount, promo_code } = req.body;
  if (!passenger_phone || String(passenger_phone).length !== 10) return res.status(400).json({ error: 'Valid phone do' });
  if (!pickup || !drop_location) return res.status(400).json({ error: 'Pickup aur drop location chahiye' });
  if (!['auto', 'bike', 'car', 'eriksha', 'luxury', 'green_bike', 'electric_auto'].includes(ride_type)) return res.status(400).json({ error: 'Invalid ride type' });
  try {
    const passenger = await db.query('SELECT * FROM users WHERE phone = $1', [passenger_phone]);
    if (passenger.rows.length === 0) return res.status(404).json({ error: 'Passenger nahi mila' });

    const distance = req.body.distance || 5;
    const fareRes = await db.query('SELECT * FROM fare_settings WHERE vehicle_type = $1', [ride_type]);
    const defaultFares = {
      luxury:        { base_fare: 80,  per_km_rate: 25, night_multiplier: 1.8, night_start: '22:00', night_end: '06:00' },
      car:           { base_fare: 40,  per_km_rate: 15, night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' },
      auto:          { base_fare: 25,  per_km_rate: 12, night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' },
      eriksha:       { base_fare: 20,  per_km_rate: 10, night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' },
      bike:          { base_fare: 15,  per_km_rate: 8,  night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' },
      green_bike:    { base_fare: 12,  per_km_rate: 6,  night_multiplier: 1.2, night_start: '22:00', night_end: '06:00' },
      electric_auto: { base_fare: 20,  per_km_rate: 9,  night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' },
    };
    const f = fareRes.rows[0] || defaultFares[ride_type] || defaultFares.auto;
    const hour = new Date().getHours();
    const nightStart = parseInt(String(f.night_start).split(':')[0]);
    const nightEnd = parseInt(String(f.night_end).split(':')[0]);
    const isNight = hour >= nightStart || hour < nightEnd;
    let fare = Math.round(parseFloat(f.base_fare) + (distance * parseFloat(f.per_km_rate)));
    if (isNight) fare = Math.round(fare * parseFloat(f.night_multiplier));

    const ride = await db.query(
      `INSERT INTO rides (passenger_id, pickup, drop_location, ride_type, fare, status, pickup_lat, pickup_lng, drop_lat, drop_lng, discount, promo_code)
       VALUES ($1, $2, $3, $4, $5, 'searching', $6, $7, $8, $9, $10, $11) RETURNING *`,
      [passenger.rows[0].id, pickup, drop_location, ride_type, fare, pickup_lat || null, pickup_lng || null, drop_lat || null, drop_lng || null, discount || 0, promo_code || null]
    );
    await db.query("UPDATE rides SET status = 'requested' WHERE id = $1", [ride.rows[0].id]);

    res.json({ message: 'Driver dhundh rahe hain...', fare: '₹' + fare, distance: distance + ' km', ride_id: ride.rows[0].id, status: 'requested' });

    assignRideToNextDriver(ride.rows[0].id, pickup_lat || null, pickup_lng || null, ride_type).catch(() => {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/status/:rideId
router.get('/status/:rideId', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.*, u.name as driver_name, u.phone as driver_phone,
              d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.upi_id as driver_upi_id,
              d.verification_status as driver_verification_status, d.rating as driver_rating,
              d.face_photo as driver_photo
       FROM rides r
       LEFT JOIN users u ON r.driver_id = u.id
       LEFT JOIN drivers d ON r.driver_id = d.id
       WHERE r.id = $1`,
      [req.params.rideId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ride nahi mili' });
    const ride = { ...result.rows[0] };
    if (ride.driver_phone) {
      ride.driver_phone_masked = maskPhone(ride.driver_phone);
      delete ride.driver_phone;
    }
    res.json({ ride });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/accept
router.post('/accept', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  if (!ride_id || !driver_phone) return res.status(400).json({ success: false, message: 'ride_id aur driver_phone chahiye' });
  try {
    const driver = await db.query('SELECT id FROM users WHERE phone=$1', [driver_phone]);
    if (!driver.rows[0]) return res.status(404).json({ success: false, message: 'Driver nahi mila' });

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const upd = await db.query(
      `UPDATE rides SET status='matched', start_otp=$1, driver_id=$2,
           assigned_to_phone=NULL, assignment_expires_at=NULL, assignment_queue='[]'
       WHERE id=$3 AND status='requested' AND driver_id IS NULL RETURNING id`,
      [otp, driver.rows[0].id, ride_id]
    );
    if (!upd.rows[0]) return res.json({ success: false, message: 'Ride already kisi aur driver ne le li — agli dekho!' });

    await db.query(
      `INSERT INTO driver_metrics (phone, rides_accepted, idle_since) VALUES ($1, 1, NOW())
       ON CONFLICT (phone) DO UPDATE SET rides_accepted=driver_metrics.rides_accepted+1, idle_since=NOW()`,
      [driver_phone]
    );
    const dm = await db.query('SELECT rides_offered, rides_accepted FROM driver_metrics WHERE phone=$1', [driver_phone]);
    if (dm.rows[0] && dm.rows[0].rides_offered > 0) {
      const rate = (parseFloat(dm.rows[0].rides_accepted) / parseFloat(dm.rows[0].rides_offered)) * 100;
      await db.query('UPDATE driver_metrics SET acceptance_rate=$1 WHERE phone=$2', [Math.min(100, rate).toFixed(2), driver_phone]);
    }

    const rideData = await db.query(`SELECT u.phone as passenger_phone FROM rides r JOIN users u ON r.passenger_id=u.id WHERE r.id=$1`, [ride_id]);
    if (rideData.rows[0]?.passenger_phone)
      sendFCM(rideData.rows[0].passenger_phone, '🚗 Driver Mil Gaya!', 'Aapka driver aa raha hai — OTP ready karo!', { type: 'ride_matched', ride_id: String(ride_id) });

    const dInfo = await db.query(
      `SELECT u.name, d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.rating, d.verification_status, d.face_photo
       FROM users u JOIN drivers d ON u.id=d.id WHERE u.id=$1`, [driver.rows[0].id]
    );
    const di = dInfo.rows[0];
    emitRideUpdate(ride_id, {
      status: 'matched',
      start_otp: otp,
      driver: di ? { name: di.name, vehicle_no: di.vehicle_no, vehicle_brand: di.vehicle_brand, vehicle_model: di.vehicle_model, rating: di.rating, verified: di.verification_status === 'approved', photo: di.face_photo || null } : null,
    });
    res.json({ success: true, message: 'Ride accepted!', otp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/reject-offer
router.post('/reject-offer', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  try {
    const r = await db.query(
      `SELECT assigned_to_phone, assignment_queue, pickup_lat, pickup_lng, ride_type
       FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [ride_id]
    );
    if (!r.rows[0] || r.rows[0].assigned_to_phone !== driver_phone)
      return res.json({ success: false, error: 'Not your assignment' });

    const { pickup_lat, pickup_lng, ride_type, assignment_queue } = r.rows[0];
    const nextQueue = JSON.parse(assignment_queue || '[]');

    const dm = await db.query('SELECT rides_offered, rides_accepted FROM driver_metrics WHERE phone=$1', [driver_phone]);
    if (dm.rows[0] && parseFloat(dm.rows[0].rides_offered) > 0) {
      const rate = (parseFloat(dm.rows[0].rides_accepted) / parseFloat(dm.rows[0].rides_offered)) * 100;
      await db.query('UPDATE driver_metrics SET acceptance_rate=$1 WHERE phone=$2', [Math.min(100, rate).toFixed(2), driver_phone]);
    }

    res.json({ success: true });
    // If this was a direct favourite request, notify customer specifically
    if (directFavouriteRideIds.has(String(ride_id))) {
      directFavouriteRideIds.delete(String(ride_id));
      emitToRoom('ride_' + ride_id, 'rideUpdate', { rideId: ride_id, status: 'buddy_declined' });
    }
    assignRideToNextDriver(ride_id, pickup_lat, pickup_lng, ride_type, nextQueue).catch(() => {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/arrived
router.post('/arrived', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  try {
    if (driver_phone) {
      const owner = await db.query(
        `SELECT 1 FROM rides r JOIN users u ON r.driver_id=u.id WHERE r.id=$1 AND u.phone=$2`, [ride_id, driver_phone]
      );
      if (!owner.rows[0]) return res.status(403).json({ error: 'Yeh ride tumhari nahi hai' });
    }
    await db.query("UPDATE rides SET status = 'arrived' WHERE id = $1", [ride_id]);
    const arrData = await db.query(`SELECT u.phone as passenger_phone FROM rides r JOIN users u ON r.passenger_id = u.id WHERE r.id = $1`, [ride_id]);
    if (arrData.rows[0]?.passenger_phone)
      sendFCM(arrData.rows[0].passenger_phone, '🚗 Driver Aa Gaya!', 'Driver pickup pe hai — OTP batao aur trip shuru karo!', { type: 'driver_arrived', ride_id: String(ride_id) });
    emitRideUpdate(ride_id, { status: 'arrived' });
    res.json({ success: true, message: 'Pickup pe pahunch gaye!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/start
router.post('/start', async (req, res) => {
  const { ride_id, otp, driver_phone } = req.body;
  try {
    const check = await db.query(`SELECT r.start_otp, u.phone as dr_phone FROM rides r LEFT JOIN users u ON r.driver_id=u.id WHERE r.id=$1`, [ride_id]);
    if (!check.rows[0]) return res.status(404).json({ success: false, message: 'Ride nahi mili' });
    if (check.rows[0]?.start_otp !== otp) return res.status(400).json({ success: false, message: 'Galat OTP!' });
    if (driver_phone && check.rows[0].dr_phone && check.rows[0].dr_phone !== driver_phone)
      return res.status(403).json({ success: false, message: 'Yeh ride tumhari nahi hai' });

    await db.query("UPDATE rides SET status = 'started' WHERE id = $1", [ride_id]);
    emitRideUpdate(ride_id, { status: 'started' });
    res.json({ success: true, message: 'Trip shuru!' });

    db.query(`SELECT u.phone FROM rides r JOIN users u ON r.passenger_id=u.id WHERE r.id=$1`, [ride_id])
      .then(r => { if (r.rows[0]) sendFCM(r.rows[0].phone, '🚀 Trip Shuru Ho Gaya!', 'Aapka ride chal raha hai. Safe journey!', { type: 'trip_started', ride_id: String(ride_id) }); })
      .catch(() => {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/cancel (legacy — prefer cancel-smart)
router.post('/cancel', async (req, res) => {
  const { ride_id, reason, driver_phone } = req.body;
  try {
    if (driver_phone) {
      const owner = await db.query(`SELECT 1 FROM rides r JOIN users u ON r.driver_id=u.id WHERE r.id=$1 AND u.phone=$2`, [ride_id, driver_phone]);
      if (!owner.rows[0]) return res.status(403).json({ error: 'Yeh ride tumhari nahi hai' });
    }
    await db.query("UPDATE rides SET status = 'cancelled' WHERE id = $1", [ride_id]);
    res.json({ success: true, message: 'Trip cancel ki', reason });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/cancel-smart
router.post('/cancel-smart', async (req, res) => {
  const { ride_id, cancelled_by, reason, phone } = req.body;
  try {
    const rideRes = await db.query(
      `SELECT r.*, EXTRACT(EPOCH FROM (NOW() - r.created_at)) AS seconds_since_book,
              p.phone AS passenger_phone, u.phone AS driver_phone
       FROM rides r
       LEFT JOIN users p ON r.passenger_id = p.id
       LEFT JOIN users u ON r.driver_id = u.id
       WHERE r.id = $1`,
      [ride_id]
    );
    if (rideRes.rows.length === 0) return res.json({ success: false, message: 'Ride nahi mili' });
    const ride = rideRes.rows[0];
    const secondsAfterBook = Math.round(ride.seconds_since_book || 0);
    let penalty = 0;
    let message = 'Ride cancel ho gayi';

    if (cancelled_by === 'customer') {
      const today = new Date().toISOString().split('T')[0];
      let cm = await db.query('SELECT * FROM customer_metrics WHERE phone = $1', [phone]);
      if (cm.rows.length === 0) {
        await db.query('INSERT INTO customer_metrics (phone) VALUES ($1)', [phone]);
        cm = await db.query('SELECT * FROM customer_metrics WHERE phone = $1', [phone]);
      }
      const metrics = cm.rows[0];
      let cancelsToday = metrics.last_cancel_date && metrics.last_cancel_date.toISOString().split('T')[0] === today ? metrics.cancels_today : 0;

      if (secondsAfterBook <= 60) {
        penalty = 0; message = 'Free cancellation (1 min ke andar)';
      } else if (ride.driver_id) {
        if (cancelsToday >= 3) { penalty = 10; message = 'Cancel fee ₹10 (aaj 3 se zyada cancel)'; }
        else { penalty = ride.status === 'arrived' ? 15 : 10; message = `Cancel fee ₹${penalty}`; }
      }

      const newTrust = Math.max(0, (metrics.trust_score || 100) - (penalty > 0 ? 5 : 2));
      await db.query(
        `UPDATE customer_metrics SET total_cancels = total_cancels + 1, cancels_today = $1, last_cancel_date = $2, trust_score = $3, is_flagged = $4 WHERE phone = $5`,
        [cancelsToday + 1, today, newTrust, newTrust < 50, phone]
      );
      if (ride.driver_phone)
        sendFCM(ride.driver_phone, '🚫 Ride Cancel Ho Gayi', `Customer ne cancel kar di. Reason: ${reason || 'N/A'}`, { type: 'ride_cancelled' }, { channelId: 'ride_requests' });
    }

    if (cancelled_by === 'driver') {
      const today = new Date().toISOString().split('T')[0];
      let dm = await db.query('SELECT * FROM driver_metrics WHERE phone = $1', [phone]);
      if (dm.rows.length === 0) {
        await db.query('INSERT INTO driver_metrics (phone) VALUES ($1)', [phone]);
        dm = await db.query('SELECT * FROM driver_metrics WHERE phone = $1', [phone]);
      }
      const metrics = dm.rows[0];
      let cancelsToday = metrics.last_cancel_date && metrics.last_cancel_date.toISOString().split('T')[0] === today ? metrics.cancels_today : 0;
      cancelsToday += 1;
      const totalCancelled = (metrics.rides_cancelled || 0) + 1;
      const totalAccepted = metrics.rides_accepted || 1;
      const cancelRate = (totalCancelled / (totalAccepted + totalCancelled)) * 100;
      let suspendedUntil = null;
      if (cancelRate > 25 || cancelsToday >= 5) {
        suspendedUntil = new Date(Date.now() + 2 * 60 * 60 * 1000);
        message = '⚠️ Bahut zyada cancel! 2 ghante suspend.';
      } else if (cancelRate > 15) {
        message = '⚠️ Warning: Cancel rate zyada hai, kam rides milengi';
      }
      await db.query(
        `UPDATE driver_metrics SET rides_cancelled = $1, cancels_today = $2, last_cancel_date = $3, cancellation_rate = $4, suspended_until = $5 WHERE phone = $6`,
        [totalCancelled, cancelsToday, today, cancelRate.toFixed(2), suspendedUntil, phone]
      );
      if (ride.passenger_phone)
        sendFCM(ride.passenger_phone, '🚫 Driver ne Cancel Kiya', `Reason: ${reason || 'N/A'}. Naya driver dhundh rahe hain...`, { type: 'ride_cancelled' });
    }

    await db.query(`UPDATE rides SET status = 'cancelled' WHERE id = $1`, [ride_id]);
    await db.query(
      `INSERT INTO cancellations (ride_id, cancelled_by, reason, seconds_after_book, penalty_applied) VALUES ($1, $2, $3, $4, $5)`,
      [ride_id, cancelled_by, reason || '', secondsAfterBook, penalty]
    );
    res.json({ success: true, penalty, message });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/complete
router.post('/complete', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  try {
    if (driver_phone) {
      const owner = await db.query(
        `SELECT 1 FROM rides r JOIN users u ON r.driver_id=u.id WHERE r.id=$1 AND u.phone=$2 AND r.status='started'`, [ride_id, driver_phone]
      );
      if (!owner.rows[0]) return res.status(403).json({ error: 'Yeh ride tumhari nahi hai ya abhi started nahi hai' });
    }
    const upd = await db.query(
      `UPDATE rides SET status = 'completed', payment_status = 'pending', completed_at = NOW() WHERE id = $1 RETURNING id, fare, payment_method, driver_id`,
      [ride_id]
    );
    if (!upd.rows[0]) return res.status(404).json({ error: 'Ride nahi mili' });
    emitRideUpdate(ride_id, { status: 'completed', fare: upd.rows[0].fare, payment_method: upd.rows[0].payment_method });
    res.json({ success: true, fare: upd.rows[0].fare, payment_method: upd.rows[0].payment_method, message: 'Trip complete! Payment ka intezaar karo.' });

    if (upd.rows[0].driver_id) {
      const drvPhone = await db.query('SELECT phone FROM users WHERE id=$1', [upd.rows[0].driver_id]);
      if (drvPhone.rows[0])
        await db.query(`INSERT INTO driver_metrics (phone, idle_since) VALUES ($1, NOW()) ON CONFLICT (phone) DO UPDATE SET idle_since=NOW()`, [drvPhone.rows[0].phone]).catch(() => {});
    }
    try {
      const compData = await db.query(
        `SELECT p.phone as passenger_phone, d.phone as driver_phone
         FROM rides r JOIN users p ON r.passenger_id::text = p.id::text JOIN users d ON r.driver_id::text = d.id::text
         WHERE r.id = $1`, [ride_id]
      );
      if (compData.rows[0]) {
        sendFCM(compData.rows[0].passenger_phone, '🏁 Trip Complete!', 'Payment karo aur driver ko rate karo!', { type: 'trip_completed', ride_id: String(ride_id) });
        sendFCM(compData.rows[0].driver_phone, '✅ Trip Complete!', 'Payment aa rahi hai — wait karo.', { type: 'payment_pending' }, { channelId: 'ride_requests' });
      }
    } catch (_e) {}
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/payment-complete
router.post('/payment-complete', async (req, res) => {
  const { ride_id, payment_method, phone } = req.body;
  try {
    const rideRes = await db.query('SELECT * FROM rides WHERE id = $1', [ride_id]);
    if (rideRes.rows.length === 0) return res.json({ success: false, message: 'Ride nahi mili' });
    const ride = rideRes.rows[0];
    const fare = parseFloat(ride.fare);
    const commission = Math.round(fare * 0.15 * 100) / 100;

    if (payment_method === 'cash') {
      await db.query(`UPDATE rides SET payment_method = 'cash', payment_status = 'cash_pending' WHERE id = $1`, [ride_id]);
      await db.query(
        `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
         SELECT u.phone, $1, $2, $3, 'cash', 'pending'
         FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1`,
        [ride_id, fare, commission]
      );
      return res.json({ success: true, status: 'cash_pending', message: 'Driver ko cash do!' });
    }

    await db.query(
      `UPDATE rides SET payment_method = $1, payment_status = 'completed', commission_amount = $2, commission_status = 'collected' WHERE id = $3`,
      [payment_method, commission, ride_id]
    );
    const commRow = await db.query(
      `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
       SELECT u.phone, $1, $2, $3, $4, 'collected'
       FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1 RETURNING driver_phone`,
      [ride_id, fare, commission, payment_method]
    );

    try {
      const drPhone = commRow.rows[0]?.driver_phone;
      if (drPhone) {
        const drInfo = await db.query(
          `SELECT u.id, COALESCE(w.pending_commission, 0) as pending_commission
           FROM users u LEFT JOIN driver_wallet w ON w.driver_id = u.id WHERE u.phone = $1`, [drPhone]
        );
        if (drInfo.rows[0]) {
          const driverId = drInfo.rows[0].id;
          const pendingCashComm = parseFloat(drInfo.rows[0].pending_commission || 0);
          const driverEarning = Math.round((fare - commission) * 100) / 100;
          const autoDeduct = Math.min(pendingCashComm, driverEarning);
          const actualCredit = Math.round((driverEarning - autoDeduct) * 100) / 100;

          await db.query(
            `INSERT INTO driver_wallet (driver_id, balance, total_earned, pending_commission) VALUES ($1, $2, $3, 0)
             ON CONFLICT (driver_id) DO UPDATE SET
               balance = driver_wallet.balance + $2,
               total_earned = driver_wallet.total_earned + $3,
               pending_commission = GREATEST(0, COALESCE(driver_wallet.pending_commission, 0) - $4)`,
            [driverId, actualCredit, driverEarning, autoDeduct]
          );

          if (autoDeduct > 0) {
            await db.query(`UPDATE driver_commissions SET status = 'auto_settled' WHERE driver_phone = $1 AND status = 'cash_owed'`, [drPhone]).catch(() => {});
            sendFCM(drPhone, '💰 Earning Credited', `₹${actualCredit.toFixed(0)} wallet mein add hua! (₹${autoDeduct.toFixed(0)} pending commission deduct hua)`, { type: 'earning_credited', amount: String(actualCredit), commission_deducted: String(autoDeduct) }).catch(() => {});
          } else {
            sendFCM(drPhone, '💰 Earning Credited', `₹${driverEarning.toFixed(0)} wallet mein add ho gaya!`, { type: 'earning_credited', amount: String(driverEarning) }).catch(() => {});
          }
        }
      }
    } catch (_e) {}

    try {
      const u = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
      if (u.rows[0]) await addLoyaltyPoints(u.rows[0].id, 10);
    } catch (_e) {}

    res.json({ success: true, status: 'completed', message: 'Payment complete!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/cash-confirm
router.post('/cash-confirm', async (req, res) => {
  const { ride_id, phone, payment_method } = req.body;
  const method = payment_method === 'upi_direct' ? 'upi' : 'cash';
  try {
    const rideRes = await db.query('SELECT * FROM rides WHERE id = $1', [ride_id]);
    if (!rideRes.rows[0]) return res.status(404).json({ error: 'Ride nahi mili' });
    const fare = parseFloat(rideRes.rows[0].fare);
    const commission = Math.round(fare * 0.15 * 100) / 100;

    await db.query(`UPDATE rides SET payment_status = 'completed', payment_method = $1, commission_amount = $2 WHERE id = $3`, [method, commission, ride_id]);
    await db.query(`UPDATE driver_commissions SET status = 'cash_owed', payment_method = $1 WHERE ride_id = $2`, [method, ride_id]);
    const walletRes = await db.query(
      `UPDATE driver_wallet SET pending_commission = COALESCE(pending_commission, 0) + $1
       WHERE driver_id = (SELECT id FROM users WHERE phone = $2) RETURNING pending_commission`,
      [commission, phone]
    );
    const totalPending = parseFloat(walletRes.rows[0]?.pending_commission || 0);
    sendFCM(phone, '💰 Commission Due', `₹${commission.toFixed(0)} commission baqi hai. Total pending: ₹${totalPending.toFixed(0)}. App mein pay karo.`, { type: 'commission_due', pending_commission: String(totalPending) }).catch(() => {});
    res.json({ success: true, message: 'Payment confirmed!', pending_commission: totalPending });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/rate
router.post('/rate', async (req, res) => {
  const { ride_id, rating, review, tip } = req.body;
  try {
    await db.query(`UPDATE rides SET rating = $1, review = $2 WHERE id = $3`, [rating, review || null, ride_id]);
    const rideData = await db.query(`SELECT driver_id FROM rides WHERE id = $1`, [ride_id]);
    if (rideData.rows[0]?.driver_id) {
      await db.query(
        `UPDATE drivers SET rating = (SELECT ROUND(AVG(rating)::numeric, 1) FROM rides WHERE driver_id = $1 AND rating IS NOT NULL) WHERE id = $1`,
        [rideData.rows[0].driver_id]
      );
    }
    if (tip && tip > 0 && rideData.rows[0]?.driver_id) {
      await db.query(`UPDATE driver_wallet SET balance = balance + $1, total_earned = total_earned + $1 WHERE driver_id = $2`, [tip, rideData.rows[0].driver_id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/history
router.get('/history', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(
      `SELECT r.id, r.pickup, r.drop_location, r.fare, r.ride_type, r.status, r.created_at,
              d.name AS driver_name, d.phone AS driver_phone, r.driver_id
       FROM rides r JOIN users u ON r.passenger_id = u.id LEFT JOIN users d ON r.driver_id = d.id
       WHERE u.phone = $1 ORDER BY r.created_at DESC LIMIT 50`,
      [phone]
    );
    res.json({ rides: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/payment-status/:rideId
router.get('/payment-status/:rideId', async (req, res) => {
  try {
    const result = await db.query(`SELECT payment_status, payment_method, fare FROM rides WHERE id = $1`, [req.params.rideId]);
    if (result.rows.length === 0) return res.json({ status: 'not_found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/driver-location/:rideId
router.get('/driver-location/:rideId', async (req, res) => {
  try {
    const result = await db.query(`SELECT u.phone FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1`, [req.params.rideId]);
    if (result.rows.length === 0) return res.json({ location: null });
    const driverPhone = result.rows[0].phone;
    let loc = driverLocations[driverPhone];
    if (!loc) {
      const dbLoc = await db.query('SELECT lat, lng, updated_at FROM driver_locations WHERE phone = $1', [driverPhone]);
      if (dbLoc.rows[0]) loc = { lat: parseFloat(dbLoc.rows[0].lat), lng: parseFloat(dbLoc.rows[0].lng), updated: new Date(dbLoc.rows[0].updated_at).getTime() };
    }
    res.json({ location: loc || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/switch-vehicle — customer switches vehicle type while searching
router.post('/switch-vehicle', async (req, res) => {
  const { ride_id, new_vehicle_type } = req.body;
  if (!['auto', 'bike', 'car', 'eriksha', 'luxury', 'green_bike', 'electric_auto'].includes(new_vehicle_type))
    return res.status(400).json({ error: 'Invalid vehicle type' });
  try {
    const r = await db.query(
      `SELECT pickup_lat, pickup_lng, distance FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
      [ride_id]
    );
    if (!r.rows[0]) return res.json({ success: false, message: 'Ride nahi mili ya already assigned hai' });
    const { pickup_lat, pickup_lng, distance } = r.rows[0];

    // Recalculate fare for new vehicle type
    const fareRes = await db.query('SELECT * FROM fare_settings WHERE vehicle_type=$1', [new_vehicle_type]);
    const defaultFares = { luxury: { base_fare: 80, per_km_rate: 25 }, car: { base_fare: 40, per_km_rate: 15 }, auto: { base_fare: 25, per_km_rate: 12 }, eriksha: { base_fare: 20, per_km_rate: 10 }, bike: { base_fare: 15, per_km_rate: 8 } };
    const f = fareRes.rows[0] || defaultFares[new_vehicle_type] || defaultFares.auto;
    const hour = new Date().getHours();
    const isNight = hour >= parseInt(String(f.night_start || '22').split(':')[0]) || hour < parseInt(String(f.night_end || '6').split(':')[0]);
    const dist = parseFloat(distance || '5');
    let newFare = Math.round(parseFloat(f.base_fare) + dist * parseFloat(f.per_km_rate));
    if (isNight) newFare = Math.round(newFare * parseFloat(f.night_multiplier || '1.3'));

    // Update ride_type + clear queue (old BullMQ jobs will see mismatched ride_type and bail)
    await db.query(
      `UPDATE rides SET ride_type=$1, fare=$2, assigned_to_phone=NULL, assignment_expires_at=NULL, assignment_queue='[]' WHERE id=$3`,
      [new_vehicle_type, newFare, ride_id]
    );

    emitRideUpdate(ride_id, { status: 'searching', new_vehicle_type, new_fare: '₹' + newFare });

    assignRideToNextDriver(ride_id, pickup_lat, pickup_lng, new_vehicle_type).catch(() => {});

    res.json({ success: true, new_vehicle_type, new_fare: '₹' + newFare, message: `${new_vehicle_type} driver dhundh rahe hain...` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/extension-request
router.post('/extension-request', async (req, res) => {
  const { customer_phone, new_drop } = req.body;
  const original_ride_id = req.body.original_ride_id;
  const new_drop_lat = req.body.new_drop_lat ? parseFloat(req.body.new_drop_lat) : null;
  const new_drop_lng = req.body.new_drop_lng ? parseFloat(req.body.new_drop_lng) : null;
  if (!original_ride_id || !customer_phone || !new_drop) return res.status(400).json({ error: 'Fields missing' });
  try {
    const rideRes = await db.query(
      `SELECT r.*, u_d.phone AS driver_phone, u_d.name AS driver_name
       FROM rides r JOIN users u_d ON r.driver_id::text = u_d.id::text WHERE r.id = $1`, [original_ride_id]
    );
    if (!rideRes.rows[0]) return res.json({ success: false, error: 'Ride nahi mili' });
    const ride = rideRes.rows[0];
    if (ride.status !== 'completed') return res.json({ success: false, error: 'Ride abhi complete nahi hui' });

    const completedAt = ride.completed_at || ride.created_at;
    const minAgo = (Date.now() - new Date(completedAt).getTime()) / 60000;
    if (minAgo > 15) return res.json({ success: false, expired: true, error: '15-minute window khatam ho gayi — naya ride book karo' });

    const busy = await db.query(
      `SELECT id FROM rides WHERE driver_id = (SELECT id FROM users WHERE phone=$1) AND status IN ('accepted','inride','matched','arrived') LIMIT 1`,
      [ride.driver_phone]
    );
    if (busy.rows[0]) return res.json({ success: false, busy: true, error: 'Driver abhi doosre customer ke saath busy hai' });

    let estFare = 50;
    if (new_drop_lat && new_drop_lng && ride.drop_lat && ride.drop_lng) {
      const km = haversineKm(parseFloat(ride.drop_lat), parseFloat(ride.drop_lng), new_drop_lat, new_drop_lng);
      const fs = await db.query('SELECT * FROM fare_settings WHERE vehicle_type=$1', [ride.ride_type]);
      const f = fs.rows[0] || { base_fare: 25, per_km_rate: 12 };
      estFare = Math.max(20, Math.round(parseFloat(f.base_fare) + km * parseFloat(f.per_km_rate)));
    }

    await db.query("UPDATE ride_extensions SET status='cancelled' WHERE driver_phone=$1 AND status='pending'", [ride.driver_phone]);
    const extR = await db.query(
      `INSERT INTO ride_extensions (original_ride_id, customer_phone, driver_phone, pickup, pickup_lat, pickup_lng, new_drop, new_drop_lat, new_drop_lng, vehicle_type, estimated_fare, window_expires_at, response_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW() + INTERVAL '15 minutes', NOW() + INTERVAL '60 seconds') RETURNING *`,
      [original_ride_id, customer_phone, ride.driver_phone, ride.drop_location, ride.drop_lat || null, ride.drop_lng || null, new_drop, new_drop_lat, new_drop_lng, ride.ride_type, estFare]
    );
    sendFCM(ride.driver_phone, '🔄 Ride Extension!', `${ride.drop_location} → ${new_drop} — ₹${estFare} | Accept karo 60 sec mein`, { type: 'ride_extension' }, { channelId: 'ride_requests' });

    const extId = extR.rows[0].id;
    setTimeout(async () => {
      try { await db.query("UPDATE ride_extensions SET status='expired' WHERE id=$1 AND status='pending'", [extId]); } catch (_e) {}
    }, 62000);

    res.json({ success: true, extension_id: extId, estimated_fare: estFare, driver_name: ride.driver_name, driver_phone: maskPhone(ride.driver_phone) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/extension-status/:id
router.get('/extension-status/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM ride_extensions WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Nahi mila' });
    const ext = r.rows[0];
    if (ext.status === 'pending' && new Date(ext.response_expires_at) < new Date()) {
      await db.query("UPDATE ride_extensions SET status='expired' WHERE id=$1", [ext.id]);
      return res.json({ status: 'expired' });
    }
    res.json({ status: ext.status, new_ride_id: ext.new_ride_id, estimated_fare: ext.estimated_fare, seconds_left: Math.max(0, Math.ceil((new Date(ext.response_expires_at).getTime() - Date.now()) / 1000)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/extension-pending
router.get('/extension-pending', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await db.query(
      `SELECT e.*, u.name AS customer_name FROM ride_extensions e JOIN users u ON u.phone = e.customer_phone
       WHERE e.driver_phone=$1 AND e.status='pending' AND e.response_expires_at > NOW() ORDER BY e.created_at DESC LIMIT 1`,
      [phone]
    );
    if (!r.rows[0]) return res.json({ extension: null });
    const ext = r.rows[0];
    res.json({ extension: { ...ext, seconds_left: Math.max(0, Math.ceil((new Date(ext.response_expires_at).getTime() - Date.now()) / 1000)) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/extension-accept
router.post('/extension-accept', async (req, res) => {
  const { extension_id } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const extR = await client.query("SELECT * FROM ride_extensions WHERE id=$1 AND status='pending' AND response_expires_at > NOW()", [extension_id]);
    if (!extR.rows[0]) { await client.query('ROLLBACK'); client.release(); return res.json({ success: false, error: 'Request expired ya nahi mili' }); }
    const ext = extR.rows[0];
    const newRide = await client.query(
      `INSERT INTO rides (passenger_id, driver_id, pickup, pickup_lat, pickup_lng, drop_location, drop_lat, drop_lng, ride_type, fare, status, payment_method)
       SELECT passenger_id, driver_id, $1, $2, $3, $4, $5, $6, ride_type, $7, 'matched', payment_method FROM rides WHERE id = $8 RETURNING *`,
      [ext.pickup, ext.pickup_lat, ext.pickup_lng, ext.new_drop, ext.new_drop_lat, ext.new_drop_lng, ext.estimated_fare, ext.original_ride_id]
    );
    await client.query("UPDATE ride_extensions SET status='accepted', new_ride_id=$1 WHERE id=$2", [newRide.rows[0].id, extension_id]);
    await client.query('COMMIT');
    client.release();
    sendFCM(ext.customer_phone, '✅ Extension Accepted!', `Driver aa raha hai — ${ext.new_drop}`);
    res.json({ success: true, new_ride_id: newRide.rows[0].id, fare: ext.estimated_fare });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}); client.release();
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rides/extension-reject
router.post('/extension-reject', async (req, res) => {
  const { extension_id } = req.body;
  try {
    const r = await db.query("UPDATE ride_extensions SET status='rejected' WHERE id=$1 RETURNING customer_phone, new_drop", [extension_id]);
    if (r.rows[0]) sendFCM(r.rows[0].customer_phone, '❌ Extension Reject', 'Driver ne reject kiya — naya ride book karo');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/surge-fare
// Customer manually bumps fare after 100s without a driver
router.post('/surge-fare', async (req, res) => {
  const { ride_id, customer_phone, surge_amount } = req.body;
  const amt = parseInt(surge_amount);
  if (!ride_id || !customer_phone) return res.status(400).json({ error: 'ride_id aur customer_phone chahiye' });
  if (![15, 25, 40, 65, 100].includes(amt)) return res.status(400).json({ error: 'Invalid surge amount (15/25/40/65/100 allowed)' });
  try {
    // Ensure columns exist (idempotent)
    await db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS surge_count INTEGER DEFAULT 0').catch(() => {});
    await db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS base_fare INTEGER').catch(() => {});

    const cu = await db.query('SELECT id FROM users WHERE phone=$1', [customer_phone]);
    if (!cu.rows[0]) return res.status(404).json({ error: 'Customer nahi mila' });

    const rideRes = await db.query(
      `SELECT id, fare, surge_count, pickup_lat, pickup_lng, ride_type
       FROM rides WHERE id=$1 AND passenger_id=$2 AND status='requested' AND driver_id IS NULL`,
      [ride_id, cu.rows[0].id]
    );
    if (!rideRes.rows[0]) return res.status(400).json({ error: 'Ride available nahi hai surge ke liye' });

    const r = rideRes.rows[0];
    const currentSurge = parseInt(r.surge_count) || 0;
    if (currentSurge >= 3) return res.status(400).json({ error: 'Max 3 surges allowed' });

    const newFare = parseInt(r.fare) + amt;
    const newSurgeCount = currentSurge + 1;

    await db.query(
      `UPDATE rides SET
         fare         = $1,
         surge_count  = $2,
         base_fare    = COALESCE(base_fare, fare),
         assigned_to_phone = NULL,
         assignment_expires_at = NULL,
         assignment_queue = '[]'
       WHERE id = $3`,
      [newFare, newSurgeCount, ride_id]
    );

    // Restart driver search from scratch with fresh queue
    assignRideToNextDriver(ride_id, r.pickup_lat, r.pickup_lng, r.ride_type, null, 5).catch(() => {});

    res.json({
      success: true,
      new_fare: '₹' + newFare,
      surge_count: newSurgeCount,
      surges_remaining: 3 - newSurgeCount,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
