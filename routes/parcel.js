'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { PARCEL_FARES, PARCEL_SIZE_SURCHARGE, PARCEL_RETURN_FEE_PCT, calculateParcelFare } = require('../services/pricing');
const { haversineKm } = require('../services/matching');
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
// Paid-return model: the sender is quoted a real fare for the drop→pickup leg
// and must actually pay it before the driver is told to bring the package
// back. That money is held (escrowed) exactly like the original parcel fare
// and released to the driver on the return handover, so a return trip is a
// second paid job rather than a 50% haircut on the first one.
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS return_fare NUMERIC').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS return_payment_status TEXT').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS return_requested_at TIMESTAMPTZ').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS disposed_at TIMESTAMPTZ').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS return_payment_method TEXT').catch(() => {});

// How long the sender gets to respond (retry / pay for a return) before the
// driver is allowed to stop being an unpaid warehouse and dispose of the
// package. The driver is still paid for the outbound trip in that case.
const RETURN_DECISION_TIMEOUT_HOURS = 24;

// ⚠️  Paid returns change what /return-decision does: instead of confirming
// the return outright, it parks the ride in 'awaiting_payment' until the
// sender pays via /return-pay. The installed customer builds have no
// pay-for-return screen (no OTA — see the pending-native-rebuild memory), so
// with this on and the apps un-rebuilt a sender could ask for a return and
// then have no way to complete it: the driver is never sent back and the
// package sits until the 24h dispose window. Off until both apps ship the UI.
// /confirm-return handles both models regardless of this flag, so returns
// already in flight when it's flipped still settle correctly.
const PAID_RETURN_ENABLED = process.env.PARCEL_PAID_RETURN === 'on';

// ── Return leg fare — a real quote for driving drop→pickup, priced through
//    the same engine as the outbound trip (not a % of the original), so a
//    receiver who turned out to be far away doesn't leave the driver
//    underpaid for a long drive back. ────────────────────────────────────────
function computeReturnFare(ride) {
  const cfg = PARCEL_FARES[ride.ride_type];
  const haveCoords = ride.drop_lat != null && ride.drop_lng != null
                  && ride.pickup_lat != null && ride.pickup_lng != null;
  if (!cfg || !haveCoords) {
    // No usable coords/config — fall back to charging the same as the
    // outbound leg, which is the closest honest approximation of "drive that
    // same distance again" and never quotes ₹0 by accident.
    return Math.max(0, Math.round(parseFloat(ride.fare || 0)));
  }
  const distKm = haversineKm(
    parseFloat(ride.drop_lat), parseFloat(ride.drop_lng),
    parseFloat(ride.pickup_lat), parseFloat(ride.pickup_lng)
  );
  return calculateParcelFare(cfg, distKm, ride.package_size || 'small').fare;
}

