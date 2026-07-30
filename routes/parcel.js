'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { PARCEL_FARES, PARCEL_SIZE_SURCHARGE, PARCEL_RETURN_FEE_PCT, calculateParcelFare } = require('../services/pricing');
const { assignRideToNextDriver } = require('../workers/rideWorker');
const { tryBatchDispatch, acceptBatch } = require('../services/parcelBatching');
const userAuth = require('../middleware/userAuth');
const { verifyOnlinePayment, razorpay, refundToWallet, creditDriverWallet } = require('../services/advance');
const { sendFCM } = require('../config/firebase');
const { emitToRoom } = require('../config/socket');
const { transitionRide } = require('../services/rideStateMachine');
const { clearRide } = require('../services/rideCache');

// Return-to-sender columns — a parcel whose delivery attempt failed
// (receiver unreachable/refused) and the sender opted to get it back.
// rides.status stays 'started' throughout this whole sub-flow (the ride is
// still physically in progress); return_status is a parallel side-field,
// same pattern as advance_status/commission_status sitting alongside status.
db.query("ALTER TABLE rides ADD COLUMN IF NOT EXISTS return_status TEXT").catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS delivery_fail_reason TEXT').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS return_otp VARCHAR(4)').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS return_fee NUMERIC').catch(() => {});

