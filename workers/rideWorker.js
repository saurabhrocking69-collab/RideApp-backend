const { Queue, Worker } = require('bullmq');
const db = require('../config/db');
const { makeBmqConn } = require('../config/redis');
const { sendFCM } = require('../config/firebase');
const { emitToRoom } = require('../config/socket');
const { haversineKm } = require('../services/matching');
const { getSurgeMultiplier } = require('../services/locationIntelligence');

const rideQueue = new Queue('ride-assignment', { connection: makeBmqConn() });

// ── Broadcast radius progression (meters) ───────────────────────────────────
const RADIUS_LEVELS_M       = [500, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000];
const WINDOW_SEC            = 30;   // each radius level gets 30 seconds (real-time rides)
const SCHEDULED_WINDOW_SEC  = 120;  // 2-minute window for scheduled rides — drivers need time to open app
const SURGE_GRACE_SEC       = 100;  // customer has 100s to accept surge offer
const STALE_GPS_MS          = 15 * 60 * 1000; // 15 min — location older than this → include anyway
const PRE_ASSIGN_OFFER_SEC  = 180;  // driver has 3 min to respond to pre-queue offer
// Pre-assignment thresholds
const PRE_ASSIGN_DRIVER_TO_DROP_KM  = 0.4; // driver must be within 400m of their own drop point
const PRE_ASSIGN_DROP_TO_CUSTOMER_KM = 0.5; // that drop must be within 500m of new customer's pickup

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
  if (d.type === 'broadcast-advance')      await _bmqBroadcastAdvance(d).catch(e => console.error('[ADVANCE] error:', e.message));
  if (d.type === 'surge-grace-timeout')    await _bmqSurgeGraceTimeout(d).catch(e => console.error('[SURGE_TIMEOUT] error:', e.message));
  if (d.type === 'assign-next')            await _bmqAssignNext(d).catch(e => console.error('[ASSIGN-NEXT] error:', e.message));
  if (d.type === 'pre-assign-timeout')     await _bmqPreAssignTimeout(d).catch(e => console.error('[PRE-ASSIGN-TIMEOUT] error:', e.message));
  if (d.type === 'pre-assign-recheck')     await _bmqPreAssignRecheck(d).catch(e => console.error('[PRE-ASSIGN-RECHECK] error:', e.message));
  // NOTE: unlike the other job types above, this one does NOT swallow its
  // error — it rethrows after logging so BullMQ's attempts/backoff (set at
  // enqueue time) actually retries a transient failure (e.g. a DB blip
  // mid-deploy) instead of silently stranding the ride forever.
  if (d.type === 'dispatch-scheduled-ride') {
    await _bmqDispatchScheduledRide(d).catch(e => { console.error('[SCHED_DISPATCH] error:', e.message); throw e; });
  }
}, { connection: makeBmqConn(), concurrency: 5 });

rideWorker.on('failed', (job, err) => {
  console.error('❌ BullMQ job failed:', job?.id, err.message);
});