// ── Platform commission for one parcel leg — mirrors completeRidePayment()'s
//    model in routes/rides.js (fare_settings.commission_rate by vehicle type,
//    default 15%) so return legs are charged on the same basis as every other
//    completed job, rather than inventing a second commission scheme. ────────
async function parcelCommission(rideType, amount) {
  if (!(amount > 0)) return 0;
  try {
    const fs = await db.query('SELECT commission_rate FROM fare_settings WHERE vehicle_type=$1', [rideType]);
    const rate = parseFloat(fs.rows[0]?.commission_rate ?? 15) / 100;
    return Math.round(amount * rate * 100) / 100;
  } catch { return Math.round(amount * 0.15 * 100) / 100; }
}

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

    // Quote the return leg now and store it, so the sender is shown a firm
    // price with the decision instead of agreeing to an open-ended charge,
    // and so the amount can't drift between the quote and the payment.
    const returnFare = computeReturnFare(ride);
    await db.query(
      `UPDATE rides SET return_status='pending_decision', delivery_fail_reason=$1,
              return_fare=$2, return_requested_at=NOW() WHERE id=$3`,
      [(reason || '').trim() || null, returnFare, ride_id]
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

    emitToRoom('ride_' + ride_id, 'returnDecisionNeeded', {
      ride_id, reason: reason || null,
      return_fare: returnFare,
      decision_deadline_hours: RETURN_DECISION_TIMEOUT_HOURS,
    });
    sendFCM(ride.passenger_phone, '⚠️ Delivery Issue', `Your delivery partner couldn't reach ${ride.receiver_name || 'the receiver'}. Tap to choose: try again, or get it back for ₹${returnFare}.`, { type: 'return_decision_needed', ride_id: String(ride_id) }, { role: 'customer' }).catch(() => {});

    res.json({ success: true, message: "Waiting for the sender's decision...", return_fare: returnFare });
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

    // 'return' is now an INTENT, not a commitment. The driver is not sent back
    // until the sender has actually paid for the return leg (/return-pay) —
    // otherwise the driver eats an unpaid second trip, which is exactly the
    // problem this flow exists to fix. No return_otp is minted yet either:
    // the OTP is what authorises the handover, so it must not exist before
    // the trip it belongs to has been paid for.
    const returnFare = ride.return_fare != null ? Math.round(parseFloat(ride.return_fare)) : computeReturnFare(ride);

    if (!PAID_RETURN_ENABLED) {
      // Legacy behaviour — confirm the return immediately and mint the OTP,
      // exactly as before paid returns existed. /confirm-return detects the
      // absent escrow and settles on the old 50/50 terms.
      const legacyOtp = Math.floor(1000 + Math.random() * 9000).toString();
      await db.query("UPDATE rides SET return_status='accepted', return_otp=$1 WHERE id=$2", [legacyOtp, ride_id]);
      await clearRide(ride_id).catch(() => {});
      emitToRoom('ride_' + ride_id, 'returnDecisionMade', {
        ride_id, decision: 'return',
        pickup: ride.pickup, pickup_lat: ride.pickup_lat, pickup_lng: ride.pickup_lng,
      });
      sendFCM(ride.driver_phone, '🔄 Return the Package', 'The sender wants the package back — head back to the pickup location.', { type: 'return_decision_made', ride_id: String(ride_id) }, { role: 'driver' }).catch(() => {});
      return res.json({ success: true, decision: 'return', return_otp: legacyOtp });
    }

    await db.query("UPDATE rides SET return_status='awaiting_payment', return_fare=$1, return_payment_status='pending' WHERE id=$2", [returnFare, ride_id]);
    await clearRide(ride_id).catch(() => {}); // see the comment in /flag-non-delivery above
    emitToRoom('ride_' + ride_id, 'returnDecisionMade', {
      ride_id, decision: 'return', return_status: 'awaiting_payment',
      return_fare: returnFare,
      pickup: ride.pickup, pickup_lat: ride.pickup_lat, pickup_lng: ride.pickup_lng,
    });
    sendFCM(ride.driver_phone, '🔄 Return Requested', `The sender wants the package back and is paying ₹${returnFare} for the return trip. Hold on — you'll get the go-ahead once payment clears.`, { type: 'return_decision_made', ride_id: String(ride_id) }, { role: 'driver' }).catch(() => {});

    res.json({ success: true, decision: 'return', return_status: 'awaiting_payment', return_fare: returnFare, message: `Pay ₹${returnFare} to have your package brought back.` });
  } catch (err) { console.error('[parcel] return-decision', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// ── POST /api/parcel/return-pay — sender pays for the return leg. Only once
//    this succeeds is the driver actually sent back and a return OTP minted.
//    Money is HELD (escrowed) here, not paid out — it's released to the driver
//    at /confirm-return, mirroring how the original parcel fare works, so a
//    driver who never completes the return doesn't keep the money. ───────────
router.post('/return-pay', userAuth, async (req, res) => {
  const { ride_id, payment_method, payment } = req.body;
  try {
    const r = await db.query(
      `SELECT r.*, p.phone AS passenger_phone, p.id AS passenger_uid, u.phone AS driver_phone
       FROM rides r LEFT JOIN users p ON r.passenger_id = p.id LEFT JOIN users u ON r.driver_id = u.id
       WHERE r.id = $1`, [ride_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    const ride = r.rows[0];
    if (ride.passenger_phone !== req.user.phone) return res.status(403).json({ error: 'This ride is not yours' });

    // Idempotent: a double-tap or a retry after a flaky response must not
    // charge twice. Return the existing state instead of re-billing.
    if (ride.return_payment_status === 'escrowed' || ride.return_status === 'accepted')
      return res.json({ success: true, already_paid: true, return_status: ride.return_status, return_otp: ride.return_otp, return_fare: Math.round(parseFloat(ride.return_fare || 0)) });

    if (ride.return_status !== 'awaiting_payment')
      return res.status(400).json({ error: 'This delivery is not waiting on a return payment' });

    const amount = Math.round(parseFloat(ride.return_fare || 0));
    if (!(amount > 0)) return res.status(400).json({ error: 'Return fare not available — please contact support' });

    // ── Collect the money ────────────────────────────────────────────────────
    if (payment_method === 'wallet') {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [ride.passenger_uid]);
        // Conditional debit — the balance check and the deduction are the same
        // statement, so two concurrent requests can't both pass a "do they have
        // enough?" read and overdraw the wallet.
        const deb = await client.query(
          'UPDATE customer_wallet SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2 AND balance >= $1 RETURNING balance',
          [amount, ride.passenger_uid]
        );
        if (!deb.rows[0]) {
          await client.query('ROLLBACK');
          return res.status(402).json({ error: 'Not enough wallet balance', required: amount });
        }
        await client.query(
          "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,$3)",
          [ride.passenger_uid, amount, `Parcel return trip (ride ${ride_id})`]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[parcel] return-pay wallet debit failed:', e.message);
        return res.status(500).json({ error: 'Payment failed — please try again' });
      } finally { client.release(); }
    } else {
      const v = await verifyOnlinePayment({ order_id: payment?.order_id, payment_id: payment?.payment_id, signature: payment?.signature });
      if (!v.ok || Math.round(v.amount) < amount)
        return res.status(402).json({ error: v.error || 'Payment verification failed' });
    }

    // ── Money is in. NOW authorise the return trip. ──────────────────────────
    const returnOtp = Math.floor(1000 + Math.random() * 9000).toString();
    await db.query(
      "UPDATE rides SET return_status='accepted', return_payment_status='escrowed', return_otp=$1, return_payment_method=$2 WHERE id=$3",
      [returnOtp, payment_method === 'wallet' ? 'wallet' : 'online', ride_id]
    );
    await clearRide(ride_id).catch(() => {}); // see the comment in /flag-non-delivery above

    emitToRoom('ride_' + ride_id, 'returnDecisionMade', {
      ride_id, decision: 'return', return_status: 'accepted', return_paid: true,
      pickup: ride.pickup, pickup_lat: ride.pickup_lat, pickup_lng: ride.pickup_lng,
    });
    sendFCM(ride.driver_phone, '🔄 Return the Package',
      `Paid — ₹${amount} for the return trip. Head back to the pickup point and hand it over with the sender's return OTP.`,
      { type: 'return_decision_made', ride_id: String(ride_id) }, { role: 'driver' }).catch(() => {});

    res.json({ success: true, return_status: 'accepted', return_fare: amount, return_otp: returnOtp });
  } catch (err) { console.error('[parcel] return-pay', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// ── POST /api/parcel/confirm-return — driver hands the package back to the
//    sender; sender's return_otp proves it. Releases BOTH escrows to the
//    driver: the outbound fare (that trip was genuinely performed, so there's
//    no refund) plus the return fare the sender paid at /return-pay, each
//    minus normal platform commission. Requires return_payment_status
//    ='escrowed' — the driver is never sent back, and this can never settle,
//    on an unpaid return.
//
//    Replaces the original model where the driver received
//    PARCEL_RETURN_FEE_PCT (50%) of a single fare for what is really two
//    trips, with the other 50% refunded to the sender. ────────────────────────
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

    // A return that was authorised under the OLD rules (sender approved it
    // before paid returns existed, so no fare was ever quoted or charged) must
    // still be settleable. Otherwise every return already in flight at deploy
    // time becomes permanently stuck: package physically handed back, money
    // frozen, no endpoint willing to close it. Those settle on the old terms;
    // only returns that actually went through /return-pay use the two-leg
    // model. New-flow rides can never reach here unpaid — /return-pay is the
    // only thing that sets return_status='accepted', and it always escrows in
    // the same statement.
    const isPaidReturn = ride.return_payment_status === 'escrowed';

    let outboundFare, returnFare, commissionTotal, driverEarns, legacyRefund = 0;
    if (isPaidReturn) {
      // Two separate paid legs, both already escrowed:
      //   outbound — the driver drove to the receiver and genuinely did that
      //              work, so it is earned in full (sender gets no refund).
      //   return   — a second real trip the sender explicitly paid for.
      // Platform commission applies to both, on the same basis as any other
      // completed job (see parcelCommission).
      outboundFare = Math.max(0, parseFloat(ride.fare || 0) - parseFloat(ride.discount || 0));
      returnFare   = Math.round(parseFloat(ride.return_fare || 0));
      const outCommission = await parcelCommission(ride.ride_type, outboundFare);
      const retCommission = await parcelCommission(ride.ride_type, returnFare);
      commissionTotal = Math.round((outCommission + retCommission) * 100) / 100;
      driverEarns = Math.max(0, Math.round((outboundFare + returnFare - commissionTotal) * 100) / 100);
    } else {
      // Legacy terms: PARCEL_RETURN_FEE_PCT of the single original fare to the
      // driver, commission waived, remainder refunded to the sender.
      const fare = parseFloat(ride.fare || 0);
      outboundFare    = fare;
      returnFare      = Math.round(fare * PARCEL_RETURN_FEE_PCT);
      legacyRefund    = Math.max(0, fare - returnFare);
      commissionTotal = 0;
      driverEarns     = returnFare;
    }

    await transitionRide(ride_id, 'completed', {
      extraFields: {
        return_status: 'returned', payment_status: 'completed',
        ...(isPaidReturn ? { return_payment_status: 'released' } : {}),
        commission_amount: commissionTotal,
        commission_status: isPaidReturn ? 'pending' : 'waived_return',
        return_fee: returnFare,
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
    if (driverEarns > 0 || legacyRefund > 0) {
      const sClient = await db.connect();
      try {
        await sClient.query('BEGIN');
        if (legacyRefund > 0) await refundToWallet(sClient, ride.passenger_phone, legacyRefund, ride_id, 'Parcel returned — refund');
        if (driverEarns > 0) {
          await creditDriverWallet(sClient, ride.driver_phone, driverEarns,
            isPaidReturn ? `Parcel delivery attempt + return trip (ride ${ride_id})` : 'Parcel return compensation');
          if (commissionTotal > 0) {
            await sClient.query(
              `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
               VALUES ($1,$2,$3,$4,'online','paid') ON CONFLICT (ride_id) DO NOTHING`,
              [ride.driver_phone, ride_id, outboundFare + returnFare, commissionTotal]
            );
          }
        }
        await sClient.query('COMMIT');
      } catch (e) {
        await sClient.query('ROLLBACK').catch(() => {});
        settlementOk = false;
        console.error(`[parcel] confirm-return settlement FAILED for ride ${ride_id} — driver payout ₹${driverEarns} to ${ride.driver_phone}${legacyRefund > 0 ? ` and refund ₹${legacyRefund} to ${ride.passenger_phone}` : ''} did NOT land, needs manual admin follow-up:`, e.message);
      } finally { sClient.release(); }
    }

    const custMsg = !settlementOk
      ? 'Your package is back with you.'
      : isPaidReturn
        ? `Your package is back with you. Return trip charge: ₹${returnFare}.`
        : `Your package is back with you. ₹${legacyRefund} refunded to your wallet.`;
    const drvMsg = !settlementOk
      ? "Your earnings are being processed — contact support if they don't appear soon."
      : isPaidReturn
        ? `₹${driverEarns} credited — delivery attempt + return trip, both paid.`
        : `₹${driverEarns} credited to your wallet for the return trip.`;
    sendFCM(ride.passenger_phone, '📦 Package Returned', custMsg, { type: 'trip_completed', ride_id: String(ride_id) }, { role: 'customer' }).catch(() => {});
    sendFCM(ride.driver_phone, '✅ Return Confirmed', drvMsg, { type: 'earning_credited', amount: String(driverEarns) }, { role: 'driver' }).catch(() => {});

    res.json({ success: true, refund: legacyRefund, outbound_fare: outboundFare, return_fare: returnFare, earned: driverEarns, commission_amount: commissionTotal, paid_return: isPaidReturn, settlement_pending: !settlementOk });
  } catch (err) { console.error('[parcel] confirm-return', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// ── POST /api/parcel/dispose — the sender never responded (no retry, no
//    return payment) within the decision window. Without this the driver is
//    stuck holding someone else's package indefinitely with the ride pinned
//    open in 'started', unable to take any other job. The outbound trip was
//    genuinely performed, so it is paid in full (minus commission).
//    Deliberately NOT available once return_status='accepted' — at that point
//    the sender HAS paid for a return, and the package must come back or go
//    to dispute, never be disposed of. ───────────────────────────────────────
router.post('/dispose', userAuth, async (req, res) => {
  const { ride_id, driver_phone, note } = req.body;
  if (req.user.phone !== String(driver_phone)) return res.status(403).json({ error: 'You can only act as yourself' });
  try {
    const r = await db.query(
      `SELECT r.*, p.phone AS passenger_phone, u.phone AS driver_phone,
              EXTRACT(EPOCH FROM (NOW() - r.return_requested_at))/3600 AS hours_waited
       FROM rides r LEFT JOIN users p ON r.passenger_id = p.id LEFT JOIN users u ON r.driver_id = u.id
       WHERE r.id = $1`, [ride_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    const ride = r.rows[0];
    if (ride.driver_phone !== driver_phone) return res.status(403).json({ error: 'This ride does not belong to you' });
    if (!ride.is_parcel || ride.status !== 'started') return res.status(400).json({ error: 'Only an in-progress delivery can be closed this way' });
    if (!['pending_decision', 'awaiting_payment'].includes(ride.return_status))
      return res.status(400).json({ error: 'This delivery is not waiting on the sender' });

    const waited = parseFloat(ride.hours_waited || 0);
    if (!(waited >= RETURN_DECISION_TIMEOUT_HOURS))
      return res.status(400).json({
        error: `You can close this after ${RETURN_DECISION_TIMEOUT_HOURS}h of no response from the sender.`,
        hours_waited: Math.floor(waited), hours_required: RETURN_DECISION_TIMEOUT_HOURS,
      });

    const outboundFare  = Math.max(0, parseFloat(ride.fare || 0) - parseFloat(ride.discount || 0));
    const commission    = await parcelCommission(ride.ride_type, outboundFare);
    const driverEarns   = Math.max(0, Math.round((outboundFare - commission) * 100) / 100);

    await transitionRide(ride_id, 'completed', {
      extraFields: {
        return_status: 'disposed', payment_status: 'completed',
        disposed_at: new Date(), delivery_fail_reason: (note || '').trim() || ride.delivery_fail_reason,
        commission_amount: commission, commission_status: 'pending',
      },
      socketData: { fare: 0, discount: 0, return_status: 'disposed' },
      custPhone: ride.passenger_phone, drvPhone: ride.driver_phone, skipFCM: true,
    });

    let settlementOk = true;
    if (driverEarns > 0) {
      const sClient = await db.connect();
      try {
        await sClient.query('BEGIN');
        await creditDriverWallet(sClient, ride.driver_phone, driverEarns, `Parcel delivery attempt — sender unreachable (ride ${ride_id})`);
        await sClient.query(
          `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
           VALUES ($1,$2,$3,$4,'online','paid') ON CONFLICT (ride_id) DO NOTHING`,
          [ride.driver_phone, ride_id, outboundFare, commission]
        );
        await sClient.query('COMMIT');
      } catch (e) {
        await sClient.query('ROLLBACK').catch(() => {});
        settlementOk = false;
        console.error(`[parcel] dispose settlement FAILED for ride ${ride_id} — payout ₹${driverEarns} to ${ride.driver_phone} did NOT land:`, e.message);
      } finally { sClient.release(); }
    }

    emitToRoom('ride_' + ride_id, 'rideUpdate', { rideId: ride_id, status: 'completed', return_status: 'disposed' });
    sendFCM(ride.passenger_phone, '📦 Delivery Closed',
      `You didn't respond within ${RETURN_DECISION_TIMEOUT_HOURS} hours, so your package could not be held any longer. Contact support if you believe this is wrong.`,
      { type: 'trip_completed', ride_id: String(ride_id) }, { role: 'customer' }).catch(() => {});

    const adminPhone = process.env.ADMIN_ALERT_PHONE;
    if (adminPhone) sendFCM(adminPhone, '📦 Parcel Disposed', `Ride ${ride_id}: sender unresponsive ${Math.floor(waited)}h, driver closed the trip.`, { type: 'health_alert', ride_id: String(ride_id) }, {}).catch(() => {});

    res.json({ success: true, earned: driverEarns, commission_amount: commission, settlement_pending: !settlementOk });
  } catch (err) { console.error('[parcel] dispose', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
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
    // Reportable while the delivery is still in progress, not only after it's
    // marked complete. A driver who is deliberately sitting on a package never
    // completes the ride, so a completed-only check made this unusable in
    // exactly the case it exists for.
    if (!['started', 'completed'].includes(ride.status))
      return res.status(400).json({ error: 'This delivery cannot be reported yet' });

    const existing = await db.query("SELECT id FROM ride_disputes WHERE ride_id=$1 AND status='pending'", [String(ride_id)]);
    if (existing.rows[0]) return res.status(400).json({ error: 'This delivery is already under review' });

    // Snapshot where the driver (and therefore the package) was at the moment
    // of the report. driver_locations only holds a CURRENT position per phone
    // and is overwritten continuously, so without capturing it here the
    // evidence is gone by the time an admin opens the case.
    let dLat = null, dLng = null, dSeen = null;
    try {
      const loc = await db.query('SELECT lat, lng, updated_at FROM driver_locations WHERE phone=$1', [ride.driver_phone]);
      if (loc.rows[0]) { dLat = loc.rows[0].lat; dLng = loc.rows[0].lng; dSeen = loc.rows[0].updated_at; }
    } catch { /* evidence is best-effort — never block the report itself */ }

    await db.query(
      `INSERT INTO ride_disputes (ride_id, customer_phone, driver_phone, reason, held_advance, fare, status, dispute_type,
                                  driver_lat, driver_lng, driver_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10)`,
      [String(ride_id), ride.passenger_phone, ride.driver_phone, reason || '',
       parseFloat(ride.fare || 0), parseFloat(ride.fare || 0),
       ride.status === 'completed' ? 'parcel_not_delivered' : 'parcel_withheld',
       dLat, dLng, dSeen]
    );

    // For a still-running delivery the money is still escrowed, so freeze it:
    // the driver must not be able to collect by completing the ride while the
    // complaint is open. Admin adjudication (routes/admin.js) decides whether
    // it's released or refunded. Deliberately NOT an automatic refund — that
    // would let a false report cost an honest driver a job they're mid-way
    // through.
    if (ride.status === 'started') {
      await db.query("UPDATE rides SET payment_status='disputed' WHERE id=$1 AND payment_status='escrowed'", [ride_id]);
      await clearRide(ride_id).catch(() => {});
      sendFCM(ride.driver_phone, '⚠️ Delivery Reported',
        'The sender has raised a complaint about this delivery. Our team is reviewing it — deliver the package or contact support immediately.',
        { type: 'ride_disputed', ride_id: String(ride_id) }, { role: 'driver' }).catch(() => {});
    }

    const adminPhone = process.env.ADMIN_ALERT_PHONE;
    if (adminPhone) sendFCM(adminPhone, '🚨 Parcel Report', `Ride ${ride_id} (${ride.status}): ${reason || 'N/A'}. Review in admin.`, { type: 'health_alert', ride_id: String(ride_id) }, {}).catch(() => {});

    // The sender is entitled to know where their package is — hand back the
    // driver's last known position with the report confirmation.
    res.json({
      success: true,
      message: 'Your report is under review — our team will get back to you.',
      escrow_frozen: ride.status === 'started',
      driver_last_location: (dLat != null && dLng != null) ? { lat: parseFloat(dLat), lng: parseFloat(dLng), seen_at: dSeen } : null,
    });
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
