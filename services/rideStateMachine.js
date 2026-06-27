const db              = require('../config/db');
const { emitToRoom }  = require('../config/socket');
const { sendFCM }     = require('../config/firebase');
const { setRideStatus, clearRide } = require('./rideCache');

// Valid state transitions — any change not in this map is rejected
const TRANSITIONS = {
  searching:  ['requested'],
  requested:  ['matched', 'cancelled', 'no_driver'],
  matched:    ['arrived', 'cancelled'],
  arrived:    ['started', 'cancelled'],
  started:    ['completed'],
  completed:  ['payment_complete'],
};

// FCM payloads per transition — [title, body, data.type, channelId?]
const FCM_MAP = {
  matched:   { customer: ['🚗 Driver Mil Gaya!',         'Aapka driver aa raha hai — OTP ready karo!',           'ride_matched'] },
  arrived:   { customer: ['📍 Sppero Buddy Pahunch Gaya!', 'Aapka Sppero Buddy pickup point pe pahunch gaya — OTP batao aur trip shuru karo!', 'driver_arrived'] },
  started:   { customer: ['🚀 Trip Shuru Ho Gaya!',      'Aapka ride chal raha hai. Safe journey!',               'trip_started'] },
  completed: {
    customer: ['🏁 Trip Complete!',   'Payment karo aur driver ko rate karo!',  'trip_completed'],
    driver:   ['✅ Trip Complete!',   'Payment aa rahi hai — wait karo.',        'payment_pending', 'ride_requests'],
  },
  cancelled: {
    customer: ['🚫 Ride Cancel Ho Gayi', 'Ride cancel ho gayi.',         'ride_cancelled'],
    driver:   ['🚫 Ride Cancel Ho Gayi', 'Ride cancel ho gayi.',         'ride_cancelled', 'ride_requests'],
  },
  no_driver: {
    customer: ['😔 Driver Nahi Mila', 'Abhi driver available nahi — thodi der baad try karo.', 'no_driver'],
  },
};

/**
 * Transition a ride to a new status.
 *
 * @param {number|string} rideId
 * @param {string}        newStatus
 * @param {object}        opts
 *   extraFields   — additional DB columns to update alongside `status`
 *   socketData    — extra fields merged into the socket emit payload
 *   custPhone     — override customer phone for FCM (avoids extra JOIN if caller already has it)
 *   drvPhone      — override driver phone for FCM
 *   skipFCM       — set true to suppress FCM (caller handles it themselves)
 * @returns {{ previousStatus: string }}
 */
async function transitionRide(rideId, newStatus, opts = {}) {
  const { extraFields = {}, socketData = {}, custPhone, drvPhone, skipFCM = false } = opts;

  // 1 — Fetch current status + party phones (used for FCM if not supplied)
  const rideRes = await db.query(
    `SELECT r.status, u_p.phone AS passenger_phone, u_d.phone AS driver_phone
     FROM rides r
     LEFT JOIN users u_p ON r.passenger_id = u_p.id
     LEFT JOIN users u_d ON r.driver_id    = u_d.id
     WHERE r.id = $1`,
    [rideId]
  );
  if (!rideRes.rows[0]) throw new Error(`Ride ${rideId} not found`);

  const current = rideRes.rows[0];
  const allowed = TRANSITIONS[current.status];
  if (!allowed || !allowed.includes(newStatus)) {
    throw new Error(`Invalid transition: ${current.status} → ${newStatus} (ride ${rideId})`);
  }

  const passengerPhone = custPhone  || current.passenger_phone;
  const driverPhone    = drvPhone   || current.driver_phone;

  // 2 — Build UPDATE statement — guards against concurrent transitions with WHERE status check
  const prevStatus = current.status;
  const setPairs = ['status = $2'];
  const values   = [rideId, newStatus];
  let   idx      = 3;
  for (const [col, val] of Object.entries(extraFields)) {
    setPairs.push(`${col} = $${idx++}`);
    values.push(val);
  }
  if (newStatus === 'completed') setPairs.push('completed_at = NOW()');
  values.push(prevStatus); // for WHERE clause
  const guardIdx = idx;

  const upd = await db.query(
    `UPDATE rides SET ${setPairs.join(', ')} WHERE id = $1 AND status = $${guardIdx} RETURNING id`,
    values
  );
  if (!upd.rows[0]) {
    // Another request already transitioned this ride — safe to ignore
    throw new Error(`Concurrent transition blocked: ride ${rideId} was no longer in '${prevStatus}'`);
  }

  // 3 — Redis cache
  if (['cancelled', 'no_driver', 'payment_complete'].includes(newStatus)) {
    clearRide(rideId).catch(() => {});
  } else {
    setRideStatus(rideId, newStatus).catch(() => {});
  }

  // 4 — Socket
  emitToRoom('ride_' + rideId, 'rideUpdate', { rideId, status: newStatus, ...socketData });

  // 5 — FCM
  if (!skipFCM) {
    const fcm = FCM_MAP[newStatus];
    if (fcm) {
      if (fcm.customer && passengerPhone) {
        const [title, body, type] = fcm.customer;
        sendFCM(passengerPhone, title, body, { type, ride_id: String(rideId) }, { role: 'customer' }).catch(() => {});
      }
      if (fcm.driver && driverPhone) {
        const [title, body, type, channelId = 'ride_requests'] = fcm.driver;
        sendFCM(driverPhone, title, body, { type, ride_id: String(rideId) }, { channelId, role: 'driver' }).catch(() => {});
      }
    }
  }

  return { previousStatus: current.status };
}

module.exports = { transitionRide, TRANSITIONS };
