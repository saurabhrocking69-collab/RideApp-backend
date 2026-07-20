'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { sendFCM }        = require('../config/firebase');
const { calculateFare, getISTHour } = require('../services/pricing');
const { rideQueue }      = require('../workers/rideWorker');

// ── Idempotent schema additions ───────────────────────────────────────────────
// Create table with correct schema if it doesn't exist yet
db.query(`
  CREATE TABLE IF NOT EXISTS scheduled_rides (
    id            SERIAL PRIMARY KEY,
    ride_id       TEXT NOT NULL,
    status        TEXT DEFAULT 'pending',
    scheduled_at  TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    failed_reason TEXT
  )
`).catch(() => {});
// Migrate: ride_id was INT in the original Railway table, must be TEXT for UUID ride IDs
db.query(`ALTER TABLE scheduled_rides ALTER COLUMN ride_id TYPE TEXT USING ride_id::TEXT`).catch(() => {});
db.query('ALTER TABLE scheduled_rides ADD COLUMN IF NOT EXISTS bullmq_job_id VARCHAR(100)').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancel_reason TEXT').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS is_scheduled BOOLEAN DEFAULT FALSE').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ').catch(() => {});

const VALID_TYPES = ['auto', 'bike', 'car', 'eriksha', 'luxury', 'green_bike', 'electric_auto'];

