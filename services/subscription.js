const db = require('../config/db');

// Maps driver vehicle_type → subscription category
function vehicleCategoryFor(vehicleType) {
  const vt = (vehicleType || '').toLowerCase();
  if (['bike', 'green_bike'].includes(vt)) return 'bike';
  if (['auto', 'electric_auto', 'e_riksha', 'eriksha'].includes(vt)) return 'auto';
  if (['car', 'car_7', 'luxury', 'ultra_luxury'].includes(vt)) return 'car';
  return null;
}

// Activate oldest queued plan for a driver (called when active plan expires)
async function activateQueuedSubscription(driverPhone) {
  try {
    const queued = await db.query(
      `SELECT ds.*, sp.validity_days
       FROM driver_subscriptions ds
       JOIN subscription_plans sp ON ds.plan_id = sp.id
       WHERE ds.driver_phone=$1 AND ds.status='queued'
       ORDER BY ds.created_at ASC LIMIT 1`,
      [driverPhone]
    );
    if (!queued.rows[0]) return;
    const now = new Date();
    const validityDays = parseInt(queued.rows[0].validity_days || 60);
    const expiresAt = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);
    await db.query(
      `UPDATE driver_subscriptions SET status='active', starts_at=$1, expires_at=$2 WHERE id=$3`,
      [now, expiresAt, queued.rows[0].id]
    );
  } catch (e) {
    console.error('[SUBSCRIPTION] activateQueued error:', e.message);
  }
}

// Check subscription and atomically decrement ride if active.
// Uses a single UPDATE...WHERE id=(SELECT...FOR UPDATE) so concurrent calls
// cannot double-decrement the same ride pack.
// Returns { subscribed: true, commission: 0 } or { subscribed: false, commission: normalCommission }
async function useSubscriptionIfActive(driverPhone, rideId, rideType, normalCommission) {
  try {
    // Atomic: lock the row with FOR UPDATE inside the subquery so concurrent
    // requests queue up; the WHERE rides_remaining>0 then excludes already-zeroed rows.
    const sub = await db.query(
      `UPDATE driver_subscriptions
       SET rides_used      = rides_used + 1,
           rides_remaining = rides_remaining - 1,
           status          = CASE WHEN rides_remaining - 1 <= 0 THEN 'expired' ELSE 'active' END
       WHERE id = (
         SELECT id FROM driver_subscriptions
         WHERE driver_phone=$1 AND status='active' AND rides_remaining>0 AND expires_at>NOW()
         ORDER BY starts_at ASC LIMIT 1
         FOR UPDATE
       )
       RETURNING *`,
      [driverPhone]
    );
    if (!sub.rows[0]) return { subscribed: false, commission: normalCommission };

    const s = sub.rows[0];

    // Log saved commission (fire-and-forget)
    db.query(
      `INSERT INTO subscription_ride_log (subscription_id, ride_id, ride_type, commission_saved)
       VALUES ($1, $2, $3, $4)`,
      [s.id, rideId || null, rideType || 'standard', normalCommission || 0]
    ).catch(() => {});

    // If all rides exhausted, activate the queued plan
    if (s.rides_remaining <= 0) activateQueuedSubscription(driverPhone).catch(() => {});

    return { subscribed: true, commission: 0 };
  } catch (e) {
    console.error('[SUBSCRIPTION] useSubscriptionIfActive error:', e.message);
    return { subscribed: false, commission: normalCommission };
  }
}

module.exports = { vehicleCategoryFor, useSubscriptionIfActive, activateQueuedSubscription };
