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
const { transitionRide } = require('../services/rideStateMachine');
const { getRideStatus, getDriverLoc, setRideStatus, clearRide: clearRideCache } = require('../services/rideCache');
const { creditPeakBonusIfApplicable } = require('./bonus');
const { maybeGrantReferralReward } = require('./referral');
const { getSurgeMultiplier } = require('../services/locationIntelligence');

function emitRideUpdate(rideId, data) {
  emitToRoom('ride_' + rideId, 'rideUpdate', { rideId, ...data });
}

// Ensure arrived_at column exists (idempotent)
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMP').catch(() => {});
// Dynamic ETA correction columns + table
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_matched_at TIMESTAMP').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS eta_estimate_min SMALLINT').catch(() => {});
db.query(`CREATE TABLE IF NOT EXISTS eta_zone_corrections (
  geocell        VARCHAR(40) NOT NULL,
  vehicle_type   VARCHAR(30) NOT NULL,
  correction_factor NUMERIC(5,3) DEFAULT 1.0,
  sample_count   INT DEFAULT 0,
  updated_at     TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (geocell, vehicle_type)
)`).catch(() => {});

function _etaGeoCell(lat, lng) {
  const zLat = Math.round(parseFloat(lat) / 0.018) * 0.018;
  const zLng = Math.round(parseFloat(lng) / 0.018) * 0.018;
  return `${zLat.toFixed(3)}_${zLng.toFixed(3)}`;
}
const AVG_SPEED_KMH_ETA = { bike: 20, auto: 16, car: 22, eriksha: 15, green_bike: 18, electric_auto: 16, luxury: 25, ultra_luxury: 25 };

async function addLoyaltyPoints(userId, points) {
  try {
    await db.query(
      'INSERT INTO customer_loyalty (user_id, total_points) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET total_points=customer_loyalty.total_points+$2, updated_at=NOW()',
      [userId, points]
    );
  } catch (_e) {}
}

