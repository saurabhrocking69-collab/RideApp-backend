const { Queue, Worker } = require('bullmq');
const db = require('../config/db');
const { makeBmqConn } = require('../config/redis');
const { sendFCM } = require('../config/firebase');
const { emitToRoom } = require('../config/socket');
const { haversineKm } = require('../services/matching');
const { getSurgeMultiplier } = require('../services/locationIntelligence');

const rideQueue = new Queue('ride-assignment', { connection: makeBmqConn() });

// How long drivers have to accept after a broadcast
const BROADCAST_WAIT_MS      = 90_000;  // 90s — first round (base fare)
const SURGE_WAIT_MS          = 60_000;  // 60s — after customer accepts surge
const CUSTOMER_SURGE_GRACE_MS = 35_000; // 35s — grace for customer to respond to surge offer before auto-cancel

const RIDE_EMOJI = { bike: '🏍️', auto: '🛺', car: '🚕', eriksha: '🛵', luxury: '🚙' };

const VEHICLE_ALTERNATIVES = {
  bike:          ['auto', 'car'],
  eriksha:       ['auto', 'bike'],
  auto:          ['car'],
  car:           ['auto'],
  luxury:        ['car'],
  ultra_luxury:  ['car'],
  green_bike:    ['bike', 'auto'],
  electric_auto: ['auto', 'eriksha'],
};

async function getAvailableAlternatives(rideType) {
  const alts = VEHICLE_ALTERNATIVES[rideType] || [];
  if (alts.length === 0) return [];
  const r = await db.query(
    `SELECT d.vehicle_type, COUNT(*) AS cnt
     FROM drivers d
     JOIN users u ON d.id = u.id
     WHERE d.vehicle_type = ANY($1)
       AND d.is_online = true
       AND d.verification_status = 'approved'
       AND NOT EXISTS (
         SELECT 1 FROM rides r2
         WHERE r2.driver_id = d.id AND r2.status IN ('matched','arrived','started')
       )
     GROUP BY d.vehicle_type`,
    [alts]
  );
  const available = new Set(r.rows.filter(row => parseInt(row.cnt) > 0).map(row => row.vehicle_type));
  return alts.filter(a => available.has(a));
}

async function fetchDriversInRadius(rideType, pickupLat, pickupLng, radiusKm, excludePhones = []) {
  const drRes = await db.query(
    `SELECT u.phone, dl.lat, dl.lng, dl.updated_at AS loc_updated_at
     FROM drivers d
     JOIN users u ON d.id = u.id
     LEFT JOIN driver_locations dl ON dl.phone = u.phone
     WHERE d.verification_status = 'approved'
       AND d.is_online = true
       AND (d.vehicle_type = $1 OR (d.vehicle_type = 'ultra_luxury' AND $1 = 'luxury'))
       AND NOT EXISTS (
         SELECT 1 FROM rides r2
         WHERE r2.driver_id = d.id AND r2.status IN ('matched','arrived','started')
       )`,
    [rideType]
  );
  const excluded = new Set(excludePhones);
  const now = Date.now();
  const STALE_MS = 10 * 60 * 1000;
  return drRes.rows.filter(dr => {
    if (excluded.has(dr.phone)) return false;
    if (!pickupLat || !pickupLng || !dr.lat || !dr.lng) return true;
    const locAge = dr.loc_updated_at ? (now - new Date(dr.loc_updated_at).getTime()) : Infinity;
    if (locAge >= STALE_MS) return true; // stale location → include in broadcast anyway
    return haversineKm(parseFloat(pickupLat), parseFloat(pickupLng), parseFloat(dr.lat), parseFloat(dr.lng)) <= radiusKm;
  });
}

const rideWorker = new Worker('ride-assignment', async (job) => {
  const d = job.data;
  if (d.type === 'broadcast')          await _bmqBroadcast(d);
  if (d.type === 'broadcast-timeout')  await _bmqBroadcastTimeout(d);
}, { connection: makeBmqConn(), concurrency: 5 });

rideWorker.on('failed', (job, err) => {
  console.error('❌ BullMQ job failed:', job?.id, err.message);
});

