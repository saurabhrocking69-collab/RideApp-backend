const { Queue, Worker } = require('bullmq');
const db = require('../config/db');
const { makeBmqConn } = require('../config/redis');
const { sendFCM } = require('../config/firebase');
const { emitToRoom } = require('../config/socket');
const { haversineKm, scoreDriver } = require('../services/matching');
const { getSurgeMultiplier } = require('../services/locationIntelligence');

const rideQueue = new Queue('ride-assignment', { connection: makeBmqConn() });

const ASSIGNMENT_WINDOW_SEC = 20;                         // each driver gets 20s
const AUTO_ADVANCE_MS       = ASSIGNMENT_WINDOW_SEC * 1000 + 2000; // 22s with grace
const SURGE_GRACE_MS        = 20_000; // customer has 20s to respond to surge offer
const RADIUS_EXPAND_MS      = 1500;   // delay between radius expansions (was 3000)

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

const rideWorker = new Worker('ride-assignment', async (job) => {
  const d = job.data;
  if (d.type === 'assign-next')        await _bmqAssignNext(d);
  if (d.type === 'auto-advance')       await _bmqAutoAdvance(d);
  if (d.type === 'surge-grace-timeout') await _bmqSurgeGraceTimeout(d);
}, { connection: makeBmqConn(), concurrency: 5 });

rideWorker.on('failed', (job, err) => {
  console.error('❌ BullMQ job failed:', job?.id, err.message);
});

