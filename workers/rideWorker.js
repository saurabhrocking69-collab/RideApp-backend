const { Queue, Worker } = require('bullmq');
const db = require('../config/db');
const { makeBmqConn } = require('../config/redis');
const { sendFCM } = require('../config/firebase');
const { emitToRoom } = require('../config/socket');
const { haversineKm } = require('../services/matching');
const { getSurgeMultiplier } = require('../services/locationIntelligence');

const rideQueue = new Queue('ride-assignment', { connection: makeBmqConn() });

// ── Broadcast radius progression (meters) ───────────────────────────────────
const RADIUS_LEVELS_M = [500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000];
const WINDOW_SEC      = 30;   // each radius level gets 30 seconds
const SURGE_GRACE_SEC = 100;  // customer has 100s to accept surge offer
const STALE_GPS_MS    = 15 * 60 * 1000; // 15 min — location older than this → include anyway

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

const rideWorker = new Worker('ride-assignment', async (job) => {
  const d = job.data;
  if (d.type === 'broadcast-advance')    await _bmqBroadcastAdvance(d).catch(e => console.error('[ADVANCE] error:', e.message));
  if (d.type === 'surge-grace-timeout')  await _bmqSurgeGraceTimeout(d).catch(e => console.error('[SURGE_TIMEOUT] error:', e.message));
  if (d.type === 'assign-next')          await _bmqAssignNext(d).catch(e => console.error('[ASSIGN-NEXT] error:', e.message));
}, { connection: makeBmqConn(), concurrency: 5 });

rideWorker.on('failed', (job, err) => {
  console.error('❌ BullMQ job failed:', job?.id, err.message);
});

// ── Broadcast ride to ALL eligible drivers within radiusM ────────────────────
// Returns { sent: number, phones: string[] }
async function broadcastToRadius(rideId, pickupLat, pickupLng, rideType, radiusM, alreadyOfferedPhones) {
  console.log(`[BROADCAST] ride=${rideId} type=${rideType} radius=${radiusM}m alreadyOffered=${alreadyOfferedPhones.length}`);

  const [rideCheck, drRes] = await Promise.all([
    db.query(
      `SELECT id, ride_type FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
      [rideId]
    ),
    db.query(
      `SELECT u.phone, dl.lat, dl.lng, dl.updated_at AS loc_ts
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
    ),
  ]);

  if (!rideCheck.rows[0]) {
    console.log(`[BROADCAST] ride=${rideId} ABORT — not found or already matched/cancelled`);
    return { sent: 0, phones: [] };
  }

  const alreadySet = new Set(alreadyOfferedPhones);
  const now = Date.now();

  const eligible = drRes.rows.filter(dr => {
    if (alreadySet.has(dr.phone)) return false;
    // No pickup coords or stale GPS → include (benefit of doubt)
    if (!pickupLat || !pickupLng || !dr.lat || !dr.lng) return true;
    const locAge = dr.loc_ts ? (now - new Date(dr.loc_ts).getTime()) : Infinity;
    if (locAge > STALE_GPS_MS) return true;
    const distKm = haversineKm(parseFloat(pickupLat), parseFloat(pickupLng), parseFloat(dr.lat), parseFloat(dr.lng));
    return distKm * 1000 <= radiusM;
  });

  console.log(`[BROADCAST] ride=${rideId} radius=${radiusM}m — total_online=${drRes.rows.length} new_eligible=${eligible.length} phones=${JSON.stringify(eligible.map(d => d.phone))}`);

  if (eligible.length === 0) {
    return { sent: 0, phones: [] };
  }

  const eligiblePhones = eligible.map(d => d.phone);
  const allOffered = [...alreadyOfferedPhones, ...eligiblePhones];

  // Update ride: set 20s window, current radius, add to offered_phones
  await db.query(
    `UPDATE rides
     SET assignment_expires_at = NOW() + INTERVAL '${WINDOW_SEC} seconds',
         current_radius_m = $1,
         offered_phones = $2::text[],
         assigned_to_phone = NULL
     WHERE id = $3 AND status = 'requested' AND driver_id IS NULL`,
    [radiusM, allOffered, rideId]
  );

  // Broadcast to all eligible drivers simultaneously
  const rideEmoji = { bike: '🏍️', auto: '🛺', car: '🚕', eriksha: '🛵', luxury: '🚙', electric_auto: '🌿', green_bike: '⚡' }[rideType] || '🚗';
  for (const dr of eligible) {
    emitToRoom('driver_' + dr.phone, 'newRideRequest', { rideId, secondsToAccept: WINDOW_SEC, radiusM });
    sendFCM(
      dr.phone,
      `${rideEmoji} Nayi Ride Request!`,
      `${rideType.toUpperCase()} ride — ${WINDOW_SEC}s mein accept karo!`,
      { type: 'new_ride', ride_id: String(rideId) },
      { channelId: 'ride_requests', role: 'driver' }
    ).catch(() => {});
    db.query(
      `INSERT INTO driver_metrics (phone, rides_offered) VALUES ($1, 1)
       ON CONFLICT (phone) DO UPDATE SET rides_offered = driver_metrics.rides_offered + 1`,
      [dr.phone]
    ).catch(() => {});
  }

  return { sent: eligiblePhones.length, phones: eligiblePhones };
}

