'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PARCEL ROUTE BATCHING — two independent, still-unassigned parcel bookings
// with compatible vehicle/size and nearby pickups get combined into one
// "batch" and offered to drivers as a single job with an ordered stop
// sequence, instead of being broadcast separately.
//
// Deliberate design choice: each underlying `rides` row keeps its own fare,
// OTPs (start_otp/delivery_otp), escrow, and RTO flow completely unchanged —
// batching only changes HOW a driver gets assigned and WHICH stop is next.
// Every existing per-ride endpoint (/mark-arrived, /start, /complete,
// /flag-non-delivery, /return-decision, /confirm-return) keeps working
// exactly as today, scoped to whichever ride_id is the current stop. This
// keeps the financially-sensitive code (already hardened this session)
// completely untouched — batching is purely a dispatch/routing layer on top.
//
// v1 scope (deliberately bounded, not a general N-package router):
//   - Max 2 parcels per batch.
//   - Pickups both happen before any drop (driver has physical custody of
//     both packages before making delivery detours) — simpler mental model
//     and liability story than interleaving pickup/drop freely.
//   - Stop order: greedy nearest-neighbor (pickups ordered by distance from
//     the driver's current location; drops ordered by distance from the
//     second pickup) — not a true TSP solver. Fine at n=4 points.
//   - Matching happens once, at dispatch time, for two still-`requested`
//     parcels. No re-optimization if a 3rd compatible parcel appears later.
//   - Flat % discount credited to both senders' wallets once the batch is
//     confirmed (driver accepts) — simpler than trying to split one shared
//     fare, and doesn't touch the upfront escrow amount each already paid.
// ═══════════════════════════════════════════════════════════════════════════
const db = require('../config/db');
const { haversineKm, driverLocations } = require('./matching');
const { emitToRoom } = require('../config/socket');
const { sendFCM } = require('../config/firebase');
const { assignRideToNextDriver } = require('../workers/rideWorker');

const BATCH_PICKUP_PROXIMITY_KM = 1.5;   // pickups must be this close to consider batching
const BATCH_MATCH_WINDOW_MIN    = 10;    // only match against parcels requested within the last N minutes
const BATCH_DISCOUNT_PERCENT    = 10;    // % refunded to each sender's wallet when a batch confirms
const BATCH_OFFER_RADIUS_M      = 3000;  // single-radius broadcast for batch offers (see note below)
const BATCH_OFFER_WINDOW_SEC    = 30;

