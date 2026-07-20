const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sendFCM } = require('../config/firebase');
const { emitToRoom } = require('../config/socket');
const { assignRideToNextDriver, activateQueuedRide, rideQueue } = require('../workers/rideWorker');
const { driverLocations } = require('../services/matching');
const { maskPhone } = require('../services/phone');
const { haversineKm } = require('../services/matching');
const { directFavouriteRideIds } = require('./favourites');
const { transitionRide } = require('../services/rideStateMachine');
const { getRideStatus, getDriverLoc, setRideStatus, setRideData, getRideData, clearRide: clearRideCache } = require('../services/rideCache');
const { creditPeakBonusIfApplicable } = require('./bonus');
const { maybeGrantReferralReward } = require('./referral');
const { getSurgeMultiplier } = require('../services/locationIntelligence');
const { calculateFare, getISTHour } = require('../services/pricing');
const { useSubscriptionIfActive } = require('../services/subscription');

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
      sendFCM(phone, '🎁 Cashback Received!', `₹${total} cashback added to your wallet!`, { type: 'cashback_earned', amount: String(total) }, { role: 'customer' }).catch(() => {});
    }
  } catch (_e) {}
  return earned;
}

// POST /api/rides/book
router.post('/book', async (req, res) => {
  const { passenger_phone, pickup, drop_location, ride_type, pickup_lat, pickup_lng, drop_lat, drop_lng, discount, promo_code } = req.body;
  console.log(`[rides] 📥 book request: phone=${passenger_phone} type=${ride_type}`);
  if (!passenger_phone || String(passenger_phone).length !== 10) return res.status(400).json({ error: 'Valid phone do' });
  if (!pickup || !drop_location) return res.status(400).json({ error: 'Pickup and drop location required' });
  if (!['auto', 'bike', 'car', 'eriksha', 'luxury', 'green_bike', 'electric_auto'].includes(ride_type)) return res.status(400).json({ error: 'Invalid ride type' });
  try {
    const passenger = await db.query('SELECT * FROM users WHERE phone = $1', [passenger_phone]);
    if (passenger.rows.length === 0) { console.log(`[rides] ❌ book blocked: phone=${passenger_phone} reason=passenger_not_found`); return res.status(404).json({ error: 'Passenger not found' }); }
    if (passenger.rows[0].booking_restricted) {
      console.log(`[rides] ❌ book blocked: phone=${passenger_phone} reason=booking_restricted`);
      return res.status(403).json({ error: '🚫 Your account is temporarily on hold due to a pending payment from a previous ride. Please contact support: help@sppero.in', restricted: true });
    }

    const distance = parseFloat(req.body.distance) || 5;
    const durationMin = parseFloat(req.body.duration_min) || (distance / 20) * 60;
    const fareRes = await db.query('SELECT * FROM fare_settings WHERE vehicle_type = $1', [ride_type]);
    const defaultFares = {
      luxury:        { base_fare: 80,  per_km_rate: 25, per_km_rate_t2: 28, per_km_rate_t3: 30, time_rate: 1.5,  platform_fee: 3.0, min_fare: 120, night_multiplier: 1.8, night_start: '22:00', night_end: '06:00' },
      car:           { base_fare: 40,  per_km_rate: 15, per_km_rate_t2: 17, per_km_rate_t3: 18, time_rate: 1.0,  platform_fee: 2.5, min_fare: 65,  night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' },
      auto:          { base_fare: 25,  per_km_rate: 12, per_km_rate_t2: 14, per_km_rate_t3: 15, time_rate: 0.75, platform_fee: 2.0, min_fare: 45,  night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' },
      eriksha:       { base_fare: 20,  per_km_rate: 10, per_km_rate_t2: 11, per_km_rate_t3: 12, time_rate: 0.65, platform_fee: 2.0, min_fare: 35,  night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' },
      bike:          { base_fare: 15,  per_km_rate: 8,  per_km_rate_t2: 9,  per_km_rate_t3: 10, time_rate: 0.5,  platform_fee: 2.0, min_fare: 30,  night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' },
      green_bike:    { base_fare: 12,  per_km_rate: 6,  per_km_rate_t2: 7,  per_km_rate_t3: 8,  time_rate: 0.4,  platform_fee: 2.0, min_fare: 25,  night_multiplier: 1.2, night_start: '22:00', night_end: '06:00' },
      electric_auto: { base_fare: 20,  per_km_rate: 9,  per_km_rate_t2: 11, per_km_rate_t3: 12, time_rate: 0.6,  platform_fee: 2.0, min_fare: 38,  night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' },
    };
    const f = fareRes.rows[0] || defaultFares[ride_type] || defaultFares.auto;
    const hour = getISTHour();
    const nightStart = parseInt(String(f.night_start || '22').split(':')[0]);
    const nightEnd   = parseInt(String(f.night_end   || '6').split(':')[0]);
    const isNight = hour >= nightStart || hour < nightEnd;
    const fareCalc = calculateFare(f, distance, durationMin, isNight);
    const fare = fareCalc.fare;
    const platFee = fareCalc.platform_fee;

    // Surge is NOT applied at booking — it's offered to customer only after no driver accepts
    const ride = await db.query(
      `INSERT INTO rides (passenger_id, pickup, drop_location, ride_type, fare, status, pickup_lat, pickup_lng, drop_lat, drop_lng, discount, promo_code, distance_km, platform_fee)
       VALUES ($1, $2, $3, $4, $5, 'requested', $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [passenger.rows[0].id, pickup, drop_location, ride_type, fare, pickup_lat || null, pickup_lng || null, drop_lat || null, drop_lng || null, discount || 0, promo_code || null, distance, platFee]
    );

    const disc = discount || 0;
    const netFare = Math.max(0, fare - disc);
    const _rideId = ride.rows[0].id, _pLat = pickup_lat || null, _pLng = pickup_lng || null;
    console.log(`[rides] ✅ booked ride=${_rideId} type=${ride_type} phone=${passenger_phone}`);
    res.json({ message: 'Searching for a driver...', fare: '₹' + fare, net_fare: netFare, discount: disc, distance: distance + ' km', ride_id: _rideId, status: 'requested', surge_multiplier: 1.0, platform_fee: platFee, dist_fare: fareCalc.dist_fare, time_fare: fareCalc.time_fare, base_fare: fareCalc.base_fare, is_night: fareCalc.is_night });

    // 2s delay: customer needs time to join the socket room before any rideUpdate events fire.
    // Without this, instant-escalation (0 drivers) emits surge_offer before the room is joined.
    setTimeout(() => assignRideToNextDriver(_rideId, _pLat, _pLng, ride_type).catch(e => console.error('[RIDE_ASSIGN_FAIL]', e.message)), 2000);
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
        UPDATE driver_locations SET lat=$1, lng=$2, updated_at=NOW() WHERE phone=$3
      `, [lat, lng, phone]);
    }
    // Emit to customer's socket room
    emitToRoom('ride_' + rideId, 'driverMoved', { lat, lng });
    res.json({ ok: true });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/rides/status/:rideId
// Reads status from Redis (fast) — falls back to Postgres for full row
router.get('/status/:rideId', async (req, res) => {
  if (!req.params.rideId || req.params.rideId === 'undefined' || req.params.rideId === 'null')
    return res.status(400).json({ error: 'Invalid ride ID' });
  try {
    const rideId = req.params.rideId;
    const [cachedData, cachedStatus] = await Promise.all([
      getRideData(rideId).catch(() => null),
      getRideStatus(rideId).catch(() => null),
    ]);

    // Redis hit — skip DB entirely
    if (cachedData) {
      if (cachedStatus) cachedData.status = cachedStatus;
      return res.json({ ride: cachedData });
    }

    // Cache miss — hit DB
    const result = await db.query(
      `SELECT r.*, u.name as driver_name, u.phone as driver_phone,
              d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.upi_id as driver_upi_id,
              d.verification_status as driver_verification_status, d.rating as driver_rating,
              d.face_photo as driver_photo, d.vehicle_photo as driver_vehicle_photo
       FROM rides r
       LEFT JOIN users u ON r.driver_id = u.id
       LEFT JOIN drivers d ON r.driver_id = d.id
       WHERE r.id = $1`,
      [rideId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
    const ride = { ...result.rows[0] };
    if (cachedStatus) ride.status = cachedStatus;
    if (ride.driver_phone) {
      ride.driver_phone_masked = maskPhone(ride.driver_phone);
      delete ride.driver_phone;
    }
    ride.net_fare = Math.max(0, parseFloat(ride.fare || 0) - parseFloat(ride.discount || 0));
    // Cache for future polls (only while ride is active with driver assigned)
    if (['matched', 'arrived', 'started'].includes(ride.status)) {
      setRideData(rideId, ride).catch(() => {});
    }
    res.json({ ride });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/accept
router.post('/accept', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  if (!ride_id || !driver_phone) return res.status(400).json({ success: false, message: 'ride_id and driver_phone required' });
  try {
    const driver = await db.query('SELECT id FROM users WHERE phone=$1', [driver_phone]);
    if (!driver.rows[0]) return res.status(404).json({ success: false, message: 'Driver not found' });

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // ── Broadcast system: any driver in offered_phones can claim within the window ──
    // Fetch offered_phones before claim so we can notify others after success
    const offerInfo = await db.query(
      `SELECT offered_phones FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
      [ride_id]
    );
    const offeredPhones = offerInfo.rows[0]?.offered_phones || [];

    // Eligibility: driver must be in offered_phones OR directly assigned (favourite buddy), AND window still open
    const claim = await db.query(
      `UPDATE rides SET assigned_to_phone=$2, assignment_expires_at=NULL, assignment_queue='[]'
       WHERE id=$1 AND status='requested' AND driver_id IS NULL
         AND (
           $2 = ANY(COALESCE(offered_phones, '{}'))
           OR assigned_to_phone = $2
         )
         AND assignment_expires_at > NOW()
       RETURNING id`,
      [ride_id, driver_phone]
    );
    if (!claim.rows[0]) return res.json({ success: false, message: 'Ride window expired or claimed by another driver — check the next one!' });

    const dInfo = await db.query(
      `SELECT u.name, d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.rating, d.verification_status, d.face_photo, d.vehicle_photo, d.upi_id
       FROM users u JOIN drivers d ON u.id=d.id WHERE u.id=$1`, [driver.rows[0].id]
    );
    const di = dInfo.rows[0];
    const driverCard = di
      ? { name: di.name, vehicle_no: di.vehicle_no, vehicle_brand: di.vehicle_brand, vehicle_model: di.vehicle_model, rating: di.rating, verified: di.verification_status === 'approved', photo: di.face_photo || null, vehicle_photo: di.vehicle_photo || null, upi_id: di.upi_id || null }
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

    // ── Notify all OTHER offered drivers: ride has been taken ─────────────────
    const otherDrivers = offeredPhones.filter(p => p !== driver_phone);
    for (const phone of otherDrivers) {
      emitToRoom('driver_' + phone, 'rideTaken', { rideId: ride_id, message: 'Ride was taken by another driver' });
    }

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
      return res.json({ success: false, message: 'Ride was taken by another driver — check the next one!' });
    }
    console.error('[rides] accept:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

// POST /api/rides/reject-offer
// In broadcast system: driver dismisses the popup. Broadcast window keeps running for other drivers.
// Just track the rejection so this driver won't see the ride again.
router.post('/reject-offer', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  try {
    // Add to rejected_phones so pending-ride won't show it again to this driver
    await db.query(
      `UPDATE rides SET rejected_phones = array_append(COALESCE(rejected_phones, '{}'), $1::text)
       WHERE id=$2 AND status='requested' AND driver_id IS NULL
         AND NOT ($1 = ANY(COALESCE(rejected_phones, '{}')))`,
      [driver_phone, ride_id]
    ).catch(() => {});

    // Update acceptance rate
    db.query('SELECT rides_offered, rides_accepted FROM driver_metrics WHERE phone=$1', [driver_phone])
      .then(dm => {
        if (dm.rows[0] && parseFloat(dm.rows[0].rides_offered) > 0) {
          const rate = (parseFloat(dm.rows[0].rides_accepted) / parseFloat(dm.rows[0].rides_offered)) * 100;
          db.query('UPDATE driver_metrics SET acceptance_rate=$1 WHERE phone=$2', [Math.min(100, rate).toFixed(2), driver_phone]).catch(() => {});
        }
      }).catch(() => {});

    // Favourite buddy declined notification
    db.query(
      `SELECT 1 FROM favourite_drivers f
       JOIN rides r ON r.passenger_id = f.customer_id
       JOIN users d ON f.driver_id = d.id
       WHERE r.id=$1 AND d.phone=$2 LIMIT 1`,
      [ride_id, driver_phone]
    ).then(fav => {
      if (fav.rows[0]) emitToRoom('ride_' + ride_id, 'rideUpdate', { rideId: ride_id, status: 'buddy_declined' });
    }).catch(() => {});

    res.json({ success: true });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/arrived
router.post('/arrived', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  if (!driver_phone) return res.status(400).json({ error: 'driver_phone required' });
  try {
    const owner = await db.query(
      `SELECT 1 FROM rides r JOIN users u ON r.driver_id=u.id WHERE r.id=$1 AND u.phone=$2`, [ride_id, driver_phone]
    );
    if (!owner.rows[0]) return res.status(403).json({ error: 'This ride does not belong to you' });

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
      return res.status(409).json({ error: 'Ride cannot be set to arrived in this state' });
    console.error('[rides] arrived:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

// POST /api/rides/start
router.post('/start', async (req, res) => {
  const { ride_id, otp, driver_phone } = req.body;
  if (!driver_phone) return res.status(400).json({ success: false, message: 'driver_phone required' });
  try {
    const check = await db.query(`SELECT r.start_otp, u.phone as dr_phone FROM rides r LEFT JOIN users u ON r.driver_id=u.id WHERE r.id=$1`, [ride_id]);
    if (!check.rows[0]) return res.status(404).json({ success: false, message: 'Ride not found' });
    if (check.rows[0]?.start_otp !== otp) return res.status(400).json({ success: false, message: 'Incorrect OTP!' });
    if (check.rows[0].dr_phone && check.rows[0].dr_phone !== driver_phone)
      return res.status(403).json({ success: false, message: 'This ride does not belong to you' });

    await transitionRide(ride_id, 'started');
    // Record actual trip start time so /complete can calculate real time fare
    db.query(`UPDATE rides SET trip_started_at = NOW() WHERE id = $1`, [ride_id]).catch(() => {});
    res.json({ success: true, message: 'Trip started!' });
  } catch (err) {
    if (err.message?.includes('Invalid transition') || err.message?.includes('Concurrent transition'))
      return res.status(409).json({ success: false, message: 'Trip cannot start yet — please confirm arrived first' });
    console.error('[rides] start:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

// POST /api/rides/cancel (legacy — prefer cancel-smart)
router.post('/cancel', async (req, res) => {
  const { ride_id, reason, driver_phone } = req.body;
  try {
    if (driver_phone) {
      const owner = await db.query(`SELECT 1 FROM rides r JOIN users u ON r.driver_id=u.id WHERE r.id=$1 AND u.phone=$2`, [ride_id, driver_phone]);
      if (!owner.rows[0]) return res.status(403).json({ error: 'This ride does not belong to you' });
    }
    const cancelRes = await db.query(
      "UPDATE rides SET status = 'cancelled' WHERE id = $1 AND status IN ('requested', 'matched', 'arrived') RETURNING id",
      [ride_id]
    );
    if (!cancelRes.rows[0]) return res.json({ success: false, message: 'Ride is already started, completed, or cancelled' });
    const rideInfo = await db.query('SELECT p.phone AS passenger_phone FROM rides r JOIN users p ON r.passenger_id=p.id WHERE r.id=$1', [ride_id]);
    if (rideInfo.rows[0]) {
      emitRideUpdate(ride_id, { status: 'cancelled' });
      sendFCM(rideInfo.rows[0].passenger_phone, '🚫 Ride Cancelled', 'Driver cancelled your ride', { type: 'ride_cancelled', ride_id: String(ride_id) }, { role: 'customer' }).catch(() => {});
    }
    res.json({ success: true, message: 'Trip cancelled', reason });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
  if (!req.params.ride_id || req.params.ride_id === 'undefined' || req.params.ride_id === 'null')
    return res.status(400).json({ error: 'Invalid ride ID' });
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
    const origFare = Math.max(0, parseFloat(String(ride.fare || '0').replace(/[^0-9.]/g, '')) || 0) - parseFloat(ride.discount || 0);

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
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
    if (rideRes.rows.length === 0) return res.json({ success: false, message: 'Ride not found' });
    const ride = rideRes.rows[0];
    const secondsAfterBook = Math.round(ride.seconds_since_book || 0);
    const secDriverWaited  = ride.arrived_at ? Math.max(0, Math.round(ride.seconds_driver_waited || 0)) : 0;
    let penalty = 0;
    let message = 'Ride cancelled';

    // Pre-assigned rides: always free cancel, notify the driver their queued ride is gone
    if (ride.status === 'pre_assigned') {
      await db.query(`UPDATE rides SET status='cancelled' WHERE id=$1 AND status='pre_assigned'`, [ride_id]);
      if (ride.pre_accepted_driver_phone) {
        emitToRoom('driver_' + ride.pre_accepted_driver_phone, 'preRideCancelled', { rideId: ride_id });
      }
      return res.json({ success: true, penalty: 0, message: 'Ride cancelled (free)' });
    }

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
        sendFCM(ride.driver_phone, '🚫 Ride Cancelled', `Customer ne cancel kar di. Reason: ${reason || 'N/A'}`, { type: 'ride_cancelled' }, { channelId: 'ride_requests', role: 'driver' }).catch(() => {});
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
        message = '⚠️ Too many cancellations! Suspended for 2 hours.';
      } else if (cancelRate > 15) {
        message = '⚠️ Warning: Cancel rate zyada hai, kam rides milengi';
      }
      await db.query(
        `UPDATE driver_metrics SET rides_cancelled = $1, cancels_today = $2, last_cancel_date = $3, cancellation_rate = $4, suspended_until = $5 WHERE phone = $6`,
        [totalCancelled, cancelsToday, today, cancelRate.toFixed(2), suspendedUntil, phone]
      );
      if (ride.passenger_phone)
        sendFCM(ride.passenger_phone, '🚫 Driver ne Cancel Kiya', `Reason: ${reason || 'N/A'}. Please book a new ride from the app.`, { type: 'ride_cancelled' }, { role: 'customer' }).catch(() => {});
    }

    const smartCancelRes = await db.query(
      `UPDATE rides SET status = 'cancelled' WHERE id = $1 AND status IN ('requested', 'pre_assigned', 'matched', 'arrived') RETURNING id`,
      [ride_id]
    );
    if (!smartCancelRes.rows[0]) return res.json({ success: false, message: 'Ride is already started, completed, or cancelled' });
    await db.query(
      `INSERT INTO cancellations (ride_id, cancelled_by, reason, seconds_after_book, penalty_applied) VALUES ($1, $2, $3, $4, $5)`,
      [ride_id, cancelled_by, reason || '', secondsAfterBook, penalty]
    );
    // Socket: both apps need real-time cancel, FCM alone isn't enough when app is in foreground
    emitRideUpdate(ride_id, { status: 'cancelled', cancelled_by, penalty });
    clearRideCache(ride_id).catch(() => {});
    res.json({ success: true, penalty, message });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/complete
// Accepts optional driver_lat/driver_lng for early-completion detection.
// If driver is >800m from drop point, marks early_completion=true and logs an incident.
router.post('/complete', async (req, res) => {
  const { ride_id, driver_phone, driver_lat, driver_lng } = req.body;
  try {
    const rideRow = await db.query(
      `SELECT r.*, u.phone AS passenger_phone, d.phone AS dphone,
              fs.base_fare AS fs_base, fs.per_km_rate AS fs_pkr, fs.per_km_rate_t2 AS fs_pkr2,
              fs.per_km_rate_t3 AS fs_pkr3, fs.time_rate AS fs_time, fs.platform_fee AS fs_platfee,
              fs.min_fare AS fs_min, fs.night_multiplier AS fs_night, fs.night_start AS fs_ns, fs.night_end AS fs_ne
       FROM rides r
       JOIN users u ON r.passenger_id = u.id
       LEFT JOIN users d ON r.driver_id = d.id
       LEFT JOIN fare_settings fs ON fs.vehicle_type = r.ride_type
       WHERE r.id=$1 AND r.status='started'`, [ride_id]
    );
    if (!rideRow.rows[0]) return res.status(404).json({ error: 'Ride not found or not started' });
    const ride = rideRow.rows[0];

    if (driver_phone && ride.dphone !== driver_phone)
      return res.status(403).json({ error: 'This ride does not belong to you' });

    // ── Recalculate actual fare using real trip duration ───────────────────────
    let finalFare = parseFloat(ride.fare);
    let finalPlatFee = parseFloat(ride.platform_fee || 0);
    if (ride.trip_started_at && ride.fs_time != null) {
      const actualDurMin = (Date.now() - new Date(ride.trip_started_at).getTime()) / 60000;
      const distKm = parseFloat(ride.distance_km) || 5;
      const hourNow = getISTHour();
      const isNightNow = hourNow >= parseInt(String(ride.fs_ns || '22').split(':')[0]) || hourNow < parseInt(String(ride.fs_ne || '6').split(':')[0]);
      const fsRow = {
        base_fare: ride.fs_base, per_km_rate: ride.fs_pkr, per_km_rate_t2: ride.fs_pkr2,
        per_km_rate_t3: ride.fs_pkr3, time_rate: ride.fs_time, platform_fee: ride.fs_platfee,
        min_fare: ride.fs_min, night_multiplier: ride.fs_night,
      };
      const recalc = calculateFare(fsRow, distKm, actualDurMin, isNightNow);
      finalFare    = recalc.fare;
      finalPlatFee = recalc.platform_fee;
    }

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

    const netFareSocket = Math.max(0, finalFare - parseFloat(ride.discount || 0));

    // State machine: DB update + socket + FCM for both parties
    await transitionRide(ride_id, 'completed', {
      extraFields: {
        payment_status: 'pending',
        early_completion: earlyCompletion,
        driver_lat_at_complete: driver_lat || null,
        driver_lng_at_complete: driver_lng || null,
        completion_dist_from_drop: distFromDrop,
        fare: finalFare,
        platform_fee: finalPlatFee,
      },
      socketData: { fare: netFareSocket, discount: parseFloat(ride.discount || 0), early_completion: earlyCompletion, platform_fee: finalPlatFee },
      custPhone:  ride.passenger_phone,
      drvPhone:   ride.dphone,
    });

    const fare = netFareSocket;
    const paymentMethod = ride.payment_method;
    res.json({
      success: true,
      fare,
      payment_method: paymentMethod,
      early_completion: earlyCompletion,
      dist_from_drop: distFromDrop ? distFromDrop.toFixed(2) : null,
      message: earlyCompletion
        ? `⚠️ Trip completed — you were ${(distFromDrop||0).toFixed(1)}km away from the drop point. Customer has been notified.`
        : 'Trip complete! Waiting for customer payment.',
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

      // Log incident for early completion
      if (earlyCompletion) {
        await db.query(
          `INSERT INTO ride_incidents (ride_id, incident_type, detected_by, driver_id, customer_id, metadata)
           VALUES ($1,'early_completion','system',$2,$3,$4)`,
          [ride_id, ride.driver_id, ride.passenger_id,
           JSON.stringify({ dist_km: distFromDrop, driver_lat, driver_lng, drop_lat: ride.drop_lat, drop_lng: ride.drop_lng })]
        ).catch((e) => { console.error('ride_incidents insert failed:', e.message); });

        // Alert customer about early completion
        sendFCM(ride.passenger_phone,
          '⚠️ Driver dropped you at the wrong location!',
          `Your driver was ${(distFromDrop||0).toFixed(1)}km from the drop point when the trip was completed.`,
          { type: 'early_completion_alert', ride_id: String(ride_id) },
          { role: 'customer' }
        ).catch(() => {});

        // Warn driver
        sendFCM(ride.dphone,
          '⚠️ Early Trip Completion Detected',
          `You completed ride #${ride_id} ${(distFromDrop||0).toFixed(1)}km away from the drop location. This is against platform policy.`,
          { type: 'early_completion_warning', ride_id: String(ride_id) },
          { channelId: 'ride_requests', role: 'driver' }
        ).catch(() => {});

        // Strike the driver
        await db.query(
          `UPDATE driver_metrics SET strike_count = COALESCE(strike_count,0)+1 WHERE phone=$1`, [ride.dphone]
        ).catch(() => {});
      }
    } catch (_e) {}
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/payment-complete
router.post('/payment-complete', async (req, res) => {
  const { ride_id, payment_method, phone } = req.body;
  try {
    const rideRes = await db.query(
      `SELECT r.*, fs.commission_rate, fs.intercity_commission_rate, u.phone AS driver_phone FROM rides r
       LEFT JOIN fare_settings fs ON fs.vehicle_type = r.ride_type
       LEFT JOIN users u ON u.id = r.driver_id
       WHERE r.id = $1`, [ride_id]
    );
    if (rideRes.rows.length === 0) return res.json({ success: false, message: 'Ride not found' });
    const ride = rideRes.rows[0];
    const fare = Math.max(0, parseFloat(ride.fare) - parseFloat(ride.discount || 0));
    // Intercity fares are large (₹5k+) — lower commission % keeps drivers motivated
    const commRate = ride.is_intercity
      ? parseFloat(ride.intercity_commission_rate || 10) / 100
      : parseFloat(ride.commission_rate || 15) / 100;
    const normalCommission = Math.round(fare * commRate * 100) / 100;

    // Idempotency: if already completed, just re-emit the socket so the driver gets notified
    if (ride.payment_status === 'completed') {
      emitToRoom('ride_' + ride_id, 'paymentConfirmed', { ride_id, status: 'completed', payment_method: ride.payment_method, cashbacks: [] });
      return res.json({ success: true, status: 'completed', already_done: true });
    }

    // Subscription check — commission = 0 if driver has an active ride pack
    const { commission } = await useSubscriptionIfActive(ride.driver_phone, ride_id, 'standard', normalCommission);

    if (payment_method === 'cash') {
      await db.query(`UPDATE rides SET payment_method = 'cash', payment_status = 'cash_pending' WHERE id = $1`, [ride_id]);
      await db.query(
        `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
         SELECT u.phone, $1, $2, $3, 'cash', 'pending'
         FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1
         ON CONFLICT (ride_id) DO NOTHING`,
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

      // Atomic idempotency: only update rides that are not yet 'completed'; returns 0 rows if a
      // concurrent request already completed it — prevents double commission insertion.
      const rideUpdate = await payClient.query(
        `UPDATE rides SET payment_method=$1, payment_status='completed', commission_amount=$2, commission_status='collected'
         WHERE id=$3 AND payment_status != 'completed' RETURNING id`,
        [payment_method, commission, ride_id]
      );
      if (!rideUpdate.rows[0]) {
        await payClient.query('ROLLBACK');
        payClient.release();
        emitToRoom('ride_' + ride_id, 'paymentConfirmed', { ride_id, status: 'completed', payment_method, cashbacks: [] });
        return res.json({ success: true, status: 'completed', already_done: true });
      }
      const commRow = await payClient.query(
        `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
         SELECT u.phone, $1, $2, $3, $4, 'collected'
         FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1
         ON CONFLICT (ride_id) DO NOTHING RETURNING driver_phone`,
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
        sendFCM(drPhone, '💰 Earning Credited', `₹${actualCredit.toFixed(0)} added to your wallet! (₹${autoDeduct.toFixed(0)} pending commission deducted)`, { type: 'earning_credited', amount: String(actualCredit), commission_deducted: String(autoDeduct) }, { role: 'driver' }).catch(() => {});
      } else {
        sendFCM(drPhone, '💰 Earning Credited', `₹${driverEarning.toFixed(0)} added to your wallet!`, { type: 'earning_credited', amount: String(driverEarning) }, { role: 'driver' }).catch(() => {});
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
    // Activate any pre-assigned ride this driver has queued (fire-and-forget)
    if (drPhone) activateQueuedRide(drPhone).catch(() => {});
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/cash-confirm
router.post('/cash-confirm', async (req, res) => {
  const { ride_id, phone, payment_method } = req.body;
  const method = payment_method === 'upi_direct' ? 'upi' : 'cash';
  try {
    const rideRes = await db.query(
      `SELECT r.*, u.phone AS driver_phone, fs.commission_rate, fs.intercity_commission_rate FROM rides r
       JOIN users u ON r.driver_id = u.id
       LEFT JOIN fare_settings fs ON fs.vehicle_type = r.ride_type
       WHERE r.id = $1 AND r.status = 'completed'`,
      [ride_id]
    );
    if (!rideRes.rows[0]) return res.status(404).json({ error: 'Ride not found or not yet completed' });
    if (rideRes.rows[0].driver_phone !== phone)
      return res.status(403).json({ error: 'This ride does not belong to you' });
    if (rideRes.rows[0].payment_status === 'completed')
      return res.json({ success: true, message: 'Payment already confirmed' });
    const fare = Math.max(0, parseFloat(rideRes.rows[0].fare) - parseFloat(rideRes.rows[0].discount || 0));
    const commRate = rideRes.rows[0].is_intercity
      ? parseFloat(rideRes.rows[0].intercity_commission_rate || 10) / 100
      : parseFloat(rideRes.rows[0].commission_rate || 15) / 100;
    const normalCommission = Math.round(fare * commRate * 100) / 100;
    // Subscription check
    const { commission } = await useSubscriptionIfActive(phone, ride_id, 'standard', normalCommission);

    await db.query(`UPDATE rides SET payment_status = 'completed', payment_method = $1, commission_amount = $2 WHERE id = $3`, [method, commission, ride_id]);
    // Upsert, not update: the driver can confirm cash before (or without) the
    // customer ever hitting /payment-complete, so no driver_commissions row may
    // exist yet. A bare UPDATE would then silently match 0 rows -- the wallet
    // debt below still gets added, but with no audit-trail record, causing the
    // per-ride commission list to permanently disagree with the wallet total.
    await db.query(
      `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
       VALUES ($1, $2, $3, $4, $5, 'cash_owed')
       ON CONFLICT (ride_id) DO UPDATE SET status = 'cash_owed', commission = $4, payment_method = $5`,
      [phone, ride_id, fare, commission, method]
    );

    let totalPending = 0;
    if (commission > 0) {
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
      totalPending = parseFloat(walletRes.rows[0]?.pending_commission || 0);
      sendFCM(phone, '💰 Commission Due', `₹${commission.toFixed(0)} commission due. Total pending: ₹${totalPending.toFixed(0)}. Pay in app.`, { type: 'commission_due', pending_commission: String(totalPending) }, { role: 'driver' }).catch(() => {});
    }
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
    // Activate any pre-assigned ride this driver has queued (fire-and-forget)
    activateQueuedRide(phone).catch(() => {});
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/payment-not-received
// Driver calls this within 10 min of trip completion when cash customer refuses/runs.
// Auto-creates incident, penalizes customer trust_score.
router.post('/payment-not-received', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  if (!ride_id || !driver_phone) return res.status(400).json({ error: 'ride_id and driver_phone required' });
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
    if (!rideRes.rows[0]) return res.status(404).json({ error: 'Ride not found or does not belong to you' });
    const ride = rideRes.rows[0];
    const netFareDisplay = Math.max(0, parseFloat(ride.fare || 0) - parseFloat(ride.discount || 0));

    if (!['completed', 'cash_pending'].includes(ride.status))
      return res.status(400).json({ error: 'Ride not yet completed' });
    if (ride.payment_not_received)
      return res.status(409).json({ error: 'This has already been reported' });

    // Only allow within 10 minutes of completion
    const minsSinceComplete = (Date.now() - new Date(ride.completed_at || ride.created_at).getTime()) / 60000;
    if (minsSinceComplete > 10)
      return res.status(400).json({ error: 'Payment not received can only be reported within 10 minutes of completion' });

    // Mark ride
    await db.query(
      `UPDATE rides SET payment_not_received=true, payment_status='disputed' WHERE id=$1`, [ride_id]
    );

    // Log incident
    await db.query(
      `INSERT INTO ride_incidents(ride_id,incident_type,detected_by,driver_id,customer_id,metadata)
       VALUES($1,'payment_skipped','driver',$2,$3,$4)`,
      [ride_id, ride.driver_id_val, ride.passenger_id_val,
       JSON.stringify({ fare: netFareDisplay, full_fare: ride.fare, discount: ride.discount || 0, payment_method: ride.payment_method })]
    ).catch(() => {});

    // Penalize customer trust score
    await db.query(
      `UPDATE users SET trust_score = GREATEST(0, COALESCE(trust_score,100) - 25) WHERE id=$1`, [ride.passenger_id_val]
    ).catch(() => {});
    const skipCountRes = await db.query(
      `SELECT COUNT(*) AS cnt FROM ride_incidents WHERE customer_id=$1 AND incident_type='payment_skipped'`,
      [ride.passenger_id_val]
    ).catch(() => ({ rows: [{ cnt: 0 }] }));
    const totalSkips = parseInt(skipCountRes.rows[0]?.cnt || 0);


    // FCM to customer — warning
    sendFCM(ride.passenger_phone,
      '⚠️ Payment Issue Reported',
      `Driver reported that you did not pay ₹${netFareDisplay} cash for ride #${ride_id}. Please contact support.`,
      { type: 'payment_dispute', ride_id: String(ride_id) },
      { role: 'customer' }
    ).catch(() => {});

    res.json({
      success: true,
      message: 'Payment not received report submitted. Admin will review.',
      customer_trust_score_deducted: 25,
      customer_skips_total: totalSkips,
    });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
              dl.lat, dl.lng, dl.updated_at
       FROM drivers d
       JOIN users u ON d.id = u.id
       LEFT JOIN driver_locations dl ON dl.phone = u.phone
       WHERE d.is_online = true
         AND d.verification_status = 'approved'
         AND NOT EXISTS (
           SELECT 1 FROM rides r2
           WHERE r2.driver_id = d.id AND r2.status IN ('matched','arrived','started')
         )`
    );

    const nearest = {};
    const LOC_STALE_MS = 15 * 60 * 1000;
    const nowMs = Date.now();
    for (const dr of drRes.rows) {
      const locFresh = dr.lat && dr.lng && dr.updated_at &&
        (nowMs - new Date(dr.updated_at).getTime()) < LOC_STALE_MS;

      if (locFresh) {
        const dist = haversineKm(lat, lng, parseFloat(dr.lat), parseFloat(dr.lng));
        if (dist > 20) continue;
        const prev = nearest[dr.vehicle_type];
        // real location always wins over a placeholder
        if (!prev || prev.dist_km === null || dist < prev.dist_km) {
          const speed = AVG_SPEED_KMH[dr.vehicle_type] || 20;
          nearest[dr.vehicle_type] = {
            dist_km: Math.round(dist * 10) / 10,
            eta_min: Math.max(1, Math.round((dist / speed) * 60) + 1),
            _rawEta: Math.max(1, Math.round((dist / speed) * 60) + 1),
          };
        }
      } else if (!nearest[dr.vehicle_type]) {
        // Driver online but location unknown/stale — mark available without ETA
        nearest[dr.vehicle_type] = { dist_km: null, eta_min: null };
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
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
         AND dl.updated_at > NOW() - INTERVAL '15 minutes'
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
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/rides/payment-status/:rideId
router.get('/payment-status/:rideId', async (req, res) => {
  try {
    const result = await db.query(`SELECT payment_status, payment_method, fare, discount FROM rides WHERE id = $1`, [req.params.rideId]);
    if (result.rows.length === 0) return res.json({ status: 'not_found' });
    const row = result.rows[0];
    row.net_fare = Math.max(0, parseFloat(row.fare || 0) - parseFloat(row.discount || 0));
    res.json(row);
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/switch-vehicle — customer switches vehicle type while searching
router.post('/switch-vehicle', async (req, res) => {
  const { ride_id, new_vehicle_type } = req.body;
  if (!['auto', 'bike', 'car', 'eriksha', 'luxury', 'green_bike', 'electric_auto'].includes(new_vehicle_type))
    return res.status(400).json({ error: 'Invalid vehicle type' });
  try {
    const r = await db.query(
      `SELECT pickup_lat, pickup_lng, distance, is_intercity FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
      [ride_id]
    );
    if (!r.rows[0]) return res.json({ success: false, message: 'Ride not found or already assigned' });
    // Intercity fares use their own long-distance model — a city-rate recalc here would misprice a 300km trip
    if (r.rows[0].is_intercity) return res.json({ success: false, message: 'Vehicle switch is not available for intercity trips' });
    const { pickup_lat, pickup_lng, distance } = r.rows[0];

    // Recalculate fare for new vehicle type
    const fareRes = await db.query('SELECT * FROM fare_settings WHERE vehicle_type=$1', [new_vehicle_type]);
    const defaultFares = { luxury: { base_fare: 80, per_km_rate: 25 }, car: { base_fare: 40, per_km_rate: 15 }, auto: { base_fare: 25, per_km_rate: 12 }, eriksha: { base_fare: 20, per_km_rate: 10 }, bike: { base_fare: 15, per_km_rate: 8 } };
    const f = fareRes.rows[0] || defaultFares[new_vehicle_type] || defaultFares.auto;
    const hour = getISTHour();
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

    res.json({ success: true, new_vehicle_type, new_fare: '₹' + newFare, message: `Searching for a ${new_vehicle_type} driver...` });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
    if (!rideRes.rows[0]) return res.json({ success: false, error: 'Ride not found' });
    const ride = rideRes.rows[0];
    if (ride.status !== 'completed') return res.json({ success: false, error: 'Ride not yet completed' });

    const completedAt = ride.completed_at || ride.created_at;
    const minAgo = (Date.now() - new Date(completedAt).getTime()) / 60000;
    if (minAgo > 15) return res.json({ success: false, expired: true, error: '15-minute window has expired — please book a new ride' });

    const busy = await db.query(
      `SELECT id FROM rides WHERE driver_id = (SELECT id FROM users WHERE phone=$1) AND status IN ('accepted','inride','matched','arrived','started') LIMIT 1`,
      [ride.driver_phone]
    );
    if (busy.rows[0]) return res.json({ success: false, busy: true, error: 'Driver is currently busy with another customer' });

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
    sendFCM(ride.driver_phone, '🔄 Ride Extension!', `${ride.drop_location} → ${new_drop} — ₹${estFare} | Accept within 60 sec`, { type: 'ride_extension' }, { channelId: 'ride_requests', role: 'driver' });

    const extId = extR.rows[0].id;
    setTimeout(async () => {
      try { await db.query("UPDATE ride_extensions SET status='expired' WHERE id=$1 AND status='pending'", [extId]); } catch (_e) {}
    }, 62000);

    res.json({ success: true, extension_id: extId, estimated_fare: estFare, driver_name: ride.driver_name, driver_phone: maskPhone(ride.driver_phone) });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/rides/extension-status/:id
router.get('/extension-status/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM ride_extensions WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Extension not found' });
    const ext = r.rows[0];
    if (ext.status === 'pending' && new Date(ext.response_expires_at) < new Date()) {
      await db.query("UPDATE ride_extensions SET status='expired' WHERE id=$1", [ext.id]);
      return res.json({ status: 'expired' });
    }
    res.json({ status: ext.status, new_ride_id: ext.new_ride_id, estimated_fare: ext.estimated_fare, seconds_left: Math.max(0, Math.ceil((new Date(ext.response_expires_at).getTime() - Date.now()) / 1000)) });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/extension-accept
router.post('/extension-accept', async (req, res) => {
  const { extension_id } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const extR = await client.query("SELECT * FROM ride_extensions WHERE id=$1 AND status='pending' AND response_expires_at > NOW()", [extension_id]);
    if (!extR.rows[0]) { await client.query('ROLLBACK'); client.release(); return res.json({ success: false, error: 'Request expired or not found' }); }
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
    console.error('[rides] extension-accept:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

// POST /api/rides/extension-reject
router.post('/extension-reject', async (req, res) => {
  const { extension_id } = req.body;
  try {
    const r = await db.query("UPDATE ride_extensions SET status='rejected' WHERE id=$1 RETURNING customer_phone, new_drop", [extension_id]);
    if (r.rows[0]) sendFCM(r.rows[0].customer_phone, '❌ Extension Declined', 'Driver declined the extension — please book a new ride', {}, { role: 'customer' });
    res.json({ success: true });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/rate-customer
router.post('/rate-customer', async (req, res) => {
  const { ride_id, driver_phone, rating } = req.body;
  const r = parseInt(rating);
  if (!ride_id || !driver_phone) return res.status(400).json({ error: 'ride_id and driver_phone required' });
  if (![1, 2, 3, 4, 5].includes(r)) return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  try {
    const check = await db.query(
      `SELECT r.id, r.passenger_id FROM rides r
       JOIN users d ON r.driver_id = d.id
       WHERE r.id=$1 AND d.phone=$2 AND r.status IN ('completed','cash_confirmed')`,
      [ride_id, driver_phone]
    );
    if (!check.rows[0]) return res.status(400).json({ error: 'Ride not found or does not belong to you' });

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
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/surge-fare
// Customer boosts fare after all radii exhausted — absolute (base_fare + surge_amount)
router.post('/surge-fare', async (req, res) => {
  const { ride_id, customer_phone, surge_amount } = req.body;
  const amt = parseInt(surge_amount);
  if (!ride_id || !customer_phone) return res.status(400).json({ error: 'ride_id and customer_phone required' });
  if (![10, 20, 30, 40, 50, 80, 100, 150].includes(amt)) return res.status(400).json({ error: 'Invalid surge amount (10/20/30/40/50/80/100/150 allowed)' });
  try {
    await db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS surge_count INTEGER DEFAULT 0').catch(() => {});
    await db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS base_fare INTEGER').catch(() => {});

    const cu = await db.query('SELECT id FROM users WHERE phone=$1', [customer_phone]);
    if (!cu.rows[0]) return res.status(404).json({ error: 'Customer not found' });

    const rideRes = await db.query(
      `SELECT id, fare, base_fare, surge_count, pickup_lat, pickup_lng, ride_type
       FROM rides WHERE id=$1 AND passenger_id=$2 AND status='requested' AND driver_id IS NULL`,
      [ride_id, cu.rows[0].id]
    );
    if (!rideRes.rows[0]) return res.status(400).json({ error: 'Ride not available for surge' });

    const r = rideRes.rows[0];
    // Absolute fare: always base_fare + selected_amount (prevents cumulative drift)
    const baseFare = parseInt(r.base_fare) || parseInt(r.fare);
    const newFare = baseFare + amt;
    const newSurgeCount = (parseInt(r.surge_count) || 0) + 1;

    await db.query(
      `UPDATE rides SET
         fare                  = $1,
         surge_count           = $2,
         base_fare             = COALESCE(base_fare, fare),
         assigned_to_phone     = NULL,
         assignment_expires_at = NULL,
         assignment_queue      = '[]',
         offered_phones        = '{}',
         rejected_phones       = '{}',
         current_radius_m      = NULL
       WHERE id = $3`,
      [newFare, newSurgeCount, ride_id]
    );

    // Re-broadcast from 500m again (afterSurge=true → final failure → no_driver_final)
    assignRideToNextDriver(ride_id, r.pickup_lat, r.pickup_lng, r.ride_type, null, 5, true).catch(() => {});

    res.json({
      success: true,
      new_fare: '₹' + newFare,
      surge_count: newSurgeCount,
    });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/pre-accept — driver accepts a pre-assignment offer
router.post('/pre-accept', async (req, res) => {
  const { ride_id, phone } = req.body;
  if (!ride_id || !phone) return res.status(400).json({ error: 'ride_id and phone required' });
  try {
    const r = await db.query(
      `SELECT r.id, r.pickup, r.fare
       FROM rides r
       WHERE r.id = $1 AND r.status = 'pre_assigned' AND r.pre_accepted_driver_phone = $2`,
      [ride_id, phone]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Pre-assigned ride not found or does not belong to you' });

    // Confirm acceptance — emit to customer so they know driver confirmed
    emitToRoom('ride_' + ride_id, 'rideUpdate', {
      rideId: ride_id, status: 'pre_assigned', pre_accepted: true,
      message: 'Driver confirmed — they will come after completing the current ride',
    });
    res.json({ success: true, message: 'Ride added to queue!' });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/rides/pre-decline — driver declines a pre-assignment offer
router.post('/pre-decline', async (req, res) => {
  const { ride_id, phone } = req.body;
  if (!ride_id || !phone) return res.status(400).json({ error: 'ride_id and phone required' });
  try {
    const r = await db.query(
      `UPDATE rides SET status='requested', pre_accepted_driver_phone=NULL, pre_accepted_at=NULL
       WHERE id=$1 AND status='pre_assigned' AND pre_accepted_driver_phone=$2
       RETURNING id, pickup_lat, pickup_lng, ride_type`,
      [ride_id, phone]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Pre-assigned ride not found' });
    const ride = r.rows[0];

    // Tell customer we're searching again
    emitToRoom('ride_' + ride_id, 'rideUpdate', {
      rideId: ride_id, status: 'searching',
      message: 'Driver unavailable — searching again...',
    });

    // Queue recheck: try next pre-assignable driver or fall to surge
    rideQueue.add('ride-assignment', {
      type: 'pre-assign-recheck',
      rideId: ride_id,
      pickupLat: ride.pickup_lat, pickupLng: ride.pickup_lng, rideType: ride.ride_type,
      excludePhones: [phone],
    }, { delay: 500 }).catch(() => {});

    res.json({ success: true });
  } catch (err) { console.error('[rides]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// ── GET /api/rides/customer-analytics?phone=X ──────────────────────────────
router.get('/customer-analytics', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const userRes = await db.query(`SELECT id FROM users WHERE phone = $1 LIMIT 1`, [phone]);
    if (!userRes.rows.length) return res.json({ total_rides: 0, total_spent: 0, avg_fare: 0, total_savings: 0, monthly: [], vehicle: {}, days7: [], payment_methods: {} });
    const uid = userRes.rows[0].id;

    const [agg, monthly, vehicle, days7, payMethods] = await Promise.all([
      // Aggregate totals
      db.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'completed') AS total_rides,
          COALESCE(SUM(fare - COALESCE(discount,0)) FILTER (WHERE status = 'completed'), 0) AS total_spent,
          COALESCE(ROUND(AVG(fare) FILTER (WHERE status = 'completed'), 0), 0) AS avg_fare,
          COALESCE(SUM(discount) FILTER (WHERE discount > 0 AND status = 'completed'), 0) AS total_savings
        FROM rides WHERE passenger_id = $1`, [uid]),

      // Monthly breakdown — last 6 months
      db.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') AS label,
               EXTRACT(MONTH FROM created_at)::int AS mon,
               EXTRACT(YEAR FROM created_at)::int AS yr,
               COUNT(*) FILTER (WHERE status = 'completed') AS rides,
               COALESCE(SUM(fare - COALESCE(discount,0)) FILTER (WHERE status = 'completed'), 0) AS spent
        FROM rides
        WHERE passenger_id = $1 AND created_at >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', created_at), label, mon, yr
        ORDER BY yr, mon`, [uid]),

      // Vehicle type breakdown
      db.query(`
        SELECT ride_type, COUNT(*) AS count
        FROM rides WHERE passenger_id = $1 AND status = 'completed'
        GROUP BY ride_type`, [uid]),

      // Last 7 days
      db.query(`
        SELECT dates.day,
               TO_CHAR(dates.day, 'Dy') AS label,
               COALESCE(r.rides, 0) AS rides,
               COALESCE(r.spent, 0) AS spent
        FROM (SELECT generate_series(NOW()::date - 6, NOW()::date, '1 day'::interval)::date AS day) AS dates
        LEFT JOIN (
          SELECT DATE(created_at) AS day, COUNT(*) AS rides,
                 COALESCE(SUM(fare - COALESCE(discount,0)),0) AS spent
          FROM rides WHERE passenger_id = $1 AND status = 'completed'
            AND created_at >= NOW() - INTERVAL '7 days'
          GROUP BY DATE(created_at)
        ) AS r ON r.day = dates.day
        ORDER BY dates.day`, [uid]),

      // Payment method breakdown
      db.query(`
        SELECT payment_method, COUNT(*) AS count
        FROM rides WHERE passenger_id = $1 AND status = 'completed' AND payment_method IS NOT NULL
        GROUP BY payment_method`, [uid]),
    ]);

    const vehicleMap = {};
    vehicle.rows.forEach(r => { vehicleMap[r.ride_type] = parseInt(r.count); });

    const payMap = {};
    payMethods.rows.forEach(r => { payMap[r.payment_method] = parseInt(r.count); });

    res.json({
      total_rides:   parseInt(agg.rows[0].total_rides),
      total_spent:   Math.round(parseFloat(agg.rows[0].total_spent)),
      avg_fare:      Math.round(parseFloat(agg.rows[0].avg_fare)),
      total_savings: Math.round(parseFloat(agg.rows[0].total_savings)),
      monthly:       monthly.rows.map(r => ({ label: r.label, rides: parseInt(r.rides), spent: Math.round(parseFloat(r.spent)) })),
      vehicle:       vehicleMap,
      days7:         days7.rows.map(r => ({ label: r.label, rides: parseInt(r.rides), spent: Math.round(parseFloat(r.spent)) })),
      payment_methods: payMap,
    });
  } catch (err) { console.error('[rides/customer-analytics]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

module.exports = router;