// ── Advance to next radius after 20s window expires ──────────────────────────
async function _bmqBroadcastAdvance({ rideId, pickupLat, pickupLng, rideType, radiusM, afterSurge }) {
  const r = await db.query(
    `SELECT id, current_radius_m, offered_phones FROM rides
     WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
    [rideId]
  );
  if (!r.rows[0]) { console.log(`[ADVANCE] ride=${rideId} — already matched or cancelled`); return; }
  if (r.rows[0].current_radius_m !== radiusM) { console.log(`[ADVANCE] ride=${rideId} — radius mismatch (current=${r.rows[0].current_radius_m} expected=${radiusM}), already advanced`); return; }

  const currentIdx = RADIUS_LEVELS_M.indexOf(radiusM);
  const currentOffered = r.rows[0].offered_phones || [];

  // Clear expired window so drivers can't accept after the window
  await db.query(
    `UPDATE rides SET assignment_expires_at=NULL, assigned_to_phone=NULL
     WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
    [rideId]
  ).catch(() => {});

  // Try next radius levels until we find drivers or exhaust all
  for (let i = currentIdx + 1; i < RADIUS_LEVELS_M.length; i++) {
    const nextRadius = RADIUS_LEVELS_M[i];
    const result = await broadcastToRadius(rideId, pickupLat, pickupLng, rideType, nextRadius, currentOffered);
    if (result.sent > 0) {
      // Found drivers at this radius — schedule next advance
      await rideQueue.add('ride-assignment', {
        type: 'broadcast-advance', rideId, pickupLat, pickupLng, rideType,
        radiusM: nextRadius, afterSurge: !!afterSurge,
      }, { delay: WINDOW_SEC * 1000 + 1000 }).catch(e => console.error('[ADVANCE] BullMQ add failed:', e.message));
      return;
    }
    // No drivers at this radius — try next immediately
    console.log(`[ADVANCE] ride=${rideId} radius=${nextRadius}m — no new drivers, trying next`);
  }

  // All radii exhausted
  console.log(`[ADVANCE] ride=${rideId} — all radii exhausted, escalating (afterSurge=${afterSurge})`);
  await _escalate(rideId, rideType, !!afterSurge, pickupLat, pickupLng);
}