// ── Broadcast to ALL matching drivers simultaneously ─────────────────────────
async function _bmqBroadcast({ rideId, pickupLat, pickupLng, rideType, radiusKm = 5, afterSurge = false }) {
  const rideCheck = await db.query(
    `SELECT id, ride_type, COALESCE(offered_phones, '{}') AS offered_phones
     FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
  );
  if (!rideCheck.rows[0]) return; // already matched / cancelled
  if (rideCheck.rows[0].ride_type !== rideType) return; // customer switched vehicle

  const alreadyOffered = rideCheck.rows[0].offered_phones || [];
  const drivers = await fetchDriversInRadius(rideType, pickupLat, pickupLng, radiusKm, alreadyOffered);

  if (drivers.length === 0) {
    if (radiusKm < 15) {
      // Expand radius and try again immediately
      await rideQueue.add('ride-assignment',
        { type: 'broadcast', rideId, pickupLat, pickupLng, rideType, radiusKm: radiusKm + 5, afterSurge },
        { delay: 1000 }
      );
      return;
    }
    // No drivers anywhere → skip wait, escalate immediately
    await _escalate(rideId, rideType, afterSurge, pickupLat, pickupLng);
    return;
  }

  // Send to ALL matching drivers at once
  const emoji = RIDE_EMOJI[rideType] || '🚗';
  const waitSec = afterSurge ? Math.floor(SURGE_WAIT_MS / 1000) : Math.floor(BROADCAST_WAIT_MS / 1000);

  await Promise.all(drivers.flatMap(dr => [
    sendFCM(
      dr.phone,
      `${emoji} Naya Ride Request!`,
      `📍 ${rideType.toUpperCase()} ride nearby — ${waitSec}s mein accept karo!`,
      { type: 'new_ride', ride_id: String(rideId) },
      { channelId: 'ride_requests', role: 'driver' }
    ).catch(() => {}),
    Promise.resolve(emitToRoom('driver_' + dr.phone, 'newRideAssigned', { rideId, secondsToAccept: waitSec })),
  ]));

  // Track which phones received this broadcast (skip on surge re-broadcast if needed)
  const newPhones = drivers.map(dr => dr.phone);
  await db.query(
    `UPDATE rides SET offered_phones = (COALESCE(offered_phones, '{}') || $1::text[])
     WHERE id=$2`,
    [newPhones, rideId]
  ).catch(() => {});

  // Schedule timeout check
  const waitMs = afterSurge ? SURGE_WAIT_MS : BROADCAST_WAIT_MS;
  await rideQueue.add('ride-assignment',
    { type: 'broadcast-timeout', rideId, pickupLat, pickupLng, rideType, radiusKm, afterSurge },
    { delay: waitMs }
  );
}

// ── Check after wait period — escalate if still unmatched ───────────────────
async function _bmqBroadcastTimeout({ rideId, pickupLat, pickupLng, rideType, radiusKm, afterSurge }) {
  const rideCheck = await db.query(
    `SELECT id FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
  );
  if (!rideCheck.rows[0]) return; // already matched — done
  await _escalate(rideId, rideType, afterSurge, pickupLat, pickupLng);
}

// ── Escalation: surge offer → final failure ──────────────────────────────────
async function _escalate(rideId, rideType, afterSurge, pickupLat, pickupLng) {
  if (afterSurge) {
    // Second round also failed → final no-driver with alternatives
    const [alts, pRes] = await Promise.all([
      getAvailableAlternatives(rideType).catch(() => []),
      db.query(`SELECT u.phone FROM rides r JOIN users u ON r.passenger_id=u.id WHERE r.id=$1`, [rideId]),
    ]);
    const customerPhone = pRes.rows[0]?.phone;
    if (customerPhone) {
      sendFCM(
        customerPhone,
        '😔 Driver Nahi Mila',
        alts.length ? 'Doosra vehicle try karo ya thodi der baad retry karo.' : 'Is area mein abhi koi driver available nahi. 5 min baad try karo.',
        { type: 'no_driver_found', ride_id: String(rideId) },
        { role: 'customer' }
      ).catch(() => {});
    }
    emitToRoom('ride_' + rideId, 'rideUpdate', {
      rideId,
      status: 'no_driver_final',
      alternatives: alts,
      retry_after_sec: 300,
      message: 'Abhi koi driver nahi mila.',
    });
    // Cancel the ride after giving customer time to switch vehicle
    await db.query(
      `UPDATE rides SET status='cancelled' WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
    );
  } else {
    // First round failed → offer surge to attract drivers
    const surgeInfo = await _computeSurgeOffer(pickupLat, pickupLng, rideId);
    emitToRoom('ride_' + rideId, 'rideUpdate', {
      rideId,
      status: 'surge_offer',
      suggested_surge_amt: surgeInfo.amt,
      surge_label: surgeInfo.label,
      message: `Koi driver nahi mila. ₹${surgeInfo.amt} extra dekar driver attract karein?`,
      timeout_sec: 30,
    });
    // Auto-cancel if customer doesn't respond to surge offer in time
    await rideQueue.add('ride-assignment',
      { type: 'broadcast-timeout', rideId, pickupLat, pickupLng, rideType, radiusKm: 5, afterSurge: true },
      { delay: CUSTOMER_SURGE_GRACE_MS }
    );
  }
}

// ── Compute suggested surge tip amount ──────────────────────────────────────
async function _computeSurgeOffer(pickupLat, pickupLng, rideId) {
  try {
    const [multiplier, rideRes] = await Promise.all([
      getSurgeMultiplier(parseFloat(pickupLat) || 0, parseFloat(pickupLng) || 0),
      db.query('SELECT fare FROM rides WHERE id=$1', [rideId]),
    ]);
    const fare = parseInt(rideRes.rows[0]?.fare) || 0;
    // Base suggestion on area demand multiplier
    let amt = 25;
    if (multiplier >= 2.0)      amt = 65;
    else if (multiplier >= 1.5) amt = 40;
    else if (multiplier >= 1.2) amt = 25;
    // Also suggest 25% of fare
    const pctAmt = Math.round(fare * 0.25 / 5) * 5;
    if (pctAmt > amt && pctAmt <= 100) amt = pctAmt;
    // Round to valid step
    const VALID = [15, 25, 40, 65, 100];
    const closest = VALID.reduce((a, b) => Math.abs(b - amt) < Math.abs(a - amt) ? b : a);
    return { amt: closest, label: `+₹${closest}` };
  } catch (_e) {
    return { amt: 25, label: '+₹25' };
  }
}

// ── Public entry point (called from routes/rides.js) ─────────────────────────
async function assignRideToNextDriver(rideId, pickupLat, pickupLng, rideType, _queue, radiusKm, afterSurge = false) {
  await rideQueue.add('ride-assignment', {
    type: 'broadcast', rideId, pickupLat, pickupLng, rideType,
    radiusKm: radiusKm || 5, afterSurge: !!afterSurge,
  });
}

module.exports = { rideQueue, rideWorker, assignRideToNextDriver };
