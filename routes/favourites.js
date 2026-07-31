const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { sendFCM }    = require('../config/firebase');
const { emitToRoom } = require('../config/socket');
const { calculateFare, getISTHour } = require('../services/pricing');
const { rideQueue }  = require('../workers/rideWorker');

// Kept for backwards-compat export — internal Set replaced by DB query in reject-offer (multi-instance safe)
const directFavouriteRideIds = new Set();

// Auto-create table
db.query(`
  CREATE TABLE IF NOT EXISTS favourite_drivers (
    customer_id UUID PRIMARY KEY REFERENCES users(id),
    driver_id   UUID REFERENCES users(id),
    created_at  TIMESTAMP DEFAULT NOW(),
    updated_at  TIMESTAMP DEFAULT NOW()
  )
`).catch(() => {});

const defaultFares = {
  luxury:        { base_fare: 80,  per_km_rate: 25, night_multiplier: 1.8 },
  car:           { base_fare: 40,  per_km_rate: 15, night_multiplier: 1.5 },
  auto:          { base_fare: 25,  per_km_rate: 12, night_multiplier: 1.5 },
  eriksha:       { base_fare: 20,  per_km_rate: 10, night_multiplier: 1.3 },
  bike:          { base_fare: 15,  per_km_rate: 8,  night_multiplier: 1.3 },
  green_bike:    { base_fare: 12,  per_km_rate: 6,  night_multiplier: 1.2 },
  electric_auto: { base_fare: 20,  per_km_rate: 9,  night_multiplier: 1.3 },
};

async function getBuddy(customerId) {
  const r = await db.query(`
    SELECT fd.driver_id,
           u.name  AS driver_name,
           u.phone AS driver_phone,
           d.vehicle_type, d.vehicle_no, d.vehicle_brand, d.vehicle_model,
           d.rating, d.face_photo, d.is_online,
           (SELECT COUNT(*) FROM rides
            WHERE passenger_id=$2 AND driver_id=fd.driver_id AND status='completed'
           ) AS rides_together
    FROM favourite_drivers fd
    JOIN  users   u ON fd.driver_id = u.id
    LEFT JOIN drivers d ON fd.driver_id = d.id
    WHERE fd.customer_id = $1
  `, [customerId, customerId]);
  return r.rows[0] || null;
}

// GET /api/favourites/driver-count?phone=xxx  — how many customers have this driver as buddy
router.get('/driver-count', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.json({ count: 0 });
  try {
    const dr = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!dr.rows[0]) return res.json({ count: 0 });
    const r = await db.query(
      'SELECT COUNT(*) FROM favourite_drivers WHERE driver_id=$1',
      [dr.rows[0].id]
    );
    res.json({ count: parseInt(r.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message, count: 0 }); }
});