// ── Surge grace: customer ignores 100s surge window → final failure ──────────
async function _bmqSurgeGraceTimeout({ rideId, pickupLat, pickupLng, rideType }) {
  const rideCheck = await db.query(
    `SELECT id, surge_count FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
    [rideId]
  );
  if (!rideCheck.rows[0]) return;
  if (parseInt(rideCheck.rows[0].surge_count) > 0) return; // customer accepted surge
  await _escalate(rideId, rideType, true, pickupLat, pickupLng);
}

// ── Escalation: first failure → surge offer, second → no_driver_final ────────
async function _escalate(rideId, rideType, afterSurge, pickupLat, pickupLng) {
  if (afterSurge) {
    // Guard: if the stale-ride cron already cancelled this ride (rare but possible
    // when BullMQ jobs are delayed past the 15-min cleanup window), skip the
    // duplicate notification — the cron already sent one.
    const statusRow = await db.query(`SELECT status FROM rides WHERE id=$1`, [rideId]);
    if (!statusRow.rows[0] || statusRow.rows[0].status !== 'requested') {
      console.log(`[ESCALATE] ride=${rideId} already ${statusRow.rows[0]?.status || 'gone'} — skipping duplicate no-driver notification`);
      return;
    }

    const [alts, pRes, schedRes] = await Promise.all([
      getAvailableAlternatives(rideType).catch(() => []),
      db.query(`SELECT u.phone FROM rides r JOIN users u ON r.passenger_id::text = u.id::text WHERE r.id=$1`, [rideId]),
      db.query(`SELECT id FROM scheduled_rides WHERE ride_id=$1`, [rideId]),
    ]);
    const customerPhone = pRes.rows[0]?.phone;
    const isScheduled   = schedRes.rows.length > 0;
    if (customerPhone) {
      const noDriverTitle = '😔 Driver Nahi Mila';
      const noDriverBody  = isScheduled
        ? 'Aapki scheduled ride ke liye koi driver available nahi hai. Please dobara book karein.'
        : (alts.length ? 'Doosra vehicle try karo ya thodi der baad retry karo.' : 'Is area mein abhi koi driver nahi. 5 min baad try karo.');
      // FCM push notification (once)
      sendFCM(
        customerPhone, noDriverTitle, noDriverBody,
        { type: 'no_driver_found', ride_id: String(rideId) }, { role: 'customer' }
      ).catch(() => {});
      // Internal notification (visible in app notification centre)
      db.query(
        `INSERT INTO notifications (user_phone, title, body, created_at) VALUES ($1, $2, $3, NOW())`,
        [customerPhone, noDriverTitle, noDriverBody]
      ).catch(() => {});
    }
    emitToRoom('ride_' + rideId, 'rideUpdate', {
      rideId, status: 'no_driver_final', alternatives: alts, retry_after_sec: 300,
      message: 'Abhi koi driver nahi mila.',
    });
    await db.query(
      `UPDATE rides SET status='cancelled' WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
      [rideId]
    );
    // If this was a scheduled ride, mark it failed so the customer can rebook
    if (isScheduled && schedRes.rows[0]) {
      await db.query(
        `UPDATE scheduled_rides SET status='failed', failed_reason='No driver found after exhausting all radius levels', updated_at=NOW()
         WHERE id=$1 AND status='dispatched'`,
        [schedRes.rows[0].id]
      ).catch(() => {});
    }
  } else {
    const surgeInfo = await _computeSurgeOffer(pickupLat, pickupLng, rideId);
    emitToRoom('ride_' + rideId, 'rideUpdate', {
      rideId, status: 'surge_offer',
      suggested_surge_amt: surgeInfo.amt, surge_label: surgeInfo.label,
      message: `Koi driver nahi mila. ₹${surgeInfo.amt} extra dekar driver attract karein?`,
      timeout_sec: SURGE_GRACE_SEC,
    });
    rideQueue.add('ride-assignment',
      { type: 'surge-grace-timeout', rideId, pickupLat, pickupLng, rideType },
      { delay: SURGE_GRACE_SEC * 1000 }
    ).catch(() => {});
  }
}

async function _computeSurgeOffer(pickupLat, pickupLng, rideId) {
  try {
    const [multiplier, rideRes] = await Promise.all([
      getSurgeMultiplier(parseFloat(pickupLat) || 0, parseFloat(pickupLng) || 0),
      db.query('SELECT fare FROM rides WHERE id=$1', [rideId]),
    ]);
    const fare = parseInt(rideRes.rows[0]?.fare) || 0;
    let amt = 25;
    if (multiplier >= 2.0) amt = 65; else if (multiplier >= 1.5) amt = 40;
    const pctAmt = Math.round(fare * 0.25 / 5) * 5;
    if (pctAmt > amt && pctAmt <= 100) amt = pctAmt;
    const VALID = [15, 25, 40, 65, 100];
    return { amt: VALID.reduce((a, b) => Math.abs(b - amt) < Math.abs(a - amt) ? b : a), label: '+₹' + amt };
  } catch (_e) {
    return { amt: 25, label: '+₹25' };
  }
}