// Vehicle "class" — a batch needs both parcels to be carryable by the SAME
// physical vehicle a driver actually has, but bike/green_bike (and the three
// auto-family types) are functionally interchangeable for this purpose.
const VEHICLE_CLASS = {
  bike: 'two_wheeler', green_bike: 'two_wheeler',
  auto: 'three_wheeler', eriksha: 'three_wheeler', electric_auto: 'three_wheeler',
  car: 'four_wheeler',
};

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ride_batches (
        id SERIAL PRIMARY KEY,
        status TEXT DEFAULT 'offered',          -- offered | matched | expired | cancelled
        driver_id INTEGER REFERENCES users(id),
        offered_phones TEXT[] DEFAULT '{}',
        assignment_expires_at TIMESTAMPTZ,
        vehicle_type TEXT,
        package_size TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        matched_at TIMESTAMPTZ
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS batch_stops (
        id SERIAL PRIMARY KEY,
        batch_id INTEGER REFERENCES ride_batches(id),
        ride_id INTEGER REFERENCES rides(id),
        stop_type TEXT NOT NULL,                -- 'pickup' | 'drop'
        sequence_order INTEGER NOT NULL,
        lat NUMERIC, lng NUMERIC, address TEXT,
        status TEXT DEFAULT 'pending',           -- pending | completed
        completed_at TIMESTAMPTZ
      )
    `);
    await db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS batch_id INTEGER').catch(() => {});
    console.log('[batching] tables ready');
  } catch (e) { console.error('[batching] table init failed:', e.message); }
})();

// ── Find a still-unassigned, compatible, nearby parcel to batch with ────────
async function findBatchPartner(rideId, vehicleType, packageSize, pickupLat, pickupLng) {
  if (!pickupLat || !pickupLng) return null;
  const vClass = VEHICLE_CLASS[vehicleType];
  if (!vClass) return null; // vehicle type not in the batching-eligible set (e.g. luxury) — skip

  const candidates = await db.query(
    `SELECT id, vehicle_type, package_size, pickup, pickup_lat, pickup_lng,
            drop_location, drop_lat, drop_lng, fare, passenger_id
     FROM rides
     WHERE is_parcel = true AND status = 'requested' AND driver_id IS NULL
       AND batch_id IS NULL AND id != $1 AND package_size = $2
       AND created_at > NOW() - INTERVAL '${BATCH_MATCH_WINDOW_MIN} minutes'`,
    [rideId, packageSize]
  );

  let best = null, bestDist = Infinity;
  for (const c of candidates.rows) {
    if (VEHICLE_CLASS[c.vehicle_type] !== vClass) continue;
    if (!c.pickup_lat || !c.pickup_lng) continue;
    const dist = haversineKm(parseFloat(pickupLat), parseFloat(pickupLng), parseFloat(c.pickup_lat), parseFloat(c.pickup_lng));
    if (dist <= BATCH_PICKUP_PROXIMITY_KM && dist < bestDist) { best = c; bestDist = dist; }
  }
  return best;
}

// ── Order the 4 stops: both pickups first (nearest-to-driver first), then
//    both drops (nearest-to-second-pickup first) ────────────────────────────
function sequenceStops(driverLat, driverLng, rideA, rideB) {
  const pickups = [
    { ride: rideA, stop_type: 'pickup', lat: parseFloat(rideA.pickup_lat), lng: parseFloat(rideA.pickup_lng), address: rideA.pickup },
    { ride: rideB, stop_type: 'pickup', lat: parseFloat(rideB.pickup_lat), lng: parseFloat(rideB.pickup_lng), address: rideB.pickup },
  ];
  if (driverLat != null && driverLng != null) {
    pickups.sort((a, b) =>
      haversineKm(driverLat, driverLng, a.lat, a.lng) - haversineKm(driverLat, driverLng, b.lat, b.lng));
  }
  const anchor = pickups[1]; // driver will be standing here with both packages in hand
  const drops = [
    { ride: rideA, stop_type: 'drop', lat: parseFloat(rideA.drop_lat), lng: parseFloat(rideA.drop_lng), address: rideA.drop_location },
    { ride: rideB, stop_type: 'drop', lat: parseFloat(rideB.drop_lat), lng: parseFloat(rideB.drop_lng), address: rideB.drop_location },
  ];
  drops.sort((a, b) =>
    haversineKm(anchor.lat, anchor.lng, a.lat, a.lng) - haversineKm(anchor.lat, anchor.lng, b.lat, b.lng));
  return [...pickups, ...drops].map((s, i) => ({ ...s, sequence_order: i + 1 }));
}

// ── Entry point, called instead of assignRideToNextDriver for a fresh parcel
//    booking. Returns true if a batch offer went out (caller should NOT also
//    run the normal single-ride broadcast); false means "no partner found,
//    dispatch this normally." ────────────────────────────────────────────────
async function tryBatchDispatch(rideId, vehicleType, packageSize, pickupLat, pickupLng) {
  const partner = await findBatchPartner(rideId, vehicleType, packageSize, pickupLat, pickupLng);
  if (!partner) return false;

  const client = await db.connect();
  let batchId;
  try {
    await client.query('BEGIN');
    // Atomic claim of BOTH rides — guards the race where ride A's dispatch
    // and ride B's own independent dispatch (each parcel booking schedules
    // its own dispatch 2s after booking) could otherwise both try to grab
    // each other, or a 3rd ride could grab one of these mid-claim.
    const claim = await client.query(
      `UPDATE rides SET status='batch_offered'
       WHERE id IN ($1,$2) AND status='requested' AND driver_id IS NULL AND batch_id IS NULL
       RETURNING id`,
      [rideId, partner.id]
    );
    if (claim.rows.length !== 2) { await client.query('ROLLBACK'); client.release(); return false; }

    const bRes = await client.query(
      `INSERT INTO ride_batches (vehicle_type, package_size) VALUES ($1,$2) RETURNING id`,
      [vehicleType, packageSize]
    );
    batchId = bRes.rows[0].id;
    await client.query('UPDATE rides SET batch_id=$1 WHERE id IN ($2,$3)', [batchId, rideId, partner.id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[batching] claim failed:', e.message);
    return false;
  } finally { client.release(); }

  // Fetch both full ride rows for stop-sequencing + broadcast payload. Both
  // rides are already committed as 'batch_offered' at this point — if
  // anything below throws, release them back to 'requested' so the caller's
  // normal-dispatch fallback (or the next poll) can still pick them up,
  // instead of leaving them stuck with no active offer and no driver.
  try {
    const ridesRes = await db.query(
      `SELECT r.*, u.phone AS passenger_phone FROM rides r JOIN users u ON r.passenger_id = u.id WHERE r.id IN ($1,$2)`,
      [rideId, partner.id]
    );
    const rideA = ridesRes.rows.find(r => r.id === rideId);
    const rideB = ridesRes.rows.find(r => r.id === partner.id);
    if (!rideA || !rideB) { await expireBatchOffer(batchId); return false; }

    await broadcastBatchOffer(batchId, vehicleType, rideA, rideB, pickupLat, pickupLng);
    return true;
  } catch (e) {
    console.error('[batching] post-claim failed, releasing:', e.message);
    await expireBatchOffer(batchId).catch(() => {});
    return false;
  }
}

// ── Broadcast the combined offer to eligible drivers ─────────────────────────
// Simplified vs. the normal single-ride broadcast's radius-progression system
// deliberately: batching only matters when a compatible driver is ALREADY
// reasonably close (if no one is, the partner ride falls back to the normal
// full radius-progression broadcast anyway once this offer times out — see
// expireBatchOffer below), so one fixed radius is enough here.
async function broadcastBatchOffer(batchId, vehicleType, rideA, rideB, pickupLat, pickupLng) {
  const drRes = await db.query(
    `SELECT u.phone, dl.lat, dl.lng
     FROM drivers d JOIN users u ON d.id = u.id
     LEFT JOIN driver_locations dl ON dl.phone = u.phone
     WHERE d.verification_status='approved' AND d.is_online=true AND d.vehicle_type=$1
       AND NOT EXISTS (SELECT 1 FROM rides r2 WHERE r2.driver_id=d.id AND r2.status IN ('matched','arrived','started'))
       AND NOT EXISTS (SELECT 1 FROM hourly_bookings hb WHERE hb.driver_phone=u.phone AND hb.status IN ('matched','arrived','active'))`,
    [vehicleType]
  );
  const eligible = drRes.rows.filter(dr => {
    if (!dr.lat || !dr.lng) return true; // no GPS yet — benefit of the doubt, same as normal broadcast
    return haversineKm(parseFloat(pickupLat), parseFloat(pickupLng), parseFloat(dr.lat), parseFloat(dr.lng)) * 1000 <= BATCH_OFFER_RADIUS_M;
  });

  if (eligible.length === 0) {
    await expireBatchOffer(batchId); // no one nearby right now — fall both rides back to normal individual dispatch immediately
    return;
  }

  const phones = eligible.map(d => d.phone);
  await db.query(
    `UPDATE ride_batches SET offered_phones=$1::text[], assignment_expires_at=NOW() + INTERVAL '${BATCH_OFFER_WINDOW_SEC} seconds' WHERE id=$2`,
    [phones, batchId]
  );

  const totalFare = Math.round(parseFloat(rideA.fare) + parseFloat(rideB.fare));
  for (const dr of eligible) {
    emitToRoom('driver_' + dr.phone, 'batchOffer', {
      batchId, secondsToAccept: BATCH_OFFER_WINDOW_SEC,
      stops: 2, totalFare,
      packages: [
        { pickup: rideA.pickup, drop: rideA.drop_location, fare: Math.round(parseFloat(rideA.fare)) },
        { pickup: rideB.pickup, drop: rideB.drop_location, fare: Math.round(parseFloat(rideB.fare)) },
      ],
    });
    sendFCM(dr.phone, '📦📦 2 Parcels — One Trip!',
      `₹${totalFare} combined — two nearby deliveries, accept within ${BATCH_OFFER_WINDOW_SEC}s!`,
      { type: 'batch_offer', batch_id: String(batchId) },
      { channelId: 'ride_requests', role: 'driver' }
    ).catch(() => {});
  }
  console.log(`[batching] batch=${batchId} offered to ${phones.length} driver(s)`);

  setTimeout(() => expireBatchOffer(batchId).catch(e => console.error('[batching] expire error:', e.message)), (BATCH_OFFER_WINDOW_SEC + 1) * 1000);
}

// ── Driver accepts a batch offer — atomically claims both rides ─────────────
async function acceptBatch(batchId, driverPhone) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const bRes = await client.query(
      `SELECT * FROM ride_batches WHERE id=$1 AND status='offered' AND $2 = ANY(COALESCE(offered_phones,'{}')) AND assignment_expires_at > NOW() FOR UPDATE`,
      [batchId, driverPhone]
    );
    if (!bRes.rows[0]) { await client.query('ROLLBACK'); return { success: false, message: 'Batch offer expired or already claimed by another driver' }; }
    const batch = bRes.rows[0];

    const driverRes = await client.query('SELECT id FROM users WHERE phone=$1', [driverPhone]);
    if (!driverRes.rows[0]) { await client.query('ROLLBACK'); return { success: false, message: 'Driver not found' }; }
    const driverId = driverRes.rows[0].id;

    // Guard against the driver having claimed a different ride in the gap
    // between the offer going out and this accept call — same pattern
    // activateQueuedRide already uses for the sequential pre-assign case.
    const busyCheck = await client.query(
      `SELECT 1 FROM rides WHERE driver_id=$1 AND status IN ('matched','arrived','started')`, [driverId]
    );
    if (busyCheck.rows[0]) { await client.query('ROLLBACK'); return { success: false, message: 'You already have an active ride' }; }

    const ridesRes = await client.query(
      `SELECT r.*, u.phone AS passenger_phone FROM rides r JOIN users u ON r.passenger_id=u.id WHERE r.batch_id=$1 AND r.status='batch_offered'`,
      [batchId]
    );
    if (ridesRes.rows.length !== 2) { await client.query('ROLLBACK'); return { success: false, message: 'Batch is no longer valid' }; }

    const otpFor = () => Math.floor(1000 + Math.random() * 9000).toString();
    const otps = {};
    for (const ride of ridesRes.rows) {
      otps[ride.id] = { start: otpFor(), delivery: otpFor() };
      await client.query(
        `UPDATE rides SET status='matched', driver_id=$1, matched_at=NOW(), start_otp=$2, delivery_otp=$3 WHERE id=$4`,
        [driverId, otps[ride.id].start, otps[ride.id].delivery, ride.id]
      );
    }
    await client.query(`UPDATE ride_batches SET status='matched', driver_id=$1, matched_at=NOW() WHERE id=$2`, [driverId, batchId]);

    const driverLoc = driverLocations[driverPhone];
    const [rideA, rideB] = ridesRes.rows;
    const stops = sequenceStops(driverLoc?.lat, driverLoc?.lng, rideA, rideB);
    for (const s of stops) {
      await client.query(
        `INSERT INTO batch_stops (batch_id, ride_id, stop_type, sequence_order, lat, lng, address) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [batchId, s.ride.id, s.stop_type, s.sequence_order, s.lat, s.lng, s.address]
      );
    }
    await client.query('COMMIT');

    applyBatchDiscount(batchId).catch(e => console.error('[batching] discount credit failed:', e.message));

    const driverInfoRes = await db.query(
      `SELECT u.name, d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.rating, d.upi_id
       FROM users u JOIN drivers d ON d.id=u.id WHERE u.id=$1`, [driverId]
    );
    const di = driverInfoRes.rows[0];
    const driverCard = di ? { name: di.name, phone: driverPhone, vehicle_no: di.vehicle_no, vehicle_brand: di.vehicle_brand, vehicle_model: di.vehicle_model, rating: parseFloat(di.rating) || 5.0, upi_id: di.upi_id || null } : null;

    for (const ride of ridesRes.rows) {
      const myStops = stops.filter(s => s.ride.id === ride.id);
      const stopsBeforeMine = stops.findIndex(s => s.stop_type === 'pickup' && s.ride.id === ride.id);
      emitToRoom('ride_' + ride.id, 'rideUpdate', {
        rideId: ride.id, status: 'matched', driver: driverCard,
        start_otp: otps[ride.id].start, delivery_otp: otps[ride.id].delivery,
        batched: true, stops_before_pickup: stopsBeforeMine,
        message: stopsBeforeMine > 0 ? 'Driver matched — 1 more pickup before reaching you' : 'Driver is on the way to you!',
      });
    }

    return { success: true, batchId, stops, rides: ridesRes.rows.map(r => ({ id: r.id, start_otp: otps[r.id].start, delivery_otp: otps[r.id].delivery })) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[batching] acceptBatch failed:', e.message);
    return { success: false, message: 'Something went wrong — please try again' };
  } finally { client.release(); }
}