// Cashback rules engine — runs after every completed payment
async function processCashback(userId, phone, rideId, fare, paymentMethod) {
  const earned = [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rideCountRes = await db.query(
      `SELECT COUNT(*) FROM rides WHERE passenger_id=$1 AND status='completed' AND DATE(created_at AT TIME ZONE 'Asia/Kolkata')=$2`,
      [userId, today]
    );
    const rideCount = parseInt(rideCountRes.rows[0].count);

    async function tryCashback(ruleType, amount, desc) {
      const cbClient = await db.connect();
      try {
        await cbClient.query('BEGIN');
        const g = await cbClient.query(
          `INSERT INTO cashback_events (user_id, ride_id, rule_type, amount) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
          [userId, rideId, ruleType, amount]
        );
        if (!g.rows[0]) { await cbClient.query('ROLLBACK'); return; } // duplicate guard
        await cbClient.query(`INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
        await cbClient.query(`UPDATE customer_wallet SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2`, [amount, userId]);
        await cbClient.query(`INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,$3)`, [userId, amount, `🎁 Cashback: ${desc}`]);
        await cbClient.query('COMMIT');
        earned.push({ rule: ruleType, amount, label: desc });
      } catch (_e) { await cbClient.query('ROLLBACK').catch(() => {}); }
      finally { cbClient.release(); }
    }

    if (fare > 100) await tryCashback('fare_over_100', 10, '₹100+ ride bonus');
    if (rideCount === 2) await tryCashback('second_ride_day', 10, '2nd ride of the day');
    if (rideCount === 3) await tryCashback('third_ride_day', 15, '3rd ride streak bonus');
    if (paymentMethod === 'wallet' && fare >= 50) await tryCashback('wallet_pay', 5, 'Wallet payment bonus');

    await addLoyaltyPoints(userId, 10);

    if (earned.length > 0) {
      const total = earned.reduce((s, e) => s + e.amount, 0);
      sendFCM(phone, '🎁 Cashback Mila!', `₹${total} cashback aapke wallet mein add ho gaya!`, { type: 'cashback_earned', amount: String(total) }, { role: 'customer' }).catch(() => {});
    }
  } catch (_e) {}
  return earned;
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
    if (passenger.rows[0].booking_restricted)
      return res.status(403).json({ error: '🚫 Aapka account temporarily hold pe hai. Kisi pichli ride ka payment issue hai. Support se contact karo: help@sppero.in', restricted: true });

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

    // Surge is NOT applied at booking — it's offered to customer only after no driver accepts
    const ride = await db.query(
      `INSERT INTO rides (passenger_id, pickup, drop_location, ride_type, fare, status, pickup_lat, pickup_lng, drop_lat, drop_lng, discount, promo_code)
       VALUES ($1, $2, $3, $4, $5, 'requested', $6, $7, $8, $9, $10, $11) RETURNING *`,
      [passenger.rows[0].id, pickup, drop_location, ride_type, fare, pickup_lat || null, pickup_lng || null, drop_lat || null, drop_lng || null, discount || 0, promo_code || null]
    );

    res.json({ message: 'Driver dhundh rahe hain...', fare: '₹' + fare, distance: distance + ' km', ride_id: ride.rows[0].id, status: 'requested', surge_multiplier: 1.0 });

    assignRideToNextDriver(ride.rows[0].id, pickup_lat || null, pickup_lng || null, ride_type).catch(() => {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/surge-check — surge multiplier for a pickup location
router.get('/surge-check', async (req, res) => {
  const { lat, lng } = req.query;
  const multiplier = await getSurgeMultiplier(parseFloat(lat), parseFloat(lng));
  const label = multiplier >= 2.0 ? '2x' : multiplier >= 1.5 ? '1.5x' : multiplier >= 1.3 ? '1.3x' : multiplier > 1.0 ? '1.2x' : null;
  res.json({ surge: multiplier, label, is_surge: multiplier > 1.0 });
});

// POST /api/rides/:id/driver-location — driver posts live GPS during active ride
router.post('/:id/driver-location', async (req, res) => {
  const { lat, lng, phone } = req.body;
  const rideId = req.params.id;
  if (!lat || !lng) return res.status(400).json({ error: 'lat lng required' });
  try {
    // Update driver_locations table
    if (phone) {
      await db.query(`
        UPDATE driver_locations SET lat=$1, lng=$2, updated=NOW() WHERE phone=$3
      `, [lat, lng, phone]);
    }
    // Emit to customer's socket room
    emitToRoom('ride_' + rideId, 'driverMoved', { lat, lng });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/status/:rideId
// Reads status from Redis (fast) — falls back to Postgres for full row
router.get('/status/:rideId', async (req, res) => {
  try {
    const cachedStatus = await getRideStatus(req.params.rideId).catch(() => null);

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
    // Prefer Redis status (fresher), fall back to DB
    if (cachedStatus) ride.status = cachedStatus;
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

    // Atomically claim the ride — only the assigned driver (or one accepting after timeout) may claim
    const claim = await db.query(
      `UPDATE rides SET assigned_to_phone=NULL, assignment_expires_at=NULL, assignment_queue='[]'
       WHERE id=$1 AND status='requested' AND driver_id IS NULL
         AND (assigned_to_phone=$2 OR assignment_expires_at IS NULL OR assignment_expires_at < NOW())
       RETURNING id`,
      [ride_id, driver_phone]
    );
    if (!claim.rows[0]) return res.json({ success: false, message: 'Ride already kisi aur driver ne le li — agli dekho!' });

    const dInfo = await db.query(
      `SELECT u.name, d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.rating, d.verification_status, d.face_photo
       FROM users u JOIN drivers d ON u.id=d.id WHERE u.id=$1`, [driver.rows[0].id]
    );
    const di = dInfo.rows[0];
    const driverCard = di
      ? { name: di.name, vehicle_no: di.vehicle_no, vehicle_brand: di.vehicle_brand, vehicle_model: di.vehicle_model, rating: di.rating, verified: di.verification_status === 'approved', photo: di.face_photo || null }
      : null;

    // Compute estimated ETA for dynamic correction tracking
    const rideForEta = await db.query(`SELECT pickup_lat, pickup_lng, ride_type FROM rides WHERE id=$1`, [ride_id]);
    let etaEstimateMin = null;
    if (rideForEta.rows[0]) {
      const { pickup_lat, pickup_lng, ride_type } = rideForEta.rows[0];
      const driverLoc = driverLocations[driver_phone];
      if (driverLoc && pickup_lat && pickup_lng) {
        const distKm = haversineKm(driverLoc.lat, driverLoc.lng, parseFloat(pickup_lat), parseFloat(pickup_lng));
        const speed = AVG_SPEED_KMH_ETA[ride_type] || 18;
        etaEstimateMin = Math.max(1, Math.round((distKm / speed) * 60) + 1);
      }
    }

    // State machine: validated DB update + socket + FCM
    await transitionRide(ride_id, 'matched', {
      extraFields: { start_otp: otp, driver_id: driver.rows[0].id },
      socketData:  { start_otp: otp, driver: driverCard },
    });

    // Record match time + estimated ETA for dynamic ETA correction
    await db.query(
      `UPDATE rides SET driver_matched_at=NOW()${etaEstimateMin ? ', eta_estimate_min=$2' : ''} WHERE id=$1`,
      etaEstimateMin ? [ride_id, etaEstimateMin] : [ride_id]
    ).catch(() => {});


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

    res.json({ success: true, message: 'Ride accepted!', otp });
  } catch (err) {
    if (err.message && err.message.includes('Concurrent transition')) {
      return res.json({ success: false, message: 'Ride kisi aur driver ne le li — agli dekho!' });
    }
    res.status(500).json({ error: err.message });
  }
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

    // ── CRITICAL: clear the active assignment immediately so the orphan auto-advance job
    // (still queued in BullMQ from the original 20s window) returns early when it fires
    // instead of seeing assigned_to_phone===expectedPhone and restarting the cycle.
    await db.query(
      `UPDATE rides SET assigned_to_phone=NULL, assignment_expires_at=NULL
       WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
      [ride_id]
    );

    db.query('SELECT rides_offered, rides_accepted FROM driver_metrics WHERE phone=$1', [driver_phone])
      .then(dm => {
        if (dm.rows[0] && parseFloat(dm.rows[0].rides_offered) > 0) {
          const rate = (parseFloat(dm.rows[0].rides_accepted) / parseFloat(dm.rows[0].rides_offered)) * 100;
          db.query('UPDATE driver_metrics SET acceptance_rate=$1 WHERE phone=$2', [Math.min(100, rate).toFixed(2), driver_phone]).catch(() => {});
        }
      }).catch(() => {});

    res.json({ success: true });
    db.query(
      `SELECT 1 FROM favourite_drivers f
       JOIN rides r ON r.passenger_id = f.customer_id
       JOIN users d ON f.driver_id = d.id
       WHERE r.id=$1 AND d.phone=$2 LIMIT 1`,
      [ride_id, driver_phone]
    ).then(fav => {
      if (fav.rows[0]) emitToRoom('ride_' + ride_id, 'rideUpdate', { rideId: ride_id, status: 'buddy_declined' });
    }).catch(() => {});

    // If there are more pre-scored drivers in the queue, offer the next one (retryRound=0 — normal flow).
    // If the queue is empty (this was the only driver), use retryRound=1 so offered_phones is NEVER
    // cleared — the driver who explicitly said NO won't be re-offered to the same ride.
    const retryRound = nextQueue.length > 0 ? 0 : 1;
    assignRideToNextDriver(ride_id, pickup_lat, pickup_lng, ride_type,
      nextQueue.length > 0 ? nextQueue : null, 5, false, retryRound
    ).catch(() => {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/arrived
router.post('/arrived', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  if (!driver_phone) return res.status(400).json({ error: 'driver_phone required' });
  try {
    const owner = await db.query(
      `SELECT 1 FROM rides r JOIN users u ON r.driver_id=u.id WHERE r.id=$1 AND u.phone=$2`, [ride_id, driver_phone]
    );
    if (!owner.rows[0]) return res.status(403).json({ error: 'Yeh ride tumhari nahi hai' });

    // Fetch ETA data before transitioning so we can compute correction
    const etaRow = await db.query(
      `SELECT pickup_lat, pickup_lng, ride_type, driver_matched_at, eta_estimate_min FROM rides WHERE id=$1`, [ride_id]
    ).catch(() => ({ rows: [] }));

    await transitionRide(ride_id, 'arrived');

    // Update dynamic ETA correction — fire and forget
    (async () => {
      try {
        const r = etaRow.rows[0];
        if (!r || !r.driver_matched_at || !r.eta_estimate_min || !r.pickup_lat) return;
        const actualMin = (Date.now() - new Date(r.driver_matched_at).getTime()) / 60000;
        if (actualMin < 0.5 || actualMin > 60) return; // ignore outliers
        const correction = actualMin / parseFloat(r.eta_estimate_min);
        if (correction < 0.3 || correction > 4) return; // discard extreme outliers
        const geocell = _etaGeoCell(r.pickup_lat, r.pickup_lng);
        const vehicleType = r.ride_type || 'auto';
        // Rolling weighted average: new = old * (n/(n+1)) + correction * (1/(n+1))
        await db.query(`
          INSERT INTO eta_zone_corrections (geocell, vehicle_type, correction_factor, sample_count, updated_at)
          VALUES ($1, $2, $3, 1, NOW())
          ON CONFLICT (geocell, vehicle_type) DO UPDATE SET
            correction_factor = (eta_zone_corrections.correction_factor * LEAST(eta_zone_corrections.sample_count, 19) + $3) / (LEAST(eta_zone_corrections.sample_count, 19) + 1),
            sample_count      = eta_zone_corrections.sample_count + 1,
            updated_at        = NOW()
        `, [geocell, vehicleType, correction.toFixed(3)]);
      } catch (_e) {}
    })();

    res.json({ success: true, message: 'Pickup pe pahunch gaye!' });
  } catch (err) {
    if (err.message?.includes('Invalid transition') || err.message?.includes('Concurrent transition'))
      return res.status(409).json({ error: 'Ride is state mein arrived nahi ho sakti' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rides/start
router.post('/start', async (req, res) => {
  const { ride_id, otp, driver_phone } = req.body;
  if (!driver_phone) return res.status(400).json({ success: false, message: 'driver_phone required' });
  try {
    const check = await db.query(`SELECT r.start_otp, u.phone as dr_phone FROM rides r LEFT JOIN users u ON r.driver_id=u.id WHERE r.id=$1`, [ride_id]);
    if (!check.rows[0]) return res.status(404).json({ success: false, message: 'Ride nahi mili' });
    if (check.rows[0]?.start_otp !== otp) return res.status(400).json({ success: false, message: 'Galat OTP!' });
    if (check.rows[0].dr_phone && check.rows[0].dr_phone !== driver_phone)
      return res.status(403).json({ success: false, message: 'Yeh ride tumhari nahi hai' });

    await transitionRide(ride_id, 'started');
    res.json({ success: true, message: 'Trip shuru!' });
  } catch (err) {
    if (err.message?.includes('Invalid transition') || err.message?.includes('Concurrent transition'))
      return res.status(409).json({ success: false, message: 'Trip abhi start nahi ho sakta — pehle arrived confirm karo' });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rides/cancel (legacy — prefer cancel-smart)
router.post('/cancel', async (req, res) => {
  const { ride_id, reason, driver_phone } = req.body;
  try {
    if (driver_phone) {
      const owner = await db.query(`SELECT 1 FROM rides r JOIN users u ON r.driver_id=u.id WHERE r.id=$1 AND u.phone=$2`, [ride_id, driver_phone]);
      if (!owner.rows[0]) return res.status(403).json({ error: 'Yeh ride tumhari nahi hai' });
    }
    const cancelRes = await db.query(
      "UPDATE rides SET status = 'cancelled' WHERE id = $1 AND status IN ('requested', 'matched', 'arrived') RETURNING id",
      [ride_id]
    );
    if (!cancelRes.rows[0]) return res.json({ success: false, message: 'Ride started, completed ya already cancelled hai' });
    const rideInfo = await db.query('SELECT p.phone AS passenger_phone FROM rides r JOIN users p ON r.passenger_id=p.id WHERE r.id=$1', [ride_id]);
    if (rideInfo.rows[0]) {
      emitRideUpdate(ride_id, { status: 'cancelled' });
      sendFCM(rideInfo.rows[0].passenger_phone, '🚫 Ride Cancel Ho Gayi', 'Driver ne ride cancel kar di', { type: 'ride_cancelled', ride_id: String(ride_id) }, { role: 'customer' });
    }
    res.json({ success: true, message: 'Trip cancel ki', reason });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Helper: load cancel settings from DB (falls back to defaults if table missing)
async function getCancelSettings() {
  try {
    const r = await db.query('SELECT * FROM cancellation_settings ORDER BY id LIMIT 1');
    return r.rows[0] || { enabled: true, free_cancel_sec: 60, base_cancel_fee: 10, arrived_cancel_fee: 15, wait_fee_free_min: 3, wait_fee_per_min: 5 };
  } catch (_e) {
    return { enabled: true, free_cancel_sec: 60, base_cancel_fee: 10, arrived_cancel_fee: 15, wait_fee_free_min: 3, wait_fee_per_min: 5 };
  }
}

// GET /api/rides/cancel-info/:ride_id — live cancellation fee + wait fare for a ride
router.get('/cancel-info/:ride_id', async (req, res) => {
  try {
    const rideRes = await db.query(
      `SELECT r.status, r.driver_id, r.arrived_at, r.fare,
              EXTRACT(EPOCH FROM (NOW() - r.created_at)) AS seconds_since_book,
              EXTRACT(EPOCH FROM (NOW() - r.arrived_at)) AS seconds_driver_waited
       FROM rides r WHERE r.id = $1`,
      [req.params.ride_id]
    );
    if (!rideRes.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    const ride = rideRes.rows[0];
    const cs = await getCancelSettings();
    const secSinceBook = Math.round(ride.seconds_since_book || 0);
    const secDriverWaited = ride.arrived_at ? Math.max(0, Math.round(ride.seconds_driver_waited || 0)) : 0;

    // ── Cancel fee system ──
    let fee = 0, is_free = true, message = 'Free cancel';
    if (cs.enabled && ride.driver_id) {
      if (secSinceBook <= cs.free_cancel_sec) {
        fee = 0; is_free = true; message = `Free (${cs.free_cancel_sec - secSinceBook}s remaining)`;
      } else if (ride.status === 'arrived') {
        const waitMinutes = Math.floor(secDriverWaited / 60);
        const extraMinutes = Math.max(0, waitMinutes - cs.wait_fee_free_min);
        fee = cs.arrived_cancel_fee + extraMinutes * cs.wait_fee_per_min;
        is_free = false;
        message = `₹${fee} cancel fee (driver ${waitMinutes} min wait kar raha)`;
      } else {
        fee = cs.base_cancel_fee; is_free = false; message = `₹${fee} cancel fee`;
      }
    }

    // ── Wait fare system (separate) — ₹1/min after 3 min free ──
    const WAIT_FARE_FREE_MIN = 3;
    const WAIT_FARE_PER_MIN = 1;
    const waitFareMin = Math.floor(secDriverWaited / 60);
    const waitFareBillableMin = Math.max(0, waitFareMin - WAIT_FARE_FREE_MIN);
    const waitFareAdd = waitFareBillableMin * WAIT_FARE_PER_MIN;
    const origFare = parseFloat(String(ride.fare || '0').replace(/[^0-9.]/g, '')) || 0;

    res.json({
      // cancel fee (existing)
      fee, is_free, message,
      driver_wait_sec: secDriverWaited,
      sec_since_book: secSinceBook,
      settings: cs,
      driver_status: ride.status,
      // wait fare (separate system)
      wait_fare_add: waitFareAdd,
      wait_fare_new_total: origFare + waitFareAdd,
      wait_fare_orig: origFare,
      wait_fare_free_min: WAIT_FARE_FREE_MIN,
      wait_fare_billable_min: waitFareBillableMin,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/cancel-smart
router.post('/cancel-smart', async (req, res) => {
  const { ride_id, cancelled_by, reason, phone } = req.body;
  try {
    const cs = await getCancelSettings();
    const rideRes = await db.query(
      `SELECT r.*, EXTRACT(EPOCH FROM (NOW() - r.created_at)) AS seconds_since_book,
              EXTRACT(EPOCH FROM (NOW() - r.arrived_at)) AS seconds_driver_waited,
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
    const secDriverWaited  = ride.arrived_at ? Math.max(0, Math.round(ride.seconds_driver_waited || 0)) : 0;
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

      if (!cs.enabled || secondsAfterBook <= cs.free_cancel_sec) {
        penalty = 0; message = `Free cancellation (${cs.free_cancel_sec}s ke andar)`;
      } else if (ride.driver_id) {
        if (ride.status === 'arrived') {
          const waitMin = Math.floor(secDriverWaited / 60);
          const extraMin = Math.max(0, waitMin - cs.wait_fee_free_min);
          penalty = cs.arrived_cancel_fee + extraMin * cs.wait_fee_per_min;
        } else {
          penalty = cs.base_cancel_fee;
        }
        if (cancelsToday >= 3) { penalty = cs.base_cancel_fee; }
        message = penalty > 0 ? `Cancel fee ₹${penalty}` : 'Free cancellation';
      }

      const newTrust = Math.max(0, (metrics.trust_score || 100) - (penalty > 0 ? 5 : 2));
      await db.query(
        `UPDATE customer_metrics SET total_cancels = total_cancels + 1, cancels_today = $1, last_cancel_date = $2, trust_score = $3, is_flagged = $4 WHERE phone = $5`,
        [cancelsToday + 1, today, newTrust, newTrust < 50, phone]
      );
      if (ride.driver_phone)
        sendFCM(ride.driver_phone, '🚫 Ride Cancel Ho Gayi', `Customer ne cancel kar di. Reason: ${reason || 'N/A'}`, { type: 'ride_cancelled' }, { channelId: 'ride_requests', role: 'driver' });
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
        sendFCM(ride.passenger_phone, '🚫 Driver ne Cancel Kiya', `Reason: ${reason || 'N/A'}. Naya driver dhundh rahe hain...`, { type: 'ride_cancelled' }, { role: 'customer' });
    }

    const smartCancelRes = await db.query(
      `UPDATE rides SET status = 'cancelled' WHERE id = $1 AND status IN ('requested', 'matched', 'arrived') RETURNING id`,
      [ride_id]
    );
    if (!smartCancelRes.rows[0]) return res.json({ success: false, message: 'Ride started, completed ya already cancelled hai' });
    await db.query(
      `INSERT INTO cancellations (ride_id, cancelled_by, reason, seconds_after_book, penalty_applied) VALUES ($1, $2, $3, $4, $5)`,
      [ride_id, cancelled_by, reason || '', secondsAfterBook, penalty]
    );
    // Socket: both apps need real-time cancel, FCM alone isn't enough when app is in foreground
    emitRideUpdate(ride_id, { status: 'cancelled', cancelled_by, penalty });
    clearRideCache(ride_id).catch(() => {});
    res.json({ success: true, penalty, message });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/complete
// Accepts optional driver_lat/driver_lng for early-completion detection.
// If driver is >800m from drop point, marks early_completion=true and auto-raises a complaint.
router.post('/complete', async (req, res) => {
  const { ride_id, driver_phone, driver_lat, driver_lng } = req.body;
  try {
    const rideRow = await db.query(
      `SELECT r.*, u.phone AS passenger_phone, d.phone AS dphone
       FROM rides r
       JOIN users u ON r.passenger_id = u.id
       LEFT JOIN users d ON r.driver_id = d.id
       WHERE r.id=$1 AND r.status='started'`, [ride_id]
    );
    if (!rideRow.rows[0]) return res.status(404).json({ error: 'Ride nahi mili ya started nahi hai' });
    const ride = rideRow.rows[0];

    if (driver_phone && ride.dphone !== driver_phone)
      return res.status(403).json({ error: 'Yeh ride tumhari nahi hai' });

    // ── Early completion detection ───────────────────────────
    let earlyCompletion = false;
    let distFromDrop = null;
    const EARLY_THRESHOLD_KM = 0.8; // 800m — flag if driver completes too far from drop

    if (driver_lat && driver_lng && ride.drop_lat && ride.drop_lng) {
      distFromDrop = haversineKm(
        parseFloat(driver_lat), parseFloat(driver_lng),
        parseFloat(ride.drop_lat), parseFloat(ride.drop_lng)
      );
      if (distFromDrop > EARLY_THRESHOLD_KM) earlyCompletion = true;
    }

    // State machine: DB update + socket + FCM for both parties
    await transitionRide(ride_id, 'completed', {
      extraFields: {
        payment_status: 'pending',
        early_completion: earlyCompletion,
        driver_lat_at_complete: driver_lat || null,
        driver_lng_at_complete: driver_lng || null,
        completion_dist_from_drop: distFromDrop,
      },
      socketData: { fare: ride.fare, early_completion: earlyCompletion },
      custPhone:  ride.passenger_phone,
      drvPhone:   ride.dphone,
    });

    const fare = ride.fare;
    const paymentMethod = ride.payment_method;
    res.json({
      success: true,
      fare,
      payment_method: paymentMethod,
      early_completion: earlyCompletion,
      dist_from_drop: distFromDrop ? distFromDrop.toFixed(2) : null,
      message: earlyCompletion
        ? `⚠️ Trip complete kiya — aap drop se ${(distFromDrop||0).toFixed(1)}km door the. Customer ko inform kar diya gaya.`
        : 'Trip complete! Payment ka intezaar karo.',
    });

    // post-complete async work
    try {
      if (ride.driver_id) {
        const drvPhone = await db.query('SELECT phone FROM users WHERE id=$1', [ride.driver_id]);
        if (drvPhone.rows[0]) {
          await db.query(`INSERT INTO driver_metrics (phone, idle_since) VALUES ($1, NOW()) ON CONFLICT (phone) DO UPDATE SET idle_since=NOW()`, [drvPhone.rows[0].phone]).catch(() => {});
          creditPeakBonusIfApplicable(drvPhone.rows[0].phone, ride_id).catch(() => {});
        }
      }

      // Log incident + auto-complaint for early completion
      if (earlyCompletion) {
        await db.query(
          `INSERT INTO ride_incidents (ride_id, incident_type, detected_by, driver_id, customer_id, metadata)
           VALUES ($1,'early_completion','system',$2,$3,$4)`,
          [ride_id, ride.driver_id, ride.passenger_id,
           JSON.stringify({ dist_km: distFromDrop, driver_lat, driver_lng, drop_lat: ride.drop_lat, drop_lng: ride.drop_lng })]
        ).catch((e) => { console.error('ride_incidents insert failed:', e.message); });

        // Auto-create complaint on behalf of customer
        const cRes = await db.query(
          `INSERT INTO complaints(ride_id,filed_by,filed_against,filer_role,complaint_type,title,description,priority,source)
           VALUES($1,$2,$3,'customer','early_trip_end',
             'Driver ne drop se pehle trip complete kiya',
             $4,'high','system_auto')
           RETURNING id`,
          [ride_id, ride.passenger_id, ride.driver_id,
           `System detected: driver ne trip complete ki jab woh drop location se ${(distFromDrop||0).toFixed(1)}km door the. Ride #${ride_id}.`]
        ).catch((e) => { console.error('Auto-complaint insert failed:', e.message); return { rows: [] }; });

        if (cRes.rows[0]) {
          await db.query(
            `INSERT INTO complaint_timeline(complaint_id,event,description,actor_role,actor_name)
             VALUES($1,'auto_created','System ne early completion detect ki aur complaint auto-raise ki','system','Sppero System')`,
            [cRes.rows[0].id]
          ).catch(() => {});
        }

        // Alert customer about early completion
        sendFCM(ride.passenger_phone,
          '⚠️ Driver ne sahi jagah nahi chhoda!',
          `Aapka driver drop se ${(distFromDrop||0).toFixed(1)}km door tha jab usne trip complete ki. Complaint auto-raise ho gayi.`,
          { type: 'early_completion_alert', ride_id: String(ride_id), complaint_id: cRes.rows[0]?.id || '' },
          { role: 'customer' }
        ).catch(() => {});

        // Warn driver
        sendFCM(ride.dphone,
          '⚠️ Early Trip Completion Detected',
          `Aapne ride #${ride_id} drop location se ${(distFromDrop||0).toFixed(1)}km door complete ki. Yeh platform policy ke against hai.`,
          { type: 'early_completion_warning', ride_id: String(ride_id) },
          { channelId: 'ride_requests', role: 'driver' }
        ).catch(() => {});

        // Strike the driver
        await db.query(
          `UPDATE driver_metrics SET strike_count = COALESCE(strike_count,0)+1 WHERE phone=$1`, [ride.dphone]
        ).catch(() => {});
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

    // Idempotency: if already completed, just re-emit the socket so the driver gets notified
    if (ride.payment_status === 'completed') {
      emitToRoom('ride_' + ride_id, 'paymentConfirmed', { ride_id, status: 'completed', payment_method: ride.payment_method, cashbacks: [] });
      return res.json({ success: true, status: 'completed', already_done: true });
    }

    if (payment_method === 'cash') {
      await db.query(`UPDATE rides SET payment_method = 'cash', payment_status = 'cash_pending' WHERE id = $1`, [ride_id]);
      await db.query(
        `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
         SELECT u.phone, $1, $2, $3, 'cash', 'pending'
         FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1`,
        [ride_id, fare, commission]
      );
      // Customer gets a socket ping to show "give cash to driver" UI
      emitToRoom('ride_' + ride_id, 'paymentConfirmed', { ride_id, status: 'cash_pending', payment_method: 'cash' });
      return res.json({ success: true, status: 'cash_pending', message: 'Driver ko cash do!' });
    }

    const payClient = await db.connect();
    let drPhone = null;
    let driverEarning = 0, autoDeduct = 0, actualCredit = 0;
    try {
      await payClient.query('BEGIN');

      // If switching from cash_pending → digital, remove the pending cash commission
      if (ride.payment_status === 'cash_pending') {
        await payClient.query(
          `DELETE FROM driver_commissions WHERE ride_id=$1 AND status='pending' AND payment_method='cash'`,
          [ride_id]
        );
      }

      await payClient.query(
        `UPDATE rides SET payment_method = $1, payment_status = 'completed', commission_amount = $2, commission_status = 'collected' WHERE id = $3`,
        [payment_method, commission, ride_id]
      );
      const commRow = await payClient.query(
        `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
         SELECT u.phone, $1, $2, $3, $4, 'collected'
         FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1 RETURNING driver_phone`,
        [ride_id, fare, commission, payment_method]
      );

      drPhone = commRow.rows[0]?.driver_phone;
      if (drPhone) {
        const drInfo = await payClient.query(
          `SELECT u.id, COALESCE(w.pending_commission, 0) as pending_commission
           FROM users u LEFT JOIN driver_wallet w ON w.driver_id = u.id WHERE u.phone = $1`, [drPhone]
        );
        if (drInfo.rows[0]) {
          const driverId = drInfo.rows[0].id;
          const pendingCashComm = parseFloat(drInfo.rows[0].pending_commission || 0);
          driverEarning = Math.round((fare - commission) * 100) / 100;
          autoDeduct = Math.min(pendingCashComm, driverEarning);
          actualCredit = Math.round((driverEarning - autoDeduct) * 100) / 100;

          await payClient.query(
            `INSERT INTO driver_wallet (driver_id, balance, total_earned, pending_commission) VALUES ($1, $2, $3, 0)
             ON CONFLICT (driver_id) DO UPDATE SET
               balance = driver_wallet.balance + $2,
               total_earned = driver_wallet.total_earned + $3,
               pending_commission = GREATEST(0, COALESCE(driver_wallet.pending_commission, 0) - $4)`,
            [driverId, actualCredit, driverEarning, autoDeduct]
          );

          if (autoDeduct > 0) {
            await payClient.query(`UPDATE driver_commissions SET status = 'auto_settled' WHERE driver_phone = $1 AND status = 'cash_owed'`, [drPhone]);
          }
        }
      }

      await payClient.query('COMMIT');
    } catch (_e) {
      await payClient.query('ROLLBACK').catch(() => {});
      throw _e;
    } finally {
      payClient.release();
    }

    if (drPhone) {
      if (autoDeduct > 0) {
        sendFCM(drPhone, '💰 Earning Credited', `₹${actualCredit.toFixed(0)} wallet mein add hua! (₹${autoDeduct.toFixed(0)} pending commission deduct hua)`, { type: 'earning_credited', amount: String(actualCredit), commission_deducted: String(autoDeduct) }, { role: 'driver' }).catch(() => {});
      } else {
        sendFCM(drPhone, '💰 Earning Credited', `₹${driverEarning.toFixed(0)} wallet mein add ho gaya!`, { type: 'earning_credited', amount: String(driverEarning) }, { role: 'driver' }).catch(() => {});
      }
    }

    let cashbacks = [];
    try {
      const u = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
      if (u.rows[0]) {
        cashbacks = await processCashback(u.rows[0].id, phone, ride_id, fare, payment_method);
        maybeGrantReferralReward(u.rows[0].id).catch(() => {});
      }
    } catch (_e) {}

    // Socket: customer's payment screen listens for this instead of polling
    emitToRoom('ride_' + ride_id, 'paymentConfirmed', { ride_id, status: 'completed', payment_method, cashbacks });
    res.json({ success: true, status: 'completed', message: 'Payment complete!', cashbacks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/cash-confirm
router.post('/cash-confirm', async (req, res) => {
  const { ride_id, phone, payment_method } = req.body;
  const method = payment_method === 'upi_direct' ? 'upi' : 'cash';
  try {
    const rideRes = await db.query(
      `SELECT r.*, u.phone AS driver_phone FROM rides r
       JOIN users u ON r.driver_id = u.id
       WHERE r.id = $1 AND r.status = 'completed'`,
      [ride_id]
    );
    if (!rideRes.rows[0]) return res.status(404).json({ error: 'Ride nahi mili ya completed nahi hai' });
    if (rideRes.rows[0].driver_phone !== phone)
      return res.status(403).json({ error: 'Yeh ride tumhari nahi hai' });
    if (rideRes.rows[0].payment_status === 'completed')
      return res.json({ success: true, message: 'Payment already confirmed hai' });
    const fare = parseFloat(rideRes.rows[0].fare);
    const commission = Math.round(fare * 0.15 * 100) / 100;

    await db.query(`UPDATE rides SET payment_status = 'completed', payment_method = $1, commission_amount = $2 WHERE id = $3`, [method, commission, ride_id]);
    await db.query(`UPDATE driver_commissions SET status = 'cash_owed', payment_method = $1 WHERE ride_id = $2`, [method, ride_id]);
    // Ensure wallet row exists before updating pending_commission
    const driverUser = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (driverUser.rows[0]) {
      await db.query(
        `INSERT INTO driver_wallet (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING`,
        [driverUser.rows[0].id]
      );
    }
    const walletRes = await db.query(
      `UPDATE driver_wallet SET pending_commission = COALESCE(pending_commission, 0) + $1
       WHERE driver_id = (SELECT id FROM users WHERE phone = $2) RETURNING pending_commission`,
      [commission, phone]
    );
    const totalPending = parseFloat(walletRes.rows[0]?.pending_commission || 0);
    sendFCM(phone, '💰 Commission Due', `₹${commission.toFixed(0)} commission baqi hai. Total pending: ₹${totalPending.toFixed(0)}. App mein pay karo.`, { type: 'commission_due', pending_commission: String(totalPending) }, { role: 'driver' }).catch(() => {});
    // Cashback for customer (cash/upi rides still earn ride-count cashbacks, not wallet bonus)
    let cashbacks = [];
    try {
      const passengerRes = await db.query(`SELECT passenger_id FROM rides WHERE id=$1`, [ride_id]);
      if (passengerRes.rows[0]) {
        const custUser = await db.query(`SELECT id, phone FROM users WHERE id=$1`, [passengerRes.rows[0].passenger_id]);
        if (custUser.rows[0]) {
          cashbacks = await processCashback(custUser.rows[0].id, custUser.rows[0].phone, ride_id, fare, method);
          maybeGrantReferralReward(custUser.rows[0].id).catch(() => {});
        }
      }
    } catch (_e) {}
    // Notify customer's payment screen via socket so it can advance to post-ride without polling
    emitToRoom('ride_' + ride_id, 'paymentConfirmed', { ride_id, status: 'completed', payment_method: method, cashbacks });
    res.json({ success: true, message: 'Payment confirmed!', pending_commission: totalPending, cashbacks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/payment-not-received
// Driver calls this within 10 min of trip completion when cash customer refuses/runs.
// Auto-creates incident + complaint, penalizes customer trust_score.
router.post('/payment-not-received', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  if (!ride_id || !driver_phone) return res.status(400).json({ error: 'ride_id aur driver_phone zaroori hai' });
  try {
    const rideRes = await db.query(
      `SELECT r.*, u.phone AS passenger_phone, u.id AS passenger_id_val,
              d.phone AS dphone, d.id AS driver_id_val,
              u.name AS passenger_name, d.name AS driver_name
       FROM rides r
       JOIN users u ON r.passenger_id = u.id
       JOIN users d ON r.driver_id = d.id
       WHERE r.id=$1 AND d.phone=$2`, [ride_id, driver_phone]
    );
    if (!rideRes.rows[0]) return res.status(404).json({ error: 'Ride nahi mili ya tumhari nahi hai' });
    const ride = rideRes.rows[0];

    if (!['completed', 'cash_pending'].includes(ride.status))
      return res.status(400).json({ error: 'Ride abhi completed nahi hai' });
    if (ride.payment_not_received)
      return res.status(409).json({ error: 'Yeh already report ho chuki hai' });

    // Only allow within 10 minutes of completion
    const minsSinceComplete = (Date.now() - new Date(ride.completed_at || ride.created_at).getTime()) / 60000;
    if (minsSinceComplete > 10)
      return res.status(400).json({ error: 'Payment not received sirf 10 minute ke andar report kar sakte ho' });

    // Mark ride
    await db.query(
      `UPDATE rides SET payment_not_received=true, payment_status='disputed' WHERE id=$1`, [ride_id]
    );

    // Log incident
    await db.query(
      `INSERT INTO ride_incidents(ride_id,incident_type,detected_by,driver_id,customer_id,metadata)
       VALUES($1,'payment_skipped','driver',$2,$3,$4)`,
      [ride_id, ride.driver_id_val, ride.passenger_id_val,
       JSON.stringify({ fare: ride.fare, payment_method: ride.payment_method })]
    ).catch(() => {});

    // Auto-create complaint against customer
    const cRes = await db.query(
      `INSERT INTO complaints(ride_id,filed_by,filed_against,filer_role,complaint_type,title,description,priority,source)
       VALUES($1,$2,$3,'driver','payment_issue',
         'Customer ne cash payment nahi ki',
         $4,'high','driver_report')
       RETURNING id`,
      [ride_id, ride.driver_id_val, ride.passenger_id_val,
       `Driver ${ride.driver_name} (${driver_phone}) ne report kiya: Ride #${ride_id} ke baad customer ${ride.passenger_name} ne ₹${ride.fare} cash payment nahi ki aur chale gaye.`]
    );
    if (cRes.rows[0]) {
      await db.query(
        `INSERT INTO complaint_timeline(complaint_id,event,description,actor_role,actor_name)
         VALUES($1,'driver_reported','Driver ne payment not received report ki','driver',$2)`,
        [cRes.rows[0].id, ride.driver_name]
      ).catch(() => {});
    }

    // Penalize customer trust score
    await db.query(
      `UPDATE users SET trust_score = GREATEST(0, COALESCE(trust_score,100) - 25) WHERE id=$1`, [ride.passenger_id_val]
    ).catch(() => {});

    // Check if repeat offender (3+ payment skips → restrict booking)
    const skipCount = await db.query(
      `SELECT COUNT(*) FROM ride_incidents WHERE customer_id=$1 AND incident_type='payment_skipped'`,
      [ride.passenger_id_val]
    );
    const totalSkips = parseInt(skipCount.rows[0]?.count || 0);
    if (totalSkips >= 3) {
      await db.query(
        `UPDATE users SET booking_restricted=true, booking_restricted_reason='3+ payment skips — admin review required' WHERE id=$1`,
        [ride.passenger_id_val]
      ).catch(() => {});
      sendFCM(ride.passenger_phone, '🚫 Booking Suspended',
        'Aapka account review ke liye hold pe hai. Support se contact karo.',
        { type: 'account_restricted' },
        { role: 'customer' }
      ).catch(() => {});
    }

    // FCM to customer — warning
    sendFCM(ride.passenger_phone,
      '⚠️ Payment Issue Reported',
      `Driver ne report kiya ki aapne ride #${ride_id} ka ₹${ride.fare} cash payment nahi kiya. Please support se contact karo.`,
      { type: 'payment_dispute', ride_id: String(ride_id) },
      { role: 'customer' }
    ).catch(() => {});

    res.json({
      success: true,
      complaint_id: cRes.rows[0]?.id,
      message: 'Payment not received report ho gayi. Admin review karega.',
      customer_trust_score_deducted: 25,
      customer_skips_total: totalSkips,
    });
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

// GET /api/rides/driver-eta — nearest available driver per vehicle type from pickup point
router.get('/driver-eta', async (req, res) => {
  const { pickup_lat, pickup_lng } = req.query;
  if (!pickup_lat || !pickup_lng) return res.status(400).json({ error: 'pickup_lat and pickup_lng required' });
  const lat = parseFloat(pickup_lat);
  const lng = parseFloat(pickup_lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Invalid coordinates' });

  const AVG_SPEED_KMH = { bike: 20, auto: 16, car: 22, eriksha: 15, green_bike: 18, electric_auto: 16, luxury: 25 };

  try {
    const drRes = await db.query(
      `SELECT CASE WHEN d.vehicle_type = 'ultra_luxury' THEN 'luxury' ELSE d.vehicle_type END AS vehicle_type,
              dl.lat, dl.lng
       FROM drivers d
       JOIN users u ON d.id = u.id
       JOIN driver_locations dl ON dl.phone = u.phone
       WHERE d.is_online = true
         AND d.verification_status = 'approved'
         AND dl.updated_at > NOW() - INTERVAL '2 hours'
         AND NOT EXISTS (
           SELECT 1 FROM rides r2
           WHERE r2.driver_id = d.id AND r2.status IN ('matched','arrived','started')
         )`
    );

    const nearest = {};
    for (const dr of drRes.rows) {
      if (!dr.lat || !dr.lng) continue;
      const dist = haversineKm(lat, lng, parseFloat(dr.lat), parseFloat(dr.lng));
      if (dist > 20) continue;
      const prev = nearest[dr.vehicle_type];
      if (!prev || dist < prev.dist_km) {
        const speed = AVG_SPEED_KMH[dr.vehicle_type] || 20;
        nearest[dr.vehicle_type] = {
          dist_km: Math.round(dist * 10) / 10,
          eta_min: Math.max(1, Math.round((dist / speed) * 60) + 1),
          _rawEta: Math.max(1, Math.round((dist / speed) * 60) + 1),
        };
      }
    }

    // Apply dynamic ETA correction factors per zone
    const geocell = _etaGeoCell(lat, lng);
    const vehicleTypes = Object.keys(nearest);
    if (vehicleTypes.length > 0) {
      const corrRes = await db.query(
        `SELECT vehicle_type, correction_factor FROM eta_zone_corrections
         WHERE geocell=$1 AND vehicle_type = ANY($2::text[]) AND sample_count >= 3`,
        [geocell, vehicleTypes]
      ).catch(() => ({ rows: [] }));
      for (const row of corrRes.rows) {
        if (nearest[row.vehicle_type]) {
          const raw = nearest[row.vehicle_type]._rawEta;
          const factor = parseFloat(row.correction_factor);
          nearest[row.vehicle_type].eta_min = Math.max(1, Math.round(raw * factor));
          nearest[row.vehicle_type].eta_corrected = true;
        }
      }
      for (const vt of vehicleTypes) delete nearest[vt]._rawEta;
    }

    res.json({ eta: nearest });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/nearby-drivers — available driver positions near a point (for map display)
router.get('/nearby-drivers', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
  const clat = parseFloat(lat), clng = parseFloat(lng);
  if (isNaN(clat) || isNaN(clng)) return res.status(400).json({ error: 'Invalid coordinates' });
  try {
    const drRes = await db.query(
      `SELECT CASE WHEN d.vehicle_type = 'ultra_luxury' THEN 'luxury' ELSE d.vehicle_type END AS vehicle_type,
              dl.lat, dl.lng
       FROM drivers d
       JOIN users u ON d.id = u.id
       JOIN driver_locations dl ON dl.phone = u.phone
       WHERE d.is_online = true
         AND d.verification_status = 'approved'
         AND dl.updated_at > NOW() - INTERVAL '30 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM rides r2
           WHERE r2.driver_id = d.id AND r2.status IN ('matched','arrived','started')
         )`
    );
    const drivers = drRes.rows
      .filter(dr => dr.lat && dr.lng)
      .map(dr => ({ lat: parseFloat(dr.lat), lng: parseFloat(dr.lng), vehicleType: dr.vehicle_type }))
      .filter(dr => haversineKm(clat, clng, dr.lat, dr.lng) <= 6)
      .slice(0, 25);
    res.json({ drivers });
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
// Priority: Redis > in-memory > Postgres
router.get('/driver-location/:rideId', async (req, res) => {
  try {
    const rideId = req.params.rideId;

    // 1. Try Redis (fastest, written on every location update)
    const cached = await getDriverLoc(rideId).catch(() => null);
    if (cached) return res.json({ location: cached });

    // 2. In-memory map (driver app on same server instance)
    const result = await db.query(`SELECT u.phone FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1`, [rideId]);
    if (result.rows.length === 0) return res.json({ location: null });
    const driverPhone = result.rows[0].phone;
    const memLoc = driverLocations[driverPhone];
    if (memLoc) return res.json({ location: memLoc });

    // 3. Postgres fallback
    const dbLoc = await db.query('SELECT lat, lng, updated_at FROM driver_locations WHERE phone = $1', [driverPhone]);
    if (dbLoc.rows[0]) {
      const loc = { lat: parseFloat(dbLoc.rows[0].lat), lng: parseFloat(dbLoc.rows[0].lng), updated: new Date(dbLoc.rows[0].updated_at).getTime() };
      return res.json({ location: loc });
    }
    res.json({ location: null });
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
    const switchSurge = await getSurgeMultiplier(parseFloat(pickup_lat), parseFloat(pickup_lng));
    if (switchSurge > 1.0) newFare = Math.round(newFare * switchSurge);

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
      `SELECT id FROM rides WHERE driver_id = (SELECT id FROM users WHERE phone=$1) AND status IN ('accepted','inride','matched','arrived','started') LIMIT 1`,
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
    sendFCM(ride.driver_phone, '🔄 Ride Extension!', `${ride.drop_location} → ${new_drop} — ₹${estFare} | Accept karo 60 sec mein`, { type: 'ride_extension' }, { channelId: 'ride_requests', role: 'driver' });

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
    sendFCM(ext.customer_phone, '✅ Extension Accepted!', `Driver aa raha hai — ${ext.new_drop}`, { type: 'extension_accepted', ride_id: String(newRide.rows[0].id) }, { role: 'customer' });
    emitRideUpdate(ext.original_ride_id, { status: 'extension_accepted', new_ride_id: newRide.rows[0].id, fare: ext.estimated_fare });
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
    if (r.rows[0]) sendFCM(r.rows[0].customer_phone, '❌ Extension Reject', 'Driver ne reject kiya — naya ride book karo', {}, { role: 'customer' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/rate-customer
router.post('/rate-customer', async (req, res) => {
  const { ride_id, driver_phone, rating } = req.body;
  const r = parseInt(rating);
  if (!ride_id || !driver_phone) return res.status(400).json({ error: 'ride_id aur driver_phone chahiye' });
  if (![1, 2, 3, 4, 5].includes(r)) return res.status(400).json({ error: 'Rating 1-5 ke beech honi chahiye' });
  try {
    const check = await db.query(
      `SELECT r.id, r.passenger_id FROM rides r
       JOIN users d ON r.driver_id = d.id
       WHERE r.id=$1 AND d.phone=$2 AND r.status IN ('completed','cash_confirmed')`,
      [ride_id, driver_phone]
    );
    if (!check.rows[0]) return res.status(400).json({ error: 'Ride nahi mili ya aapki nahi thi' });

    await db.query('UPDATE rides SET customer_rating=$1 WHERE id=$2', [r, ride_id]);

    // Recalculate customer average rating
    const pid = check.rows[0].passenger_id;
    await db.query(
      `UPDATE users SET customer_rating = (
         SELECT ROUND(AVG(customer_rating)::numeric, 1) FROM rides
         WHERE passenger_id=$1 AND customer_rating IS NOT NULL
       ) WHERE id=$1`,
      [pid]
    ).catch(() => {});

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
         fare              = $1,
         surge_count       = $2,
         base_fare         = COALESCE(base_fare, fare),
         assigned_to_phone = NULL,
         assignment_expires_at = NULL,
         assignment_queue  = '[]',
         offered_phones    = '{}'
       WHERE id = $3`,
      [newFare, newSurgeCount, ride_id]
    );

    // Re-broadcast to all drivers with updated fare (afterSurge=true so final failure → no_driver_final)
    assignRideToNextDriver(ride_id, r.pickup_lat, r.pickup_lng, r.ride_type, null, 5, true).catch(() => {});

    res.json({
      success: true,
      new_fare: '₹' + newFare,
      surge_count: newSurgeCount,
      surges_remaining: 3 - newSurgeCount,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ────────────────────────────────────────────────────────
// SCHEDULED RIDES
// ────────────────────────────────────────────────────────
db.query(`CREATE TABLE IF NOT EXISTS scheduled_rides (
  id SERIAL PRIMARY KEY,
  customer_phone VARCHAR(20) NOT NULL,
  pickup TEXT NOT NULL,
  drop_location TEXT NOT NULL,
  pickup_lat DECIMAL(10,7), pickup_lng DECIMAL(10,7),
  drop_lat  DECIMAL(10,7), drop_lng  DECIMAL(10,7),
  vehicle_type VARCHAR(30) DEFAULT 'auto',
  scheduled_at TIMESTAMP NOT NULL,
  status VARCHAR(20) DEFAULT 'pending',
  fare_estimate INT DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});

// POST /api/rides/schedule
router.post('/schedule', async (req, res) => {
  const { customer_phone, pickup, drop_location, pickup_lat, pickup_lng, drop_lat, drop_lng, vehicle_type, scheduled_at, fare_estimate, notes } = req.body;
  if (!customer_phone || !pickup || !drop_location || !scheduled_at)
    return res.status(400).json({ error: 'customer_phone, pickup, drop_location, aur scheduled_at chahiye' });
  const scheduledDate = new Date(scheduled_at);
  if (isNaN(scheduledDate.getTime()) || scheduledDate <= new Date())
    return res.status(400).json({ error: 'scheduled_at future mein hona chahiye' });
  try {
    const r = await db.query(
      `INSERT INTO scheduled_rides (customer_phone, pickup, drop_location, pickup_lat, pickup_lng, drop_lat, drop_lng, vehicle_type, scheduled_at, fare_estimate, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [customer_phone, pickup, drop_location, pickup_lat||null, pickup_lng||null, drop_lat||null, drop_lng||null, vehicle_type||'auto', scheduledDate, fare_estimate||0, notes||null]
    );
    res.json({ success: true, ride: r.rows[0] });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// GET /api/rides/scheduled/:phone
router.get('/scheduled/:phone', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT * FROM scheduled_rides WHERE customer_phone=$1 AND status='pending' AND scheduled_at > NOW() ORDER BY scheduled_at ASC LIMIT 20`,
      [req.params.phone]
    );
    res.json({ rides: r.rows });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// DELETE /api/rides/scheduled/:id  — body: { phone }
router.delete('/scheduled/:id', async (req, res) => {
  const { phone } = req.body;
  try {
    const r = await db.query(
      `UPDATE scheduled_rides SET status='cancelled' WHERE id=$1 AND customer_phone=$2 RETURNING id`,
      [req.params.id, phone]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Ride nahi mili ya unauthorized' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

// ── GET /api/rides/track-info/:rideId — public, no auth, for live tracking page ──
router.get('/track-info/:rideId', async (req, res) => {
  try {
    const { rideId } = req.params;
    const result = await db.query(
      `SELECT r.id, r.status, r.pickup, r.drop_location,
              r.pickup_lat, r.pickup_lng, r.drop_lat, r.drop_lng, r.ride_type,
              u.name  AS driver_name,
              d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.vehicle_type
       FROM rides r
       LEFT JOIN users   u ON r.driver_id = u.id
       LEFT JOIN drivers d ON r.driver_id = d.id
       WHERE r.id = $1`,
      [rideId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    const r = result.rows[0];
    res.json({
      rideId:    r.id,
      status:    r.status,
      pickup:    r.pickup,
      drop:      r.drop_location,
      pickupLat: r.pickup_lat ? parseFloat(r.pickup_lat) : null,
      pickupLng: r.pickup_lng ? parseFloat(r.pickup_lng) : null,
      dropLat:   r.drop_lat   ? parseFloat(r.drop_lat)   : null,
      dropLng:   r.drop_lng   ? parseFloat(r.drop_lng)   : null,
      rideType:  r.ride_type,
      driver: r.driver_name ? {
        name:      r.driver_name,
        vehicleNo: r.vehicle_no || '',
        vehicle:   [r.vehicle_brand, r.vehicle_model].filter(Boolean).join(' '),
      } : null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