// ── Broadcast ride to ALL eligible drivers within radiusM ────────────────────
// Returns { sent: number, phones: string[] }
async function broadcastToRadius(rideId, pickupLat, pickupLng, rideType, radiusM, alreadyOfferedPhones, windowSec = WINDOW_SEC) {
  console.log(`[BROADCAST] ride=${rideId} type=${rideType} radius=${radiusM}m window=${windowSec}s alreadyOffered=${alreadyOfferedPhones.length}`);

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
         )
         AND NOT EXISTS (
           SELECT 1 FROM hourly_bookings hb
           WHERE hb.driver_phone = u.phone AND hb.status IN ('matched','arrived','active')
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
    // No pickup coords → include all online drivers (can't determine distance)
    if (!pickupLat || !pickupLng) return true;
    // Driver has no GPS record yet (just came online) → include (benefit of doubt)
    if (!dr.lat || !dr.lng) {
      console.log(`[BROADCAST] ride=${rideId} — driver ${dr.phone} included (no GPS yet)`);
      return true;
    }
    // GPS is stale (>15 min old) → include anyway; last known location is unreliable
    if (dr.loc_ts && (now - new Date(dr.loc_ts).getTime()) > STALE_GPS_MS) {
      console.log(`[BROADCAST] ride=${rideId} — driver ${dr.phone} included (stale GPS ${Math.round((now - new Date(dr.loc_ts).getTime()) / 60000)}m old)`);
      return true;
    }
    // Driver has fresh GPS → strict distance check using last known location
    const distKm = haversineKm(parseFloat(pickupLat), parseFloat(pickupLng), parseFloat(dr.lat), parseFloat(dr.lng));
    const withinRange = distKm * 1000 <= radiusM;
    if (!withinRange) console.log(`[BROADCAST] ride=${rideId} — driver ${dr.phone} excluded (${distKm.toFixed(1)}km > ${(radiusM/1000).toFixed(1)}km)`);
    return withinRange;
  });

  console.log(`[BROADCAST] ride=${rideId} radius=${radiusM}m — total_online=${drRes.rows.length} new_eligible=${eligible.length} phones=${JSON.stringify(eligible.map(d => d.phone))}`);

  if (eligible.length === 0) {
    return { sent: 0, phones: [] };
  }

  const eligiblePhones = eligible.map(d => d.phone);
  const allOffered = [...alreadyOfferedPhones, ...eligiblePhones];

  // Update ride: set acceptance window, current radius, add to offered_phones
  await db.query(
    `UPDATE rides
     SET assignment_expires_at = NOW() + INTERVAL '${windowSec} seconds',
         current_radius_m = $1,
         offered_phones = $2::text[],
         assigned_to_phone = NULL
     WHERE id = $3 AND status = 'requested' AND driver_id IS NULL`,
    [radiusM, allOffered, rideId]
  );

  // Check if this is a scheduled and/or intercity ride so we can label it correctly for the driver
  const schedRow = await db.query(
    `SELECT scheduled_at, is_scheduled, is_intercity, is_roundtrip, fare, distance_km FROM rides WHERE id=$1`,
    [rideId]
  ).catch(() => ({ rows: [] }));
  const isScheduledRide = schedRow.rows[0]?.is_scheduled;
  const scheduledAt     = schedRow.rows[0]?.scheduled_at;
  const isIntercity     = schedRow.rows[0]?.is_intercity;
  const isRoundtrip     = schedRow.rows[0]?.is_roundtrip;
  const icFare          = Math.round(parseFloat(schedRow.rows[0]?.fare || 0));
  const icKm            = Math.round(parseFloat(schedRow.rows[0]?.distance_km || 0));
  const scheduledTimeStr = scheduledAt
    ? new Date(scheduledAt).toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
    : null;

  // Broadcast to all eligible drivers simultaneously
  const rideEmoji = { bike: '🏍️', auto: '🛺', car: '🚕', eriksha: '🛵', luxury: '🚙', electric_auto: '🌿', green_bike: '⚡' }[rideType] || '🚗';
  for (const dr of eligible) {
    emitToRoom('driver_' + dr.phone, 'newRideRequest', {
      rideId, secondsToAccept: windowSec, radiusM,
      isScheduled: !!isScheduledRide, scheduledAt: scheduledAt || null,
      isIntercity: !!isIntercity, isRoundtrip: !!isRoundtrip,
    });
    const icLabel = isRoundtrip ? 'ROUND TRIP' : 'ONE WAY';
    const fcmTitle = isIntercity
      ? (isScheduledRide ? `🛣️ Intercity ${icLabel} — ${scheduledTimeStr}` : `🛣️ INTERCITY ${icLabel} — ₹${icFare}!`)
      : isScheduledRide
        ? `📅 Scheduled Ride — ${scheduledTimeStr}`
        : `${rideEmoji} Nayi Ride Request!`;
    const fcmBody = isIntercity
      ? `${icKm}km intercity trip, ₹${icFare} fare — badi kamai! ${isScheduledRide ? `Departure ${scheduledTimeStr}.` : `Accept within ${windowSec}s!`}`
      : isScheduledRide
        ? `${rideEmoji} ${(rideType || '').toUpperCase()} — for ${scheduledTimeStr}. Accept now, you have time!`
        : `${rideType.toUpperCase()} ride — accept within ${windowSec}s!`;
    sendFCM(
      dr.phone,
      fcmTitle,
      fcmBody,
      { type: 'new_ride', ride_id: String(rideId), is_scheduled: isScheduledRide ? 'true' : 'false', scheduled_at: scheduledAt ? String(scheduledAt) : '', is_intercity: isIntercity ? 'true' : 'false' },
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
async function _bmqBroadcastAdvance({ rideId, pickupLat, pickupLng, rideType, radiusM, afterSurge, isScheduled }) {
  const windowSec = isScheduled ? SCHEDULED_WINDOW_SEC : WINDOW_SEC;
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
    const result = await broadcastToRadius(rideId, pickupLat, pickupLng, rideType, nextRadius, currentOffered, windowSec);
    if (result.sent > 0) {
      // Found drivers at this radius — schedule next advance
      await rideQueue.add('ride-assignment', {
        type: 'broadcast-advance', rideId, pickupLat, pickupLng, rideType,
        radiusM: nextRadius, afterSurge: !!afterSurge, isScheduled: !!isScheduled,
      }, { delay: windowSec * 1000 + 1000 }).catch(e => console.error('[ADVANCE] BullMQ add failed:', e.message));
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

// ── Pre-assignment: find a busy driver who is almost at their drop, near the new customer ──
// Returns the best candidate object or null. excludePhones prevents re-offering declined drivers.
async function findPreAssignableDriver(pickupLat, pickupLng, rideType, excludePhones = []) {
  const busyDrivers = await db.query(
    `SELECT u.phone, u.name AS driver_name,
            d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.rating,
            dl.lat AS driver_lat, dl.lng AS driver_lng, dl.updated_at AS loc_ts,
            r.id AS active_ride_id, r.drop_lat, r.drop_lng
     FROM rides r
     JOIN users u ON r.driver_id = u.id
     JOIN drivers d ON d.id = u.id
     LEFT JOIN driver_locations dl ON dl.phone = u.phone
     WHERE r.status IN ('matched','arrived','started')
       AND d.vehicle_type = $1
       AND d.is_online = true
       AND d.verification_status = 'approved'
       AND dl.lat IS NOT NULL
       AND dl.updated_at > NOW() - INTERVAL '10 minutes'`,
    [rideType]
  );

  const cLat = parseFloat(pickupLat);
  const cLng = parseFloat(pickupLng);
  const excludeSet = new Set(excludePhones);

  const candidates = busyDrivers.rows
    .filter(dr => {
      if (excludeSet.has(dr.phone)) return false;
      if (!dr.drop_lat || !dr.drop_lng) return false;
      const distToDropKm     = haversineKm(parseFloat(dr.driver_lat), parseFloat(dr.driver_lng), parseFloat(dr.drop_lat), parseFloat(dr.drop_lng));
      const distDropToCustKm = haversineKm(parseFloat(dr.drop_lat), parseFloat(dr.drop_lng), cLat, cLng);
      return distToDropKm <= PRE_ASSIGN_DRIVER_TO_DROP_KM && distDropToCustKm <= PRE_ASSIGN_DROP_TO_CUSTOMER_KM;
    })
    .map(dr => ({
      ...dr,
      dropToCustKm: haversineKm(parseFloat(dr.drop_lat), parseFloat(dr.drop_lng), cLat, cLng),
    }))
    .sort((a, b) => a.dropToCustKm - b.dropToCustKm);

  return candidates[0] || null;
}

// ── Offer a pre-assignment slot to a candidate driver ─────────────────────────
async function _offerPreAssignment(rideId, rideType, pickupLat, pickupLng, candidate, excludePhones = []) {
  // Re-check ride still searching
  const rideCheck = await db.query(
    `SELECT id, pickup, fare FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
    [rideId]
  );
  if (!rideCheck.rows[0]) return;
  const ride = rideCheck.rows[0];

  // ETA estimate: haversine drop→customer at 30 km/h city + 5 min buffer
  const etaMin = Math.max(3, Math.ceil(candidate.dropToCustKm / 0.5) + 5);

  await db.query(
    `UPDATE rides
     SET status = 'pre_assigned', pre_accepted_driver_phone = $1, pre_accepted_at = NOW()
     WHERE id = $2 AND status = 'requested' AND driver_id IS NULL`,
    [candidate.phone, rideId]
  );

  // Notify customer
  emitToRoom('ride_' + rideId, 'rideUpdate', {
    rideId, status: 'pre_assigned',
    driver: {
      name: candidate.driver_name, phone: candidate.phone,
      vehicle_no: candidate.vehicle_no, vehicle_brand: candidate.vehicle_brand,
      vehicle_model: candidate.vehicle_model, rating: parseFloat(candidate.rating) || 5.0,
    },
    eta_min: etaMin,
    message: 'Driver mil gaya — woh apni current ride complete karke aayenge',
  });

  // Notify driver via socket + FCM
  const rideEmoji = { bike: '🏍️', auto: '🛺', car: '🚕', eriksha: '🛵', luxury: '🚙', electric_auto: '🌿', green_bike: '⚡' }[rideType] || '🚗';
  emitToRoom('driver_' + candidate.phone, 'preRideQueued', {
    rideId, pickup: ride.pickup, fare: '₹' + Math.round(parseFloat(ride.fare)),
    rideType, etaMin,
  });
  sendFCM(
    candidate.phone,
    `${rideEmoji} Next Ride Ready!`,
    `${ride.pickup} · Go straight after drop — respond within ${PRE_ASSIGN_OFFER_SEC / 60} min`,
    { type: 'pre_ride_queued', ride_id: String(rideId) },
    { channelId: 'ride_requests', role: 'driver' }
  ).catch(() => {});

  // Timeout: if driver never responds, try next candidate or surge
  rideQueue.add('ride-assignment', {
    type: 'pre-assign-timeout', rideId, rideType, pickupLat, pickupLng,
    offeredDriverPhone: candidate.phone,
    excludePhones: [...excludePhones, candidate.phone],
  }, { delay: PRE_ASSIGN_OFFER_SEC * 1000 }).catch(() => {});

  console.log(`[PRE-ASSIGN] ride=${rideId} offered to driver=${candidate.phone} eta=${etaMin}min`);
}

// ── Pre-assign timeout: driver never responded → try next or surge ────────────
async function _bmqPreAssignTimeout({ rideId, rideType, pickupLat, pickupLng, offeredDriverPhone, excludePhones = [] }) {
  const r = await db.query(
    `SELECT id FROM rides WHERE id=$1 AND status='pre_assigned' AND pre_accepted_driver_phone=$2`,
    [rideId, offeredDriverPhone]
  );
  if (!r.rows[0]) {
    console.log(`[PRE-ASSIGN-TIMEOUT] ride=${rideId} — already handled`);
    return;
  }
  console.log(`[PRE-ASSIGN-TIMEOUT] ride=${rideId} driver=${offeredDriverPhone} timed out — trying next`);
  // Revert to requested, then try pre-assign again or fall to surge
  await db.query(
    `UPDATE rides SET status='requested', pre_accepted_driver_phone=NULL, pre_accepted_at=NULL
     WHERE id=$1 AND status='pre_assigned' AND pre_accepted_driver_phone=$2`,
    [rideId, offeredDriverPhone]
  );
  const next = await findPreAssignableDriver(pickupLat, pickupLng, rideType, excludePhones).catch(() => null);
  if (next) {
    await _offerPreAssignment(rideId, rideType, pickupLat, pickupLng, next, excludePhones);
  } else {
    await _escalate(rideId, rideType, false, pickupLat, pickupLng, true /* skipPreAssign */);
  }
}

// ── Pre-assign recheck: driver declined → try next or surge ──────────────────
async function _bmqPreAssignRecheck({ rideId, rideType, pickupLat, pickupLng, excludePhones = [] }) {
  const r = await db.query(
    `SELECT id FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
    [rideId]
  );
  if (!r.rows[0]) return;
  const next = await findPreAssignableDriver(pickupLat, pickupLng, rideType, excludePhones).catch(() => null);
  if (next) {
    await _offerPreAssignment(rideId, rideType, pickupLat, pickupLng, next, excludePhones);
  } else {
    await _escalate(rideId, rideType, false, pickupLat, pickupLng, true /* skipPreAssign */);
  }
}

// ── Activate a pre-assigned ride when driver finishes their current trip ──────
// Called from the payment endpoints in rides.js after payment is confirmed.
async function activateQueuedRide(driverPhone) {
  const r = await db.query(
    `SELECT r.id, r.pickup, r.drop_location, r.fare, r.ride_type,
            u.phone AS passenger_phone
     FROM rides r
     JOIN users u ON r.passenger_id = u.id
     WHERE r.status = 'pre_assigned' AND r.pre_accepted_driver_phone = $1
     LIMIT 1`,
    [driverPhone]
  );
  if (!r.rows[0]) return;
  const pr = r.rows[0];

  const driverRes = await db.query(
    `SELECT u.phone, u.name, d.vehicle_type, d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.rating
     FROM drivers d JOIN users u ON d.id = u.id WHERE u.phone = $1`,
    [driverPhone]
  );
  if (!driverRes.rows[0]) return;
  const driver = driverRes.rows[0];

  // Assign ride to driver
  await db.query(
    `UPDATE rides
     SET status = 'matched', driver_id = (SELECT id FROM users WHERE phone = $1),
         matched_at = NOW(), pre_accepted_driver_phone = NULL, pre_accepted_at = NULL
     WHERE id = $2 AND status = 'pre_assigned'`,
    [driverPhone, pr.id]
  );

  const driverPayload = {
    name: driver.name, phone: driver.phone, vehicle_type: driver.vehicle_type,
    vehicle_no: driver.vehicle_no, vehicle_brand: driver.vehicle_brand,
    vehicle_model: driver.vehicle_model, rating: parseFloat(driver.rating) || 5.0,
  };

  // Tell customer their driver is now matched
  emitToRoom('ride_' + pr.id, 'rideUpdate', {
    rideId: pr.id, status: 'matched', driver: driverPayload,
    message: 'Driver is on the way to you!',
  });

  // Tell driver their queued ride is now active
  emitToRoom('driver_' + driverPhone, 'preRideActivated', {
    rideId: pr.id, pickup: pr.pickup, dropLocation: pr.drop_location,
    fare: '₹' + Math.round(parseFloat(pr.fare)), rideType: pr.ride_type,
  });
  sendFCM(
    driverPhone,
    '🏍️ Queued Ride Active!',
    `Ab jao: ${pr.pickup}`,
    { type: 'pre_ride_activated', ride_id: String(pr.id) },
    { channelId: 'ride_requests', role: 'driver' }
  ).catch(() => {});

  console.log(`[PRE-ASSIGN] ride=${pr.id} activated for driver=${driverPhone}`);
}

// ── Escalation: first failure → surge offer, second → no_driver_final ────────
async function _escalate(rideId, rideType, afterSurge, pickupLat, pickupLng, skipPreAssign = false) {
  console.log(`[ESCALATE] ride=${rideId} type=${rideType} afterSurge=${afterSurge}`);
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
      const noDriverTitle = '😔 No Driver Found';
      const noDriverBody  = isScheduled
        ? 'No driver available for your scheduled ride. Please book again.'
        : (alts.length ? 'Try a different vehicle or retry in a few minutes.' : 'No driver available in this area right now. Try again in 5 min.');
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
      message: 'No driver found right now.',
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
    // Scheduled rides skip surge — go straight to no_driver_final so the customer
    // isn't waiting on an offer they can't interact with at pickup time.
    const schedCheck = await db.query(
      `SELECT id FROM scheduled_rides WHERE ride_id=$1 AND status='dispatched'`,
      [rideId]
    ).catch(() => ({ rows: [] }));
    if (schedCheck.rows.length > 0) {
      console.log(`[ESCALATE] ride=${rideId} — scheduled, skipping surge → no_driver_final`);
      return _escalate(rideId, rideType, true, pickupLat, pickupLng, skipPreAssign);
    }

    // Before showing surge offer, check if a busy driver is almost at their drop
    // and close enough to the customer to pre-assign this ride.
    if (!skipPreAssign && pickupLat && pickupLng) {
      const candidate = await findPreAssignableDriver(pickupLat, pickupLng, rideType, []).catch(() => null);
      if (candidate) {
        await _offerPreAssignment(rideId, rideType, pickupLat, pickupLng, candidate, []);
        return; // customer stays in matching; driver gets special offer
      }
    }

    const surgeInfo = await _computeSurgeOffer(pickupLat, pickupLng, rideId);
    console.log(`[ESCALATE] ride=${rideId} — emitting surge_offer to room ride_${rideId} amt=${surgeInfo.amt}`);
    emitToRoom('ride_' + rideId, 'rideUpdate', {
      rideId, status: 'surge_offer',
      suggested_surge_amt: surgeInfo.amt, surge_label: surgeInfo.label,
      message: `No driver found. Add ₹${surgeInfo.amt} to attract a driver?`,
      timeout_sec: SURGE_GRACE_SEC,
    });
    setTimeout(() => {
      _bmqSurgeGraceTimeout({ rideId, pickupLat, pickupLng, rideType })
        .catch(e => console.error(`[SURGE_TIMEOUT] handler error ride=${rideId}:`, e.message));
    }, SURGE_GRACE_SEC * 1000);
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
       AND NOT EXISTS (SELECT 1 FROM hourly_bookings hb WHERE hb.driver_phone = u.phone AND hb.status IN ('matched','arrived','active'))
     GROUP BY d.vehicle_type`,
    [alts]
  );
  const available = new Set(r.rows.filter(row => parseInt(row.cnt) > 0).map(row => row.vehicle_type));
  return alts.filter(a => available.has(a));
}

// ── Dispatch a scheduled ride at T-15min ─────────────────────────────────────
async function _bmqDispatchScheduledRide({ ride_id, scheduled_ride_id, pickup_lat, pickup_lng, ride_type, passenger_phone }) {
  console.log(`[SCHED_DISPATCH] ride=${ride_id} — T-15min, starting driver match`);

  // Check ride is still waiting (customer may have cancelled)
  const rideRow = await db.query(
    `SELECT id, pickup_lat, pickup_lng, ride_type, scheduled_at FROM rides WHERE id=$1 AND status='scheduled'`,
    [ride_id]
  );
  if (!rideRow.rows[0]) {
    console.log(`[SCHED_DISPATCH] ride=${ride_id} — not in scheduled state, abort`);
    return;
  }

  // Flip status to 'requested' so broadcastToRadius can pick it up
  await db.query(`UPDATE rides SET status='requested' WHERE id=$1`, [ride_id]);
  await db.query(
    `UPDATE scheduled_rides SET status='dispatched', updated_at=NOW() WHERE ride_id=$1`,
    [ride_id]
  );

  // Notify customer that matching has started
  const pRes = await db.query(
    `SELECT u.phone FROM rides r JOIN users u ON r.passenger_id::text=u.id::text WHERE r.id=$1`,
    [ride_id]
  ).catch(() => ({ rows: [] }));
  const cPhone = pRes.rows[0]?.phone || passenger_phone;
  if (cPhone) {
    sendFCM(
      cPhone,
      '🚗 Finding Your Driver',
      'We\'re matching a driver for your scheduled ride right now. Please stay nearby.',
      { type: 'scheduled_matching', ride_id: String(ride_id) },
      { role: 'customer' }
    ).catch(() => {});
  }

  const lat  = rideRow.rows[0].pickup_lat  ?? pickup_lat;
  const lng  = rideRow.rows[0].pickup_lng  ?? pickup_lng;
  const type = rideRow.rows[0].ride_type   ?? ride_type;

  // The generous 120s-per-radius-level "scheduled" window exists to give
  // drivers advance notice when this fires at its intended T-15min moment.
  // If we're dispatching AT or AFTER the customer's actual pickup time
  // (late original firing, or a health-check recovery run well past due),
  // the customer is waiting right now -- dispatch urgently (30s/level) like
  // a real-time ride instead of making them wait up to 24 more minutes.
  const scheduledAt = rideRow.rows[0].scheduled_at;
  const isStillAdvanceNotice = scheduledAt ? new Date(scheduledAt).getTime() > Date.now() : true;
  if (!isStillAdvanceNotice) console.log(`[SCHED_DISPATCH] ride=${ride_id} — dispatching past its scheduled time, using urgent window`);

  await assignRideToNextDriver(ride_id, lat, lng, type, null, null, false, isStillAdvanceNotice);
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
async function assignRideToNextDriver(rideId, pickupLat, pickupLng, rideType, _ignored_queue, _ignored_radius, afterSurge = false, isScheduled = false) {
  const windowSec = isScheduled ? SCHEDULED_WINDOW_SEC : WINDOW_SEC;
  console.log(`[BROADCAST] ▶ Starting broadcast ride=${rideId} type=${rideType} afterSurge=${afterSurge} isScheduled=${isScheduled} window=${windowSec}s`);

  // Diagnostic: show ALL online drivers and their approval status
  db.query(`SELECT u.phone, d.vehicle_type, d.is_online, d.verification_status FROM drivers d JOIN users u ON d.id=u.id WHERE d.is_online=true`)
    .then(r => console.log(`[BROADCAST] ride=${rideId} — online driver snapshot: ${JSON.stringify(r.rows.map(d => ({p:d.phone,t:d.vehicle_type,s:d.verification_status})))}`))
    .catch(() => {});

  // Helper: walk all radius levels for a given vehicle type, return true if drivers found
  async function _walkRadii(searchType, offeredPhones) {
    for (let i = 0; i < RADIUS_LEVELS_M.length; i++) {
      let result;
      try {
        result = await broadcastToRadius(rideId, pickupLat, pickupLng, searchType, RADIUS_LEVELS_M[i], offeredPhones, windowSec);
      } catch (e) {
        console.error(`[BROADCAST] ride=${rideId} radius=${RADIUS_LEVELS_M[i]}m error:`, e.message);
        result = { sent: 0, phones: [] };
      }
      if (result.sent > 0) {
        offeredPhones.push(...result.phones);
        // setTimeout is reliable on single-instance Railway; BullMQ was dropping jobs silently.
        setTimeout(() => {
          _bmqBroadcastAdvance({ rideId, pickupLat, pickupLng, rideType: searchType, radiusM: RADIUS_LEVELS_M[i], afterSurge: !!afterSurge, isScheduled: !!isScheduled })
            .catch(e => console.error(`[ADVANCE] handler error ride=${rideId}:`, e.message));
        }, (windowSec + 1) * 1000);
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

module.exports = { rideQueue, rideWorker, assignRideToNextDriver, broadcastToRadius, activateQueuedRide, dispatchScheduledRide: _bmqDispatchScheduledRide };