async function getAvailableAlternatives(rideType) {
  const alts = VEHICLE_ALTERNATIVES[rideType] || [];
  if (alts.length === 0) return [];
  const r = await db.query(
    `SELECT d.vehicle_type, COUNT(*) AS cnt FROM drivers d JOIN users u ON d.id = u.id
     WHERE d.vehicle_type = ANY($1) AND d.is_online = true AND d.verification_status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM rides r2 WHERE r2.driver_id = d.id AND r2.status IN ('matched','arrived','started'))
     GROUP BY d.vehicle_type`,
    [alts]
  );
  const available = new Set(r.rows.filter(row => parseInt(row.cnt) > 0).map(row => row.vehicle_type));
  return alts.filter(a => available.has(a));
}

// ── Fallback: buddy ignored direct request → start normal broadcast ───────────
// Also handles the 3-second cron's stuck-ride recovery path.
async function _bmqAssignNext({ rideId, pickupLat, pickupLng, rideType }) {
  // Only act if ride is still unmatched AND the assignment window has expired
  // (prevents duplicate broadcast if another job already started one)
  const r = await db.query(
    `SELECT id FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL
     AND (assignment_expires_at IS NULL OR assignment_expires_at < NOW())`,
    [rideId]
  );
  if (!r.rows[0]) { console.log(`[ASSIGN-NEXT] ride=${rideId} — already matched or window still active, skip`); return; }
  console.log(`[ASSIGN-NEXT] ride=${rideId} type=${rideType} — starting normal broadcast`);
  await assignRideToNextDriver(rideId, pickupLat, pickupLng, rideType, null, null, false);
}

// ── Public entry point: walk ALL radii in-process until drivers found ────────
// BullMQ is only used for the "advance after the acceptance window" step.
// Walking radii in-process means a Redis/BullMQ hiccup can't silently strand
// a ride at 500 m — every new booking always finds the nearest available driver.
async function assignRideToNextDriver(rideId, pickupLat, pickupLng, rideType, _ignored_queue, _ignored_radius, afterSurge = false) {
  console.log(`[BROADCAST] ▶ Starting broadcast ride=${rideId} type=${rideType} afterSurge=${afterSurge}`);

  // Helper: walk all radius levels for a given vehicle type, return true if drivers found
  async function _walkRadii(searchType, offeredPhones) {
    for (let i = 0; i < RADIUS_LEVELS_M.length; i++) {
      let result;
      try {
        result = await broadcastToRadius(rideId, pickupLat, pickupLng, searchType, RADIUS_LEVELS_M[i], offeredPhones);
      } catch (e) {
        console.error(`[BROADCAST] ride=${rideId} radius=${RADIUS_LEVELS_M[i]}m error:`, e.message);
        result = { sent: 0, phones: [] };
      }
      if (result.sent > 0) {
        offeredPhones.push(...result.phones);
        rideQueue.add('ride-assignment', {
          type: 'broadcast-advance', rideId, pickupLat, pickupLng,
          rideType: searchType, radiusM: RADIUS_LEVELS_M[i], afterSurge: !!afterSurge,
        }, { delay: WINDOW_SEC * 1000 + 1000 }).catch(e =>
          console.error(`[BROADCAST] ride=${rideId} BullMQ.add failed:`, e.message)
        );
        return true;
      }
      console.log(`[BROADCAST] ride=${rideId} type=${searchType} radius=${RADIUS_LEVELS_M[i]}m — 0 drivers`);
    }
    return false;
  }

  const offeredPhones = [];

  // 1. Try exact vehicle type first
  if (await _walkRadii(rideType, offeredPhones)) return;

  // 2. Exact type exhausted — try VEHICLE_ALTERNATIVES before giving up
  const altTypes = VEHICLE_ALTERNATIVES[rideType] || [];
  if (altTypes.length > 0) {
    console.log(`[BROADCAST] ride=${rideId} type=${rideType} — 0 exact drivers; trying alternatives: ${altTypes.join(',')}`);
    for (const alt of altTypes) {
      if (await _walkRadii(alt, offeredPhones)) {
        console.log(`[BROADCAST] ride=${rideId} — matched via alt type=${alt}`);
        return;
      }
    }
  }

  // 3. All radius levels + all alternatives exhausted → escalate now
  console.log(`[BROADCAST] ride=${rideId} — all radii + alternatives exhausted, escalating`);
  await _escalate(rideId, rideType, !!afterSurge, pickupLat, pickupLng);
}

module.exports = { rideQueue, rideWorker, assignRideToNextDriver, broadcastToRadius };