// ── No driver accepted in time (or nobody was eligible) — release both rides
//    back to normal individual dispatch, exactly as if they'd never been
//    considered for batching. Deliberately doesn't retry batching with each
//    other again (avoids an infinite offer-expire-reoffer loop between the
//    same two parcels). ───────────────────────────────────────────────────
async function expireBatchOffer(batchId) {
  const b = await db.query(`SELECT * FROM ride_batches WHERE id=$1 AND status='offered'`, [batchId]);
  if (!b.rows[0]) return; // already accepted or already expired
  await db.query(`UPDATE ride_batches SET status='expired' WHERE id=$1`, [batchId]);
  const rides = await db.query(`SELECT id, pickup_lat, pickup_lng, vehicle_type FROM rides WHERE batch_id=$1 AND status='batch_offered'`, [batchId]);
  for (const r of rides.rows) {
    const released = await db.query(`UPDATE rides SET status='requested', batch_id=NULL WHERE id=$1 AND status='batch_offered' RETURNING id`, [r.id]);
    if (released.rows[0]) {
      // Re-dispatch normally, exactly as if it had never been considered for
      // batching. Deliberately does NOT call tryBatchDispatch again here —
      // that would let this exact pair keep re-offering to each other in an
      // offer/expire loop if neither driver responds.
      assignRideToNextDriver(r.id, r.pickup_lat, r.pickup_lng, r.vehicle_type)
        .catch(e => console.error('[batching] fallback dispatch failed:', e.message));
    }
  }
  console.log(`[batching] batch=${batchId} expired, ${rides.rows.length} ride(s) released back to normal dispatch`);
}