const DEFAULT_FARES = {
  luxury:        { base_fare: 80,  per_km_rate: 25, per_km_rate_t2: 28, per_km_rate_t3: 30, time_rate: 1.5,  platform_fee: 3.0, min_fare: 120, night_multiplier: 1.8, night_start: '22:00', night_end: '06:00' },
  car:           { base_fare: 40,  per_km_rate: 15, per_km_rate_t2: 17, per_km_rate_t3: 18, time_rate: 1.0,  platform_fee: 2.5, min_fare: 65,  night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' },
  auto:          { base_fare: 25,  per_km_rate: 12, per_km_rate_t2: 14, per_km_rate_t3: 15, time_rate: 0.75, platform_fee: 2.0, min_fare: 45,  night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' },
  eriksha:       { base_fare: 20,  per_km_rate: 10, per_km_rate_t2: 11, per_km_rate_t3: 12, time_rate: 0.65, platform_fee: 2.0, min_fare: 35,  night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' },
  bike:          { base_fare: 15,  per_km_rate: 8,  per_km_rate_t2: 9,  per_km_rate_t3: 10, time_rate: 0.5,  platform_fee: 2.0, min_fare: 30,  night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' },
  green_bike:    { base_fare: 12,  per_km_rate: 6,  per_km_rate_t2: 7,  per_km_rate_t3: 8,  time_rate: 0.4,  platform_fee: 2.0, min_fare: 25,  night_multiplier: 1.2, night_start: '22:00', night_end: '06:00' },
  electric_auto: { base_fare: 20,  per_km_rate: 9,  per_km_rate_t2: 11, per_km_rate_t3: 12, time_rate: 0.6,  platform_fee: 2.0, min_fare: 38,  night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' },
};

// ── POST /api/scheduled — create a scheduled ride ─────────────────────────────
router.post('/', async (req, res) => {
  const {
    passenger_phone, pickup, drop_location, ride_type,
    pickup_lat, pickup_lng, drop_lat, drop_lng,
    discount, promo_code, scheduled_at,
  } = req.body;

  if (!passenger_phone || String(passenger_phone).length !== 10)
    return res.status(400).json({ error: 'Valid phone required' });
  if (!pickup || !drop_location)
    return res.status(400).json({ error: 'Pickup and drop required' });
  if (!VALID_TYPES.includes(ride_type))
    return res.status(400).json({ error: 'Invalid ride type' });
  if (!scheduled_at)
    return res.status(400).json({ error: 'scheduled_at (ISO string) required' });

  const scheduledTime = new Date(scheduled_at);
  if (isNaN(scheduledTime.getTime()))
    return res.status(400).json({ error: 'Invalid scheduled_at format' });

  const diffMs = scheduledTime.getTime() - Date.now();
  if (diffMs < 60 * 60 * 1000)
    return res.status(400).json({ error: 'Must schedule at least 1 hour in advance' });
  if (diffMs > 48 * 60 * 60 * 1000)
    return res.status(400).json({ error: 'Cannot schedule more than 2 days in advance' });

  try {
    const passengerRes = await db.query('SELECT * FROM users WHERE phone=$1', [passenger_phone]);
    if (!passengerRes.rows[0])
      return res.status(404).json({ error: 'Passenger not found' });
    if (passengerRes.rows[0].booking_restricted)
      return res.status(403).json({ error: '🚫 Account on hold. Contact support: help@sppero.in', restricted: true });

    const passenger = passengerRes.rows[0];
    const distance    = parseFloat(req.body.distance) || 5;
    const durationMin = parseFloat(req.body.duration_min) || (distance / 20) * 60;

    const fareRes = await db.query('SELECT * FROM fare_settings WHERE vehicle_type=$1', [ride_type]);
    const f = fareRes.rows[0] || DEFAULT_FARES[ride_type] || DEFAULT_FARES.auto;
    const hour = getISTHour();
    const nightStart = parseInt(String(f.night_start || '22').split(':')[0]);
    const nightEnd   = parseInt(String(f.night_end   || '6').split(':')[0]);
    const isNight    = hour >= nightStart || hour < nightEnd;
    const fareCalc   = calculateFare(f, distance, durationMin, isNight);
    const fare       = fareCalc.fare;
    const platFee    = fareCalc.platform_fee;

    // INSERT ride with status='scheduled'
    const rideRes = await db.query(
      `INSERT INTO rides
         (passenger_id, pickup, drop_location, ride_type, fare, status,
          is_scheduled, scheduled_at,
          pickup_lat, pickup_lng, drop_lat, drop_lng,
          discount, promo_code, distance_km, platform_fee)
       VALUES ($1,$2,$3,$4,$5,'scheduled',true,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        passenger.id, pickup, drop_location, ride_type, fare,
        scheduledTime,
        pickup_lat || null, pickup_lng || null, drop_lat || null, drop_lng || null,
        discount || 0, promo_code || null, distance, platFee,
      ]
    );
    const rideId = rideRes.rows[0].id;

    // INSERT into scheduled_rides
    const srRes = await db.query(
      `INSERT INTO scheduled_rides (ride_id, status, scheduled_at, updated_at)
       VALUES ($1,'pending',$2,NOW()) RETURNING *`,
      [rideId, scheduledTime]
    );
    const srId = srRes.rows[0].id;

    // Add BullMQ delayed job — fires 15 min before scheduled_at
    const delayMs = Math.max(0, scheduledTime.getTime() - Date.now() - 15 * 60 * 1000);
    let bullmqJobId = null;
    try {
      const job = await rideQueue.add(
        'sched-dispatch',
        {
          type:               'dispatch-scheduled-ride',
          ride_id:            rideId,
          scheduled_ride_id:  srId,
          pickup_lat:         pickup_lat || null,
          pickup_lng:         pickup_lng || null,
          ride_type,
          passenger_phone,
        },
        { delay: delayMs, removeOnComplete: true }
      );
      bullmqJobId = job.id;
      await db.query(
        'UPDATE scheduled_rides SET bullmq_job_id=$1 WHERE id=$2',
        [bullmqJobId, srId]
      );
    } catch (qErr) {
      console.error('[scheduled] BullMQ enqueue failed:', qErr.message);
    }

    console.log(`[scheduled] ✅ ride=${rideId} scheduled for ${scheduledTime.toISOString()} (delay=${Math.round(delayMs/60000)}min) job=${bullmqJobId}`);

    res.json({
      message:      'Ride scheduled!',
      ride_id:      rideId,
      scheduled_at: scheduledTime.toISOString(),
      fare:         '₹' + fare,
      net_fare:     Math.max(0, fare - (discount || 0)),
      discount:     discount || 0,
      platform_fee: platFee,
      distance:     distance + ' km',
      status:       'scheduled',
    });

    // Confirmation FCM (fire-and-forget after response)
    const timeStr = scheduledTime.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
    });
    const dateStr = scheduledTime.toLocaleDateString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata',
    });
    sendFCM(
      passenger_phone,
      '📅 Ride Scheduled!',
      `Your ${ride_type} on ${dateStr} at ${timeStr} is confirmed. Driver will be matched 15 mins before.`,
      { type: 'scheduled_confirmed', ride_id: String(rideId) },
      { role: 'customer' }
    ).catch(() => {});
  } catch (err) {
    console.error('[scheduled] POST error:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

// ── GET /api/scheduled/my-rides?phone=xxx ─────────────────────────────────────
router.get('/my-rides', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const result = await db.query(
      `SELECT r.id, r.pickup, r.drop_location, r.ride_type, r.fare, r.discount,
              r.platform_fee, r.scheduled_at, r.status, r.cancel_reason,
              r.pickup_lat, r.pickup_lng, r.drop_lat, r.drop_lng, r.distance_km,
              r.created_at,
              sr.id AS sr_id, sr.status AS sr_status, sr.failed_reason
       FROM rides r
       JOIN scheduled_rides sr ON sr.ride_id = r.id::text
       JOIN users u ON r.passenger_id::text = u.id::text
       WHERE u.phone = $1
         AND r.is_scheduled = true
       ORDER BY r.scheduled_at DESC
       LIMIT 20`,
      [phone]
    );
    res.json({ scheduled_rides: result.rows });
  } catch (err) {
    console.error('[scheduled] GET my-rides error:', err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ── DELETE /api/scheduled/:id — cancel a scheduled ride ───────────────────────
router.delete('/:id', async (req, res) => {
  const rideId = req.params.id;
  const { phone, reason } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const rideRes = await db.query(
      `SELECT r.id, r.status, r.scheduled_at,
              sr.id AS sr_id, sr.bullmq_job_id, sr.status AS sr_status
       FROM rides r
       JOIN scheduled_rides sr ON sr.ride_id = r.id::text
       JOIN users u ON r.passenger_id::text = u.id::text
       WHERE r.id=$1 AND u.phone=$2 AND r.is_scheduled=true`,
      [rideId, phone]
    );
    if (!rideRes.rows[0])
      return res.status(404).json({ error: 'Scheduled ride not found' });

    const row = rideRes.rows[0];
    if (!['scheduled', 'requested'].includes(row.status))
      return res.status(400).json({ error: 'Ride cannot be cancelled in current state' });

    // Remove BullMQ delayed job if it hasn't fired yet
    if (row.bullmq_job_id) {
      try {
        const job = await rideQueue.getJob(row.bullmq_job_id);
        if (job) await job.remove();
      } catch (_e) {}
    }

    await Promise.all([
      db.query(
        `UPDATE rides SET status='scheduled_cancelled', cancel_reason=$1 WHERE id=$2`,
        [reason || 'Customer cancelled', rideId]
      ),
      db.query(
        `UPDATE scheduled_rides SET status='cancelled', updated_at=NOW() WHERE id=$1`,
        [row.sr_id]
      ),
    ]);

    console.log(`[scheduled] cancelled ride=${rideId} reason="${reason}"`);
    res.json({ message: 'Scheduled ride cancelled' });
  } catch (err) {
    console.error('[scheduled] DELETE error:', err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

module.exports = router;