// Package size gates which vehicle types can carry it — enforced here too,
// not just client-side, same "never trust the client" rule the rest of the
// booking endpoints follow.
// - small (fits in a bag, ≤2kg): bike/e-bike only — fastest, cheapest,
//   most available on the road; sending a bag-sized item by car/auto is
//   needlessly slow and expensive, and offering those just clutters the
//   choice with no upside for the customer.
// - medium (a box, ≤10kg): too bulky/heavy to secure safely on a 2-wheeler —
//   needs an actual boot/cargo area, so bike/green_bike are excluded and it's
//   auto/eriksha/electric_auto/car instead.
// - large (won't fit on a bike, ≤25kg): only a car has the trunk space.
const SIZE_VEHICLES = {
  small:  ['bike', 'green_bike'],
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
    // 2s delay so the customer joins the socket room first (same as /rides/book, /intercity/book).
    // Try route-batching with another nearby unassigned parcel first; if no
    // partner is found (or the resulting offer times out with no driver —
    // see expireBatchOffer in services/parcelBatching.js), fall back to the
    // normal individual broadcast exactly as before batching existed.
    const _pLat = pickup_lat || null, _pLng = pickup_lng || null;
    setTimeout(async () => {
      let batched = false;
      try {
        batched = await tryBatchDispatch(rideId, vehicle_type, size, _pLat, _pLng);
      } catch (e) { console.error('[PARCEL_BATCH_FAIL]', e.message); }
      // Batching is a best-effort optimization — if it throws for any reason
      // (schema drift, DB hiccup, etc.), the parcel must still get dispatched
      // normally instead of being silently stranded in 'requested'.
      if (!batched) {
        try { await assignRideToNextDriver(rideId, _pLat, _pLng, vehicle_type); }
        catch (e) { console.error('[PARCEL_ASSIGN_FAIL]', e.message); }
      }
    }, 2000);

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

// ── POST /api/parcel/flag-non-delivery — driver can't reach/deliver to the
//    receiver (not answering, refused, etc.). Notifies the sender to decide
//    what happens next; the ride itself stays 'started' the whole time. ────
router.post('/flag-non-delivery', userAuth, async (req, res) => {
  const { ride_id, driver_phone, reason } = req.body;
  if (req.user.phone !== String(driver_phone)) return res.status(403).json({ error: 'You can only act as yourself' });
  try {
    const r = await db.query(
      `SELECT r.*, p.phone AS passenger_phone, u.phone AS driver_phone
       FROM rides r LEFT JOIN users p ON r.passenger_id = p.id LEFT JOIN users u ON r.driver_id = u.id
       WHERE r.id = $1`, [ride_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    const ride = r.rows[0];
    if (ride.driver_phone !== driver_phone) return res.status(403).json({ error: 'This ride does not belong to you' });
    if (!ride.is_parcel || ride.status !== 'started') return res.status(400).json({ error: 'Only an in-progress delivery can be flagged' });
    if (ride.return_status === 'pending_decision' || ride.return_status === 'accepted')
      return res.status(400).json({ error: 'Already waiting on the sender for this' });

    await db.query(
      "UPDATE rides SET return_status='pending_decision', delivery_fail_reason=$1 WHERE id=$2",
      [(reason || '').trim() || null, ride_id]
    );
    // /api/rides/status/:id serves from Redis whenever a ride is 'started'
    // (which a parcel stays throughout this entire RTO sub-flow) — without
    // this, the very next poll/resync after the socket event below would
    // hand the client a stale pre-flag copy and stomp return_status back to
    // null within about a second, making the just-shown decision window
    // vanish. transitionRide() does this automatically for real status
    // changes; this raw UPDATE needs it done explicitly since return_status
    // is a sub-field, not a status transition.
    await clearRide(ride_id).catch(() => {});

    emitToRoom('ride_' + ride_id, 'returnDecisionNeeded', { ride_id, reason: reason || null });
    sendFCM(ride.passenger_phone, '⚠️ Delivery Issue', `Your delivery partner couldn't reach ${ride.receiver_name || 'the receiver'}. Tap to decide what happens next.`, { type: 'return_decision_needed', ride_id: String(ride_id) }, { role: 'customer' }).catch(() => {});

    res.json({ success: true, message: "Waiting for the sender's decision..." });
  } catch (err) { console.error('[parcel] flag-non-delivery', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// ── POST /api/parcel/return-decision — sender decides whether to get the
//    package back after a flagged delivery failure. ─────────────────────────
router.post('/return-decision', userAuth, async (req, res) => {
  const { ride_id, decision } = req.body;
  if (!['retry', 'return'].includes(decision)) return res.status(400).json({ error: "decision must be 'retry' or 'return'" });
  try {
    const r = await db.query(
      `SELECT r.*, p.phone AS passenger_phone, u.phone AS driver_phone
       FROM rides r LEFT JOIN users p ON r.passenger_id = p.id LEFT JOIN users u ON r.driver_id = u.id
       WHERE r.id = $1`, [ride_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    const ride = r.rows[0];
    if (ride.passenger_phone !== req.user.phone) return res.status(403).json({ error: 'This ride is not yours' });
    if (ride.return_status !== 'pending_decision') return res.status(400).json({ error: 'Nothing is waiting on your decision right now' });

    if (decision === 'retry') {
      await db.query("UPDATE rides SET return_status=NULL WHERE id=$1", [ride_id]);
      await clearRide(ride_id).catch(() => {}); // see the comment in /flag-non-delivery above
      emitToRoom('ride_' + ride_id, 'returnDecisionMade', { ride_id, decision: 'retry' });
      sendFCM(ride.driver_phone, '🔁 Try Again', 'The sender wants you to try reaching the receiver again.', { type: 'return_decision_made', ride_id: String(ride_id) }, { role: 'driver' }).catch(() => {});
      return res.json({ success: true, decision: 'retry' });
    }

    const returnOtp = Math.floor(1000 + Math.random() * 9000).toString();
    await db.query("UPDATE rides SET return_status='accepted', return_otp=$1 WHERE id=$2", [returnOtp, ride_id]);
    await clearRide(ride_id).catch(() => {}); // see the comment in /flag-non-delivery above
    emitToRoom('ride_' + ride_id, 'returnDecisionMade', {
      ride_id, decision: 'return',
      pickup: ride.pickup, pickup_lat: ride.pickup_lat, pickup_lng: ride.pickup_lng,
    });
    sendFCM(ride.driver_phone, '🔄 Return the Package', 'The sender wants the package back — head back to the pickup location.', { type: 'return_decision_made', ride_id: String(ride_id) }, { role: 'driver' }).catch(() => {});

    res.json({ success: true, decision: 'return', return_otp: returnOtp });
  } catch (err) { console.error('[parcel] return-decision', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// ── POST /api/parcel/confirm-return — driver hands the package back to the
//    sender; sender's return_otp proves it. Settles payment: a handling fee
//    (PARCEL_RETURN_FEE_PCT of the fare) is kept and paid to the driver in
//    full (compensation for the wasted attempt + return trip, no commission
//    taken on it), the rest is refunded to the sender. Mirrors /cancel-smart's
//    charge-a-fee-refund-the-rest shape, reusing refundToWallet/
//    creditDriverWallet from services/advance.js. ────────────────────────────
router.post('/confirm-return', userAuth, async (req, res) => {
  const { ride_id, driver_phone, return_otp } = req.body;
  if (req.user.phone !== String(driver_phone)) return res.status(403).json({ error: 'You can only act as yourself' });
  try {
    const r = await db.query(
      `SELECT r.*, p.phone AS passenger_phone, u.phone AS driver_phone
       FROM rides r LEFT JOIN users p ON r.passenger_id = p.id LEFT JOIN users u ON r.driver_id = u.id
       WHERE r.id = $1`, [ride_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    const ride = r.rows[0];
    if (ride.driver_phone !== driver_phone) return res.status(403).json({ error: 'This ride does not belong to you' });
    if (ride.return_status !== 'accepted') return res.status(400).json({ error: 'Return was not confirmed by the sender' });
    if (ride.return_otp !== return_otp) return res.status(400).json({ error: 'Incorrect return OTP!' });

    const fare      = parseFloat(ride.fare || 0);
    const returnFee = Math.round(fare * PARCEL_RETURN_FEE_PCT);
    const refund    = Math.max(0, fare - returnFee);

    await transitionRide(ride_id, 'completed', {
      extraFields: {
        return_status: 'returned', payment_status: 'completed',
        commission_amount: 0, commission_status: 'waived_return', return_fee: returnFee,
      },
      socketData: { fare: 0, discount: 0, return_status: 'returned' },
      custPhone: ride.passenger_phone, drvPhone: ride.driver_phone, skipFCM: true,
    });

    // Both credits atomic with each other (both land or neither does) — the
    // previous version ran these unguarded and swallowed any failure, so a
    // mid-way DB error could silently short the sender's refund or the
    // driver's compensation while the API still reported success:true to
    // both apps. transitionRide() above has already marked the ride
    // returned/completed regardless (the physical handoff genuinely
    // happened), but the money movement itself now either fully succeeds or
    // is loudly logged for manual follow-up — never silently half-done.
    let settlementOk = true;
    if (refund > 0 || returnFee > 0) {
      const sClient = await db.connect();
      try {
        await sClient.query('BEGIN');
        if (refund > 0)    await refundToWallet(sClient, ride.passenger_phone, refund, ride_id, 'Parcel returned — refund');
        if (returnFee > 0) await creditDriverWallet(sClient, ride.driver_phone, returnFee, 'Parcel return compensation');
        await sClient.query('COMMIT');
      } catch (e) {
        await sClient.query('ROLLBACK').catch(() => {});
        settlementOk = false;
        console.error(`[parcel] confirm-return settlement FAILED for ride ${ride_id} — refund ₹${refund} to ${ride.passenger_phone} and compensation ₹${returnFee} to ${ride.driver_phone} did NOT land, needs manual admin follow-up:`, e.message);
      } finally { sClient.release(); }
    }

    if (settlementOk) {
      sendFCM(ride.passenger_phone, '📦 Package Returned', `Your package is back with you. ₹${refund} refunded to your wallet.`, { type: 'trip_completed', ride_id: String(ride_id) }, { role: 'customer' }).catch(() => {});
      sendFCM(ride.driver_phone, '✅ Return Confirmed', `₹${returnFee} credited to your wallet for the return trip.`, { type: 'earning_credited', amount: String(returnFee) }, { role: 'driver' }).catch(() => {});
    } else {
      sendFCM(ride.passenger_phone, '📦 Package Returned', `Your package is back with you. Your refund is being processed — contact support if it doesn't appear soon.`, { type: 'trip_completed', ride_id: String(ride_id) }, { role: 'customer' }).catch(() => {});
      sendFCM(ride.driver_phone, '✅ Return Confirmed', `Your compensation is being processed — contact support if it doesn't appear soon.`, { type: 'earning_credited', amount: String(returnFee) }, { role: 'driver' }).catch(() => {});
    }

    res.json({ success: true, refund, return_fee: returnFee, earned: returnFee, commission_amount: 0, settlement_pending: !settlementOk });
  } catch (err) { console.error('[parcel] confirm-return', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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

// ════════════════════════════════════════════════
//  ROUTE BATCHING — two nearby, compatible parcels combined into one driver
//  trip. See services/parcelBatching.js for the matching/sequencing logic;
//  everything here is thin endpoint plumbing around it. Deliberately does
//  NOT duplicate /arrived, /start, or /complete — the driver app calls those
//  exact existing endpoints per-stop, scoped to that stop's own ride_id.
// ════════════════════════════════════════════════

// ── POST /api/parcel/batch-accept — driver accepts a combined 2-parcel offer ──
router.post('/batch-accept', userAuth, async (req, res) => {
  const { batch_id, driver_phone } = req.body;
  if (req.user.phone !== String(driver_phone)) return res.status(403).json({ error: 'You can only act as yourself' });
  if (!batch_id) return res.status(400).json({ error: 'batch_id required' });
  const result = await acceptBatch(batch_id, driver_phone);
  if (!result.success) return res.status(400).json(result);
  res.json(result);
});

// ── GET /api/parcel/batch/active?phone=X — driver's current batch + ordered
//    stop sequence, each stop carrying its ride's full detail so the driver
//    app doesn't need a second round-trip per stop. ─────────────────────────
router.get('/batch/active', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const b = await db.query(
      `SELECT rb.* FROM ride_batches rb JOIN users u ON rb.driver_id = u.id
       WHERE u.phone=$1 AND rb.status='matched'
         AND EXISTS (SELECT 1 FROM rides r WHERE r.batch_id = rb.id AND r.status NOT IN ('completed','cancelled'))
       ORDER BY rb.matched_at DESC LIMIT 1`,
      [phone]
    );
    if (!b.rows[0]) return res.json({ batch: null, stops: [] });
    const batch = b.rows[0];

    // r.* (the full row, not cherry-picked fields) so each stop's `ride`
    // object is exactly the same shape the driver app already gets from
    // GET /api/driver/active-ride for a normal single ride — pickup_lat/lng
    // AND drop_lat/lng both present (not just this stop's own lat/lng),
    // driver-facing fields, everything. That shape-compatibility is what
    // lets the app feed a batch's current-stop ride straight into its
    // existing single-ride UI with zero changes to that UI's own code.
    const stopsRes = await db.query(
      `SELECT bs.stop_type, bs.sequence_order, bs.lat AS stop_lat, bs.lng AS stop_lng, bs.address AS stop_address,
              r.*
       FROM batch_stops bs JOIN rides r ON bs.ride_id = r.id
       WHERE bs.batch_id=$1 ORDER BY bs.sequence_order ASC`,
      [batch.id]
    );

    const stops = stopsRes.rows.map(s => ({
      ...s,
      ride_id: s.id, ride_status: s.status,
      // Derived, not stored — a pickup stop is "done" once its ride has
      // actually started (arrived + start-OTP both happened); a drop stop is
      // "done" once its ride is completed. Deriving from rides.status (which
      // the existing /arrived, /start, /complete already update correctly)
      // instead of a separately-tracked batch_stops.status avoids a second
      // source of truth that could drift out of sync.
      // 'cancelled' also counts as done (i.e. skippable) — if the driver
      // cancels one leg of a batch mid-trip, that leg's stops must stop
      // blocking the sequence rather than sit "not done" forever, so the
      // driver can still reach the OTHER leg's remaining stop(s) normally.
      done: s.stop_type === 'pickup' ? ['started', 'completed', 'cancelled'].includes(s.status) : ['completed', 'cancelled'].includes(s.status),
    }));

    res.json({ batch: { id: batch.id, status: batch.status }, stops });
  } catch (err) { console.error('[parcel] batch/active', err.message); res.status(500).json({ error: 'Something went wrong' }); }
});

// ── POST /api/parcel/batch-stop-complete — informational nudge only. Called
//    by the driver app right after it completes a stop via the real,
//    unchanged /arrived, /start, or /complete endpoints, so any batch-mate
//    still waiting on their own pickup gets a live "N stops before you"
//    update instead of a stale count from match time. Never gates or
//    verifies anything — the actual state change already happened. ────────
router.post('/batch-stop-complete', async (req, res) => {
  const { ride_id } = req.body;
  try {
    const rideRes = await db.query(`SELECT batch_id FROM rides WHERE id=$1`, [ride_id]);
    const batchId = rideRes.rows[0]?.batch_id;
    if (!batchId) return res.json({ success: true });

    const stopsRes = await db.query(
      `SELECT bs.sequence_order, bs.stop_type, bs.ride_id, r.status AS ride_status
       FROM batch_stops bs JOIN rides r ON bs.ride_id = r.id
       WHERE bs.batch_id=$1 ORDER BY bs.sequence_order ASC`,
      [batchId]
    );
    const stops = stopsRes.rows;
    const isDone = s => s.stop_type === 'pickup' ? ['started', 'completed', 'cancelled'].includes(s.ride_status) : ['completed', 'cancelled'].includes(s.ride_status);

    // The customer app's rideUpdate handler only merges batched/
    // stops_before_pickup into rideData on the branch gated by `data.driver`
    // being present (see AppContext.tsx) — the no-driver branch re-fetches
    // from /api/rides/status/:id instead, which doesn't carry these
    // request-time-computed fields at all. So this nudge must include
    // driver info too, or it'd silently take that other branch and never
    // actually update the "stops before you" count. Driver is the same
    // across the whole batch, so fetch it once.
    const driverRes = await db.query(
      `SELECT rb.driver_id, u.name, d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.rating, d.upi_id
       FROM ride_batches rb JOIN users u ON rb.driver_id = u.id JOIN drivers d ON d.id = u.id
       WHERE rb.id=$1`,
      [batchId]
    );
    const di = driverRes.rows[0];
    const driverCard = di ? { name: di.name, vehicle_no: di.vehicle_no, vehicle_brand: di.vehicle_brand, vehicle_model: di.vehicle_model, rating: parseFloat(di.rating) || 5.0, upi_id: di.upi_id || null } : null;

    for (const s of stops) {
      if (s.stop_type !== 'pickup' || s.ride_status !== 'matched') continue; // only nudge riders still waiting on their own pickup
      const stopsBeforeMine = stops.filter(x => x.sequence_order < s.sequence_order && !isDone(x)).length;
      emitToRoom('ride_' + s.ride_id, 'rideUpdate', {
        rideId: s.ride_id, status: 'matched', driver: driverCard, batched: true, stops_before_pickup: stopsBeforeMine,
        message: stopsBeforeMine > 0 ? `Driver matched — ${stopsBeforeMine} more stop before reaching you` : 'Driver is on the way to you now!',
      });
    }
    res.json({ success: true });
  } catch (err) { console.error('[parcel] batch-stop-complete', err.message); res.json({ success: true }); }
});

module.exports = router;
