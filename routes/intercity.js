'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { sendFCM } = require('../config/firebase');
const { INTERCITY_FARES, calculateIntercityFare } = require('../services/pricing');
const { rideQueue, assignRideToNextDriver } = require('../workers/rideWorker');

// ── Idempotent schema additions ───────────────────────────────────────────────
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS is_intercity BOOLEAN DEFAULT FALSE').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS is_roundtrip BOOLEAN DEFAULT FALSE').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS return_at TIMESTAMPTZ').catch(() => {});
// Lower commission for intercity — big absolute fares, keep drivers motivated
db.query('ALTER TABLE fare_settings ADD COLUMN IF NOT EXISTS intercity_commission_rate NUMERIC DEFAULT 10').catch(() => {});

// Admin-editable intercity rates — persisted here, hydrated into the in-memory
// INTERCITY_FARES singleton on boot (module cache shares the reference with admin.js)
db.query(`
  CREATE TABLE IF NOT EXISTS intercity_settings (
    vehicle_type TEXT PRIMARY KEY,
    base_fare NUMERIC, per_km_oneway NUMERIC, per_km_round NUMERIC,
    driver_allowance_per_day NUMERIC, night_halt NUMERIC, min_km NUMERIC,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => db.query('SELECT * FROM intercity_settings'))
  .then(r => {
    for (const row of (r.rows || [])) {
      const cfg = INTERCITY_FARES[row.vehicle_type];
      if (!cfg) continue;
      for (const k of ['base_fare', 'per_km_oneway', 'per_km_round', 'driver_allowance_per_day', 'night_halt', 'min_km']) {
        if (row[k] != null) cfg[k] = parseFloat(row[k]);
      }
    }
    if (r.rows?.length) console.log(`[intercity] hydrated ${r.rows.length} fare config(s) from DB`);
  })
  .catch(() => {});

// Intercity only makes sense for genuinely long trips. Client switches at 80km;
// server accepts a little under to tolerate route-recalculation drift.
const MIN_INTERCITY_KM = 70;
const INTERCITY_VEHICLES = ['car', 'luxury'];

// Calendar days a round trip spans in IST (inclusive) — drives allowance/night-halt
function tripDaysIST(leaveAt, returnAt) {
  if (!returnAt) return 1;
  const IST = 5.5 * 60 * 60 * 1000;
  const dayOf = (d) => Math.floor((new Date(d).getTime() + IST) / 86400000);
  return Math.max(1, dayOf(returnAt) - dayOf(leaveAt) + 1);
}

// ── POST /api/intercity/estimate — fare options for both car tiers ────────────
router.post('/estimate', async (req, res) => {
  const { distance, trip_kind, leave_at, return_at } = req.body;
  const distKm = parseFloat(distance);
  if (!distKm || distKm <= 0) return res.status(400).json({ error: 'distance (km) required' });
  const kind = trip_kind === 'round' ? 'round' : 'oneway';
  const days = kind === 'round' ? tripDaysIST(leave_at || Date.now(), return_at) : 1;

  const options = INTERCITY_VEHICLES.map(v =>
    ({ vehicle_type: v, ...calculateIntercityFare(INTERCITY_FARES[v], distKm, kind, days) })
  );
  res.json({
    options,
    min_km: MIN_INTERCITY_KM,
    trip_kind: kind,
    trip_days: days,
    notes: ['Tolls & interstate charges extra — pay driver directly', 'Parking charges extra', 'Taxes not included'],
  });
});

// ── POST /api/intercity/book ──────────────────────────────────────────────────
router.post('/book', async (req, res) => {
  const {
    passenger_phone, pickup, drop_location, vehicle_type, trip_kind,
    pickup_lat, pickup_lng, drop_lat, drop_lng,
    scheduled_at, return_at, discount, promo_code,
  } = req.body;

  if (!passenger_phone || String(passenger_phone).length !== 10)
    return res.status(400).json({ error: 'Valid phone required' });
  if (!pickup || !drop_location)
    return res.status(400).json({ error: 'Pickup and drop required' });
  if (!INTERCITY_VEHICLES.includes(vehicle_type))
    return res.status(400).json({ error: 'Intercity supports cars only' });

  const kind = trip_kind === 'round' ? 'round' : 'oneway';
  const distKm = parseFloat(req.body.distance);
  if (!distKm || distKm < MIN_INTERCITY_KM)
    return res.status(400).json({ error: `Intercity is for trips above ${MIN_INTERCITY_KM} km` });

  // Leave time: absent → leave now; present → scheduled (1h–48h ahead, same as scheduled rides)
  let scheduledTime = null;
  if (scheduled_at) {
    scheduledTime = new Date(scheduled_at);
    if (isNaN(scheduledTime.getTime())) return res.status(400).json({ error: 'Invalid scheduled_at format' });
    const diffMs = scheduledTime.getTime() - Date.now();
    if (diffMs < 60 * 60 * 1000)      return res.status(400).json({ error: 'Must schedule at least 1 hour in advance' });
    if (diffMs > 48 * 60 * 60 * 1000) return res.status(400).json({ error: 'Cannot schedule more than 2 days in advance' });
  }

  let returnTime = null;
  if (kind === 'round') {
    if (!return_at) return res.status(400).json({ error: 'return_at required for round trips' });
    returnTime = new Date(return_at);
    if (isNaN(returnTime.getTime())) return res.status(400).json({ error: 'Invalid return_at format' });
    const leaveMs = scheduledTime ? scheduledTime.getTime() : Date.now();
    if (returnTime.getTime() <= leaveMs) return res.status(400).json({ error: 'Return time must be after departure' });
  }

  try {
    const passengerRes = await db.query('SELECT * FROM users WHERE phone=$1', [passenger_phone]);
    if (!passengerRes.rows[0]) return res.status(404).json({ error: 'Passenger not found' });
    if (passengerRes.rows[0].booking_restricted)
      return res.status(403).json({ error: '🚫 Account on hold. Contact support: help@sppero.in', restricted: true });
    const passenger = passengerRes.rows[0];

    // Fare is always computed server-side — never trust a client-sent amount
    const days     = kind === 'round' ? tripDaysIST(scheduledTime || Date.now(), returnTime) : 1;
    const fareCalc = calculateIntercityFare(INTERCITY_FARES[vehicle_type], distKm, kind, days);
    const fare     = fareCalc.fare;

    const status = scheduledTime ? 'scheduled' : 'requested';
    const rideRes = await db.query(
      `INSERT INTO rides
         (passenger_id, pickup, drop_location, ride_type, fare, status,
          is_intercity, is_roundtrip, return_at, is_scheduled, scheduled_at,
          pickup_lat, pickup_lng, drop_lat, drop_lng,
          discount, promo_code, distance_km, platform_fee)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,0)
       RETURNING *`,
      [
        passenger.id, pickup, drop_location, vehicle_type, fare, status,
        kind === 'round', returnTime, !!scheduledTime, scheduledTime,
        pickup_lat || null, pickup_lng || null, drop_lat || null, drop_lng || null,
        discount || 0, promo_code || null, distKm,
      ]
    );
    const rideId = rideRes.rows[0].id;

    if (scheduledTime) {
      // Reuse the scheduled-rides pipeline: driver matched 15 min before departure
      const srRes = await db.query(
        `INSERT INTO scheduled_rides (ride_id, status, scheduled_at, updated_at)
         VALUES ($1,'pending',$2,NOW()) RETURNING id`,
        [rideId, scheduledTime]
      );
      const delayMs = Math.max(0, scheduledTime.getTime() - Date.now() - 15 * 60 * 1000);
      try {
        const job = await rideQueue.add(
          'sched-dispatch',
          {
            type: 'dispatch-scheduled-ride',
            ride_id: rideId, scheduled_ride_id: srRes.rows[0].id,
            pickup_lat: pickup_lat || null, pickup_lng: pickup_lng || null,
            ride_type: vehicle_type, passenger_phone,
          },
          { delay: delayMs, removeOnComplete: true }
        );
        await db.query('UPDATE scheduled_rides SET bullmq_job_id=$1 WHERE id=$2', [job.id, srRes.rows[0].id]);
      } catch (qErr) {
        console.error('[intercity] BullMQ enqueue failed:', qErr.message);
      }
      console.log(`[intercity] ✅ ride=${rideId} ${kind} ${vehicle_type} ${distKm}km scheduled ${scheduledTime.toISOString()}`);
    } else {
      console.log(`[intercity] ✅ ride=${rideId} ${kind} ${vehicle_type} ${distKm}km leave-now`);
      // 2s delay so the customer joins the socket room first (same as /rides/book)
      const _pLat = pickup_lat || null, _pLng = pickup_lng || null;
      setTimeout(() => assignRideToNextDriver(rideId, _pLat, _pLng, vehicle_type)
        .catch(e => console.error('[INTERCITY_ASSIGN_FAIL]', e.message)), 2000);
    }

    res.json({
      message: scheduledTime ? 'Intercity trip scheduled!' : 'Finding your intercity driver...',
      ride_id: rideId,
      status,
      fare: '₹' + fare,
      net_fare: Math.max(0, fare - (discount || 0)),
      discount: discount || 0,
      breakdown: fareCalc,
      trip_kind: kind,
      is_intercity: true,
      scheduled_at: scheduledTime ? scheduledTime.toISOString() : null,
      return_at: returnTime ? returnTime.toISOString() : null,
      distance: distKm + ' km',
      surge_multiplier: 1.0,
      platform_fee: 0,
      dist_fare: fareCalc.dist_fare,
      time_fare: 0,
      base_fare: fareCalc.base_fare,
      is_night: false,
    });

    if (scheduledTime) {
      const timeStr = scheduledTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
      const dateStr = scheduledTime.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
      sendFCM(
        passenger_phone,
        '🛣️ Intercity Trip Scheduled!',
        `Your ${kind === 'round' ? 'round trip' : 'one-way trip'} on ${dateStr} at ${timeStr} is confirmed. Driver will be matched 15 mins before.`,
        { type: 'scheduled_confirmed', ride_id: String(rideId) },
        { role: 'customer' }
      ).catch(() => {});
    }
  } catch (err) {
    console.error('[intercity] book error:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

module.exports = router;
