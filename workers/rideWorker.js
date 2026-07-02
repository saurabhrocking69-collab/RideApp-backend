const { Queue, Worker } = require('bullmq');
const db = require('../config/db');
const { makeBmqConn } = require('../config/redis');
const { sendFCM } = require('../config/firebase');
const { emitToRoom } = require('../config/socket');
const { haversineKm, scoreDriver } = require('../services/matching');

const rideQueue = new Queue('ride-assignment', { connection: makeBmqConn() });

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
  // Single query for all alternatives instead of N separate round trips
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
  return alts.filter(a => available.has(a)); // preserve original priority order
}

const rideWorker = new Worker('ride-assignment', async (job) => {
  const d = job.data;
  if (d.type === 'assign-next')  await _bmqAssignNext(d);
  if (d.type === 'auto-advance') await _bmqAutoAdvance(d);
}, { connection: makeBmqConn(), concurrency: 5 });

rideWorker.on('failed', (job, err) => {
  console.error('❌ BullMQ job failed:', job?.id, err.message);
});

async function _bmqAssignNext({ rideId, pickupLat, pickupLng, rideType, queue, radiusKm = 5, offeredPhones = [], wasFavouriteTimeout = false, buddyName = null }) {
  let remaining = queue;

  if (remaining === null || remaining === undefined) {
    // Run ride validity check + driver fetch in parallel — saves one full DB round trip
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
    if (!rideCheck.rows[0]) return;
    if (rideCheck.rows[0].ride_type !== rideType) return; // customer switched vehicle — stale job

    // Notify customer that favourite buddy didn't respond before starting normal search
    if (wasFavouriteTimeout) {
      const name = buddyName || 'Aapka favourite buddy';
      emitToRoom('ride_' + rideId, 'rideUpdate', {
        rideId, status: 'buddy_timeout',
        message: `${name} ne respond nahi kiya — ab doosre drivers dhundh rahe hain`,
      });
    }

    // Drivers already offered this ride (timed out / rejected) — skip them on fresh rebuilds
    const alreadyOffered = new Set([
      ...((rideCheck.rows[0].offered_phones) || []),
      ...offeredPhones,
    ]);

    const now = Date.now();
    const STALE_MS = 10 * 60 * 1000; // location older than 10 min = unreliable
    const scored = drRes.rows
      .filter(dr => !alreadyOffered.has(dr.phone)) // skip already-offered drivers
      .map(dr => {
        let distKm = null;
        const locAge = dr.loc_updated_at ? (now - new Date(dr.loc_updated_at).getTime()) : Infinity;
        const locFresh = locAge < STALE_MS;
        if (pickupLat && pickupLng && dr.lat && dr.lng && locFresh)
          distKm = haversineKm(parseFloat(pickupLat), parseFloat(pickupLng), parseFloat(dr.lat), parseFloat(dr.lng));
        return { phone: dr.phone, distKm, score: scoreDriver(dr, distKm, now) };
      })
      .filter(dr => dr.distKm === null || dr.distKm <= radiusKm)
      .sort((a, b) => b.score - a.score);
    remaining = scored.map(dr => dr.phone);
  } else {
    // queue already built — just verify ride is still valid
    const rideCheck = await db.query(
      `SELECT id, ride_type FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
    );
    if (!rideCheck.rows[0]) return;
    if (rideCheck.rows[0].ride_type !== rideType) return;
  }

  if (!remaining || remaining.length === 0) {
    if (radiusKm < 15) {
      // Emit alternative vehicle suggestion when initial search radius fails
      if (radiusKm <= 5) {
        try {
          const alts = await getAvailableAlternatives(rideType);
          if (alts.length > 0) {
            emitToRoom('ride_' + rideId, 'suggestAlternative', {
              rideId, current_type: rideType, alternatives: alts,
            });
          }
        } catch (_e) {}
      }
      await rideQueue.add('ride-assignment',
        { type: 'assign-next', rideId, pickupLat, pickupLng, rideType, queue: null, radiusKm: radiusKm + 5 },
        { delay: 3000 }
      );
    } else {
      await db.query(`UPDATE rides SET status='cancelled', assigned_to_phone=NULL, assignment_expires_at=NULL WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]);
      const pRes = await db.query(`SELECT u.phone FROM rides r JOIN users u ON r.passenger_id=u.id WHERE r.id=$1`, [rideId]);
      if (pRes.rows[0]) {
        sendFCM(pRes.rows[0].phone, '😔 Driver Nahi Mila', 'Is area mein abhi koi driver available nahi hai. Thodi der baad try karo.', { type: 'no_driver_found', ride_id: String(rideId) });
        emitToRoom('ride_' + rideId, 'rideUpdate', { rideId, status: 'cancelled', reason: 'no_driver', message: 'Koi driver available nahi — baad mein try karo' });
      }
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
         assignment_expires_at=NOW()+INTERVAL '45 seconds',
         assignment_queue=$2,
         offered_phones = array_append(COALESCE(offered_phones,'{}'), $1::text)
     WHERE id=$3 AND status='requested' AND driver_id IS NULL
       AND (assigned_to_phone IS NULL OR assignment_expires_at < NOW())
     RETURNING id`,
    [nextPhone, JSON.stringify(newQueue), rideId]
  );
  if (!upd.rows[0]) return; // Race: another worker already assigned this slot — no duplicate notification

  // Notify driver immediately — BEFORE any other awaits
  const rideEmoji = { bike: '🏍️', auto: '🛺', car: '🚕', eriksha: '🛵', luxury: '🚙' }[rideType] || '🚗';
  sendFCM(nextPhone, `${rideEmoji} Naya Ride Request!`, `📍 ${rideType.toUpperCase()} ride nearby — 45 sec mein accept karo!`, { type: 'new_ride', ride_id: String(rideId) }, { channelId: 'ride_requests', role: 'driver' });
  emitToRoom('driver_' + nextPhone, 'newRideAssigned', { rideId, secondsToAccept: 45 });

  // Non-critical ops — fire and forget, don't block notification path
  db.query(
    `INSERT INTO driver_metrics (phone, rides_offered) VALUES ($1, 1)
     ON CONFLICT (phone) DO UPDATE SET rides_offered = driver_metrics.rides_offered + 1`,
    [nextPhone]
  ).catch(() => {});
  rideQueue.add('ride-assignment',
    { type: 'auto-advance', rideId, expectedPhone: nextPhone, pickupLat, pickupLng, rideType, queue: newQueue, radiusKm },
    { delay: 47000 }
  ).catch(() => {});
}

async function _bmqAutoAdvance({ rideId, expectedPhone, pickupLat, pickupLng, rideType, queue, radiusKm = 5 }) {
  const r = await db.query(
    `SELECT assigned_to_phone, assignment_queue FROM rides
     WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
  );
  if (!r.rows[0] || r.rows[0].assigned_to_phone !== expectedPhone) return;
  const nextQueue = JSON.parse(r.rows[0].assignment_queue || '[]');
  await rideQueue.add('ride-assignment',
    { type: 'assign-next', rideId, pickupLat, pickupLng, rideType, queue: nextQueue, radiusKm }
  );
}

async function assignRideToNextDriver(rideId, pickupLat, pickupLng, rideType, queue, radiusKm) {
  await rideQueue.add('ride-assignment', {
    type: 'assign-next', rideId, pickupLat, pickupLng, rideType,
    queue: queue || null, radiusKm: radiusKm || 5,
  });
}

module.exports = { rideQueue, rideWorker, assignRideToNextDriver };
