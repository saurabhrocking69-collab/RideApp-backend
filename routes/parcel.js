'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { PARCEL_FARES, PARCEL_SIZE_SURCHARGE, calculateParcelFare } = require('../services/pricing');
const { assignRideToNextDriver } = require('../workers/rideWorker');
const userAuth = require('../middleware/userAuth');
const { verifyOnlinePayment, razorpay } = require('../services/advance');
const { sendFCM } = require('../config/firebase');

// Package size gates which vehicle types can carry it — enforced here too,
// not just client-side, same "never trust the client" rule the rest of the
// booking endpoints follow.
const SIZE_VEHICLES = {
  small:  ['bike', 'green_bike', 'auto', 'eriksha', 'electric_auto', 'car'],
  medium: ['auto', 'eriksha', 'electric_auto', 'car'],
  large:  ['car'],
};

// Admin-editable parcel rates — persisted here, hydrated into the in-memory
// PARCEL_FARES/PARCEL_SIZE_SURCHARGE singletons on boot (module cache shares
// the reference with admin.js), same pattern as intercity_settings.
db.query(`
  CREATE TABLE IF NOT EXISTS parcel_settings (
    vehicle_type TEXT PRIMARY KEY,
    base_fare NUMERIC, per_km_rate NUMERIC, min_fare NUMERIC,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => db.query('SELECT * FROM parcel_settings'))
  .then(r => {
    for (const row of (r.rows || [])) {
      const cfg = PARCEL_FARES[row.vehicle_type];
      if (!cfg) continue;
      for (const k of ['base_fare', 'per_km_rate', 'min_fare']) {
        if (row[k] != null) cfg[k] = parseFloat(row[k]);
      }
    }
    if (r.rows?.length) console.log(`[parcel] hydrated ${r.rows.length} fare config(s) from DB`);
  })
  .catch(() => {});

db.query(`
  CREATE TABLE IF NOT EXISTS parcel_size_settings (
    size TEXT PRIMARY KEY,
    surcharge NUMERIC,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => db.query('SELECT * FROM parcel_size_settings'))
  .then(r => {
    for (const row of (r.rows || [])) {
      if (row.surcharge != null && row.size in PARCEL_SIZE_SURCHARGE) {
        PARCEL_SIZE_SURCHARGE[row.size] = parseFloat(row.surcharge);
      }
    }
    if (r.rows?.length) console.log(`[parcel] hydrated ${r.rows.length} size surcharge(s) from DB`);
  })
  .catch(() => {});

// ── POST /api/parcel/estimate — fare options for every vehicle type the
//    chosen package size allows ──────────────────────────────────────────────
router.post('/estimate', userAuth, async (req, res) => {
  const { distance, package_size } = req.body;
  const distKm = parseFloat(distance);
  if (!distKm || distKm <= 0) return res.status(400).json({ error: 'distance (km) required' });
  const size = SIZE_VEHICLES[package_size] ? package_size : 'small';

  const options = SIZE_VEHICLES[size].map(v =>
    ({ vehicle_type: v, ...calculateParcelFare(PARCEL_FARES[v], distKm, size) })
  );
  res.json({ options, package_size: size });
});

// ── POST /api/parcel/payment-order — Razorpay order for the FULL delivery
//    fare, paid upfront at booking and held in escrow until delivery is
//    confirmed. Mirrors routes/advance.js's /order (same HMAC/capture
//    verification via verifyOnlinePayment), just no 1/3-fraction math. ──────
router.post('/payment-order', userAuth, async (req, res) => {
  const { fare } = req.body;
  const fareNum = parseFloat(fare) || 0;
  if (fareNum <= 0) return res.status(400).json({ error: 'Valid fare required' });
  if (!razorpay) return res.status(500).json({ error: 'Payment gateway not configured' });
  try {
    const order = await razorpay.orders.create({
      amount: Math.round(fareNum * 100), currency: 'INR',
      receipt: `parcel_${req.user.phone}_${Date.now()}`,
      notes: { phone: req.user.phone, purpose: 'parcel_escrow', fare: String(fareNum) },
    });
    res.json({ success: true, order_id: order.id, amount: order.amount, currency: 'INR', key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/parcel/book ──────────────────────────────────────────────────
// Payment is collected in FULL, upfront, before the ride is created — held
// in escrow (rides.payment_status='escrowed') and released to the driver's
// wallet automatically when delivery is confirmed (see rides.js /complete).
// No cash-on-delivery: the sender has already paid, so there's nothing left
// for the driver to collect from the receiver.
router.post('/book', userAuth, async (req, res) => {
  const {
    passenger_phone, pickup, drop_location, vehicle_type, package_size, package_note,
    pickup_lat, pickup_lng, drop_lat, drop_lng,
    discount, promo_code, receiver_name, receiver_phone, payment,
  } = req.body;

  if (req.user.phone !== String(passenger_phone)) return res.status(403).json({ error: 'You can only book as yourself' });
  if (!passenger_phone || String(passenger_phone).length !== 10)
    return res.status(400).json({ error: 'Valid phone required' });
  if (!pickup || !drop_location)
    return res.status(400).json({ error: 'Pickup and drop required' });
  const size = SIZE_VEHICLES[package_size] ? package_size : null;
  if (!size) return res.status(400).json({ error: 'Valid package_size required (small/medium/large)' });
  if (!SIZE_VEHICLES[size].includes(vehicle_type))
    return res.status(400).json({ error: `${vehicle_type} can't carry a ${size} package` });
  // Receiver details are mandatory for a parcel — the driver picks up FROM
  // the account holder (sender), so these are deliberately separate columns
  // from rider_name/rider_phone (which mean "who the driver picks up"
  // everywhere else in this codebase).
  const receiverNameVal  = (receiver_name || '').trim();
  const receiverPhoneVal = String(receiver_phone || '').trim();
  if (!receiverNameVal) return res.status(400).json({ error: "Receiver's name is required" });
  if (!/^[0-9]{10}$/.test(receiverPhoneVal)) return res.status(400).json({ error: "Receiver's valid 10-digit phone is required" });

  const distKm = parseFloat(req.body.distance);
  if (!distKm || distKm <= 0) return res.status(400).json({ error: 'distance (km) required' });

  const paymentMethod = payment?.method;
  if (!['wallet', 'online'].includes(paymentMethod))
    return res.status(400).json({ error: 'Payment is required to book a parcel delivery' });

  const client = await db.connect();
  try {
    const passengerRes = await client.query('SELECT * FROM users WHERE phone=$1', [passenger_phone]);
    if (!passengerRes.rows[0]) { client.release(); return res.status(404).json({ error: 'Account not found — please log in again' }); }
    if (passengerRes.rows[0].booking_restricted) {
      client.release();
      return res.status(403).json({ error: '🚫 Your account is on hold. Please contact support: help@sppero.com', restricted: true });
    }
    const passenger = passengerRes.rows[0];

    // Fare is always computed server-side — never trust a client-sent amount
    const fareCalc = calculateParcelFare(PARCEL_FARES[vehicle_type], distKm, size);
    const fare = fareCalc.fare;

    // ── Collect the full fare upfront, before the ride exists — held in
    //    escrow (payment_status='escrowed') and released to the driver's
    //    wallet automatically on delivery (rides.js /complete). ────────────
    if (paymentMethod === 'wallet') {
      await client.query('BEGIN');
      const walletRes = await client.query('SELECT balance FROM customer_wallet WHERE user_id=$1 FOR UPDATE', [passenger.id]);
      const balance = walletRes.rows[0] ? parseFloat(walletRes.rows[0].balance) : 0;
      if (balance < fare) {
        await client.query('ROLLBACK'); client.release();
        return res.status(402).json({ error: 'Insufficient wallet balance', balance, fare, use_online: true });
      }
      await client.query('UPDATE customer_wallet SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2', [fare, passenger.id]);
      await client.query("INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,'Parcel delivery payment')", [passenger.id, fare]);
    } else {
      const v = await verifyOnlinePayment({ order_id: payment.order_id, payment_id: payment.payment_id, signature: payment.signature });
      if (!v.ok || Math.round(v.amount) < Math.round(fare))
        { client.release(); return res.status(402).json({ error: v.error || 'Payment verification failed' }); }
      await client.query('BEGIN');
    }

    const rideRes = await client.query(
      `INSERT INTO rides
         (passenger_id, pickup, drop_location, ride_type, fare, status,
          is_parcel, package_size, package_note,
          pickup_lat, pickup_lng, drop_lat, drop_lng,
          discount, promo_code, distance_km, platform_fee,
          receiver_name, receiver_phone, payment_status, payment_method)
       VALUES ($1,$2,$3,$4,$5,'requested',true,$6,$7,$8,$9,$10,$11,$12,$13,$14,0,$15,$16,'escrowed',$17)
       RETURNING *`,
      [
        passenger.id, pickup, drop_location, vehicle_type, fare,
        size, (package_note || '').trim() || null,
        pickup_lat || null, pickup_lng || null, drop_lat || null, drop_lng || null,
        discount || 0, promo_code || null, distKm,
        receiverNameVal, receiverPhoneVal, paymentMethod,
      ]
    );
    await client.query('COMMIT');
    client.release();
    const rideId = rideRes.rows[0].id;

    console.log(`[parcel] ✅ ride=${rideId} ${vehicle_type} ${size} ${distKm}km → ${receiverNameVal} · paid ₹${fare} via ${paymentMethod} (escrowed)`);
    // 2s delay so the customer joins the socket room first (same as /rides/book, /intercity/book)
    const _pLat = pickup_lat || null, _pLng = pickup_lng || null;
    setTimeout(() => assignRideToNextDriver(rideId, _pLat, _pLng, vehicle_type)
      .catch(e => console.error('[PARCEL_ASSIGN_FAIL]', e.message)), 2000);

    res.json({
      message: 'Finding your delivery partner...',
      ride_id: rideId,
      status: 'requested',
      fare: '₹' + fare,
      net_fare: Math.max(0, fare - (discount || 0)),
      discount: discount || 0,
      breakdown: fareCalc,
      is_parcel: true,
      package_size: size,
      receiver_name: receiverNameVal,
      receiver_phone: receiverPhoneVal,
      distance: distKm + ' km',
      payment_status: 'escrowed',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[parcel] book error:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

// ── POST /api/parcel/report-not-delivered — sender reports a completed
//    delivery as never actually reaching the receiver. Money has already
//    been released to the driver by this point (escrow releases on delivery
//    OTP confirmation), so this opens a dispute for Sppero's team to review
//    — reuses the same ride_disputes table + admin-adjudication flow already
//    built for emergency mid-trip cancellations (routes/admin.js). ─────────
router.post('/report-not-delivered', userAuth, async (req, res) => {
  const { ride_id, reason } = req.body;
  try {
    const r = await db.query(
      `SELECT r.*, p.phone AS passenger_phone, u.phone AS driver_phone
       FROM rides r LEFT JOIN users p ON r.passenger_id = p.id LEFT JOIN users u ON r.driver_id = u.id
       WHERE r.id = $1`, [ride_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    const ride = r.rows[0];
    if (ride.passenger_phone !== req.user.phone) return res.status(403).json({ error: 'This ride is not yours' });
    if (!ride.is_parcel) return res.status(400).json({ error: 'This isn\'t a parcel delivery' });
    if (ride.status !== 'completed') return res.status(400).json({ error: 'Only a completed delivery can be reported' });

    const existing = await db.query("SELECT id FROM ride_disputes WHERE ride_id=$1 AND status='pending'", [String(ride_id)]);
    if (existing.rows[0]) return res.status(400).json({ error: 'This delivery is already under review' });

    await db.query(
      `INSERT INTO ride_disputes (ride_id, customer_phone, driver_phone, reason, held_advance, fare, status, dispute_type)
       VALUES ($1,$2,$3,$4,$5,$6,'pending','parcel_not_delivered')`,
      [String(ride_id), ride.passenger_phone, ride.driver_phone, reason || '', parseFloat(ride.fare || 0), parseFloat(ride.fare || 0)]
    );

    const adminPhone = process.env.ADMIN_ALERT_PHONE;
    if (adminPhone) sendFCM(adminPhone, '🚨 Parcel Not Delivered — Report', `Ride ${ride_id}: sender says the package never reached the receiver. Reason: ${reason || 'N/A'}. Review in admin.`, { type: 'health_alert', ride_id: String(ride_id) }, {}).catch(() => {});

    res.json({ success: true, message: 'Your report is under review — our team will get back to you.' });
  } catch (err) { console.error('[parcel] report-not-delivered', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

module.exports = router;