// ── Flat discount to both senders once a batch is confirmed — simpler than
//    splitting one shared fare, and doesn't touch the upfront escrow amount
//    each already paid (which stays exactly as booked for accounting). ─────
async function applyBatchDiscount(batchId) {
  const rides = await db.query(
    `SELECT r.id, r.fare, u.phone AS passenger_phone FROM rides r JOIN users u ON r.passenger_id=u.id WHERE r.batch_id=$1`,
    [batchId]
  );
  for (const r of rides.rows) {
    const discount = Math.round(parseFloat(r.fare) * BATCH_DISCOUNT_PERCENT / 100);
    if (discount <= 0) continue;
    const u = await db.query('SELECT id FROM users WHERE phone=$1', [r.passenger_phone]);
    if (!u.rows[0]) continue;
    const userId = u.rows[0].id;
    await db.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    await db.query('UPDATE customer_wallet SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2', [discount, userId]);
    await db.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'credit',$2,$3)",
      [userId, discount, `Batch delivery discount (ride ${r.id})`]
    );
    sendFCM(r.passenger_phone, '🎉 Batch Discount!', `₹${discount} credited to your wallet — your parcel was batched with another delivery.`,
      { type: 'wallet_topup', amount: String(discount) }, { role: 'customer' }).catch(() => {});
  }
}

module.exports = { tryBatchDispatch, expireBatchOffer, acceptBatch, applyBatchDiscount, sequenceStops, BATCH_DISCOUNT_PERCENT };
