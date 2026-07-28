'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { PARCEL_FARES, calculateParcelFare } = require('../services/pricing');
const { assignRideToNextDriver } = require('../workers/rideWorker');
const userAuth = require('../middleware/userAuth');

// Package size gates which vehicle types can carry it — enforced here too,
// not just client-side, same "never trust the client" rule the rest of the
// booking endpoints follow.
const SIZE_VEHICLES = {
  small:  ['bike', 'green_bike', 'auto', 'eriksha', 'electric_auto', 'car'],
  medium: ['auto', 'eriksha', 'electric_auto', 'car'],
  large:  ['car'],
};

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

// ── POST /api/parcel/book ──────────────────────────────────────────────────
router.post('/book', userAuth, async (req, res) => {
  const {
    passenger_phone, pickup, drop_location, vehicle_type, package_size, package_note,
    pickup_lat, pickup_lng, drop_lat, drop_lng,
    discount, promo_code, receiver_name, receiver_phone, cod_amount,
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

  try {
    const passengerRes = await db.query('SELECT * FROM users WHERE phone=$1', [passenger_phone]);
    if (!passengerRes.rows[0]) return res.status(404).json({ error: 'Account not found — please log in again' });
    if (passengerRes.rows[0].booking_restricted)
      return res.status(403).json({ error: '🚫 Your account is on hold. Please contact support: help@sppero.com', restricted: true });
    const passenger = passengerRes.rows[0];

    // Fare is always computed server-side — never trust a client-sent amount
    const fareCalc = calculateParcelFare(PARCEL_FARES[vehicle_type], distKm, size);
    const fare = fareCalc.fare;

    const codVal = cod_amount != null && parseFloat(cod_amount) > 0 ? parseFloat(cod_amount) : null;

    const rideRes = await db.query(
      `INSERT INTO rides
         (passenger_id, pickup, drop_location, ride_type, fare, status,
          is_parcel, package_size, package_note, cod_amount,
          pickup_lat, pickup_lng, drop_lat, drop_lng,
          discount, promo_code, distance_km, platform_fee,
          receiver_name, receiver_phone)
       VALUES ($1,$2,$3,$4,$5,'requested',true,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,$16,$17)
       RETURNING *`,
      [
        passenger.id, pickup, drop_location, vehicle_type, fare,
        size, (package_note || '').trim() || null, codVal,
        pickup_lat || null, pickup_lng || null, drop_lat || null, drop_lng || null,
        discount || 0, promo_code || null, distKm,
        receiverNameVal, receiverPhoneVal,
      ]
    );
    const rideId = rideRes.rows[0].id;

    console.log(`[parcel] ✅ ride=${rideId} ${vehicle_type} ${size} ${distKm}km → ${receiverNameVal}`);
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
      cod_amount: codVal,
      receiver_name: receiverNameVal,
      receiver_phone: receiverPhoneVal,
      distance: distKm + ' km',
    });
  } catch (err) {
    console.error('[parcel] book error:', err.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

module.exports = router;