// GET /api/favourites?phone=xxx  — fetch current favourite buddy
router.get('/', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.json({ buddy: null });
  try {
    const cu = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!cu.rows[0]) return res.json({ buddy: null });
    const buddy = await getBuddy(cu.rows[0].id);
    res.json({ buddy });
  } catch (err) { console.error('[favourites]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/favourites  — set / replace favourite buddy
// body: { customer_phone, driver_phone }
router.post('/', async (req, res) => {
  const { customer_phone, driver_phone } = req.body;
  if (!customer_phone || !driver_phone) return res.status(400).json({ error: 'customer_phone and driver_phone required' });
  try {
    const cu = await db.query('SELECT id FROM users WHERE phone=$1', [customer_phone]);
    if (!cu.rows[0]) return res.status(404).json({ error: 'Customer not found' });

    const dr = await db.query('SELECT id FROM users WHERE phone=$1', [driver_phone]);
    if (!dr.rows[0]) return res.status(404).json({ error: 'Driver not found' });

    const customerId = cu.rows[0].id;
    const driverId   = dr.rows[0].id;

    // Eligibility: must have at least one completed ride together
    const check = await db.query(
      `SELECT COUNT(*) FROM rides WHERE passenger_id=$1 AND driver_id=$2 AND status='completed'`,
      [customerId, driverId]
    );
    if (parseInt(check.rows[0].count) === 0)
      return res.status(400).json({ error: 'You can only add a driver you have completed a ride with as your favourite' });

    // Upsert — replaces any existing favourite
    await db.query(`
      INSERT INTO favourite_drivers (customer_id, driver_id)
      VALUES ($1, $2)
      ON CONFLICT (customer_id) DO UPDATE SET driver_id=$2, updated_at=NOW()
    `, [customerId, driverId]);

    const buddy = await getBuddy(customerId);
    res.json({ success: true, buddy });
  } catch (err) { console.error('[favourites]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// DELETE /api/favourites  — remove favourite buddy
// body: { customer_phone }
router.delete('/', async (req, res) => {
  const { customer_phone } = req.body;
  if (!customer_phone) return res.status(400).json({ error: 'customer_phone required' });
  try {
    const cu = await db.query('SELECT id FROM users WHERE phone=$1', [customer_phone]);
    if (!cu.rows[0]) return res.status(404).json({ error: 'Customer not found' });
    await db.query('DELETE FROM favourite_drivers WHERE customer_id=$1', [cu.rows[0].id]);
    res.json({ success: true });
  } catch (err) { console.error('[favourites]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/favourites/book  — direct booking with favourite buddy
router.post('/book', async (req, res) => {
  const { customer_phone, pickup, drop_location, pickup_lat, pickup_lng, drop_lat, drop_lng, distance } = req.body;
  if (!customer_phone || !pickup || !drop_location)
    return res.status(400).json({ error: 'Pickup and drop location required' });

  const client = await db.connect();
  try {
    const cu = await client.query('SELECT * FROM users WHERE phone=$1', [customer_phone]);
    if (!cu.rows[0]) return res.status(404).json({ error: 'Account not found — please log in again' });
    const customer = cu.rows[0];
    if (customer.booking_restricted)
      return res.status(403).json({ error: '🚫 Your account is on hold. Please contact help@sppero.com', restricted: true });

    const buddy = await getBuddy(customer.id);
    if (!buddy) return res.status(400).json({ error: 'No favourite buddy set' });

    if (!buddy.is_online)
      return res.json({ success: false, reason: 'offline', driver_name: buddy.driver_name });

    const busyCheck = await client.query(
      // A parked parcel doesn't make a favourite buddy "busy" — they've been
      // released to take normal rides while carrying it.
      `SELECT 1 FROM rides WHERE driver_id=$1 AND status IN ('matched','arrived','started') AND parcel_parked_at IS NULL LIMIT 1`,
      [buddy.driver_id]
    );
    if (busyCheck.rows[0])
      return res.json({ success: false, reason: 'busy', driver_name: buddy.driver_name });

    // Calculate fare
    let dist = parseFloat(distance) || 0;
    if (!dist && pickup_lat && pickup_lng && drop_lat && drop_lng) {
      const toRad = d => d * Math.PI / 180;
      const dLat = toRad(drop_lat - pickup_lat), dLng = toRad(drop_lng - pickup_lng);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(pickup_lat)) * Math.cos(toRad(drop_lat)) * Math.sin(dLng/2)**2;
      dist = parseFloat((6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))).toFixed(2));
    }
    if (!dist) dist = 5;
    const durMin = (dist / 20) * 60;
    const ride_type = buddy.vehicle_type || 'auto';
    const fareRow = await client.query('SELECT * FROM fare_settings WHERE vehicle_type=$1', [ride_type]);
    const f = fareRow.rows[0] || defaultFares[ride_type] || defaultFares.auto;
    const hour = getISTHour();
    const isNight = hour >= parseInt(String(f.night_start || '22').split(':')[0]) || hour < parseInt(String(f.night_end || '6').split(':')[0]);
    const fareCalc = calculateFare(f, dist, durMin, isNight);
    const fare = fareCalc.fare;

    // Atomic transaction: INSERT ride + UPDATE assignment together.
    // If either fails the whole thing rolls back — no orphan rides left in DB.
    await client.query('BEGIN');

    const ride = await client.query(
      `INSERT INTO rides (passenger_id, pickup, drop_location, ride_type, fare, status,
          pickup_lat, pickup_lng, drop_lat, drop_lng, distance_km, platform_fee)
       VALUES ($1,$2,$3,$4,$5,'requested',$6,$7,$8,$9,$10,$11) RETURNING *`,
      [customer.id, pickup, drop_location, ride_type, fare,
       pickup_lat || null, pickup_lng || null, drop_lat || null, drop_lng || null,
       dist, fareCalc.platform_fee]
    );
    const rideId = ride.rows[0].id;

    await client.query(
      `UPDATE rides
       SET assigned_to_phone=$1,
           assignment_expires_at=NOW()+INTERVAL '25 seconds',
           assignment_queue='[]',
           offered_phones=ARRAY[$3::text]
       WHERE id=$2`,
      [buddy.driver_phone, rideId, buddy.driver_phone]
    );

    await client.query('COMMIT');

    // Post-commit side-effects (outside transaction — failures here don't orphan the ride)
    rideQueue.add('ride-assignment', {
      type: 'assign-next', rideId, pickupLat: pickup_lat, pickupLng: pickup_lng,
      rideType: ride_type, queue: null, radiusKm: 5,
      wasFavouriteTimeout: true, buddyName: buddy.driver_name,
    }, { delay: 28000 }).catch(() => {});

    sendFCM(
      buddy.driver_phone,
      `⭐ Direct Request from ${customer.name || 'Customer'}!`,
      `Your regular customer sent you a direct request — decide within 25 sec!`,
      { type: 'new_ride', ride_id: String(rideId), is_favourite_request: 'true' },
      { channelId: 'ride_requests' }
    );
    emitToRoom('driver_' + buddy.driver_phone, 'newRideAssigned', {
      rideId, secondsToAccept: 25, is_favourite_request: true,
    });

    res.json({
      success: true,
      ride_id: rideId,
      fare: '₹' + fare,
      driver_name: buddy.driver_name,
      vehicle_type: ride_type,
      distance: dist + ' km',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[BUDDY BOOK] Error:', err.message);
    res.status(500).json({ error: 'Booking failed — please try again' });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.directFavouriteRideIds = directFavouriteRideIds;