// ── Send ride request to one driver at a time, 20s per driver ────────────────
async function _bmqAssignNext({ rideId, pickupLat, pickupLng, rideType, queue, radiusKm = 5, offeredPhones = [], wasFavouriteTimeout = false, buddyName = null, afterSurge = false, retryRound = 0 }) {
  let remaining = queue;

  if (remaining === null || remaining === undefined) {
    // Build a fresh scored queue
    const [rideCheck, drRes] = await Promise.all([
      db.query(
        `SELECT id, ride_type, COALESCE(offered_phones, '{}') AS offered_phones
         FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
      ),
      db.query(
        `SELECT u.phone,
                COALESCE(d.rating, 5.0)                                AS rating,
                COALESCE(dm.acceptance_rate, 100)                      AS acceptance_rate,
                COALESCE(dm.idle_since, NOW() - INTERVAL '30 minutes') AS idle_since,
                dl.lat, dl.lng,
                dl.updated_at AS loc_updated_at
         FROM drivers d
         JOIN users u ON d.id = u.id
         LEFT JOIN driver_metrics dm ON dm.phone = u.phone
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
    if (!rideCheck.rows[0]) { console.log(`[MATCH] ride=${rideId} ABORT — ride not found or already matched`); return; }
    if (rideCheck.rows[0].ride_type !== rideType) { console.log(`[MATCH] ride=${rideId} ABORT — ride_type mismatch`); return; }

    if (drRes.rows.length === 0) {
      console.log(`[MATCH] ride=${rideId} type=${rideType} — 0 online+approved drivers with this vehicle type in entire DB`);
    }

    if (wasFavouriteTimeout) {
      const name = buddyName || 'Aapka favourite buddy';
      emitToRoom('ride_' + rideId, 'rideUpdate', {
        rideId, status: 'buddy_timeout',
        message: `${name} ne respond nahi kiya — ab doosre drivers dhundh rahe hain`,
      });
    }

    const alreadyOffered = new Set([
      ...((rideCheck.rows[0].offered_phones) || []),
      ...offeredPhones,
    ]);

    const now = Date.now();
    const STALE_MS = 15 * 60 * 1000;
    const scored = drRes.rows
      .filter(dr => !alreadyOffered.has(dr.phone))
      .map(dr => {
        let distKm = null;
        const locAge = dr.loc_updated_at ? (now - new Date(dr.loc_updated_at).getTime()) : Infinity;
        const locFresh = locAge < STALE_MS;
        if (pickupLat && pickupLng && dr.lat && dr.lng && locFresh)
          distKm = haversineKm(parseFloat(pickupLat), parseFloat(pickupLng), parseFloat(dr.lat), parseFloat(dr.lng));
        return { phone: dr.phone, distKm, score: scoreDriver(dr, distKm, now) };
      })
      .filter(dr => radiusKm >= 15 || dr.distKm === null || dr.distKm <= radiusKm)
      .sort((a, b) => b.score - a.score);
    remaining = scored.map(dr => dr.phone);
    const alreadyOfferedCount = drRes.rows.length - drRes.rows.filter(dr => !alreadyOffered.has(dr.phone)).length;
    console.log(`[MATCH] ride=${rideId} type=${rideType} r=${radiusKm}km total=${drRes.rows.length} alreadyOffered=${alreadyOfferedCount} afterDistFilter=${remaining.length} queue=${JSON.stringify(remaining)}`);
  } else {
    const rideCheck = await db.query(
      `SELECT id, ride_type FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
    );
    if (!rideCheck.rows[0]) return;
    if (rideCheck.rows[0].ride_type !== rideType) return;
  }

  if (!remaining || remaining.length === 0) {
    if (radiusKm < 15) {
      // Suggest alternatives when 5km radius has no drivers
      if (radiusKm <= 5) {
        getAvailableAlternatives(rideType).then(alts => {
          if (alts.length > 0)
            emitToRoom('ride_' + rideId, 'suggestAlternative', { rideId, current_type: rideType, alternatives: alts });
        }).catch(() => {});
      }
      await rideQueue.add('ride-assignment',
        { type: 'assign-next', rideId, pickupLat, pickupLng, rideType, queue: null, radiusKm: radiusKm + 5, afterSurge, retryRound },
        { delay: RADIUS_EXPAND_MS }
      );
    } else if (!afterSurge && retryRound === 0) {
      // All drivers timed-out (none explicitly rejected). Clear offered_phones and try once more —
      // handles the "1 driver online, didn't see notification" case without immediately failing.
      await db.query(
        `UPDATE rides SET offered_phones='{}' WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
        [rideId]
      );
      await rideQueue.add('ride-assignment',
        { type: 'assign-next', rideId, pickupLat, pickupLng, rideType, queue: null, radiusKm: 5, afterSurge: false, retryRound: 1 },
        { delay: RADIUS_EXPAND_MS }
      );
    } else {
      // All drivers at all radii tried (both rounds) — escalate
      await _escalate(rideId, rideType, afterSurge, pickupLat, pickupLng);
    }
    await db.query(
      `UPDATE rides SET assigned_to_phone=NULL, assignment_expires_at=NULL
       WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
    );
    return;
  }

  const nextPhone = remaining[0];
  const newQueue  = remaining.slice(1);

  const upd = await db.query(
    `UPDATE rides
     SET assigned_to_phone=$1,
         assignment_expires_at=NOW()+INTERVAL '${ASSIGNMENT_WINDOW_SEC} seconds',
         assignment_queue=$2,
         offered_phones = array_append(COALESCE(offered_phones,'{}'), $1::text)
     WHERE id=$3 AND status='requested' AND driver_id IS NULL
       AND (assigned_to_phone IS NULL OR assignment_expires_at < NOW())
     RETURNING id`,
    [nextPhone, JSON.stringify(newQueue), rideId]
  );
  if (!upd.rows[0]) { console.log(`[MATCH] ride=${rideId} UPDATE claimed by another worker — skipping`); return; }

  console.log(`[MATCH] ride=${rideId} → offering to ${nextPhone}`);
  const rideEmoji = { bike: '🏍️', auto: '🛺', car: '🚕', eriksha: '🛵', luxury: '🚙' }[rideType] || '🚗';
  sendFCM(nextPhone, `${rideEmoji} Naya Ride Request!`, `📍 ${rideType.toUpperCase()} ride nearby — ${ASSIGNMENT_WINDOW_SEC}s mein accept karo!`, { type: 'new_ride', ride_id: String(rideId) }, { channelId: 'ride_requests', role: 'driver' });
  emitToRoom('driver_' + nextPhone, 'newRideAssigned', { rideId, secondsToAccept: ASSIGNMENT_WINDOW_SEC });

  db.query(
    `INSERT INTO driver_metrics (phone, rides_offered) VALUES ($1, 1)
     ON CONFLICT (phone) DO UPDATE SET rides_offered = driver_metrics.rides_offered + 1`,
    [nextPhone]
  ).catch(() => {});
  rideQueue.add('ride-assignment',
    { type: 'auto-advance', rideId, expectedPhone: nextPhone, pickupLat, pickupLng, rideType, queue: newQueue, radiusKm, afterSurge, retryRound },
    { delay: AUTO_ADVANCE_MS }
  ).catch(() => {});
}

// ── Auto-advance if driver didn't respond within their window ────────────────
async function _bmqAutoAdvance({ rideId, expectedPhone, pickupLat, pickupLng, rideType, queue, radiusKm = 5, afterSurge = false, retryRound = 0 }) {
  const r = await db.query(
    `SELECT assigned_to_phone, assignment_queue FROM rides
     WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
  );
  if (!r.rows[0] || r.rows[0].assigned_to_phone !== expectedPhone) return;
  const rawQ = r.rows[0].assignment_queue;
  const nextQueue = Array.isArray(rawQ) ? rawQ : JSON.parse(rawQ || '[]');
  await rideQueue.add('ride-assignment',
    { type: 'assign-next', rideId, pickupLat, pickupLng, rideType, queue: nextQueue, radiusKm, afterSurge, retryRound }
  );
}

// ── Grace timer: if customer ignores surge offer within 30s → final failure ──
async function _bmqSurgeGraceTimeout({ rideId, pickupLat, pickupLng, rideType }) {
  const rideCheck = await db.query(
    `SELECT id, surge_count FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
  );
  if (!rideCheck.rows[0]) return; // already matched or cancelled
  if (parseInt(rideCheck.rows[0].surge_count) > 0) return; // customer accepted surge — new search running
  // Customer ignored surge offer → final failure
  await _escalate(rideId, rideType, true, pickupLat, pickupLng);
}

// ── Escalation: first failure → surge offer, second failure → no_driver_final ─
async function _escalate(rideId, rideType, afterSurge, pickupLat, pickupLng) {
  if (afterSurge) {
    // Both rounds failed → final no-driver
    const [alts, pRes] = await Promise.all([
      getAvailableAlternatives(rideType).catch(() => []),
      db.query(`SELECT u.phone FROM rides r JOIN users u ON r.passenger_id=u.id WHERE r.id=$1`, [rideId]),
    ]);
    const customerPhone = pRes.rows[0]?.phone;
    if (customerPhone) {
      sendFCM(
        customerPhone,
        '😔 Driver Nahi Mila',
        alts.length ? 'Doosra vehicle try karo ya thodi der baad retry karo.' : 'Is area mein abhi koi driver nahi. 5 min baad try karo.',
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
    await db.query(
      `UPDATE rides SET status='cancelled' WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
    );
  } else {
    // First round failed → offer surge
    const surgeInfo = await _computeSurgeOffer(pickupLat, pickupLng, rideId);
    emitToRoom('ride_' + rideId, 'rideUpdate', {
      rideId,
      status: 'surge_offer',
      suggested_surge_amt: surgeInfo.amt,
      surge_label: surgeInfo.label,
      message: `Koi driver nahi mila. ₹${surgeInfo.amt} extra dekar driver attract karein?`,
      timeout_sec: Math.round(SURGE_GRACE_MS / 1000),
    });
    // Schedule auto-cancel if customer doesn't respond
    rideQueue.add('ride-assignment',
      { type: 'surge-grace-timeout', rideId, pickupLat, pickupLng, rideType },
      { delay: SURGE_GRACE_MS }
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
    if (multiplier >= 2.0)      amt = 65;
    else if (multiplier >= 1.5) amt = 40;
    else if (multiplier >= 1.2) amt = 25;
    const pctAmt = Math.round(fare * 0.25 / 5) * 5;
    if (pctAmt > amt && pctAmt <= 100) amt = pctAmt;
    const VALID = [15, 25, 40, 65, 100];
    const closest = VALID.reduce((a, b) => Math.abs(b - amt) < Math.abs(a - amt) ? b : a);
    return { amt: closest, label: `+₹${closest}` };
  } catch (_e) {
    return { amt: 25, label: '+₹25' };
  }
}

async function assignRideToNextDriver(rideId, pickupLat, pickupLng, rideType, queue, radiusKm, afterSurge = false, retryRound = 0) {
  const jobData = {
    type: 'assign-next', rideId, pickupLat, pickupLng, rideType,
    queue: queue || null, radiusKm: radiusKm || 5, afterSurge: !!afterSurge, retryRound,
  };
  try {
    await rideQueue.add('ride-assignment', jobData);
    console.log(`[MATCH] ride=${rideId} job queued in BullMQ (type=${rideType})`);
  } catch (err) {
    // BullMQ / Redis unavailable — run the match in-process immediately
    console.error(`[MATCH] ride=${rideId} BullMQ.add FAILED (${err.message}) — running in-process fallback`);
    _bmqAssignNext(jobData).catch(e => console.error(`[MATCH] ride=${rideId} in-process fallback error:`, e.message));
  }
}

module.exports = { rideQueue, rideWorker, assignRideToNextDriver, _bmqAssignNext };
