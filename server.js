const crypto = require('crypto');
const { initializeApp: initFirebaseApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

let firebaseMessaging = null;

// Firebase Admin initialize
try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (sa) {
    const serviceAccount = JSON.parse(sa);
    initFirebaseApp({ credential: cert(serviceAccount) });
    firebaseMessaging = getMessaging();
    console.log('✅ Firebase Admin initialized');
  } else {
    console.log('⚠️ FIREBASE_SERVICE_ACCOUNT not set - FCM disabled');
  }
} catch (e) {
  console.log('⚠️ Firebase Admin error:', e.message);
}

const express      = require('express');
const cors         = require('cors');
const http         = require('http');
const { Server }   = require('socket.io');
const { Pool }     = require('pg');
const { createClient } = require('redis');
const jwt          = require('jsonwebtoken');
const rateLimit    = require('express-rate-limit');
const { createAdapter } = require('@socket.io/redis-adapter');

const cloudinary = require('cloudinary').v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const Razorpay = require('razorpay');
console.log('🔑 RZP KEY:', process.env.RAZORPAY_KEY_ID ? 'MILA' : 'NAHI MILA');
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '12mb' }));

// ── Rate Limiting ───────────────────────────────
app.use('/api/auth/send-otp', rateLimit({
  windowMs: 60_000, max: 3,
  message: { error: 'Bahut zyada attempts! 1 minute baad try karo' },
}));
app.use('/api/', rateLimit({
  windowMs: 60_000, max: 400,
  message: { error: 'Too many requests, slow down' },
}));

// ── Health Check ────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: Date.now() }));

// ── PostgreSQL ──────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: parseInt(process.env.DB_POOL_MAX || '10'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
db.connect()
  .then(() => console.log('✅ PostgreSQL connected!'))
  .catch(err => console.log('❌ PostgreSQL error:', err.message));
// ══════════════════════════════════════════════════
//  PRODUCTION-SCALE MATCHING SYSTEM
//  server.js ke TOP mein (baaki APIs se pehle) paste karo
//  Yeh helper functions hain + updated APIs
// ══════════════════════════════════════════════════

// ─── GEOHASH: location ko grid cell mein convert ───
// Precision 6 = ~1.2km x 0.6km cells
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
function encodeGeohash(lat, lng, precision = 6) {
  let idx = 0, bit = 0, evenBit = true, geohash = '';
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { idx = idx * 2 + 1; lngMin = mid; } else { idx = idx * 2; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; } else { idx = idx * 2; latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) { geohash += GEOHASH_BASE32[idx]; bit = 0; idx = 0; }
  }
  return geohash;
}

// ─── Neighbor cells (3x3 grid around center) ───
// Simple approach: thoda precision kam karke wider area cover
function getNearbyCells(lat, lng) {
  // Center cell + approximate neighbors by shifting lat/lng
  const cells = new Set();
  const delta = 0.011; // ~1.2km in degrees
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      cells.add(encodeGeohash(lat + dLat * delta, lng + dLng * delta, 6));
    }
  }
  return Array.from(cells);
}

// ─── Haversine distance (km) ───
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─── Driver scoring: distance (40) + idle time (40) + acceptance (15) + rating (5) ───
function scoreDriver(driver, distKm, now) {
  const idleMs  = now - new Date(driver.idle_since || 0).getTime();
  const idleMin = Math.min(idleMs / 60000, 120);
  const distScore  = (distKm !== null && distKm !== undefined) ? Math.max(0, (10 - distKm) / 10) * 40 : 0;
  const idleScore  = (idleMin / 120) * 40;
  const accScore   = (parseFloat(driver.acceptance_rate || 100) / 100) * 15;
  const ratScore   = ((parseFloat(driver.rating || 5)) - 1) / 4 * 5;
  return distScore + idleScore + accScore + ratScore;
}

// ─── Thin wrapper — existing call sites unchanged ───
async function assignRideToNextDriver(rideId, pickupLat, pickupLng, rideType, queue, radiusKm) {
  await rideQueue.add('ride-assignment', {
    type: 'assign-next',
    rideId, pickupLat, pickupLng, rideType,
    queue: queue || null,
    radiusKm: radiusKm || 5,
  });
}

// ─── DRIVER SCORE (multi-factor) ───
function calculateDriverScore(driver, distanceKm) {
  // Distance: 0km=1.0, 5km=0.0
  const distScore = Math.max(0, 1 - distanceKm / 5);
  // Rating: 5star=1.0, 1star=0.2
  const ratingScore = (parseFloat(driver.rating) || 4) / 5;
  // Acceptance: 100%=1.0
  const accScore = (parseFloat(driver.acceptance_rate) || 100) / 100;
  // Idle: zyada idle = zyada score (fairness). idle_mins capped at 30
  const idleMins = driver.idle_since ? Math.min(30, (Date.now() - new Date(driver.idle_since).getTime()) / 60000) : 0;
  const idleScore = idleMins / 30;

  return (distScore * 0.40) + (ratingScore * 0.20) + (accScore * 0.20) + (idleScore * 0.20);
}

// ── Redis (OTP / rate-limit) ────────────────────
const redis = createClient({
  url: process.env.REDIS_URL,
  socket: { tls: process.env.REDIS_URL?.includes('rediss') }
});
redis.connect();
redis.on('ready', async () => {
  console.log('✅ Redis connected!');
  // Socket.io Redis adapter — enables multi-instance pub/sub
  try {
    const subClient = redis.duplicate();
    await subClient.connect();
    io.adapter(createAdapter(redis, subClient));
    console.log('✅ Socket.io Redis adapter ready');
  } catch (e) {
    console.log('⚠️ Socket.io Redis adapter failed:', e.message);
  }
});
redis.on('error', (err) => console.log('❌ Redis error:', err.message));

// ── BullMQ (ride assignment job queue) ──────────
const { Queue, Worker } = require('bullmq');
const { Redis: IORedis } = require('ioredis');

const makeBmqConn = () => new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  ...(process.env.REDIS_URL?.startsWith('rediss://') ? { tls: {} } : {}),
});

const rideQueue = new Queue('ride-assignment', { connection: makeBmqConn() });

// ── BullMQ Worker ────────────────────────────────
const rideWorker = new Worker('ride-assignment', async (job) => {
  const d = job.data;
  if (d.type === 'assign-next')   await _bmqAssignNext(d);
  if (d.type === 'auto-advance')  await _bmqAutoAdvance(d);
}, { connection: makeBmqConn(), concurrency: 5 });

rideWorker.on('failed', (job, err) => {
  console.error('❌ BullMQ job failed:', job?.id, err.message);
});

// ── Job handler: assign to next scored driver ────
async function _bmqAssignNext({ rideId, pickupLat, pickupLng, rideType, queue, radiusKm = 5 }) {
  const rideCheck = await db.query(
    `SELECT id FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [rideId]
  );
  if (!rideCheck.rows[0]) return;

  let remaining = queue;

  if (remaining === null || remaining === undefined) {
    const drRes = await db.query(
      `SELECT u.phone,
              COALESCE(d.rating, 5.0)                                AS rating,
              COALESCE(dm.acceptance_rate, 100)                      AS acceptance_rate,
              COALESCE(dm.idle_since, NOW() - INTERVAL '30 minutes') AS idle_since,
              dl.lat, dl.lng
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
    );
    const now = Date.now();
    const scored = drRes.rows
      .map(dr => {
        let distKm = null;
        if (pickupLat && pickupLng && dr.lat && dr.lng)
          distKm = haversineKm(parseFloat(pickupLat), parseFloat(pickupLng), parseFloat(dr.lat), parseFloat(dr.lng));
        return { phone: dr.phone, distKm, score: scoreDriver(dr, distKm, now) };
      })
      .filter(dr => dr.distKm === null || dr.distKm <= radiusKm)
      .sort((a, b) => b.score - a.score);
    remaining = scored.map(dr => dr.phone);
  }

  if (!remaining || remaining.length === 0) {
    if (radiusKm < 15) {
      await rideQueue.add('ride-assignment',
        { type: 'assign-next', rideId, pickupLat, pickupLng, rideType, queue: null, radiusKm: radiusKm + 5 },
        { delay: 45000 }
      );
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
     SET assigned_to_phone=$1, assignment_expires_at=NOW()+INTERVAL '60 seconds', assignment_queue=$2
     WHERE id=$3 AND status='requested' AND driver_id IS NULL
     RETURNING id`,
    [nextPhone, JSON.stringify(newQueue), rideId]
  );
  if (!upd.rows[0]) return;

  await db.query(
    `INSERT INTO driver_metrics (phone, rides_offered) VALUES ($1, 1)
     ON CONFLICT (phone) DO UPDATE SET rides_offered = driver_metrics.rides_offered + 1`,
    [nextPhone]
  );

  sendFCM(nextPhone, '🚗 Naya Ride Request!', '📍 Pickup nearby — 60 sec mein accept karo!', { type: 'new_ride', ride_id: String(rideId) });
  io.to('driver_' + nextPhone).emit('newRideAssigned', { rideId, secondsToAccept: 60 });

  // Delayed auto-advance — survives server restart unlike setTimeout
  await rideQueue.add('ride-assignment',
    { type: 'auto-advance', rideId, expectedPhone: nextPhone, pickupLat, pickupLng, rideType, queue: newQueue, radiusKm },
    { delay: 62000 }
  );
}

// ── Job handler: advance queue if driver didn't respond ──
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

// ── Startup: DB indexes + re-queue stuck rides ──
setTimeout(async () => {
  // DB Indexes — idempotent, safe to run every startup
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_rides_status            ON rides(status)`,
    `CREATE INDEX IF NOT EXISTS idx_rides_driver_id         ON rides(driver_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rides_passenger_id      ON rides(passenger_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rides_assigned_phone    ON rides(assigned_to_phone)`,
    `CREATE INDEX IF NOT EXISTS idx_rides_created_at        ON rides(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_driver_locations_phone  ON driver_locations(phone)`,
    `CREATE INDEX IF NOT EXISTS idx_drivers_online          ON drivers(is_online, verification_status)`,
    `CREATE INDEX IF NOT EXISTS idx_driver_metrics_phone    ON driver_metrics(phone)`,
  ];
  for (const sql of indexes) await db.query(sql).catch(() => {});
  console.log('✅ DB indexes ready');

  // Re-queue any rides stuck without a driver (from server restart)
  try {
    const stuck = await db.query(
      `SELECT id, pickup_lat, pickup_lng, ride_type FROM rides
       WHERE status='requested' AND driver_id IS NULL`
    );
    for (const r of stuck.rows) {
      await rideQueue.add('ride-assignment', {
        type: 'assign-next', rideId: r.id, pickupLat: r.pickup_lat, pickupLng: r.pickup_lng,
        rideType: r.ride_type, queue: null, radiusKm: 5
      });
    }
    if (stuck.rows.length) console.log(`✅ Re-queued ${stuck.rows.length} stuck rides on startup`);
  } catch (_e) {}
}, 3000);

// ── Auth Middleware ─────────────────────────────
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ── Distance Calculate (OpenStreetMap - Free) ───
async function getDistance(pickup, dropLocation) {
  try {
    const geoPickup = await fetch(
      'https://nominatim.openstreetmap.org/search?q=' +
      encodeURIComponent(pickup) + '&format=json&limit=1'
    );
    const geoDrop = await fetch(
      'https://nominatim.openstreetmap.org/search?q=' +
      encodeURIComponent(dropLocation) + '&format=json&limit=1'
    );
    const pickupData = await geoPickup.json();
    const dropData   = await geoDrop.json();

    if (pickupData[0] && dropData[0]) {
      const lat1 = parseFloat(pickupData[0].lat);
      const lon1 = parseFloat(pickupData[0].lon);
      const lat2 = parseFloat(dropData[0].lat);
      const lon2 = parseFloat(dropData[0].lon);
      const R    = 6371;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a    = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                   Math.cos(lat1 * Math.PI / 180) *
                   Math.cos(lat2 * Math.PI / 180) *
                   Math.sin(dLon / 2) * Math.sin(dLon / 2);
      const dist = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return Math.round(dist * 10) / 10;
    }
  } catch (e) {
    console.log('Distance error:', e.message);
  }
  return 5; // default 5km
}

// ── Test Routes ─────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: '🚖 Sppero backend chal raha hai!' });
});

app.get('/test-db', async (req, res) => {
  const result = await db.query('SELECT COUNT(*) FROM users');
  res.json({ users_count: result.rows[0].count });
});

// ── OTP Send ─────────────────────────────────────
app.post('/api/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 10) return res.status(400).json({ error: 'Sahi phone number do' });
  try {
    // Block check (3 wrong attempts)
    const blocked = await redis.get('otp:block:' + phone);
    if (blocked) {
      const ttl = await redis.ttl('otp:block:' + phone);
      const mins = Math.ceil(ttl / 60);
      return res.status(429).json({ error: `Bahut zyada attempts! ${mins} min baad try karo` });
    }

    // Resend throttle (60 sec)
    const recentSend = await redis.get('otp:sent:' + phone);
    if (recentSend) {
      const ttl = await redis.ttl('otp:sent:' + phone);
      return res.status(429).json({ error: `${ttl} second baad resend karo` });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await redis.setEx('otp:' + phone, 600, otp);        // 10 min expire
    await redis.setEx('otp:sent:' + phone, 30, '1');    // 30 sec resend block
    await redis.del('otp:attempts:' + phone);

    console.log('📱 OTP for', phone, ':', otp);
    res.json({ message: 'OTP bheja gaya', success: true, otp });
  } catch (err) {
    console.error('send-otp error:', err.message);
    res.status(500).json({ error: 'OTP bhejne mein dikkat. Dobara try karo.' });
  }
});

// ── OTP Verify ──────────────────────────────────
app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone, otp, name } = req.body;
  try {
    // Block check
    const blocked = await redis.get('otp:block:' + phone);
    if (blocked) {
      const ttl = await redis.ttl('otp:block:' + phone);
      return res.status(429).json({ error: `Account blocked! ${Math.ceil(ttl/60)} min baad try karo` });
    }

    // Test OTP bypass — '000000' kisi bhi number ke liye kaam karta hai (dev/testing only)
    const isTestOtp = otp === '000000';

    const savedOtp = await redis.get('otp:' + phone);
    if (!savedOtp && !isTestOtp) return res.status(400).json({ error: 'OTP expire ho gaya! Dobara bhejwao' });

    // Wrong OTP attempts track
    if (!isTestOtp && savedOtp !== otp) {
      const attempts = await redis.incr('otp:attempts:' + phone);
      await redis.expire('otp:attempts:' + phone, 300);
      if (attempts >= 3) {
        await redis.setEx('otp:block:' + phone, 1800, '1'); // 30 min block
        await redis.del('otp:' + phone);
        return res.status(429).json({ error: '3 baar galat OTP! 30 min ke liye block ho gaya' });
      }
      return res.status(400).json({ error: `Galat OTP! ${3 - attempts} aur chances bache hain` });
    }

    // OTP sahi — cleanup (test OTP pe Redis cleanup skip)
    if (!isTestOtp) {
      await redis.del('otp:' + phone);
      await redis.del('otp:attempts:' + phone);
      await redis.del('otp:sent:' + phone);
    }

    let user = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) {
      user = await db.query(
        "INSERT INTO users (phone, name, role) VALUES ($1, $2, 'passenger') RETURNING *",
        [phone, name || 'User']
      );
    } else {
      if (name && name.trim() !== '' && name !== 'Rider') {
        await db.query('UPDATE users SET name = $1 WHERE phone = $2', [name.trim(), phone]);
        user.rows[0].name = name.trim();
      }
    }

    const token = jwt.sign(
      { id: user.rows[0].id, phone },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ message: 'Login successful!', token, user: user.rows[0] });
  } catch (err) {
    console.error('verify-otp error:', err.message);
    res.status(500).json({ error: `Login error: ${err.message}` });
  }
});

// ── Driver Register ─────────────────────────────
app.post('/api/driver/register', async (req, res) => {
  const { phone, name, vehicle_type, vehicle_no, license_no } = req.body;
  try {
    let user = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) {
      user = await db.query(
        "INSERT INTO users (phone, name, role) VALUES ($1, $2, 'driver') RETURNING *",
        [phone, name]
      );
    }
    const userId = user.rows[0].id;
    const driver = await db.query(
      'INSERT INTO drivers (id, vehicle_type, vehicle_no, license_no) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, vehicle_type, vehicle_no, license_no]
    );
    await db.query('INSERT INTO driver_wallet (driver_id) VALUES ($1)', [userId]);
    res.json({ message: 'Driver registered!', driver: driver.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update user name + gender after onboarding ─
app.post('/api/auth/update-name', async (req, res) => {
  const { phone, name, gender } = req.body;
  try {
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(10)').catch(() => {});
    await db.query(
      'UPDATE users SET name=$1, gender=$2 WHERE phone=$3',
      [name, gender || null, phone]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Ride Book ───────────────────────────────────
app.post('/api/rides/book', async (req, res) => {
  const { passenger_phone, pickup, drop_location, ride_type, pickup_lat, pickup_lng, drop_lat, drop_lng, discount, promo_code } = req.body;
  if (!passenger_phone || String(passenger_phone).length !== 10) return res.status(400).json({ error: 'Valid phone do' });
  if (!pickup || !drop_location) return res.status(400).json({ error: 'Pickup aur drop location chahiye' });
  if (!['auto', 'bike', 'car', 'luxury'].includes(ride_type)) return res.status(400).json({ error: 'Invalid ride type' });
  try {
    const passenger = await db.query(
      'SELECT * FROM users WHERE phone = $1', [passenger_phone]
    );
    if (passenger.rows.length === 0)
      return res.status(404).json({ error: 'Passenger nahi mila' });

    const distance = req.body.distance || 5;
    
    // DB se fare settings lo
    const fareRes = await db.query(
      'SELECT * FROM fare_settings WHERE vehicle_type = $1', [ride_type]
    );
    const fareSettings = fareRes.rows[0] || (ride_type === 'luxury' ? { base_fare: 80, per_km_rate: 25, night_multiplier: 1.8, night_start: '22:00', night_end: '06:00' } : { base_fare: 25, per_km_rate: 12, night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' });
    
    // Night time check karo
    const now = new Date();
    const hour = now.getHours();
    const nightStart = parseInt(fareSettings.night_start.split(':')[0]);
    const nightEnd = parseInt(fareSettings.night_end.split(':')[0]);
    const isNight = hour >= nightStart || hour < nightEnd;
    
    let fare = Math.round(parseFloat(fareSettings.base_fare) + (distance * parseFloat(fareSettings.per_km_rate)));
    if (isNight) fare = Math.round(fare * parseFloat(fareSettings.night_multiplier));

    console.log('Distance:', distance, 'km | Fare: ₹' + fare);

    const ride = await db.query(
      `INSERT INTO rides (passenger_id, pickup, drop_location, ride_type, fare, status, pickup_lat, pickup_lng, drop_lat, drop_lng, discount, promo_code)
       VALUES ($1, $2, $3, $4, $5, 'searching', $6, $7, $8, $9, $10, $11) RETURNING *`,
      [passenger.rows[0].id, pickup, drop_location, ride_type, fare, pickup_lat || null, pickup_lng || null, drop_lat || null, drop_lng || null, discount || 0, promo_code || null]
    );

  // Driver assign nahi karte — sirf status requested set karo
    await db.query(
      "UPDATE rides SET status = 'requested' WHERE id = $1",
      [ride.rows[0].id]
    );

    res.json({
      message:  'Driver dhundh rahe hain...',
      fare:     '₹' + fare,
      distance: distance + ' km',
      ride_id:  ride.rows[0].id,
      status:   'requested'
    });

    // Trigger smart assignment (async — does not delay response)
    assignRideToNextDriver(
      ride.rows[0].id,
      pickup_lat || null,
      pickup_lng || null,
      ride_type
    ).catch(() => {});

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ride Complete ───────────────────────────────
app.post('/api/rides/complete-OLD', async (req, res) => {
  const { ride_id, payment_method } = req.body;
  try {
    const ride = await db.query('SELECT * FROM rides WHERE id = $1', [ride_id]);
    if (ride.rows.length === 0)
      return res.status(404).json({ error: 'Ride nahi mili' });
    if (ride.rows[0].status === 'completed')
      return res.status(400).json({ error: 'Ride already complete hai' });

    const fare        = parseFloat(ride.rows[0].fare);
    const platformFee = Math.round(fare * 0.15 * 100) / 100;
    const netEarning  = Math.round((fare - platformFee) * 100) / 100;
    const driverId    = ride.rows[0].driver_id;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE rides SET status = 'completed' WHERE id = $1", [ride_id]);
      await client.query(
        "INSERT INTO payments (ride_id, amount, method, status) VALUES ($1, $2, $3, 'completed')",
        [ride_id, fare, payment_method || 'cash']
      );
      const walletRes = await client.query(
        'UPDATE driver_wallet SET balance = balance + $1, total_earned = total_earned + $1, updated_at = NOW() WHERE driver_id = $2 RETURNING balance',
        [netEarning, driverId]
      );
      await client.query('COMMIT');
      res.json({
        message:       'Ride complete! Driver ko paisa credit hua!',
        fare:          '₹' + fare,
        platform_fee:  '₹' + platformFee,
        driver_earned: '₹' + netEarning,
        new_balance:   '₹' + walletRes.rows[0].balance
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Socket.io ───────────────────────────────────
io.on('connection', (socket) => {
  // Customer joins their ride room for real-time updates
  socket.on('joinRide', ({ rideId }) => {
    socket.join('ride_' + rideId);
  });
  // Driver joins their phone room for real-time ride assignments
  socket.on('driverJoin', ({ phone }) => {
    socket.join('driver_' + phone);
  });
  // Legacy location update
  socket.on('locationUpdate', ({ driverId, lat, lng }) => {
    io.emit('driverMoved_' + driverId, { lat, lng });
  });
  socket.on('driverOnline', ({ driverId }) => {
    socket.join('driver_' + driverId);
  });
});

// Emit ride status update to customer (and anyone listening to this ride)
function emitRideUpdate(rideId, data) {
  io.to('ride_' + rideId).emit('rideUpdate', { rideId, ...data });
}


// ── Driver Pending Ride (Smart Matching) ─────────
app.get('/api/driver/pending-ride-OLD', async (req, res) => {
  const { phone } = req.query;
  try {
    // Driver ka vehicle type nikalo
    const driverResult = await db.query(
      `SELECT d.vehicle_type FROM drivers d
       JOIN users u ON d.id = u.id
       WHERE u.phone = $1`,
      [phone]
    );
    if (driverResult.rows.length === 0) {
      return res.json({ ride: null });
    }
    const vehicleType = driverResult.rows[0].vehicle_type;

    // Driver ki current location
    const locResult = await db.query(
      `SELECT lat, lng FROM driver_locations WHERE phone = $1`,
      [phone]
    );
    const driverLoc = locResult.rows[0];

    // Saari matching unassigned rides
    const result = await db.query(
      `SELECT r.*, 
              p.name AS passenger_name,
              p.phone AS passenger_phone
       FROM rides r
       JOIN users p ON r.passenger_id = p.id
       WHERE r.status = 'requested'
       AND r.driver_id IS NULL
       AND r.ride_type = $1
       ORDER BY r.created_at ASC`,
      [vehicleType]
    );

    if (result.rows.length === 0) {
      return res.json({ ride: null });
    }

    // Agar driver location hai, nearest ride dhundho (within 5km)
    if (driverLoc && driverLoc.lat) {
      const haversine = (lat1, lon1, lat2, lon2) => {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      };

      let nearest = null;
      let minDist = Infinity;
      for (const ride of result.rows) {
        if (ride.pickup_lat && ride.pickup_lng) {
          const dist = haversine(parseFloat(driverLoc.lat), parseFloat(driverLoc.lng), parseFloat(ride.pickup_lat), parseFloat(ride.pickup_lng));
          if (dist < minDist) { minDist = dist; nearest = ride; }
        }
      }
      // Nearest ride within 5km, warna oldest
      if (nearest && minDist <= 5) {
        nearest.distance_to_pickup = minDist.toFixed(1) + ' km';
        return res.json({ ride: nearest });
      }
    }

    // Fallback — oldest ride (agar location nahi ya koi coords nahi)
    res.json({ ride: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── Driver Accept Ride ──────────────────────────
app.post('/api/rides/accept', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  if (!ride_id || !driver_phone) return res.status(400).json({ success: false, message: 'ride_id aur driver_phone chahiye' });
  try {
    const driver = await db.query('SELECT id FROM users WHERE phone=$1', [driver_phone]);
    if (!driver.rows[0]) return res.status(404).json({ success: false, message: 'Driver nahi mila' });

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // Atomic accept: only succeeds if ride is still unassigned (race-condition safe)
    const upd = await db.query(
      `UPDATE rides
       SET status='matched', start_otp=$1, driver_id=$2,
           assigned_to_phone=NULL, assignment_expires_at=NULL, assignment_queue='[]'
       WHERE id=$3 AND status='requested' AND driver_id IS NULL
       RETURNING id`,
      [otp, driver.rows[0].id, ride_id]
    );
    if (!upd.rows[0])
      return res.json({ success: false, message: 'Ride already kisi aur driver ne le li — agli dekho!' });

    // Track acceptance in metrics
    await db.query(
      `INSERT INTO driver_metrics (phone, rides_accepted, idle_since) VALUES ($1, 1, NOW())
       ON CONFLICT (phone) DO UPDATE SET rides_accepted=driver_metrics.rides_accepted+1, idle_since=NOW()`,
      [driver_phone]
    );
    const dm = await db.query('SELECT rides_offered, rides_accepted FROM driver_metrics WHERE phone=$1', [driver_phone]);
    if (dm.rows[0] && dm.rows[0].rides_offered > 0) {
      const rate = (parseFloat(dm.rows[0].rides_accepted) / parseFloat(dm.rows[0].rides_offered)) * 100;
      await db.query('UPDATE driver_metrics SET acceptance_rate=$1 WHERE phone=$2', [Math.min(100, rate).toFixed(2), driver_phone]);
    }

    // Customer ko notification bhejo
    const rideData = await db.query(
      `SELECT u.phone as passenger_phone FROM rides r JOIN users u ON r.passenger_id=u.id WHERE r.id=$1`, [ride_id]
    );
    if (rideData.rows[0]?.passenger_phone)
      sendFCM(rideData.rows[0].passenger_phone, '🚗 Driver Mil Gaya!', 'Aapka driver aa raha hai — OTP ready karo!', { type: 'ride_matched', ride_id: String(ride_id) });

    emitRideUpdate(ride_id, { status: 'matched' });
    res.json({ success: true, message: 'Ride accepted!', otp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Driver: Reject ride offer (advance queue immediately) ──
app.post('/api/rides/reject-offer', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  try {
    const r = await db.query(
      `SELECT assigned_to_phone, assignment_queue, pickup_lat, pickup_lng, ride_type
       FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`, [ride_id]
    );
    if (!r.rows[0] || r.rows[0].assigned_to_phone !== driver_phone)
      return res.json({ success: false, error: 'Not your assignment' });

    const { pickup_lat, pickup_lng, ride_type, assignment_queue } = r.rows[0];
    const nextQueue = JSON.parse(assignment_queue || '[]');

    // Recalculate acceptance rate (they rejected → lower rate)
    const dm = await db.query('SELECT rides_offered, rides_accepted FROM driver_metrics WHERE phone=$1', [driver_phone]);
    if (dm.rows[0] && parseFloat(dm.rows[0].rides_offered) > 0) {
      const rate = (parseFloat(dm.rows[0].rides_accepted) / parseFloat(dm.rows[0].rides_offered)) * 100;
      await db.query('UPDATE driver_metrics SET acceptance_rate=$1 WHERE phone=$2', [Math.min(100, rate).toFixed(2), driver_phone]);
    }

    res.json({ success: true });

    // Immediately advance to next driver (async after response)
    assignRideToNextDriver(ride_id, pickup_lat, pickup_lng, ride_type, nextQueue).catch(() => {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Ride Status Check ───────────────────────────
app.get('/api/rides/status/:rideId', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.*, u.name as driver_name, u.phone as driver_phone,
              d.vehicle_no, d.vehicle_brand, d.vehicle_model, d.upi_id as driver_upi_id
       FROM rides r
       LEFT JOIN users u ON r.driver_id = u.id
       LEFT JOIN drivers d ON r.driver_id = d.id
       WHERE r.id = $1`,
      [req.params.rideId]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Ride nahi mili' });
    res.json({ ride: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver: Save / Update UPI ID ────────────────
app.post('/api/driver/upi', async (req, res) => {
  const { phone, upi_id } = req.body;
  try {
    await db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS upi_id VARCHAR(100)');
    const result = await db.query(
      `UPDATE drivers SET upi_id=$1 WHERE id=(SELECT id FROM users WHERE phone=$2) RETURNING upi_id`,
      [upi_id, phone]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Driver nahi mila' });
    res.json({ success: true, upi_id: result.rows[0].upi_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Driver: Get own UPI ID ───────────────────────
app.get('/api/driver/upi', async (req, res) => {
  const { phone } = req.query;
  try {
    const r = await db.query(
      `SELECT d.upi_id FROM drivers d JOIN users u ON d.id=u.id WHERE u.phone=$1`, [phone]
    );
    res.json({ upi_id: r.rows[0]?.upi_id || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ══════════════════════════════════════════════════
//  PHASE 1 — TRIP STATUS MANAGEMENT APIs
//  server.js mein app.listen se PEHLE paste karo
// ══════════════════════════════════════════════════

// ── Driver: Active Ride dekho ───────────────────────
app.get('/api/driver/active-ride', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(
      `SELECT r.*, 
              p.name AS passenger_name, 
              p.phone AS passenger_phone,
              d2.vehicle_no
       FROM rides r
       JOIN users d ON r.driver_id = d.id
       LEFT JOIN users p ON r.passenger_id::text = p.id::text
       LEFT JOIN drivers d2 ON r.driver_id = d2.id
       WHERE d.phone = $1
         AND r.status IN ('matched','arrived','started')
       ORDER BY r.created_at DESC LIMIT 1`,
      [phone]
    );
    res.json({ ride: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver: Pickup pe pahunch gaya ──────────────────
app.post('/api/rides/arrived', async (req, res) => {
  const { ride_id } = req.body;
  try {
    await db.query(
      "UPDATE rides SET status = 'arrived' WHERE id = $1",
      [ride_id]
    );
    // Customer ko notify karo
    const arrData = await db.query(
      `SELECT u.phone as passenger_phone FROM rides r JOIN users u ON r.passenger_id = u.id WHERE r.id = $1`,
      [ride_id]
    );
    if (arrData.rows[0]?.passenger_phone) {
      sendFCM(arrData.rows[0].passenger_phone, '🚗 Driver Aa Gaya!', 'Driver pickup pe hai — OTP batao aur trip shuru karo!', { type: 'driver_arrived', ride_id: String(ride_id) });
    }
    emitRideUpdate(ride_id, { status: 'arrived' });
    res.json({ success: true, message: 'Pickup pe pahunch gaye!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver: Trip shuru karo ─────────────────────────
app.post('/api/rides/start', async (req, res) => {
  const { ride_id, otp } = req.body;
  try {
    const check = await db.query(
      'SELECT start_otp FROM rides WHERE id = $1',
      [ride_id]
    );
    if (check.rows[0]?.start_otp !== otp) {
      return res.status(400).json({ success: false, message: 'Galat OTP!' });
    }
    await db.query(
      "UPDATE rides SET status = 'started' WHERE id = $1",
      [ride_id]
    );
    emitRideUpdate(ride_id, { status: 'started' });
    res.json({ success: true, message: 'Trip shuru!' });
    // Notify customer that trip has started
    db.query(`SELECT u.phone FROM rides r JOIN users u ON r.passenger_id=u.id WHERE r.id=$1`, [ride_id])
      .then(r => { if (r.rows[0]) sendFCM(r.rows[0].phone, '🚀 Trip Shuru Ho Gaya!', 'Aapka ride chal raha hai. Safe journey!', { type: 'trip_started', ride_id: String(ride_id) }); })
      .catch(() => {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver: Trip cancel karo ────────────────────────
app.post('/api/rides/cancel', async (req, res) => {
  const { ride_id, reason } = req.body;
  try {
    await db.query(
      "UPDATE rides SET status = 'cancelled' WHERE id = $1",
      [ride_id]
    );
    res.json({ success: true, message: 'Trip cancel ki', reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  RAZORPAY PAYMENT APIs
//  server.js mein server.listen se PEHLE paste karo
// ══════════════════════════════════════════════════

// ── Payment Order banao ─────────────────────────────
app.post('/api/payment/create-order', async (req, res) => {
  const { amount, ride_id } = req.body;
  try {
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // paise mein
      currency: 'INR',
      receipt: 'ride_' + ride_id,
    });
    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      key_id: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Payment Verify karo ─────────────────────────────
app.post('/api/payment/verify', async (req, res) => {
  const { ride_id, payment_id, amount, method } = req.body;
  try {
    await db.query(
      `INSERT INTO payments (ride_id, amount, method, status)
       VALUES ($1, $2, $3, 'completed')`,
      [ride_id, amount, method || 'online']
    );
    res.json({ success: true, message: 'Payment successful!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  RIDE HISTORY API
//  server.js mein server.listen se PEHLE paste karo
// ══════════════════════════════════════════════════

// ── Passenger Ride History ──────────────────────────
app.get('/api/rides/history', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(
      `SELECT r.id, r.pickup, r.drop_location, r.fare, r.ride_type,
              r.status, r.created_at,
              d.name AS driver_name
       FROM rides r
       JOIN users u ON r.passenger_id = u.id
       LEFT JOIN users d ON r.driver_id = d.id
       WHERE u.phone = $1
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [phone]
    );
    res.json({ rides: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver Ride History + Stats ─────────────────────
app.get('/api/driver/history', async (req, res) => {
  const { phone } = req.query;
  try {
    const rides = await db.query(
      `SELECT r.id, r.pickup, r.drop_location, r.fare, r.ride_type,
              r.status, r.created_at,
              p.name AS passenger_name
       FROM rides r
       JOIN users d ON r.driver_id = d.id
       LEFT JOIN users p ON r.passenger_id = p.id
       WHERE d.phone = $1 AND r.status = 'completed'
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [phone]
    );

    // Wallet balance
    const wallet = await db.query(
      `SELECT w.balance, w.total_earned
       FROM driver_wallet w
       JOIN users d ON w.driver_id = d.id
       WHERE d.phone = $1`,
      [phone]
    );

    res.json({
      rides: rides.rows,
      wallet: wallet.rows[0] || { balance: 0, total_earned: 0 },
      total_trips: rides.rows.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  LIVE LOCATION TRACKING APIs
//  server.js mein server.listen se PEHLE paste karo
// ══════════════════════════════════════════════════

// In-memory store for driver locations (fast access)
const driverLocations = {};

// ── Driver: apni location update kare ───────────────
app.post('/api/driver/update-location-OLD', async (req, res) => {
  const { phone, lat, lng } = req.body;
  try {
    driverLocations[phone] = { lat, lng, updated: Date.now() };
    // DB mein bhi save karo (matching ke liye)
    await db.query(
      `INSERT INTO driver_locations (phone, lat, lng, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (phone) DO UPDATE SET lat = $2, lng = $3, updated_at = NOW()`,
      [phone, lat, lng]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Customer: driver ki live location le ────────────
app.get('/api/rides/driver-location-OLD/:rideId', async (req, res) => {
  try {
    // Ride se driver ka phone nikalo
    const result = await db.query(
      `SELECT u.phone FROM rides r
       JOIN users u ON r.driver_id = u.id
       WHERE r.id = $1`,
      [req.params.rideId]
    );
    if (result.rows.length === 0)
      return res.json({ location: null });

    const driverPhone = result.rows[0].phone;
    const loc = driverLocations[driverPhone] || null;
    res.json({ location: loc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  ADMIN DASHBOARD APIs
//  server.js mein server.listen se PEHLE paste karo
// ══════════════════════════════════════════════════

// ── Admin: Dashboard Stats ──────────────────────────
app.get('/api/admin/stats', async (req, res) => {
  try {
    const users    = await db.query("SELECT COUNT(*) FROM users WHERE role = 'passenger'");
    const drivers  = await db.query("SELECT COUNT(*) FROM drivers");
    const rides    = await db.query("SELECT COUNT(*) FROM rides");
    const completed= await db.query("SELECT COUNT(*) FROM rides WHERE status = 'completed'");
    const revenue  = await db.query("SELECT COALESCE(SUM(fare),0) AS total FROM rides WHERE status = 'completed'");
    const todayRides = await db.query("SELECT COUNT(*) FROM rides WHERE created_at >= CURRENT_DATE");

    res.json({
      total_customers: parseInt(users.rows[0].count),
      total_drivers:   parseInt(drivers.rows[0].count),
      total_rides:     parseInt(rides.rows[0].count),
      completed_rides: parseInt(completed.rows[0].count),
      total_revenue:   parseFloat(revenue.rows[0].total),
      today_rides:     parseInt(todayRides.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: All Rides ────────────────────────────────
app.get('/api/admin/rides', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.pickup, r.drop_location, r.fare, r.ride_type,
              r.status, r.created_at, r.rating, r.review,
              p.name AS passenger_name, p.phone AS passenger_phone,
              d.name AS driver_name
       FROM rides r
       LEFT JOIN users p ON r.passenger_id = p.id
       LEFT JOIN users d ON r.driver_id = d.id
       ORDER BY r.created_at DESC
       LIMIT 100`
    );
    res.json({ rides: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: All Drivers ──────────────────────────────
app.get('/api/admin/drivers', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.name, u.phone, d.vehicle_type, d.vehicle_no,
              d.is_online, d.rating,
              COALESCE(w.balance, 0) AS balance,
              COALESCE(w.total_earned, 0) AS total_earned
       FROM drivers d
       JOIN users u ON d.id = u.id
       LEFT JOIN driver_wallet w ON d.id = w.driver_id
       ORDER BY u.name`
    );
    res.json({ drivers: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: All Customers ────────────────────────────
app.get('/api/admin/customers', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.name, u.phone, u.created_at,
              COUNT(r.id) AS total_rides,
              COALESCE(w.balance, 0) AS wallet_balance
       FROM users u
       LEFT JOIN rides r ON r.passenger_id = u.id
       LEFT JOIN customer_wallet w ON w.user_id = u.id
       WHERE u.role = 'passenger'
       GROUP BY u.id, u.name, u.phone, u.created_at, w.balance
       ORDER BY u.created_at DESC`
    );
    res.json({ customers: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  WALLET APIs
//  server.js mein server.listen se PEHLE paste karo
// ══════════════════════════════════════════════════

// ── Customer: Wallet balance dekho ──────────────────
app.get('/api/wallet/balance', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ balance: 0 });
    const userId = user.rows[0].id;

    // Wallet nahi hai toh banao
    let wallet = await db.query('SELECT balance FROM customer_wallet WHERE user_id = $1', [userId]);
    if (wallet.rows.length === 0) {
      await db.query('INSERT INTO customer_wallet (user_id) VALUES ($1)', [userId]);
      return res.json({ balance: 0 });
    }
    res.json({ balance: parseFloat(wallet.rows[0].balance) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Customer: Wallet mein paisa add karo ────────────
app.post('/api/wallet/add', async (req, res) => {
  const { phone, amount } = req.body;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User nahi mila' });
    const userId = user.rows[0].id;

    // Wallet ensure karo
    await db.query(
      'INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    );
    // Balance badhao
    const result = await db.query(
      'UPDATE customer_wallet SET balance = balance + $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance',
      [amount, userId]
    );
    // Transaction record
    await db.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'credit', $2, 'Wallet recharge')",
      [userId, amount]
    );
    res.json({ success: true, balance: parseFloat(result.rows[0].balance) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Customer: Wallet se ride pay karo ───────────────
app.post('/api/wallet/pay', async (req, res) => {
  const { phone, amount, ride_id } = req.body;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User nahi mila' });
    const userId = user.rows[0].id;

    const wallet = await db.query('SELECT balance FROM customer_wallet WHERE user_id = $1', [userId]);
    const balance = wallet.rows[0] ? parseFloat(wallet.rows[0].balance) : 0;

    if (balance < amount) {
      return res.json({ success: false, message: 'Wallet mein paisa kam hai', balance });
    }

    const result = await db.query(
      'UPDATE customer_wallet SET balance = balance - $1, updated_at = NOW() WHERE user_id = $2 RETURNING balance',
      [amount, userId]
    );
    await db.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'debit', $2, 'Ride payment')",
      [userId, amount]
    );
    await db.query(
      "INSERT INTO payments (ride_id, amount, method, status) VALUES ($1, $2, 'wallet', 'completed')",
      [ride_id, amount]
    );
    res.json({ success: true, balance: parseFloat(result.rows[0].balance) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Transactions history ────────────────────────────
app.get('/api/wallet/transactions', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ transactions: [] });
    const result = await db.query(
      'SELECT type, amount, description, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [user.rows[0].id]
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver: Payout request ──────────────────────────
app.post('/api/driver/payout', async (req, res) => {
  const { phone, amount } = req.body;
  try {
    const driver = await db.query(
      `SELECT w.driver_id, w.balance, COALESCE(w.pending_commission, 0) as pending_commission
       FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`,
      [phone]
    );
    if (!driver.rows[0]) return res.status(404).json({ error: 'Driver nahi mila' });
    const balance = parseFloat(driver.rows[0].balance);
    const pendingCommission = parseFloat(driver.rows[0].pending_commission);

    if (balance < amount) return res.json({ success: false, message: 'Balance kam hai', balance });

    // Auto-deduct pending commission from this payout before releasing to driver
    const commDeduct = Math.min(pendingCommission, amount);
    const actualPayout = amount - commDeduct;

    const result = await db.query(
      `UPDATE driver_wallet
       SET balance = balance - $1,
           total_withdrawn = total_withdrawn + $2,
           pending_commission = GREATEST(0, COALESCE(pending_commission, 0) - $3)
       WHERE driver_id = $4 RETURNING balance, pending_commission`,
      [amount, actualPayout, commDeduct, driver.rows[0].driver_id]
    );

    if (commDeduct > 0) {
      await db.query(
        `UPDATE driver_commissions SET status = 'settled' WHERE driver_phone = $1 AND status = 'cash_owed'`,
        [phone]
      ).catch(() => {});
    }

    const newPending = parseFloat(result.rows[0].pending_commission);
    res.json({
      success: true,
      balance: parseFloat(result.rows[0].balance),
      actual_payout: actualPayout,
      commission_deducted: commDeduct,
      pending_commission: newPending,
      message: commDeduct > 0
        ? `Payout bhej di! ₹${commDeduct.toFixed(0)} commission platform ne rakha.`
        : 'Payout request submitted!'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  DRIVER DOCUMENT UPLOAD + REGISTRATION APIs
//  server.js mein server.listen se PEHLE paste karo
//  (cloudinary config top pe hona chahiye)
// ══════════════════════════════════════════════════

// ── Photo upload to Cloudinary ──────────────────────
// App base64 image bhejega, yeh Cloudinary pe upload karke URL dega
app.post('/api/upload', async (req, res) => {
  const { image } = req.body; // base64 data URI: "data:image/jpeg;base64,..."
  try {
    if (!image) return res.status(400).json({ error: 'Image nahi mili' });
    const result = await cloudinary.uploader.upload(image, {
      folder: 'rideapp_drivers',
      resource_type: 'image'
    });
    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver Registration (Sppero Buddy) ───────────────
app.post('/api/driver/register-buddy', async (req, res) => {
  const {
    phone, name, vehicle_type, vehicle_no, vehicle_brand, vehicle_model,
    dl_name, dl_number, dl_photo, vehicle_photo, rc_photo,
    aadhaar_number, aadhaar_photo, face_photo
  } = req.body;
  try {
    // User exist karta hai? (phone se)
    let user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    let userId;
    if (user.rows.length === 0) {
      // Naya user banao (driver role)
      const newUser = await db.query(
        "INSERT INTO users (name, phone, role) VALUES ($1, $2, 'driver') RETURNING id",
        [name || dl_name, phone]
      );
      userId = newUser.rows[0].id;
    } else {
      userId = user.rows[0].id;
      // Role driver karo
      await db.query("UPDATE users SET role = 'driver', name = $1 WHERE id = $2", [name || dl_name, userId]);
    }

    // Driver record banao ya update karo
    const existing = await db.query('SELECT id FROM drivers WHERE id = $1', [userId]);
    if (existing.rows.length === 0) {
      await db.query(
        `INSERT INTO drivers (id, vehicle_type, vehicle_brand, vehicle_model, vehicle_no, dl_name, dl_number, dl_photo,
            vehicle_photo, rc_photo, aadhaar_number, aadhaar_photo, face_photo,
            verification_status, is_online, rating)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',false,5.0)`,
        [userId, vehicle_type, vehicle_brand || null, vehicle_model || null, vehicle_no || null,
         dl_name, dl_number || null, dl_photo, vehicle_photo, rc_photo || null,
         aadhaar_number, aadhaar_photo, face_photo]
      );
    } else {
      await db.query(
        `UPDATE drivers SET vehicle_type=$2, vehicle_brand=$3, vehicle_model=$4, vehicle_no=$5,
            dl_name=$6, dl_number=$7, dl_photo=$8, vehicle_photo=$9, rc_photo=$10,
            aadhaar_number=$11, aadhaar_photo=$12, face_photo=$13,
            verification_status='pending', admin_message=NULL
         WHERE id=$1`,
        [userId, vehicle_type, vehicle_brand || null, vehicle_model || null, vehicle_no || null,
         dl_name, dl_number || null, dl_photo, vehicle_photo, rc_photo || null,
         aadhaar_number, aadhaar_photo, face_photo]
      );
    }

    // Driver wallet ensure karo
    await db.query(
      'INSERT INTO driver_wallet (driver_id) VALUES ($1) ON CONFLICT (driver_id) DO NOTHING',
      [userId]
    );

    res.json({ success: true, message: 'Registration submit ho gaya! Verification pending.', status: 'pending' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver: apna verification status check kare ─────
app.get('/api/driver/verification-status', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(
      `SELECT d.verification_status, d.admin_message
       FROM drivers d JOIN users u ON d.id = u.id
       WHERE u.phone = $1`,
      [phone]
    );
    if (result.rows.length === 0) return res.json({ status: null });
    res.json({
      status: result.rows[0].verification_status,
      message: result.rows[0].admin_message
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  ADMIN DRIVER VERIFICATION APIs
//  server.js mein server.listen se PEHLE paste karo
// ══════════════════════════════════════════════════

// ── Admin: Pending/all drivers with documents ───────
app.get('/api/admin/driver-verifications', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.phone,
              d.vehicle_type, d.vehicle_brand, d.vehicle_model, d.vehicle_no,
              d.dl_name, d.dl_number, d.dl_photo,
              d.vehicle_photo, d.rc_photo, d.aadhaar_number, d.aadhaar_photo,
              d.face_photo, d.verification_status, d.admin_message
       FROM drivers d
       JOIN users u ON d.id = u.id
       ORDER BY
         CASE d.verification_status
           WHEN 'pending' THEN 1
           WHEN 'resubmit' THEN 2
           WHEN 'rejected' THEN 3
           WHEN 'approved' THEN 4
           ELSE 5 END,
         u.name`
    );
    res.json({ drivers: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: Approve / Reject / Suspend / Resubmit driver ────────
app.post('/api/admin/verify-driver', async (req, res) => {
  const { driver_id, status, message } = req.body;
  // status: 'approved' | 'rejected' | 'suspended' | 'resubmit'
  if (!['approved','rejected','suspended','resubmit'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  try {
    await db.query(
      'UPDATE drivers SET verification_status = $1, admin_message = $2 WHERE id::text = $3::text',
      [status, message || null, String(driver_id)]
    );
    // Send FCM notification to driver
    const dr = await db.query('SELECT u.phone FROM drivers d JOIN users u ON d.id=u.id WHERE d.id::text = $1::text', [String(driver_id)]);
    if (dr.rows[0]) {
      const dPhone = dr.rows[0].phone;
      if (status === 'approved') {
        sendFCM(dPhone, '🎉 Sppero Buddy Captain — Approved!', 'Aapke documents verify ho gaye! Ab app mein login karke rides lo.');
      } else if (status === 'rejected') {
        sendFCM(dPhone, '❌ Documents Reject Ho Gaye', message || 'Aapke documents mein problem hai — app mein dekho aur dobara upload karo.');
      } else if (status === 'resubmit') {
        sendFCM(dPhone, '📋 Documents Resubmit Karein', message || 'Admin ne kuch documents dobara maange hain — app mein message padho.');
      } else if (status === 'suspended') {
        sendFCM(dPhone, '⚠️ Account Suspend Ho Gaya', message || 'Aapka Sppero Buddy Captain account suspend kar diya gaya hai.');
      }
    }
    res.json({ success: true, message: `Driver ${status} ho gaya` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  SCRATCH CARD APIs
//  server.js mein server.listen se PEHLE paste karo
// ══════════════════════════════════════════════════

// ── Ride ke baad scratch card generate karo ─────────
app.post('/api/scratch-card/create', async (req, res) => {
  const { phone, ride_id } = req.body;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ success: false });
    const userId = user.rows[0].id;

    // Random reward: zyada chance chhote reward ka (realistic)
    const rand = Math.random();
    let reward;
    if (rand < 0.50) reward = Math.floor(Math.random() * 5) + 1;      // ₹1-5 (50%)
    else if (rand < 0.80) reward = Math.floor(Math.random() * 10) + 5; // ₹5-15 (30%)
    else if (rand < 0.95) reward = Math.floor(Math.random() * 20) + 15;// ₹15-35 (15%)
    else reward = Math.floor(Math.random() * 50) + 50;                 // ₹50-100 (5%)

    const card = await db.query(
      `INSERT INTO scratch_cards (user_id, ride_id, reward_amount)
       VALUES ($1, $2, $3) RETURNING id, reward_amount`,
      [userId, ride_id || null, reward]
    );
    res.json({ success: true, card_id: card.rows[0].id, reward: parseFloat(card.rows[0].reward_amount) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Scratch karo → reward wallet mein add ───────────
app.post('/api/scratch-card/scratch', async (req, res) => {
  const { card_id, phone } = req.body;
  try {
    const card = await db.query('SELECT * FROM scratch_cards WHERE id = $1', [card_id]);
    if (card.rows.length === 0) return res.json({ success: false, message: 'Card nahi mila' });
    if (card.rows[0].is_scratched) return res.json({ success: false, message: 'Pehle hi scratch ho chuka' });

    const reward = parseFloat(card.rows[0].reward_amount);
    const userId = card.rows[0].user_id;

    // Card scratched mark karo
    await db.query('UPDATE scratch_cards SET is_scratched = true WHERE id = $1', [card_id]);

    // Wallet mein reward add karo
    await db.query(
      'INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [userId]
    );
    const wallet = await db.query(
      'UPDATE customer_wallet SET balance = balance + $1 WHERE user_id = $2 RETURNING balance',
      [reward, userId]
    );
    await db.query(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'credit', $2, 'Scratch card reward')",
      [userId, reward]
    );

    res.json({ success: true, reward, balance: parseFloat(wallet.rows[0].balance) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  DRIVER LOGIN API (real driver)
//  server.js mein server.listen se PEHLE paste karo
// ══════════════════════════════════════════════════

// ── Driver login — phone se data + status ───────────
app.post('/api/driver/login', async (req, res) => {
  const { phone } = req.body;
  try {
    const result = await db.query(
      `SELECT u.id, u.name, u.phone,
              d.vehicle_type, d.vehicle_no, d.dl_name,
              d.verification_status, d.admin_message, d.rating
       FROM users u
       JOIN drivers d ON u.id = d.id
       WHERE u.phone = $1`,
      [phone]
    );
    if (result.rows.length === 0) {
      return res.json({ success: false, message: 'Yeh number registered nahi hai. Pehle Sppero Buddy banein.' });
    }
    const d = result.rows[0];
    res.json({
      success: true,
      driver: {
        name: d.name || d.dl_name,
        phone: d.phone,
        vehicle_type: d.vehicle_type,
        vehicle_no: d.vehicle_no,
        rating: d.rating || 5.0,
        status: d.verification_status,
        admin_message: d.admin_message
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/driver/toggle-online', async (req, res) => {
  const { phone, is_online } = req.body;
  try {
    await db.query(
      `UPDATE drivers SET is_online = $1
       WHERE id = (SELECT id FROM users WHERE phone = $2)`,
      [is_online, phone]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Rating save karo ────────────────────────────────
app.post('/api/rides/rate', async (req, res) => {
  const { ride_id, rating, review, tip } = req.body;
  try {
    // Ride mein rating save karo
    await db.query(
      `UPDATE rides SET rating = $1, review = $2 WHERE id = $3`,
      [rating, review || null, ride_id]
    );

    // Driver ki average rating update karo
    const rideData = await db.query(
      `SELECT driver_id FROM rides WHERE id = $1`, [ride_id]
    );
    if (rideData.rows[0]?.driver_id) {
      await db.query(
        `UPDATE drivers SET rating = (
          SELECT ROUND(AVG(rating)::numeric, 1)
          FROM rides
          WHERE driver_id = $1 AND rating IS NOT NULL
        ) WHERE id = $1`,
        [rideData.rows[0].driver_id]
      );
    }

    // Tip wallet mein add karo (driver ke)
    if (tip && tip > 0 && rideData.rows[0]?.driver_id) {
      await db.query(
        `UPDATE driver_wallet SET balance = balance + $1, total_earned = total_earned + $1
         WHERE driver_id = $2`,
        [tip, rideData.rows[0].driver_id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Auto-cancel stale rides (older than 5 min)
setInterval(async () => {
  try {
    await db.query(`
      UPDATE rides SET status = 'cancelled'
      WHERE status = 'requested'
      AND driver_id IS NULL
      AND created_at < NOW() - INTERVAL '5 minutes'
    `);
  } catch (_e) {}
}, 60000);
// ── Fare Settings APIs ──────────────────────────

// Get fare settings (customer app ke liye)
app.get('/api/fare-settings', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM fare_settings ORDER BY vehicle_type');
    res.json({ fares: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Update fare settings (UPSERT — works even if row not yet inserted)
app.post('/api/admin/fare-settings', async (req, res) => {
  const { vehicle_type, base_fare, per_km_rate, night_multiplier, night_start, night_end } = req.body;
  try {
    await db.query(
      `WITH updated AS (
         UPDATE fare_settings
         SET base_fare=$1, per_km_rate=$2, night_multiplier=$3, night_start=$4, night_end=$5, updated_at=NOW()
         WHERE vehicle_type=$6
         RETURNING 1
       )
       INSERT INTO fare_settings (vehicle_type, base_fare, per_km_rate, night_multiplier, night_start, night_end)
       SELECT $6, $1, $2, $3, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM updated)`,
      [base_fare, per_km_rate, night_multiplier, night_start, night_end, vehicle_type]
    );
    res.json({ success: true, message: 'Fare updated!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  NEW FEATURES APIs — server.listen se PEHLE paste karo
// ══════════════════════════════════════════════════

// ─────────────────────────────────────────────────
//  1. PROMO CODES
// ─────────────────────────────────────────────────
app.post('/api/promo/validate', async (req, res) => {
  const { code, fare, phone } = req.body;
  try {
    const promo = await db.query(
      `SELECT * FROM promo_codes WHERE UPPER(code) = UPPER($1) AND active = true`,
      [code]
    );
    if (promo.rows.length === 0) return res.json({ valid: false, message: 'Galat promo code' });
    const p = promo.rows[0];

    if (p.expires_at && new Date(p.expires_at) < new Date())
      return res.json({ valid: false, message: 'Promo code expire ho gaya' });
    if (p.used_count >= p.usage_limit)
      return res.json({ valid: false, message: 'Promo code limit khatam' });
    if (parseFloat(fare) < parseFloat(p.min_fare))
      return res.json({ valid: false, message: `Minimum ₹${p.min_fare} ki ride chahiye` });

    // Check user already used
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length > 0) {
      const used = await db.query(
        'SELECT id FROM promo_usage WHERE user_id = $1 AND promo_code = $2',
        [user.rows[0].id, code.toUpperCase()]
      );
      if (used.rows.length > 0)
        return res.json({ valid: false, message: 'Aap yeh code pehle use kar chuke' });
    }

    let discount = p.discount_type === 'percent'
      ? Math.round(parseFloat(fare) * parseFloat(p.discount_value) / 100)
      : parseFloat(p.discount_value);
    if (discount > parseFloat(p.max_discount)) discount = parseFloat(p.max_discount);

    res.json({ valid: true, discount, final_fare: Math.max(0, Math.round(parseFloat(fare) - discount)), message: `₹${discount} discount!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/promo/apply', async (req, res) => {
  const { code, phone, ride_id, discount } = req.body;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ success: false });
    await db.query(
      `INSERT INTO promo_usage (user_id, promo_code, ride_id, discount_applied) VALUES ($1, $2, $3, $4)`,
      [user.rows[0].id, code.toUpperCase(), ride_id || null, discount]
    );
    await db.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE UPPER(code) = UPPER($1)`, [code]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: list/add/toggle promo codes
app.get('/api/admin/promos', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
    res.json({ promos: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/promos', async (req, res) => {
  const { code, discount_type, discount_value, max_discount, min_fare, usage_limit } = req.body;
  try {
    await db.query(
      `INSERT INTO promo_codes (code, discount_type, discount_value, max_discount, min_fare, usage_limit)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET discount_type=$2, discount_value=$3, max_discount=$4, min_fare=$5, usage_limit=$6, active=true`,
      [code.toUpperCase(), discount_type, discount_value, max_discount || 100, min_fare || 0, usage_limit || 1000]
    );
    res.json({ success: true, message: 'Promo code saved!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/promos/toggle', async (req, res) => {
  const { code, active } = req.body;
  try {
    await db.query('UPDATE promo_codes SET active = $1 WHERE code = $2', [active, code]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────
//  2. REFERRAL SYSTEM
// ─────────────────────────────────────────────────
function genReferralCode(name) {
  const base = (name || 'USER').substring(0, 4).toUpperCase().replace(/[^A-Z]/g, '');
  return base + Math.floor(1000 + Math.random() * 9000);
}

app.get('/api/referral/my-code', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id, name, referral_code FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ code: null });
    let code = user.rows[0].referral_code;
    if (!code) {
      code = genReferralCode(user.rows[0].name);
      await db.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, user.rows[0].id]);
    }
    // Count referrals
    const count = await db.query('SELECT COUNT(*) FROM referrals WHERE referrer_id = $1', [user.rows[0].id]);
    const earned = await db.query("SELECT COALESCE(SUM(reward_amount),0) AS total FROM referrals WHERE referrer_id = $1 AND status = 'completed'", [user.rows[0].id]);
    res.json({ code, total_referrals: parseInt(count.rows[0].count), total_earned: parseFloat(earned.rows[0].total) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/referral/apply', async (req, res) => {
  const { phone, referral_code } = req.body;
  try {
    const newUser = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (newUser.rows.length === 0) return res.json({ success: false, message: 'User nahi mila' });

    const referrer = await db.query('SELECT id FROM users WHERE referral_code = $1', [referral_code.toUpperCase()]);
    if (referrer.rows.length === 0) return res.json({ success: false, message: 'Galat referral code' });
    if (referrer.rows[0].id === newUser.rows[0].id) return res.json({ success: false, message: 'Apna hi code use nahi kar sakte' });

    // Already referred?
    const exists = await db.query('SELECT id FROM referrals WHERE referred_id = $1', [newUser.rows[0].id]);
    if (exists.rows.length > 0) return res.json({ success: false, message: 'Aap pehle referral use kar chuke' });

    await db.query(
      `INSERT INTO referrals (referrer_id, referred_id, referral_code, reward_amount, status) VALUES ($1,$2,$3,50,'completed')`,
      [referrer.rows[0].id, newUser.rows[0].id, referral_code.toUpperCase()]
    );

    // Reward dono ko ₹50 wallet
    for (const uid of [referrer.rows[0].id, newUser.rows[0].id]) {
      await db.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [uid]);
      await db.query('UPDATE customer_wallet SET balance = balance + 50 WHERE user_id = $1', [uid]);
      await db.query("INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'credit',50,'Referral reward')", [uid]);
    }
    res.json({ success: true, message: '₹50 reward dono ko mil gaya!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────
//  3. CHAT
// ─────────────────────────────────────────────────
app.post('/api/chat/send', async (req, res) => {
  const { ride_id, sender, message } = req.body;
  try {
    await db.query('INSERT INTO chat_messages (ride_id, sender, message) VALUES ($1,$2,$3)', [ride_id, sender, message]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chat/:rideId', async (req, res) => {
  try {
    const r = await db.query('SELECT sender, message, created_at FROM chat_messages WHERE ride_id = $1 ORDER BY created_at ASC', [req.params.rideId]);
    res.json({ messages: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Hourly booking chat — uses ride_id = 'h_<booking_id>' to avoid collision with regular rides
app.post('/api/hourly/chat/send', async (req, res) => {
  const { booking_id, sender, message } = req.body;
  if (!booking_id || !sender || !message) return res.status(400).json({ error: 'booking_id, sender, message required' });
  try {
    await db.query('INSERT INTO chat_messages (ride_id, sender, message) VALUES ($1,$2,$3)', [`h_${booking_id}`, sender, message]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hourly/chat/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT sender, message, created_at FROM chat_messages WHERE ride_id=$1 ORDER BY created_at ASC', [`h_${req.params.id}`]);
    res.json({ messages: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────
//  4. GPS RANGE CHECK (pickup 15m, drop 10m)
// ─────────────────────────────────────────────────
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

app.post('/api/rides/check-range', async (req, res) => {
  const { ride_id, driver_lat, driver_lng, type } = req.body; // type: 'pickup' | 'drop'
  try {
    const ride = await db.query('SELECT pickup_lat, pickup_lng, drop_lat, drop_lng FROM rides WHERE id = $1', [ride_id]);
    if (ride.rows.length === 0) return res.json({ in_range: false });
    const r = ride.rows[0];
    let targetLat, targetLng, maxDist;
    if (type === 'pickup') { targetLat = r.pickup_lat; targetLng = r.pickup_lng; maxDist = 15; }
    else { targetLat = r.drop_lat; targetLng = r.drop_lng; maxDist = 10; }

    if (!targetLat || !targetLng) return res.json({ in_range: true, distance: 0, note: 'No coords - allowed' });

    const dist = distanceMeters(driver_lat, driver_lng, parseFloat(targetLat), parseFloat(targetLng));
    res.json({ in_range: dist <= maxDist, distance: Math.round(dist), max: maxDist });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────
//  5. DRIVER DAILY TARGET
// ─────────────────────────────────────────────────
app.get('/api/driver/target', async (req, res) => {
  const { phone } = req.query;
  try {
    const target = await db.query('SELECT * FROM driver_targets WHERE active = true LIMIT 1');
    const t = target.rows[0] || { rides_target: 10, bonus_amount: 200 };
    const today = await db.query(
      `SELECT COUNT(*) FROM rides r JOIN users u ON r.driver_id = u.id
       WHERE u.phone = $1 AND r.status = 'completed' AND r.created_at >= CURRENT_DATE`,
      [phone]
    );
    const done = parseInt(today.rows[0].count);
    res.json({
      target: t.rides_target,
      bonus: parseFloat(t.bonus_amount),
      completed: done,
      remaining: Math.max(0, t.rides_target - done),
      achieved: done >= t.rides_target
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────
//  6. SAVED PLACES
// ─────────────────────────────────────────────────
app.get('/api/places/saved', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ places: [] });
    const r = await db.query('SELECT id, label, address, lat, lng FROM saved_places WHERE user_id = $1', [user.rows[0].id]);
    res.json({ places: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/places/save', async (req, res) => {
  const { phone, label, address, lat, lng } = req.body;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ success: false });
    await db.query(
      'INSERT INTO saved_places (user_id, label, address, lat, lng) VALUES ($1,$2,$3,$4,$5)',
      [user.rows[0].id, label, address, lat || null, lng || null]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/places/delete', async (req, res) => {
  const { id } = req.body;
  try {
    await db.query('DELETE FROM saved_places WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────
//  7. SOS ALERT
// ─────────────────────────────────────────────────
app.post('/api/sos', async (req, res) => {
  const { phone, ride_id, lat, lng, type } = req.body;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    await db.query(
      'INSERT INTO sos_alerts (user_id, ride_id, lat, lng, type) VALUES ($1,$2,$3,$4,$5)',
      [user.rows[0]?.id || null, ride_id || null, lat || null, lng || null, type || 'emergency']
    );
    console.log('🆘 SOS ALERT:', phone, lat, lng);
    res.json({ success: true, message: 'Emergency alert bheja gaya', helplines: { police: '100', ambulance: '108', women: '1091' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────
//  8. ADMIN NOTIFICATIONS + ANALYTICS
// ─────────────────────────────────────────────────
app.post('/api/admin/notify', async (req, res) => {
  const { target, title, message } = req.body;
  try {
    await db.query('INSERT INTO notifications (target, title, message) VALUES ($1,$2,$3)', [target || 'all', title, message]);
    res.json({ success: true, message: 'Notification bheja gaya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/notifications', async (req, res) => {
  const { target } = req.query;
  try {
    const r = await db.query(
      `SELECT title, message, created_at FROM notifications WHERE target = 'all' OR target = $1 ORDER BY created_at DESC LIMIT 10`,
      [target || 'all']
    );
    res.json({ notifications: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/analytics', async (req, res) => {
  try {
    const daily = await db.query(`
      SELECT DATE(created_at) AS day, COUNT(*) AS rides, COALESCE(SUM(fare),0) AS revenue
      FROM rides WHERE status = 'completed' AND created_at >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY DATE(created_at) ORDER BY day
    `);
    const byType = await db.query(`
      SELECT ride_type, COUNT(*) AS count FROM rides WHERE status = 'completed' GROUP BY ride_type
    `);
    res.json({ daily: daily.rows, by_type: byType.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: set driver target
app.post('/api/admin/set-target', async (req, res) => {
  const { rides_target, bonus_amount } = req.body;
  try {
    await db.query('UPDATE driver_targets SET active = false');
    await db.query('INSERT INTO driver_targets (rides_target, bonus_amount, active) VALUES ($1,$2,true)', [rides_target, bonus_amount]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ══════════════════════════════════════════════════
//  CANCELLATION SYSTEM APIs — server.listen se PEHLE paste karo
//  (Purane /api/rides/cancel ko isse REPLACE karo agar hai)
// ══════════════════════════════════════════════════
// ── Smart Cancellation (customer ya driver) ──────
app.post('/api/rides/cancel-smart', async (req, res) => {
  const { ride_id, cancelled_by, reason, phone } = req.body;
  try {
    const rideRes = await db.query(
      `SELECT r.*, EXTRACT(EPOCH FROM (NOW() - r.created_at)) AS seconds_since_book,
              p.phone AS passenger_phone, u.phone AS driver_phone
       FROM rides r
       LEFT JOIN users p ON r.passenger_id = p.id
       LEFT JOIN users u ON r.driver_id = u.id
       WHERE r.id = $1`,
      [ride_id]
    );
    if (rideRes.rows.length === 0) return res.json({ success: false, message: 'Ride nahi mili' });
    const ride = rideRes.rows[0];
    const secondsAfterBook = Math.round(ride.seconds_since_book || 0);

    let penalty = 0;
    let message = 'Ride cancel ho gayi';

    // ─── CUSTOMER CANCEL ───
    if (cancelled_by === 'customer') {
      const today = new Date().toISOString().split('T')[0];
      let cm = await db.query('SELECT * FROM customer_metrics WHERE phone = $1', [phone]);
      if (cm.rows.length === 0) {
        await db.query('INSERT INTO customer_metrics (phone) VALUES ($1)', [phone]);
        cm = await db.query('SELECT * FROM customer_metrics WHERE phone = $1', [phone]);
      }
      let metrics = cm.rows[0];
      let cancelsToday = metrics.last_cancel_date && metrics.last_cancel_date.toISOString().split('T')[0] === today ? metrics.cancels_today : 0;

      if (secondsAfterBook <= 60) {
        penalty = 0; message = 'Free cancellation (1 min ke andar)';
      } else if (ride.driver_id) {
        if (cancelsToday >= 3) { penalty = 10; message = 'Cancel fee ₹10 (aaj 3 se zyada cancel)'; }
        else { penalty = ride.status === 'arrived' ? 15 : 10; message = `Cancel fee ₹${penalty}`; }
      }

      const newTrust = Math.max(0, (metrics.trust_score || 100) - (penalty > 0 ? 5 : 2));
      await db.query(
        `UPDATE customer_metrics SET total_cancels = total_cancels + 1, cancels_today = $1, last_cancel_date = $2, trust_score = $3, is_flagged = $4 WHERE phone = $5`,
        [cancelsToday + 1, today, newTrust, newTrust < 50, phone]
      );

      // Driver ko notification — ride cancel ho gayi
      if (ride.driver_phone) {
        sendFCM(ride.driver_phone, '🚫 Ride Cancel Ho Gayi', `Customer ne cancel kar di. Reason: ${reason || 'N/A'}`, { type: 'ride_cancelled' });
      }
    }

    // ─── DRIVER CANCEL ───
    if (cancelled_by === 'driver') {
      const today = new Date().toISOString().split('T')[0];
      let dm = await db.query('SELECT * FROM driver_metrics WHERE phone = $1', [phone]);
      if (dm.rows.length === 0) {
        await db.query('INSERT INTO driver_metrics (phone) VALUES ($1)', [phone]);
        dm = await db.query('SELECT * FROM driver_metrics WHERE phone = $1', [phone]);
      }
      let metrics = dm.rows[0];
      let cancelsToday = metrics.last_cancel_date && metrics.last_cancel_date.toISOString().split('T')[0] === today ? metrics.cancels_today : 0;
      cancelsToday += 1;

      const totalCancelled = (metrics.rides_cancelled || 0) + 1;
      const totalAccepted = metrics.rides_accepted || 1;
      const cancelRate = (totalCancelled / (totalAccepted + totalCancelled)) * 100;

      let suspendedUntil = null;
      if (cancelRate > 25 || cancelsToday >= 5) {
        suspendedUntil = new Date(Date.now() + 2 * 60 * 60 * 1000);
        message = '⚠️ Bahut zyada cancel! 2 ghante suspend.';
      } else if (cancelRate > 15) {
        message = '⚠️ Warning: Cancel rate zyada hai, kam rides milengi';
      }

      await db.query(
        `UPDATE driver_metrics SET rides_cancelled = $1, cancels_today = $2, last_cancel_date = $3, cancellation_rate = $4, suspended_until = $5 WHERE phone = $6`,
        [totalCancelled, cancelsToday, today, cancelRate.toFixed(2), suspendedUntil, phone]
      );

      // Customer ko notification — driver ne cancel kiya
      if (ride.passenger_phone) {
        sendFCM(ride.passenger_phone, '🚫 Driver ne Cancel Kiya', `Reason: ${reason || 'N/A'}. Naya driver dhundh rahe hain...`, { type: 'ride_cancelled' });
      }
    }

    // Ride cancel karo
    await db.query(`UPDATE rides SET status = 'cancelled' WHERE id = $1`, [ride_id]);

    // Log cancellation
    await db.query(
      `INSERT INTO cancellations (ride_id, cancelled_by, reason, seconds_after_book, penalty_applied) VALUES ($1, $2, $3, $4, $5)`,
      [ride_id, cancelled_by, reason || '', secondsAfterBook, penalty]
    );

    res.json({ success: true, penalty, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver suspension check (login/online ke time) ──
app.get('/api/driver/check-suspension', async (req, res) => {
  const { phone } = req.query;
  try {
    const dm = await db.query('SELECT suspended_until, cancellation_rate, acceptance_rate FROM driver_metrics WHERE phone = $1', [phone]);
    if (dm.rows.length === 0) return res.json({ suspended: false });
    const m = dm.rows[0];
    if (m.suspended_until && new Date(m.suspended_until) > new Date()) {
      const minsLeft = Math.ceil((new Date(m.suspended_until) - new Date()) / 60000);
      return res.json({ suspended: true, minutes_left: minsLeft, message: `${minsLeft} min baad online ho sakte ho` });
    }
    res.json({ suspended: false, cancellation_rate: m.cancellation_rate, acceptance_rate: m.acceptance_rate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Customer cancel check (booking se pehle) ─────
app.get('/api/customer/cancel-status', async (req, res) => {
  const { phone } = req.query;
  try {
    const cm = await db.query('SELECT * FROM customer_metrics WHERE phone = $1', [phone]);
    if (cm.rows.length === 0) return res.json({ free_cancels_left: 3, trust_score: 100, flagged: false });
    const m = cm.rows[0];
    const today = new Date().toISOString().split('T')[0];
    const cancelsToday = m.last_cancel_date && m.last_cancel_date.toISOString().split('T')[0] === today ? m.cancels_today : 0;
    res.json({ free_cancels_left: Math.max(0, 3 - cancelsToday), trust_score: m.trust_score, flagged: m.is_flagged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Track ride offered/accepted (matching metrics) ──
app.post('/api/driver/track-metric', async (req, res) => {
  const { phone, action } = req.body; // action: 'offered' | 'accepted'
  try {
    let dm = await db.query('SELECT * FROM driver_metrics WHERE phone = $1', [phone]);
    if (dm.rows.length === 0) await db.query('INSERT INTO driver_metrics (phone) VALUES ($1)', [phone]);
    if (action === 'offered') await db.query('UPDATE driver_metrics SET rides_offered = rides_offered + 1 WHERE phone = $1', [phone]);
    if (action === 'accepted') {
      await db.query('UPDATE driver_metrics SET rides_accepted = rides_accepted + 1, idle_since = NOW() WHERE phone = $1', [phone]);
      // Recalc acceptance rate
      const m = (await db.query('SELECT rides_offered, rides_accepted FROM driver_metrics WHERE phone = $1', [phone])).rows[0];
      if (m && m.rides_offered > 0) {
        const accRate = (m.rides_accepted / m.rides_offered) * 100;
        await db.query('UPDATE driver_metrics SET acceptance_rate = $1 WHERE phone = $2', [Math.min(100, accRate).toFixed(2), phone]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: cancellation analytics ────────────────
app.get('/api/admin/cancellation-stats', async (req, res) => {
  try {
    const byType = await db.query(`SELECT cancelled_by, COUNT(*) AS count FROM cancellations GROUP BY cancelled_by`);
    const topReasons = await db.query(`SELECT reason, COUNT(*) AS count FROM cancellations WHERE reason != '' GROUP BY reason ORDER BY count DESC LIMIT 5`);
    const flaggedCustomers = await db.query(`SELECT phone, total_cancels, trust_score FROM customer_metrics WHERE is_flagged = true ORDER BY total_cancels DESC LIMIT 10`);
    const highCancelDrivers = await db.query(`SELECT phone, rides_cancelled, cancellation_rate FROM driver_metrics WHERE cancellation_rate > 15 ORDER BY cancellation_rate DESC LIMIT 10`);
    res.json({ by_type: byType.rows, top_reasons: topReasons.rows, flagged_customers: flaggedCustomers.rows, high_cancel_drivers: highCancelDrivers.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  UPDATED MATCHING APIs
//  Purane update-location aur pending-ride ko REPLACE karo
// ══════════════════════════════════════════════════

// ─── Driver location update (with geocell) ───
app.post('/api/driver/update-location', async (req, res) => {
  const { phone, lat, lng } = req.body;
  try {
    driverLocations[phone] = { lat, lng, updated: Date.now() };
    const geocell = encodeGeohash(parseFloat(lat), parseFloat(lng), 6);
    await db.query(
      `INSERT INTO driver_locations (phone, lat, lng, geocell, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (phone) DO UPDATE SET lat = $2, lng = $3, geocell = $4, updated_at = NOW()`,
      [phone, lat, lng, geocell]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Smart pending-ride (assignment-based) ───
app.get('/api/driver/pending-ride', async (req, res) => {
  const { phone } = req.query;
  try {
    // Suspension check
    const susp = await db.query('SELECT suspended_until FROM driver_metrics WHERE phone=$1', [phone]);
    if (susp.rows[0]?.suspended_until && new Date(susp.rows[0].suspended_until) > new Date())
      return res.json({ ride: null, suspended: true });

    // Commission info (never blocks rides — drivers are always eligible)
    let pendingComm = 0;
    try {
      const commWallet = await db.query(
        `SELECT COALESCE(w.pending_commission, 0) as pending_commission
         FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]
      );
      pendingComm = parseFloat(commWallet.rows[0]?.pending_commission || 0);
    } catch (_e) {}

    // Only approved + online drivers get rides
    const drRes = await db.query(
      `SELECT d.vehicle_type, d.verification_status, d.is_online
       FROM drivers d JOIN users u ON d.id = u.id WHERE u.phone=$1`, [phone]
    );
    if (!drRes.rows[0]) return res.json({ ride: null });
    const dr = drRes.rows[0];
    if (dr.verification_status !== 'approved') return res.json({ ride: null, not_approved: true });
    if (!dr.is_online) return res.json({ ride: null });

    // PRIMARY: ride specifically assigned to this driver with active window
    const assigned = await db.query(
      `SELECT r.*, p.name AS passenger_name, p.phone AS passenger_phone
       FROM rides r JOIN users p ON r.passenger_id = p.id
       WHERE r.assigned_to_phone=$1
         AND r.status='requested' AND r.driver_id IS NULL
         AND r.assignment_expires_at > NOW()
       LIMIT 1`, [phone]
    );
    if (assigned.rows[0]) {
      const r = assigned.rows[0];
      const secLeft = Math.max(0, Math.ceil((new Date(r.assignment_expires_at).getTime() - Date.now()) / 1000));
      return res.json({ ride: { ...r, seconds_to_accept: secLeft } });
    }

    // FALLBACK: ride has been waiting > 2 min with no active assignment (GPS-less drivers, exhausted queues)
    const vehicleType = dr.vehicle_type === 'ultra_luxury' ? 'luxury' : dr.vehicle_type;
    const fallback = await db.query(
      `SELECT r.*, p.name AS passenger_name, p.phone AS passenger_phone
       FROM rides r JOIN users p ON r.passenger_id = p.id
       WHERE r.status='requested' AND r.driver_id IS NULL AND r.ride_type=$1
         AND (r.assigned_to_phone IS NULL OR r.assignment_expires_at < NOW())
         AND r.created_at < NOW() - INTERVAL '2 minutes'
       ORDER BY r.created_at ASC LIMIT 1`, [vehicleType]
    );
    if (fallback.rows[0]) return res.json({ ride: fallback.rows[0] });

    return res.json({ ride: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Driver location for customer (DB based now) ───
app.get('/api/rides/driver-location/:rideId', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT u.phone FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1`,
      [req.params.rideId]
    );
    if (result.rows.length === 0) return res.json({ location: null });
    const driverPhone = result.rows[0].phone;
    // Memory first (fast), DB fallback
    let loc = driverLocations[driverPhone];
    if (!loc) {
      const dbLoc = await db.query('SELECT lat, lng, updated_at FROM driver_locations WHERE phone = $1', [driverPhone]);
      if (dbLoc.rows[0]) loc = { lat: parseFloat(dbLoc.rows[0].lat), lng: parseFloat(dbLoc.rows[0].lng), updated: new Date(dbLoc.rows[0].updated_at).getTime() };
    }
    res.json({ location: loc || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Fare Estimate (booking se pehle) ─────────────
app.post('/api/fare-estimate', async (req, res) => {
  const { ride_type, distance } = req.body;
  try {
    const fareRes = await db.query('SELECT * FROM fare_settings WHERE vehicle_type = $1', [ride_type]);
    const f = fareRes.rows[0] || (ride_type === 'luxury' ? { base_fare: 80, per_km_rate: 25, night_multiplier: 1.8, night_start: '22:00', night_end: '06:00' } : { base_fare: 25, per_km_rate: 12, night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' });
    const dist = parseFloat(distance) || 3;

    const now = new Date();
    const hour = now.getHours();
    const nightStart = parseInt(String(f.night_start).split(':')[0]);
    const nightEnd = parseInt(String(f.night_end).split(':')[0]);
    const isNight = hour >= nightStart || hour < nightEnd;

    let fare = Math.round(parseFloat(f.base_fare) + (dist * parseFloat(f.per_km_rate)));
    if (isNight) fare = Math.round(fare * parseFloat(f.night_multiplier));

    res.json({ fare, is_night: isNight, base: parseFloat(f.base_fare), per_km: parseFloat(f.per_km_rate) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
//  PAYMENT FLOW APIs
// ══════════════════════════════════════════════════

// ══════════════════════════════════════════════════
//  RIDE EXTENSION — same driver, new destination
// ══════════════════════════════════════════════════

// POST /api/rides/extension-request
app.post('/api/rides/extension-request', async (req, res) => {
  const { customer_phone, new_drop } = req.body;
  const original_ride_id = parseInt(req.body.original_ride_id);
  const new_drop_lat = req.body.new_drop_lat ? parseFloat(req.body.new_drop_lat) : null;
  const new_drop_lng = req.body.new_drop_lng ? parseFloat(req.body.new_drop_lng) : null;
  if (!original_ride_id || isNaN(original_ride_id) || !customer_phone || !new_drop) return res.status(400).json({ error: 'Fields missing' });
  try {
    const rideRes = await db.query(
      `SELECT r.*, u_d.phone AS driver_phone, u_d.name AS driver_name
       FROM rides r
       JOIN users u_d ON r.driver_id::text = u_d.id::text
       WHERE r.id = $1`, [original_ride_id]
    );
    if (!rideRes.rows[0]) return res.json({ success: false, error: 'Ride nahi mili' });
    const ride = rideRes.rows[0];
    if (ride.status !== 'completed') return res.json({ success: false, error: 'Ride abhi complete nahi hui' });

    // 15-min window from ride completion
    const completedAt = ride.completed_at || ride.created_at;
    const minAgo = (Date.now() - new Date(completedAt).getTime()) / 60000;
    if (minAgo > 15) return res.json({ success: false, expired: true, error: '15-minute window khatam ho gayi — naya ride book karo' });

    // Driver must be free
    const busy = await db.query(
      `SELECT id FROM rides WHERE driver_id = (SELECT id FROM users WHERE phone=$1)
       AND status IN ('accepted','inride','matched','arrived') LIMIT 1`, [ride.driver_phone]
    );
    if (busy.rows[0]) return res.json({ success: false, busy: true, error: 'Driver abhi doosre customer ke saath busy hai' });

    // Fare estimate
    let estFare = 50;
    if (new_drop_lat && new_drop_lng && ride.drop_lat && ride.drop_lng) {
      const km = haversineKm(parseFloat(ride.drop_lat), parseFloat(ride.drop_lng), parseFloat(new_drop_lat), parseFloat(new_drop_lng));
      const fs = await db.query('SELECT * FROM fare_settings WHERE vehicle_type=$1', [ride.ride_type]);
      const f = fs.rows[0] || { base_fare: 25, per_km_rate: 12 };
      estFare = Math.max(20, Math.round(parseFloat(f.base_fare) + km * parseFloat(f.per_km_rate)));
    }

    // Cancel any old pending extension for this driver
    await db.query("UPDATE ride_extensions SET status='cancelled' WHERE driver_phone=$1 AND status='pending'", [ride.driver_phone]);

    const extR = await db.query(
      `INSERT INTO ride_extensions
         (original_ride_id, customer_phone, driver_phone, pickup, pickup_lat, pickup_lng,
          new_drop, new_drop_lat, new_drop_lng, vehicle_type, estimated_fare,
          window_expires_at, response_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               NOW() + INTERVAL '15 minutes', NOW() + INTERVAL '60 seconds')
       RETURNING *`,
      [original_ride_id, customer_phone, ride.driver_phone,
       ride.drop_location, ride.drop_lat || null, ride.drop_lng || null,
       new_drop, new_drop_lat, new_drop_lng,
       ride.ride_type, estFare]
    );

    sendFCM(ride.driver_phone, '🔄 Ride Extension!', `${ride.drop_location} → ${new_drop} — ₹${estFare} | Accept karo 60 sec mein`);

    // Auto-expire after 62 sec if no response
    const extId = extR.rows[0].id;
    setTimeout(async () => {
      try { await db.query("UPDATE ride_extensions SET status='expired' WHERE id=$1 AND status='pending'", [extId]); } catch (_e) {}
    }, 62000);

    res.json({ success: true, extension_id: extId, estimated_fare: estFare, driver_name: ride.driver_name, driver_phone: ride.driver_phone });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/extension-status/:id  (customer polls)
app.get('/api/rides/extension-status/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM ride_extensions WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Nahi mila' });
    const ext = r.rows[0];
    if (ext.status === 'pending' && new Date(ext.response_expires_at) < new Date()) {
      await db.query("UPDATE ride_extensions SET status='expired' WHERE id=$1", [ext.id]);
      return res.json({ status: 'expired' });
    }
    res.json({ status: ext.status, new_ride_id: ext.new_ride_id, estimated_fare: ext.estimated_fare, seconds_left: Math.max(0, Math.ceil((new Date(ext.response_expires_at).getTime() - Date.now()) / 1000)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rides/extension-pending?phone=  (driver polls)
app.get('/api/rides/extension-pending', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await db.query(
      `SELECT e.*, u.name AS customer_name
       FROM ride_extensions e JOIN users u ON u.phone = e.customer_phone
       WHERE e.driver_phone=$1 AND e.status='pending' AND e.response_expires_at > NOW()
       ORDER BY e.created_at DESC LIMIT 1`, [phone]
    );
    if (!r.rows[0]) return res.json({ extension: null });
    const ext = r.rows[0];
    res.json({ extension: { ...ext, seconds_left: Math.max(0, Math.ceil((new Date(ext.response_expires_at).getTime() - Date.now()) / 1000)) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/extension-accept
app.post('/api/rides/extension-accept', async (req, res) => {
  const { extension_id } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const extR = await client.query(
      "SELECT * FROM ride_extensions WHERE id=$1 AND status='pending' AND response_expires_at > NOW()", [extension_id]
    );
    if (!extR.rows[0]) { await client.query('ROLLBACK'); client.release(); return res.json({ success: false, error: 'Request expired ya nahi mili' }); }
    const ext = extR.rows[0];

    const newRide = await client.query(
      `INSERT INTO rides (passenger_id, driver_id, pickup, pickup_lat, pickup_lng, drop_location, drop_lat, drop_lng, ride_type, fare, status, payment_method)
       SELECT passenger_id, driver_id, $1, $2, $3, $4, $5, $6, ride_type, $7, 'matched', payment_method
       FROM rides WHERE id = $8 RETURNING *`,
      [ext.pickup, ext.pickup_lat, ext.pickup_lng, ext.new_drop, ext.new_drop_lat, ext.new_drop_lng, ext.estimated_fare, ext.original_ride_id]
    );
    await client.query("UPDATE ride_extensions SET status='accepted', new_ride_id=$1 WHERE id=$2", [newRide.rows[0].id, extension_id]);
    await client.query('COMMIT');
    client.release();

    sendFCM(ext.customer_phone, '✅ Extension Accepted!', `Driver aa raha hai — ${ext.new_drop}`);
    res.json({ success: true, new_ride_id: newRide.rows[0].id, fare: ext.estimated_fare });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {}); client.release();
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rides/extension-reject
app.post('/api/rides/extension-reject', async (req, res) => {
  const { extension_id } = req.body;
  try {
    const r = await db.query("UPDATE ride_extensions SET status='rejected' WHERE id=$1 RETURNING customer_phone, new_drop", [extension_id]);
    if (r.rows[0]) sendFCM(r.rows[0].customer_phone, '❌ Extension Reject', 'Driver ne reject kiya — naya ride book karo');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Driver: Trip complete (payment pending) ───────
app.post('/api/rides/complete', async (req, res) => {
  const { ride_id } = req.body;
  try {
    const upd = await db.query(
      `UPDATE rides SET status = 'completed', payment_status = 'pending', completed_at = NOW() WHERE id = $1 RETURNING id, fare, payment_method, driver_id`,
      [ride_id]
    );
    if (!upd.rows[0]) return res.status(404).json({ error: 'Ride nahi mili' });
    emitRideUpdate(ride_id, { status: 'completed', fare: upd.rows[0].fare, payment_method: upd.rows[0].payment_method });
    res.json({ success: true, fare: upd.rows[0].fare, payment_method: upd.rows[0].payment_method, message: 'Trip complete! Payment ka intezaar karo.' });

    // Reset idle_since so driver gets priority for next ride
    if (upd.rows[0].driver_id) {
      const drvPhone = await db.query('SELECT phone FROM users WHERE id=$1', [upd.rows[0].driver_id]);
      if (drvPhone.rows[0]) {
        await db.query(
          `INSERT INTO driver_metrics (phone, idle_since) VALUES ($1, NOW())
           ON CONFLICT (phone) DO UPDATE SET idle_since=NOW()`,
          [drvPhone.rows[0].phone]
        ).catch(() => {});
      }
    }
    // FCM fire-and-forget (does not affect response)
    try {
      const compData = await db.query(
        `SELECT p.phone as passenger_phone, d.phone as driver_phone
         FROM rides r
         JOIN users p ON r.passenger_id::text = p.id::text
         JOIN users d ON r.driver_id::text = d.id::text
         WHERE r.id = $1`, [ride_id]
      );
      if (compData.rows[0]) {
        sendFCM(compData.rows[0].passenger_phone, '🏁 Trip Complete!', 'Payment karo aur driver ko rate karo!', { type: 'trip_completed', ride_id: String(ride_id) });
        sendFCM(compData.rows[0].driver_phone, '✅ Trip Complete!', 'Payment aa rahi hai — wait karo.', { type: 'payment_pending' });
      }
    } catch (_e) {}
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Customer: Payment karo ────────────────────────
app.post('/api/rides/payment-complete', async (req, res) => {
  const { ride_id, payment_method, phone } = req.body;
  try {
    const rideRes = await db.query('SELECT * FROM rides WHERE id = $1', [ride_id]);
    if (rideRes.rows.length === 0) return res.json({ success: false, message: 'Ride nahi mili' });
    const ride = rideRes.rows[0];
    const fare = parseFloat(ride.fare);
    const commission = Math.round(fare * 0.15 * 100) / 100;

    // Payment method ke hisaab se
    if (payment_method === 'cash') {
      // Cash — driver confirm karega
      await db.query(
        `UPDATE rides SET payment_method = 'cash', payment_status = 'cash_pending' WHERE id = $1`,
        [ride_id]
      );
      // Commission pending mein add
      await db.query(
        `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
         SELECT u.phone, $1, $2, $3, 'cash', 'pending'
         FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1`,
        [ride_id, fare, commission]
      );
      return res.json({ success: true, status: 'cash_pending', message: 'Driver ko cash do!' });
    }

    // Wallet/Online — auto complete
    await db.query(
      `UPDATE rides SET payment_method = $1, payment_status = 'completed', commission_amount = $2, commission_status = 'collected' WHERE id = $3`,
      [payment_method, commission, ride_id]
    );
    // Commission record
    const commRow = await db.query(
      `INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
       SELECT u.phone, $1, $2, $3, $4, 'collected'
       FROM rides r JOIN users u ON r.driver_id = u.id WHERE r.id = $1
       RETURNING driver_phone`,
      [ride_id, fare, commission, payment_method]
    );

    // Credit driver wallet (auto-deduct any pending cash commissions)
    try {
      const drPhone = commRow.rows[0]?.driver_phone;
      if (drPhone) {
        const drInfo = await db.query(
          `SELECT u.id, COALESCE(w.pending_commission, 0) as pending_commission
           FROM users u LEFT JOIN driver_wallet w ON w.driver_id = u.id
           WHERE u.phone = $1`, [drPhone]
        );
        if (drInfo.rows[0]) {
          const driverId = drInfo.rows[0].id;
          const pendingCashComm = parseFloat(drInfo.rows[0].pending_commission || 0);
          const driverEarning = Math.round((fare - commission) * 100) / 100;
          const autoDeduct = Math.min(pendingCashComm, driverEarning);
          const actualCredit = Math.round((driverEarning - autoDeduct) * 100) / 100;

          await db.query(
            `INSERT INTO driver_wallet (driver_id, balance, total_earned, pending_commission)
             VALUES ($1, $2, $3, 0)
             ON CONFLICT (driver_id) DO UPDATE SET
               balance = driver_wallet.balance + $2,
               total_earned = driver_wallet.total_earned + $3,
               pending_commission = GREATEST(0, COALESCE(driver_wallet.pending_commission, 0) - $4)`,
            [driverId, actualCredit, driverEarning, autoDeduct]
          );

          if (autoDeduct > 0) {
            // Mark oldest pending cash commissions as auto_settled
            await db.query(
              `UPDATE driver_commissions SET status = 'auto_settled'
               WHERE driver_phone = $1 AND status = 'cash_owed'`, [drPhone]
            ).catch(() => {});
            sendFCM(drPhone, '💰 Earning Credited',
              `₹${actualCredit.toFixed(0)} wallet mein add hua! (₹${autoDeduct.toFixed(0)} pending commission deduct hua)`,
              { type: 'earning_credited', amount: String(actualCredit), commission_deducted: String(autoDeduct) }
            ).catch(() => {});
          } else {
            sendFCM(drPhone, '💰 Earning Credited',
              `₹${driverEarning.toFixed(0)} wallet mein add ho gaya!`,
              { type: 'earning_credited', amount: String(driverEarning) }
            ).catch(() => {});
          }
        }
      }
    } catch (_e) {}

    // Add loyalty points (10 per ride)
    try {
      const u = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
      if (u.rows[0]) await addLoyaltyPoints(u.rows[0].id, 10);
    } catch (_e) {}
    res.json({ success: true, status: 'completed', message: 'Payment complete!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver: Cash/UPI-direct payment confirm ────────
app.post('/api/rides/cash-confirm', async (req, res) => {
  const { ride_id, phone, payment_method } = req.body;
  const method = payment_method === 'upi_direct' ? 'upi' : 'cash';
  try {
    const rideRes = await db.query('SELECT * FROM rides WHERE id = $1', [ride_id]);
    if (!rideRes.rows[0]) return res.status(404).json({ error: 'Ride nahi mili' });
    const fare = parseFloat(rideRes.rows[0].fare);
    const commission = Math.round(fare * 0.15 * 100) / 100;

    await db.query(
      `UPDATE rides SET payment_status = 'completed', payment_method = $1, commission_amount = $2 WHERE id = $3`,
      [method, commission, ride_id]
    );
    // Driver received cash; marks commission as owed (not yet collected by platform)
    await db.query(
      `UPDATE driver_commissions SET status = 'cash_owed', payment_method = $1 WHERE ride_id = $2`,
      [method, ride_id]
    );
    // Add to driver's pending commission debt
    const walletRes = await db.query(
      `UPDATE driver_wallet SET pending_commission = COALESCE(pending_commission, 0) + $1
       WHERE driver_id = (SELECT id FROM users WHERE phone = $2)
       RETURNING pending_commission`,
      [commission, phone]
    );
    const totalPending = parseFloat(walletRes.rows[0]?.pending_commission || 0);

    // Always notify driver about pending commission
    sendFCM(phone,
      '💰 Commission Due',
      `₹${commission.toFixed(0)} commission baqi hai. Total pending: ₹${totalPending.toFixed(0)}. App mein pay karo.`,
      { type: 'commission_due', pending_commission: String(totalPending) }
    ).catch(() => {});

    res.json({ success: true, message: 'Payment confirmed!', pending_commission: totalPending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver: Commission status ─────────────────────
app.get('/api/driver/commission-status', async (req, res) => {
  const { phone } = req.query;
  try {
    const w = await db.query(
      `SELECT COALESCE(pending_commission, 0) as pending_commission
       FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]
    );
    const pending = parseFloat(w.rows[0]?.pending_commission || 0);
    const records = await db.query(
      `SELECT ride_id, fare, commission, payment_method, status, created_at
       FROM driver_commissions WHERE driver_phone = $1 AND status = 'cash_owed'
       ORDER BY created_at DESC LIMIT 20`, [phone]
    );
    res.json({ pending_commission: pending, is_blocked: false, records: records.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Driver: Full commission history ───────────────
app.get('/api/driver/commission-history', async (req, res) => {
  const { phone } = req.query;
  try {
    const walletRow = await db.query(
      `SELECT COALESCE(w.pending_commission, 0) as pending_commission,
              COALESCE(w.balance, 0) as balance,
              COALESCE(w.total_earned, 0) as total_earned
       FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]
    );

    const commRows = await db.query(
      `SELECT dc.id, dc.ride_id, dc.fare, dc.commission, dc.payment_method, dc.status, dc.created_at
       FROM driver_commissions dc
       WHERE dc.driver_phone = $1
       ORDER BY dc.created_at DESC LIMIT 50`, [phone]
    );

    const payRows = await db.query(
      `SELECT id, amount, payment_id, status, created_at
       FROM driver_commission_payments WHERE driver_phone = $1
       ORDER BY created_at DESC LIMIT 20`, [phone]
    );

    const records = commRows.rows;
    const totalCommission = records.reduce((s, r) => s + parseFloat(r.commission), 0);
    const settledCommission = records
      .filter(r => ['settled', 'collected', 'auto_settled'].includes(r.status))
      .reduce((s, r) => s + parseFloat(r.commission), 0);
    const pendingCommission = parseFloat(walletRow.rows[0]?.pending_commission || 0);

    res.json({
      pending_commission: pendingCommission,
      total_commission: Math.round(totalCommission * 100) / 100,
      settled_commission: Math.round(settledCommission * 100) / 100,
      wallet_balance: parseFloat(walletRow.rows[0]?.balance || 0),
      total_earned: parseFloat(walletRow.rows[0]?.total_earned || 0),
      records,
      payments: payRows.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Driver: Create Razorpay order for commission payment ─────────
app.post('/api/driver/commission-pay', async (req, res) => {
  const { phone } = req.body;
  try {
    const w = await db.query(
      `SELECT COALESCE(pending_commission, 0) as pending_commission
       FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]
    );
    const pending = parseFloat(w.rows[0]?.pending_commission || 0);
    if (pending <= 0) return res.json({ success: false, message: 'Koi pending commission nahi hai' });
    if (!razorpay) return res.status(500).json({ error: 'Payment gateway not configured' });

    const order = await razorpay.orders.create({
      amount: Math.round(pending * 100),
      currency: 'INR',
      receipt: `comm_${phone}_${Date.now()}`,
      notes: { driver_phone: phone, purpose: 'commission_payment' },
    });
    await db.query(
      `INSERT INTO driver_commission_payments (driver_phone, amount, payment_id, status)
       VALUES ($1, $2, $3, 'initiated')`,
      [phone, pending, order.id]
    );
    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: 'INR',
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Driver: Verify commission payment signature ───────────────────
app.post('/api/driver/commission-pay-verify', async (req, res) => {
  const { phone, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  try {
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing payment fields' });

    // Verify HMAC signature
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Invalid payment signature' });

    // Get the amount tied to this order
    const payRow = await db.query(
      `SELECT amount FROM driver_commission_payments WHERE payment_id = $1 AND driver_phone = $2`,
      [razorpay_order_id, phone]
    );
    if (!payRow.rows[0]) return res.status(400).json({ error: 'Order not found' });
    const amount = parseFloat(payRow.rows[0].amount);

    // Mark paid
    await db.query(
      `UPDATE driver_commission_payments SET status = 'paid', payment_id = $1
       WHERE payment_id = $2 AND driver_phone = $3`,
      [razorpay_payment_id, razorpay_order_id, phone]
    );
    // Clear debt
    await db.query(
      `UPDATE driver_wallet SET pending_commission = GREATEST(0, COALESCE(pending_commission, 0) - $1)
       WHERE driver_id = (SELECT id FROM users WHERE phone = $2)`, [amount, phone]
    );
    // Check if fully cleared → settle commission records
    const remaining = await db.query(
      `SELECT COALESCE(pending_commission, 0) as pc
       FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]
    );
    if (parseFloat(remaining.rows[0]?.pc || 0) <= 0) {
      await db.query(
        `UPDATE driver_commissions SET status = 'settled' WHERE driver_phone = $1 AND status = 'cash_owed'`, [phone]
      ).catch(() => {});
    }
    sendFCM(phone, '✅ Commission Paid!',
      `₹${amount.toFixed(0)} commission clear ho gaya. Ab aap nayi rides le sakte hain!`,
      { type: 'commission_cleared' }
    ).catch(() => {});
    res.json({ success: true, message: 'Commission paid!', pending_commission: parseFloat(remaining.rows[0]?.pc || 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Payment status check (driver polling) ─────────
app.get('/api/rides/payment-status/:rideId', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT payment_status, payment_method, fare FROM rides WHERE id = $1`,
      [req.params.rideId]
    );
    if (result.rows.length === 0) return res.json({ status: 'not_found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: Commission stats ────────────────────────
app.get('/api/admin/commissions', async (req, res) => {
  try {
    const total = await db.query(`SELECT SUM(commission) as total, COUNT(*) as count FROM driver_commissions WHERE status = 'collected'`);
    const pending = await db.query(`SELECT SUM(commission) as total, COUNT(*) as count FROM driver_commissions WHERE status = 'pending'`);
    const byMethod = await db.query(`SELECT payment_method, SUM(commission) as total, COUNT(*) as count FROM driver_commissions GROUP BY payment_method`);
    const recent = await db.query(`SELECT * FROM driver_commissions ORDER BY created_at DESC LIMIT 10`);
    res.json({ collected: total.rows[0], pending: pending.rows[0], by_method: byMethod.rows, recent: recent.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
//  USER MANAGEMENT APIs (Admin)
// ══════════════════════════════════════════════════

// ── All users list (admin) ────────────────────────
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await db.query(`
      SELECT u.*, 
        COALESCE(r.total_rides, 0) as total_rides,
        COALESCE(r.total_fare, 0) as total_fare,
        cm.trust_score, cm.total_cancels, cm.is_flagged
      FROM users u
      LEFT JOIN (
        SELECT passenger_id, COUNT(*) as total_rides, SUM(fare) as total_fare
        FROM rides WHERE status = 'completed'
        GROUP BY passenger_id
      ) r ON u.id = r.passenger_id
      LEFT JOIN customer_metrics cm ON u.phone = cm.phone
      WHERE u.role = 'passenger'
      ORDER BY u.created_at DESC
    `);
    res.json({ users: users.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Suspend user ──────────────────────────────────
app.post('/api/admin/users/suspend', async (req, res) => {
  const { phone, hours, reason } = req.body;
  try {
    const suspendedUntil = hours ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
    await db.query(
      `UPDATE users SET is_suspended = true, suspended_until = $1, suspend_reason = $2 WHERE phone = $3`,
      [suspendedUntil, reason || 'Admin action', phone]
    );
    res.json({ success: true, message: hours ? `${hours} ghante ke liye suspend kiya` : 'Suspend kiya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Unsuspend user ────────────────────────────────
app.post('/api/admin/users/unsuspend', async (req, res) => {
  const { phone } = req.body;
  try {
    await db.query(
      `UPDATE users SET is_suspended = false, suspended_until = NULL, suspend_reason = NULL WHERE phone = $1`,
      [phone]
    );
    res.json({ success: true, message: 'Unsuspend kiya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Block user ────────────────────────────────────
app.post('/api/admin/users/block', async (req, res) => {
  const { phone, reason } = req.body;
  try {
    await db.query(
      `UPDATE users SET is_blocked = true, block_reason = $1 WHERE phone = $2`,
      [reason || 'Admin action', phone]
    );
    res.json({ success: true, message: 'Block kiya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Unblock user ──────────────────────────────────
app.post('/api/admin/users/unblock', async (req, res) => {
  const { phone } = req.body;
  try {
    await db.query(
      `UPDATE users SET is_blocked = false, block_reason = NULL WHERE phone = $1`,
      [phone]
    );
    res.json({ success: true, message: 'Unblock kiya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Send message to user ──────────────────────────
app.post('/api/admin/users/message', async (req, res) => {
  const { phone, message } = req.body;
  try {
    await db.query(
      `UPDATE users SET admin_message = $1 WHERE phone = $2`,
      [message, phone]
    );
    
    // Notification save karo agar table hai
    try {
      await db.query(
        `INSERT INTO notifications (user_phone, title, body, created_at) 
         VALUES ($1, 'Admin Message', $2, NOW())`,
        [phone, message]
      );
    } catch (_e) {} // Table structure different ho sakta hai
    res.json({ success: true, message: 'Message bheja gaya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Check suspension (login ke time) ─────────────
app.get('/api/auth/check-status', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query(
      `SELECT is_suspended, suspended_until, suspend_reason, is_blocked, block_reason, admin_message FROM users WHERE phone = $1`,
      [phone]
    );
    if (user.rows.length === 0) return res.json({ status: 'ok' });
    const u = user.rows[0];

    // Auto unsuspend check
    if (u.is_suspended && u.suspended_until && new Date(u.suspended_until) < new Date()) {
      await db.query(`UPDATE users SET is_suspended = false, suspended_until = NULL WHERE phone = $1`, [phone]);
      return res.json({ status: 'ok' });
    }
    if (u.is_blocked) return res.json({ status: 'blocked', reason: u.block_reason });
    if (u.is_suspended) {
      const minsLeft = u.suspended_until ? Math.ceil((new Date(u.suspended_until) - new Date()) / 60000) : 0;
      return res.json({ status: 'suspended', reason: u.suspend_reason, mins_left: minsLeft });
    }
    res.json({ status: 'ok', admin_message: u.admin_message });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Latest notification for user ─────────────────
app.get('/api/notifications/latest', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(
      `SELECT * FROM notifications WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    res.json({ notification: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ══════════════════════════════════════════════════
//  FCM — Push Notifications
// ══════════════════════════════════════════════════

// ── FCM token save karo ───────────────────────────
app.post('/api/auth/save-fcm-token', async (req, res) => {
  const { phone, token, role } = req.body;
  try {
    await db.query(
      `UPDATE users SET fcm_token = $1 WHERE phone = $2`,
      [token, phone]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Send FCM notification ─────────────────────────
// data = { type, ride_id } — app uses this to navigate on tap
async function sendFCM(phone, title, body, data = {}) {
  try {
    const user = await db.query('SELECT fcm_token FROM users WHERE phone = $1', [phone]);
    const token = user.rows[0]?.fcm_token;
    if (!token) { console.log('⚠️ No FCM token for', phone); return; }

    // Expo Push Token hai toh Expo API use karo
    if (token.startsWith('ExponentPushToken')) {
      const expoRes = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
        body: JSON.stringify({ to: token, title, body, sound: 'default', priority: 'high', channelId: 'default', data })
      });
      const expoData = await expoRes.json().catch(() => ({}));
      if (expoData?.data?.status === 'error') {
        console.log('❌ Expo push error for', phone, ':', expoData.data.message);
      } else {
        console.log('✅ Expo FCM sent to', phone, '| status:', expoData?.data?.status || 'ok');
      }
      return;
    }

    // Native FCM token — Firebase Admin use karo
    if (!firebaseMessaging) { console.log('⚠️ Firebase not initialized, skipping FCM'); return; }
    await firebaseMessaging.send({
      token,
      notification: { title, body },
      // Firebase data values must be strings
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', notification: { sound: 'default', channelId: 'default' } },
    });
    console.log('✅ Firebase FCM sent to', phone);
  } catch (e) {
    console.log('FCM error:', e.message);
  }
}

// ══════════════════════════════════════════════════
//  HOURLY BOOKING SYSTEM — Standalone, no rides table changes
// ══════════════════════════════════════════════════
// Fares are admin-editable at runtime (POST /api/admin/hourly-fares)
let HOURLY_FARES = {
  auto:         { 2:{fare:180,km:20}, 4:{fare:320,km:40}, 6:{fare:460,km:60}, 8:{fare:580,km:80},  24:{fare:1500,km:200}, 48:{fare:2800,km:400}, 72:{fare:4000,km:600}, extra:8  },
  bike:         { 2:{fare:120,km:20}, 4:{fare:210,km:40}, 6:{fare:300,km:60}, 8:{fare:380,km:80},  24:{fare:1000,km:200}, 48:{fare:1800,km:400}, 72:{fare:2600,km:600}, extra:5  },
  car:          { 2:{fare:260,km:20}, 4:{fare:460,km:40}, 6:{fare:660,km:60}, 8:{fare:840,km:80},  24:{fare:2200,km:200}, 48:{fare:4000,km:400}, 72:{fare:5800,km:600}, extra:12 },
  eriksha:      { 2:{fare:150,km:20}, 4:{fare:270,km:40}, 6:{fare:390,km:60}, 8:{fare:490,km:80},  24:{fare:1200,km:200}, 48:{fare:2200,km:400}, 72:{fare:3200,km:600}, extra:7  },
  ultra_luxury: { 2:{fare:800,km:20}, 4:{fare:1400,km:40}, 6:{fare:2000,km:60}, 8:{fare:2600,km:80}, 24:{fare:6000,km:200}, 48:{fare:10000,km:400}, 72:{fare:14000,km:600}, extra:25 },
};
let SURGE_MULTIPLIER = 1.0; // Admin can update via POST /api/admin/surge

db.query(`CREATE TABLE IF NOT EXISTS hourly_bookings (
  id SERIAL PRIMARY KEY,
  customer_phone VARCHAR(15), driver_phone VARCHAR(15),
  vehicle_type VARCHAR(20), package_hours INTEGER, km_included INTEGER,
  stay_hours INTEGER DEFAULT 0, is_roundtrip BOOLEAN DEFAULT FALSE,
  pickup TEXT, pickup_lat FLOAT, pickup_lng FLOAT,
  drop_location TEXT, drop_lat FLOAT, drop_lng FLOAT,
  base_fare DECIMAL(10,2), total_fare DECIMAL(10,2),
  extra_km INTEGER DEFAULT 0, extra_km_charge DECIMAL(10,2) DEFAULT 0,
  payment_status VARCHAR(20) DEFAULT 'held', status VARCHAR(20) DEFAULT 'pending',
  early_end_requested_by VARCHAR(20), early_end_confirmed BOOLEAN DEFAULT FALSE,
  started_at TIMESTAMP, ended_at TIMESTAMP, actual_hours FLOAT,
  actual_km INTEGER DEFAULT 0, driver_earning DECIMAL(10,2), platform_fee DECIMAL(10,2),
  refund_amount DECIMAL(10,2) DEFAULT 0, otp VARCHAR(6), created_at TIMESTAMP DEFAULT NOW()
)`).then(() => console.log('✅ hourly_bookings table ready')).catch(e => console.log('hourly_bookings:', e.message));

app.get('/api/hourly/packages', (req, res) => res.json({ fares: HOURLY_FARES }));

app.post('/api/hourly/book', async (req, res) => {
  const { phone, vehicle_type, package_hours, pickup, pickup_lat, pickup_lng, drop_location, drop_lat, drop_lng, is_roundtrip, stay_hours, scheduled_at } = req.body;
  const client = await db.connect();
  try {
    const pkg = HOURLY_FARES[vehicle_type]?.[package_hours];
    if (!pkg) return res.status(400).json({ error: `Invalid package: ${vehicle_type} ${package_hours}h` });
    const baseFare = Math.round(pkg.fare * SURGE_MULTIPLIER);
    await client.query('BEGIN');
    const user = await client.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (!user.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User nahi mila' }); }
    const userId = user.rows[0].id;
    await client.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const wallet = await client.query('SELECT balance FROM customer_wallet WHERE user_id = $1', [userId]);
    const balance = wallet.rows[0] ? parseFloat(wallet.rows[0].balance) : 0;
    if (balance < baseFare) { await client.query('ROLLBACK'); return res.json({ success: false, error: `Wallet mein ₹${baseFare} chahiye, aapke paas ₹${balance.toFixed(0)} hai` }); }
    await client.query('UPDATE customer_wallet SET balance = balance - $1 WHERE user_id = $2', [baseFare, userId]);
    await client.query("INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,'Hourly booking - escrow hold')", [userId, baseFare]);
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const schedAt = scheduled_at ? new Date(scheduled_at) : null;
    const bk = await client.query(
      `INSERT INTO hourly_bookings (customer_phone,vehicle_type,package_hours,km_included,base_fare,total_fare,pickup,pickup_lat,pickup_lng,drop_location,drop_lat,drop_lng,is_roundtrip,stay_hours,otp,scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [phone, vehicle_type, package_hours, pkg.km, baseFare, pickup, pickup_lat||null, pickup_lng||null, drop_location||null, drop_lat||null, drop_lng||null, is_roundtrip||false, stay_hours||0, otp, schedAt]
    );
    await client.query('COMMIT');
    res.json({ success: true, booking_id: bk.rows[0].id, fare: baseFare, km_included: pkg.km, scheduled_at: schedAt });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

app.get('/api/hourly/status/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Nahi mili' });
    const b = r.rows[0];
    let driver = null;
    if (b.driver_phone) {
      const d = await db.query('SELECT u.name, d.vehicle_no, d.vehicle_brand, d.vehicle_model FROM users u JOIN drivers d ON u.id = d.id WHERE u.phone = $1', [b.driver_phone]);
      driver = d.rows[0] || null;
    }
    // Compute live approaching-limit flags for active trips
    let approaching_limit = null;
    if (b.status === 'active' && b.started_at) {
      const elapsedMin = (Date.now() - new Date(b.started_at).getTime()) / 60000;
      const totalMin = parseFloat(b.package_hours) * 60;
      const timePct = totalMin > 0 ? elapsedMin / totalMin : 0;
      const kmPct = parseFloat(b.km_included) > 0 ? (parseFloat(b.actual_km || 0) / parseFloat(b.km_included)) : 0;
      const minLeft = Math.max(0, Math.round(totalMin - elapsedMin));
      const kmLeft = Math.max(0, parseFloat(b.km_included) - parseFloat(b.actual_km || 0));
      const extraKmNow = Math.max(0, parseFloat(b.actual_km || 0) - parseFloat(b.km_included));
      approaching_limit = {
        time_pct: Math.round(timePct * 100),
        km_pct: Math.round(kmPct * 100),
        min_left: minLeft,
        km_left: Math.round(kmLeft),
        extra_km: Math.round(extraKmNow * 10) / 10,
        extra_km_charge: Math.round(extraKmNow * (HOURLY_FARES[b.vehicle_type]?.extra || 8)),
        is_roundtrip: b.is_roundtrip,
        warn: timePct >= 0.80,     // Time is the primary constraint — km only adds extra charges
        critical: timePct >= 0.95,
      };
    }
    res.json({ booking: b, driver, approaching_limit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hourly/driver-pending', async (req, res) => {
  const { phone } = req.query;
  try {
    const dr = await db.query('SELECT d.vehicle_type FROM drivers d JOIN users u ON d.id = u.id WHERE u.phone = $1', [phone]);
    if (!dr.rows[0]) return res.json({ booking: null });
    // Immediate: created < 30 min ago | Scheduled: scheduled_at within next 75 mins
    const r = await db.query(
      `SELECT * FROM hourly_bookings
       WHERE status='pending' AND driver_phone IS NULL AND vehicle_type=$1
       AND (
         (scheduled_at IS NULL AND created_at > NOW() - INTERVAL '30 minutes')
         OR
         (scheduled_at IS NOT NULL AND scheduled_at BETWEEN NOW() - INTERVAL '15 minutes' AND NOW() + INTERVAL '75 minutes')
       )
       ORDER BY CASE WHEN scheduled_at IS NULL THEN 0 ELSE 1 END, COALESCE(scheduled_at, created_at) ASC
       LIMIT 1`,
      [dr.rows[0].vehicle_type]
    );
    res.json({ booking: r.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hourly/accept', async (req, res) => {
  const { booking_id, driver_phone } = req.body;
  try {
    const result = await db.query(
      `UPDATE hourly_bookings SET driver_phone=$1, status='matched' WHERE id=$2 AND status='pending' AND driver_phone IS NULL RETURNING *`,
      [driver_phone, booking_id]
    );
    if (result.rows.length === 0) return res.json({ success: false, message: 'Already taken' });
    sendFCM(result.rows[0].customer_phone, '⏱️ Driver Mil Gaya!', 'Hourly booking ke liye driver aa raha hai!');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hourly/start', async (req, res) => {
  const { booking_id, otp } = req.body;
  try {
    const r = await db.query('SELECT otp FROM hourly_bookings WHERE id=$1', [booking_id]);
    if (!r.rows[0] || r.rows[0].otp !== otp) return res.status(400).json({ success: false, message: 'Galat OTP!' });
    await db.query(`UPDATE hourly_bookings SET status='active', started_at=NOW() WHERE id=$1`, [booking_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hourly/driver-active', async (req, res) => {
  const { phone } = req.query;
  try {
    const r = await db.query(
      `SELECT * FROM hourly_bookings WHERE driver_phone=$1 AND status IN ('matched','active') ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    res.json({ booking: r.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/hourly/active', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await db.query(
      `SELECT * FROM hourly_bookings WHERE customer_phone=$1 AND status IN ('pending','matched','active') ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (!r.rows[0]) return res.json({ booking: null, driver: null });
    const b = r.rows[0];
    let driver = null;
    if (b.driver_phone) {
      const dr = await db.query(
        `SELECT u.name, u.phone, d.vehicle_type, d.vehicle_number FROM users u JOIN drivers d ON u.phone=d.phone WHERE u.phone=$1`,
        [b.driver_phone]
      );
      driver = dr.rows[0] || null;
    }
    res.json({ booking: b, driver });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Hourly completion helper (called from complete + auto-confirm timer) ──
async function doCompleteHourly(booking_id, actual_km) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM hourly_bookings WHERE id=$1', [booking_id]);
    if (!r.rows[0]) { await client.query('ROLLBACK'); client.release(); return null; }
    const b = r.rows[0];
    const extraKm = Math.max(0, (actual_km||0) - parseFloat(b.km_included));
    const extraCharge = extraKm * (HOURLY_FARES[b.vehicle_type]?.extra || 8);
    const extensionFare = parseFloat(b.extend_total_fare || 0);
    const totalFare = parseFloat(b.base_fare) + extraCharge + extensionFare;
    const commission = Math.round(totalFare * 0.12 * 100) / 100;
    const driverEarning = Math.round((totalFare - commission) * 100) / 100;
    const actualHours = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) / 3600000 : b.package_hours;
    const driverUser = await client.query('SELECT id FROM users WHERE phone=$1', [b.driver_phone]);
    if (driverUser.rows[0]) await client.query('UPDATE driver_wallet SET balance=balance+$1, total_earned=total_earned+$1 WHERE driver_id=$2', [driverEarning, driverUser.rows[0].id]);
    if (extraCharge > 0) {
      const cu = await client.query('SELECT id FROM users WHERE phone=$1', [b.customer_phone]);
      if (cu.rows[0]) {
        await client.query('UPDATE customer_wallet SET balance=balance-$1 WHERE user_id=$2', [extraCharge, cu.rows[0].id]);
        await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'debit',$2,'Hourly - extra km charge')", [cu.rows[0].id, extraCharge]);
      }
    }
    await client.query(
      `UPDATE hourly_bookings SET status='completed', ended_at=NOW(), actual_km=$1, extra_km=$2, extra_km_charge=$3, total_fare=$4, actual_hours=$5, driver_earning=$6, platform_fee=$7, payment_status='released', pending_customer_confirm=false WHERE id=$8`,
      [actual_km||0, extraKm, extraCharge, totalFare, actualHours, driverEarning, commission, booking_id]
    );
    await client.query('COMMIT');
    sendFCM(b.customer_phone, '⏱️ Hourly Trip Complete!', `Trip khatam! Total: ₹${totalFare.toFixed(0)}`);
    sendFCM(b.driver_phone, '✅ Trip Complete', `₹${driverEarning.toFixed(0)} aapki kamai!`);
    client.release();
    return { total_fare: totalFare, driver_earning: driverEarning, extra_km: extraKm, extra_km_charge: extraCharge };
  } catch (err) {
    await client.query('ROLLBACK'); client.release(); throw err;
  }
}

app.post('/api/hourly/complete', async (req, res) => {
  const { booking_id, actual_km } = req.body;
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE id=$1 AND status='active'", [booking_id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Active booking nahi mila' });
    const b = r.rows[0];

    const elapsedMin = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) / 60000 : 0;
    const totalMin = parseFloat(b.package_hours) * 60;

    // 20-min startup lock — prevents accidental completion right after OTP
    if (elapsedMin < 20) {
      const waitMin = Math.ceil(20 - elapsedMin);
      return res.json({ success: false, too_early: true, wait_mins: waitMin, message: `Trip abhi ${Math.floor(elapsedMin)} min pehle shuru hui — ${waitMin} min aur wait karo` });
    }

    // Package time lock — driver cannot complete before full package time is done
    // Exception: mutual early termination (early_end_confirmed=true) goes through /api/hourly/early-end-confirm which completes directly
    if (elapsedMin < totalMin) {
      const remMin = Math.ceil(totalMin - elapsedMin);
      const remH = Math.floor(remMin / 60);
      const remM = remMin % 60;
      const remStr = remH > 0 ? `${remH} ghante ${remM > 0 ? remM + ' minute' : ''}` : `${remMin} minute`;
      return res.json({ success: false, time_locked: true, remaining_min: remMin, message: `Package time baaki hai — ${remStr} aur chalao. Jaldi khatam karna ho to customer se Early End agree karo.` });
    }

    // Package time fully elapsed — complete
    const result = await doCompleteHourly(booking_id, actual_km || 0);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hourly/early-end-request', async (req, res) => {
  const { booking_id, requested_by } = req.body;
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id=$1', [booking_id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Nahi mila' });
    const b = r.rows[0];
    // Locked after 2 rejections
    if ((b.early_end_reject_count || 0) >= 2) {
      return res.json({ success: false, locked: true, message: '2 baar reject ho chuka — Support se contact karo' });
    }
    // 15-min cooldown after last rejection
    if (b.early_end_last_rejected_at) {
      const msSince = Date.now() - new Date(b.early_end_last_rejected_at).getTime();
      if (msSince < 15 * 60 * 1000) {
        const waitMin = Math.ceil((15 * 60 * 1000 - msSince) / 60000);
        return res.json({ success: false, cooldown: true, wait_mins: waitMin, message: `${waitMin} min baad dobara request kar sakte ho` });
      }
    }
    await db.query('UPDATE hourly_bookings SET early_end_requested_by=$1 WHERE id=$2', [requested_by, booking_id]);
    if (requested_by === 'driver') sendFCM(b.customer_phone, '⚠️ Driver Trip End Karna Chahta Hai', 'App mein confirm ya reject karo.');
    else sendFCM(b.driver_phone, '⚠️ Customer Trip End Karna Chahta Hai', 'App mein confirm ya reject karo.');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hourly/early-end-confirm', async (req, res) => {
  const { booking_id } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM hourly_bookings WHERE id=$1', [booking_id]);
    if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Nahi mila' }); }
    const b = r.rows[0];
    const actualHours = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) / 3600000 : 0;
    const proportion = Math.max(0.70, actualHours / b.package_hours);
    const driverAmount = Math.round(parseFloat(b.base_fare) * proportion);
    const refund = Math.round(parseFloat(b.base_fare) - driverAmount);
    const commission = Math.round(driverAmount * 0.12);
    const driverEarning = driverAmount - commission;
    const driverUser = await client.query('SELECT id FROM users WHERE phone=$1', [b.driver_phone]);
    if (driverUser.rows[0]) await client.query('UPDATE driver_wallet SET balance=balance+$1, total_earned=total_earned+$1 WHERE driver_id=$2', [driverEarning, driverUser.rows[0].id]);
    if (refund > 0) {
      const cu = await client.query('SELECT id FROM users WHERE phone=$1', [b.customer_phone]);
      if (cu.rows[0]) {
        await client.query('UPDATE customer_wallet SET balance=balance+$1 WHERE user_id=$2', [refund, cu.rows[0].id]);
        await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Hourly - early end refund')", [cu.rows[0].id, refund]);
      }
    }
    await client.query(
      `UPDATE hourly_bookings SET status='completed', ended_at=NOW(), actual_hours=$1, driver_earning=$2, platform_fee=$3, refund_amount=$4, payment_status='released', early_end_confirmed=true WHERE id=$5`,
      [actualHours, driverEarning, commission, refund, booking_id]
    );
    await client.query('COMMIT');
    sendFCM(b.customer_phone, '✅ Trip End Confirm', `₹${refund} wallet mein wapas aa gaye!`);
    sendFCM(b.driver_phone, '✅ Trip Complete', `₹${driverEarning} aapki kamai!`);
    res.json({ success: true, driver_earning: driverEarning, refund, actual_hours: actualHours.toFixed(1) });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

app.post('/api/hourly/early-end-reject', async (req, res) => {
  const { booking_id } = req.body;
  try {
    const r = await db.query(
      'UPDATE hourly_bookings SET early_end_requested_by=NULL, early_end_reject_count=COALESCE(early_end_reject_count,0)+1, early_end_last_rejected_at=NOW() WHERE id=$1 RETURNING early_end_reject_count',
      [booking_id]
    );
    const count = r.rows[0]?.early_end_reject_count || 1;
    res.json({ success: true, reject_count: count, locked: count >= 2 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hourly/cancel', async (req, res) => {
  const { booking_id, phone } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query("SELECT * FROM hourly_bookings WHERE id=$1 AND status='pending'", [booking_id]);
    if (!r.rows[0]) { await client.query('ROLLBACK'); return res.json({ success: false, message: 'Cancel nahi ho sakta' }); }
    const b = r.rows[0];
    const cu = await client.query('SELECT id FROM users WHERE phone=$1', [b.customer_phone]);
    if (cu.rows[0]) {
      await client.query('UPDATE customer_wallet SET balance=balance+$1 WHERE user_id=$2', [b.base_fare, cu.rows[0].id]);
      await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Hourly booking cancelled - refund')", [cu.rows[0].id, b.base_fare]);
    }
    await client.query("UPDATE hourly_bookings SET status='cancelled', payment_status='refunded' WHERE id=$1", [booking_id]);
    await client.query('COMMIT');
    res.json({ success: true, refunded: b.base_fare });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// Customer confirms driver's early complete
app.post('/api/hourly/customer-confirm-complete', async (req, res) => {
  const { booking_id } = req.body;
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE id=$1 AND pending_customer_confirm=true AND status='active'", [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'Confirmation pending nahi hai' });
    const result = await doCompleteHourly(booking_id, r.rows[0].actual_km || 0);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Customer disputes driver's early complete — money stays in escrow, admin reviews
app.post('/api/hourly/customer-dispute-complete', async (req, res) => {
  const { booking_id, reason } = req.body;
  try {
    const r = await db.query(
      "UPDATE hourly_bookings SET pending_customer_confirm=false, dispute_raised=true WHERE id=$1 AND pending_customer_confirm=true RETURNING driver_phone",
      [booking_id]
    );
    if (!r.rows[0]) return res.json({ success: false, message: 'Koi pending confirmation nahi' });
    sendFCM(r.rows[0].driver_phone, '⚠️ Customer ne Dispute Raise Kiya', 'Admin review karega — paise escrow mein hain');
    res.json({ success: true, message: 'Dispute raise ho gaya — admin 24h mein resolve karega' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin resolves dispute in driver's favour
app.post('/api/admin/resolve-dispute', async (req, res) => {
  const { booking_id, favour } = req.body; // favour: 'driver' | 'customer'
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id=$1 AND dispute_raised=true', [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'Disputed booking nahi mila' });
    const b = r.rows[0];
    if (favour === 'driver') {
      const result = await doCompleteHourly(booking_id, b.actual_km || 0);
      return res.json({ success: true, resolved: 'driver', ...result });
    } else {
      // Refund customer fully
      const cu = await db.query('SELECT id FROM users WHERE phone=$1', [b.customer_phone]);
      if (cu.rows[0]) {
        await db.query('UPDATE customer_wallet SET balance=balance+$1 WHERE user_id=$2', [b.base_fare, cu.rows[0].id]);
        await db.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Hourly dispute resolved - full refund')", [cu.rows[0].id, b.base_fare]);
      }
      await db.query("UPDATE hourly_bookings SET status='cancelled', payment_status='refunded', dispute_raised=false WHERE id=$1", [booking_id]);
      sendFCM(b.customer_phone, '✅ Dispute Resolved', `₹${b.base_fare} aapke wallet mein wapas!`);
      sendFCM(b.driver_phone, '❌ Dispute Against You', 'Customer ko refund mil gaya');
      return res.json({ success: true, resolved: 'customer', refunded: b.base_fare });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: list all disputed bookings
app.get('/api/admin/hourly-disputes', async (req, res) => {
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE dispute_raised=true ORDER BY id DESC");
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Customer requests time extension
app.post('/api/hourly/request-extend', async (req, res) => {
  const { booking_id, extra_hours, customer_phone } = req.body;
  if (!extra_hours || extra_hours < 1) return res.json({ success: false, message: 'Min 1 hour extend karo' });
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE id=$1 AND status='active'", [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'Active booking nahi mila' });
    const b = r.rows[0];
    if (b.extend_requested_hours) return res.json({ success: false, message: 'Extension request pehle se pending hai' });
    const pkg = HOURLY_FARES[b.vehicle_type];
    // Fare: look up package fare for extra_hours, else proportional from base
    const extraFare = pkg?.[extra_hours]?.fare
      ? Math.round(pkg[extra_hours].fare * SURGE_MULTIPLIER)
      : Math.round((parseFloat(b.base_fare) / parseFloat(b.package_hours)) * extra_hours * SURGE_MULTIPLIER);
    const cu = await db.query('SELECT id FROM users WHERE phone=$1', [customer_phone]);
    if (!cu.rows[0]) return res.json({ success: false, message: 'User nahi mila' });
    const wallet = await db.query('SELECT balance FROM customer_wallet WHERE user_id=$1', [cu.rows[0].id]);
    const balance = parseFloat(wallet.rows[0]?.balance || 0);
    if (balance < extraFare) return res.json({ success: false, message: `Wallet mein ₹${extraFare} chahiye, aapke paas ₹${balance.toFixed(0)} hai` });
    await db.query('UPDATE customer_wallet SET balance=balance-$1 WHERE user_id=$2', [extraFare, cu.rows[0].id]);
    await db.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'debit',$2,'Hourly extend request - escrow')", [cu.rows[0].id, extraFare]);
    await db.query('UPDATE hourly_bookings SET extend_requested_hours=$1, extend_escrow=$2 WHERE id=$3', [extra_hours, extraFare, booking_id]);
    sendFCM(b.driver_phone, `📅 Customer +${extra_hours}h Extend Chahta Hai`, `₹${extraFare} escrow mein — accept ya reject karo app mein`);
    res.json({ success: true, extra_fare: extraFare, message: `₹${extraFare} hold ho gaye — driver ka intezaar karo` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Driver accepts extension
app.post('/api/hourly/accept-extend', async (req, res) => {
  const { booking_id } = req.body;
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id=$1 AND extend_requested_hours IS NOT NULL', [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'Koi extend request nahi' });
    const b = r.rows[0];
    const extraHours = parseFloat(b.extend_requested_hours);
    const newHours = parseFloat(b.package_hours) + extraHours;
    // Extra KM proportional to package ratio
    const extraKm = Math.round((parseFloat(b.km_included) / parseFloat(b.package_hours)) * extraHours);
    const newKm = parseFloat(b.km_included) + extraKm;
    const newFare = parseFloat(b.base_fare) + parseFloat(b.extend_escrow);
    const extMinutes = Math.round(extraHours * 60);
    await db.query(
      `UPDATE hourly_bookings SET package_hours=$1, km_included=$2, base_fare=$3, total_fare=$3,
       extend_requested_hours=NULL, extend_escrow=0,
       extend_total_minutes=COALESCE(extend_total_minutes,0)+$4,
       extend_total_fare=COALESCE(extend_total_fare,0)+$5
       WHERE id=$6`,
      [newHours, newKm, newFare, extMinutes, parseFloat(b.extend_escrow), booking_id]
    );
    sendFCM(b.customer_phone, '✅ Extension Accept Ho Gaya!', `Trip ab ${newHours >= 24 ? (newHours/24)+'d' : newHours+'h'} ke liye extend ho gaya — ${newKm} km included`);
    res.json({ success: true, new_hours: newHours, new_km: newKm, new_fare: newFare });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Driver rejects extension — refund customer
app.post('/api/hourly/reject-extend', async (req, res) => {
  const { booking_id } = req.body;
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id=$1 AND extend_requested_hours IS NOT NULL', [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'Koi extend request nahi' });
    const b = r.rows[0];
    if (parseFloat(b.extend_escrow || 0) > 0) {
      const cu = await db.query('SELECT id FROM users WHERE phone=$1', [b.customer_phone]);
      if (cu.rows[0]) {
        await db.query('UPDATE customer_wallet SET balance=balance+$1 WHERE user_id=$2', [b.extend_escrow, cu.rows[0].id]);
        await db.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Hourly extend rejected - refund')", [cu.rows[0].id, b.extend_escrow]);
      }
    }
    await db.query('UPDATE hourly_bookings SET extend_requested_hours=NULL, extend_escrow=0 WHERE id=$1', [booking_id]);
    sendFCM(b.customer_phone, '❌ Extension Reject Ho Gaya', `₹${parseFloat(b.extend_escrow||0).toFixed(0)} wapas aapke wallet mein`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Driver sends live km update — triggers pre-completion alerts at 80% threshold
app.post('/api/hourly/update-km', async (req, res) => {
  const { booking_id, actual_km } = req.body;
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE id=$1 AND status='active'", [booking_id]);
    if (!r.rows[0]) return res.json({ success: false });
    const b = r.rows[0];
    await db.query('UPDATE hourly_bookings SET actual_km=$1 WHERE id=$2', [actual_km || 0, booking_id]);

    const kmPct = parseFloat(b.km_included) > 0 ? (actual_km / parseFloat(b.km_included)) : 0;
    const elapsedMin = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) / 60000 : 0;
    const totalMin = parseFloat(b.package_hours) * 60;
    const timePct = totalMin > 0 ? elapsedMin / totalMin : 0;

    const alerts = [];
    // KM alert at 80%
    if (kmPct >= 0.80 && !b.km_alert_sent) {
      await db.query('UPDATE hourly_bookings SET km_alert_sent=TRUE WHERE id=$1', [booking_id]);
      const kmLeft = Math.max(0, parseFloat(b.km_included) - actual_km);
      sendFCM(b.customer_phone, '📍 Package KM Khatam Hua', `${actual_km} km travel ho gaye — package mein ${b.km_included} km tha. Ab ₹${HOURLY_FARES[b.vehicle_type]?.extra || 8}/km extra charge hoga jo trip end pe pay hoga.`);
      sendFCM(b.driver_phone, '📍 Customer Package KM Exceed Hua', `${actual_km}/${b.km_included} km. Ab extra charges customer se honge — trip jaari rahegi.`);
      alerts.push('km_alert');
    }
    // Time alert at 80%
    if (timePct >= 0.80 && !b.time_alert_sent) {
      await db.query('UPDATE hourly_bookings SET time_alert_sent=TRUE WHERE id=$1', [booking_id]);
      const minLeft = Math.max(0, Math.round(totalMin - elapsedMin));
      sendFCM(b.customer_phone, '⏰ Time Khatam Hone Wala Hai!', `Sirf ~${minLeft} minute bacha hai. Extension chahiye? App mein extend karo.`);
      sendFCM(b.driver_phone, '⏰ Trip Time 80% Complete', `${Math.round(elapsedMin)}/${Math.round(totalMin)} min elapsed.`);
      alerts.push('time_alert');
    }

    const extraKmCharge = Math.max(0, actual_km - parseFloat(b.km_included)) * (HOURLY_FARES[b.vehicle_type]?.extra || 8);
    res.json({ success: true, alerts, km_pct: Math.round(kmPct * 100), time_pct: Math.round(timePct * 100), extra_km_charge: extraKmCharge });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cost preview before requesting extension
app.get('/api/hourly/extend-cost', async (req, res) => {
  const { booking_id, extra_hours, extra_minutes } = req.query;
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id=$1', [booking_id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Booking nahi mila' });
    const b = r.rows[0];
    const pkg = HOURLY_FARES[b.vehicle_type];
    const extraHours = parseFloat(extra_hours || 0);
    const extraMin = parseInt(extra_minutes || 0);
    const totalExtraDecimalHours = extraHours + extraMin / 60;

    let extraFare = 0;
    if (extraHours >= 1 && pkg?.[extraHours]) {
      // Named package fare
      extraFare = Math.round(pkg[extraHours].fare * SURGE_MULTIPLIER);
    } else {
      // Per-hour rate from base package
      const perHourRate = parseFloat(b.base_fare) / parseFloat(b.package_hours);
      extraFare = Math.round(perHourRate * totalExtraDecimalHours * SURGE_MULTIPLIER);
    }
    const extraKm = extraHours >= 1 && pkg?.[extraHours]
      ? pkg[extraHours].km
      : Math.round((parseFloat(b.km_included) / parseFloat(b.package_hours)) * totalExtraDecimalHours);

    res.json({ extra_fare: extraFare, extra_km: extraKm, extra_hours: extraHours, extra_minutes: extraMin, per_km_rate: pkg?.extra || 8 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Extended request-extend that handles minutes too
app.post('/api/hourly/request-extend-v2', async (req, res) => {
  const { booking_id, extra_hours, extra_minutes, customer_phone } = req.body;
  const extraHours = parseFloat(extra_hours || 0);
  const extraMin = parseInt(extra_minutes || 0);
  const totalExtraDecimalHours = extraHours + extraMin / 60;
  if (totalExtraDecimalHours <= 0) return res.json({ success: false, message: 'Kam se kam 15 minute extend karo' });
  if (extraMin > 0 && extraMin < 15) return res.json({ success: false, message: 'Minutes mein minimum 15 minute extension' });
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE id=$1 AND status='active'", [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'Active booking nahi mila' });
    const b = r.rows[0];
    if (b.extend_requested_hours) return res.json({ success: false, message: 'Extension request pehle se pending hai — driver ka intezaar karo' });
    const pkg = HOURLY_FARES[b.vehicle_type];
    let extraFare = 0;
    if (extraHours >= 1 && pkg?.[extraHours]) {
      extraFare = Math.round(pkg[extraHours].fare * SURGE_MULTIPLIER);
    } else {
      const perHourRate = parseFloat(b.base_fare) / parseFloat(b.package_hours);
      extraFare = Math.round(perHourRate * totalExtraDecimalHours * SURGE_MULTIPLIER);
    }
    const cu = await db.query('SELECT id FROM users WHERE phone=$1', [customer_phone]);
    if (!cu.rows[0]) return res.json({ success: false, message: 'User nahi mila' });
    const wallet = await db.query('SELECT balance FROM customer_wallet WHERE user_id=$1', [cu.rows[0].id]);
    const balance = parseFloat(wallet.rows[0]?.balance || 0);
    if (balance < extraFare) return res.json({ success: false, message: `Wallet mein ₹${extraFare} chahiye, aapke paas ₹${balance.toFixed(0)} hai` });
    await db.query('UPDATE customer_wallet SET balance=balance-$1 WHERE user_id=$2', [extraFare, cu.rows[0].id]);
    await db.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'debit',$2,'Hourly extend request v2 - escrow')", [cu.rows[0].id, extraFare]);
    await db.query('UPDATE hourly_bookings SET extend_requested_hours=$1, extend_escrow=$2 WHERE id=$3', [totalExtraDecimalHours, extraFare, booking_id]);
    const label = extraHours >= 1 ? `${extraHours}h${extraMin > 0 ? ` ${extraMin}m` : ''}` : `${extraMin} min`;
    sendFCM(b.driver_phone, `📅 Customer +${label} Extend Chahta Hai`, `₹${extraFare} escrow mein — accept ya reject karo app mein`);
    res.json({ success: true, extra_fare: extraFare, label, message: `₹${extraFare} hold ho gaye — driver ka intezaar karo` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════
//  WALLET TOPUP via Razorpay.me + Full History APIs
// ══════════════════════════════════════════════════
const RAZORPAY_ME_URL = 'https://razorpay.me/@rajawat101';

// Ensure razorpay_topups table exists
db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS upi_id VARCHAR(100)').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP DEFAULT NULL').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS assigned_to_phone VARCHAR(20) DEFAULT NULL').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS assignment_expires_at TIMESTAMP DEFAULT NULL').catch(() => {});
db.query('ALTER TABLE rides ADD COLUMN IF NOT EXISTS assignment_queue JSONB DEFAULT \'[]\'').catch(() => {});
db.query(`CREATE TABLE IF NOT EXISTS ride_extensions (
  id SERIAL PRIMARY KEY,
  original_ride_id INTEGER NOT NULL,
  customer_phone VARCHAR(20) NOT NULL,
  driver_phone VARCHAR(20) NOT NULL,
  pickup VARCHAR(500), pickup_lat FLOAT, pickup_lng FLOAT,
  new_drop VARCHAR(500) NOT NULL, new_drop_lat FLOAT, new_drop_lng FLOAT,
  vehicle_type VARCHAR(20), estimated_fare FLOAT,
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  window_expires_at TIMESTAMP NOT NULL,
  response_expires_at TIMESTAMP NOT NULL,
  new_ride_id INTEGER
)`).catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP DEFAULT NULL').catch(() => {});
db.query('ALTER TABLE driver_wallet ADD COLUMN IF NOT EXISTS pending_commission DECIMAL(10,2) DEFAULT 0').catch(() => {});
db.query(`CREATE TABLE IF NOT EXISTS driver_commission_payments (
  id SERIAL PRIMARY KEY,
  driver_phone VARCHAR(15) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  payment_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS pending_customer_confirm BOOLEAN DEFAULT FALSE').catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS dispute_raised BOOLEAN DEFAULT FALSE').catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS early_end_reject_count INTEGER DEFAULT 0').catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS early_end_last_rejected_at TIMESTAMP').catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS extend_requested_hours DECIMAL').catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS extend_escrow DECIMAL DEFAULT 0').catch(() => {});
db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_brand VARCHAR(100)').catch(() => {});
db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR(100)').catch(() => {});
db.query('ALTER TABLE drivers ADD COLUMN IF NOT EXISTS dl_number VARCHAR(20)').catch(() => {});
db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT').catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS km_alert_sent BOOLEAN DEFAULT FALSE').catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS time_alert_sent BOOLEAN DEFAULT FALSE').catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS extend_total_minutes INTEGER DEFAULT 0').catch(() => {});
db.query('ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS extend_total_fare DECIMAL DEFAULT 0').catch(() => {});
db.query(`CREATE TABLE IF NOT EXISTS driver_bonus_claims (
  id SERIAL PRIMARY KEY,
  driver_phone VARCHAR(15),
  claim_date DATE DEFAULT CURRENT_DATE,
  rides_at_claim INTEGER,
  bonus_tier INTEGER,
  bonus_amount DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(driver_phone, claim_date, bonus_tier)
)`).catch(() => {});
db.query(`CREATE TABLE IF NOT EXISTS customer_loyalty (
  user_id INTEGER PRIMARY KEY,
  total_points INTEGER DEFAULT 0,
  total_redeemed INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});
db.query(`CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id SERIAL PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  body TEXT,
  target VARCHAR(20) DEFAULT 'all',
  type VARCHAR(20) DEFAULT 'banner',
  promo_code VARCHAR(50),
  cta_label VARCHAR(100),
  active BOOLEAN DEFAULT TRUE,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});

db.query(`CREATE TABLE IF NOT EXISTS razorpay_topups (
  id SERIAL PRIMARY KEY,
  user_phone VARCHAR(15),
  amount DECIMAL(10,2),
  payment_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(e => console.log('razorpay_topups:', e.message));

db.query(`INSERT INTO fare_settings (vehicle_type, base_fare, per_km_rate, night_multiplier, night_start, night_end)
  SELECT 'luxury', 80, 25, 1.8, '22:00', '06:00'
  WHERE NOT EXISTS (SELECT 1 FROM fare_settings WHERE vehicle_type = 'luxury')`).catch(() => {});

// POST /api/wallet/topup/order — create Razorpay order for wallet recharge (native SDK)
app.post('/api/wallet/topup/order', async (req, res) => {
  const { phone, amount } = req.body;
  const paise = Math.round(parseFloat(amount || 0) * 100);
  if (paise < 100) return res.status(400).json({ error: 'Minimum ₹1 chahiye' });
  if (!razorpay) return res.status(500).json({ error: 'Payment gateway not configured' });
  try {
    const user = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User nahi mila' });
    const order = await razorpay.orders.create({
      amount: paise,
      currency: 'INR',
      receipt: `topup_${phone}_${Date.now()}`,
      notes: { phone, purpose: 'wallet_topup' },
    });
    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: 'INR',
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/wallet/topup/verify — verify Razorpay signature + credit wallet
app.post('/api/wallet/topup/verify', async (req, res) => {
  const { phone, razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ error: 'Missing payment fields' });

  // Verify HMAC
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  if (expected !== razorpay_signature)
    return res.status(400).json({ error: 'Invalid payment signature' });

  const client = await db.connect();
  try {
    // Prevent duplicate credits
    const dup = await client.query(
      "SELECT id FROM razorpay_topups WHERE payment_id=$1 AND status='confirmed'", [razorpay_payment_id]
    );
    if (dup.rows.length > 0) return res.json({ success: false, error: 'Payment already processed' });

    const rupees = Math.round(parseFloat(amount) * 100) === Math.round(parseFloat(amount) * 100)
      ? parseFloat(amount)
      : parseFloat(amount) / 100;

    await client.query('BEGIN');
    const user = await client.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User nahi mila' }); }
    const userId = user.rows[0].id;
    await client.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const w = await client.query(
      'UPDATE customer_wallet SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 RETURNING balance',
      [rupees, userId]
    );
    await client.query(
      "INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,$3)",
      [userId, rupees, `Wallet recharge ₹${rupees} (${razorpay_payment_id})`]
    );
    await client.query(
      "INSERT INTO razorpay_topups (user_phone,amount,payment_id,status) VALUES ($1,$2,$3,'confirmed')",
      [phone, rupees, razorpay_payment_id]
    );
    await client.query('COMMIT');
    res.json({ success: true, balance: parseFloat(w.rows[0].balance), message: `₹${rupees} wallet mein add ho gaya!` });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// GET /api/wallet/topup/url — legacy Razorpay.me link (kept for fallback)
app.get('/api/wallet/topup/url', (req, res) => {
  const { amount } = req.query;
  const paise = Math.round(parseFloat(amount || 0) * 100);
  if (paise < 100) return res.status(400).json({ error: 'Minimum ₹1 chahiye' });
  const url = `${RAZORPAY_ME_URL}?amount=${paise}`;
  res.json({ url, amount: parseFloat(amount), paise });
});

// POST /api/wallet/topup/confirm — credit wallet after Razorpay.me payment
app.post('/api/wallet/topup/confirm', async (req, res) => {
  const { phone, amount, payment_id } = req.body;
  const client = await db.connect();
  try {
    if (!phone || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid request' });
    // Check duplicate payment_id
    if (payment_id) {
      const dup = await client.query("SELECT id FROM razorpay_topups WHERE payment_id=$1 AND status='confirmed'", [payment_id]);
      if (dup.rows.length > 0) return res.json({ success: false, error: 'Payment ID already used' });
    }
    await client.query('BEGIN');
    const user = await client.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User nahi mila' }); }
    const userId = user.rows[0].id;
    await client.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const w = await client.query('UPDATE customer_wallet SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 RETURNING balance', [amount, userId]);
    await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,$3)", [userId, amount, payment_id ? `Wallet recharge via Razorpay (${payment_id})` : 'Wallet recharge']);
    await client.query('INSERT INTO razorpay_topups (user_phone,amount,payment_id,status) VALUES ($1,$2,$3,$4)', [phone, amount, payment_id || null, payment_id ? 'confirmed' : 'unverified']);
    await client.query('COMMIT');
    res.json({ success: true, balance: parseFloat(w.rows[0].balance), message: `₹${amount} wallet mein add ho gaya!` });
  } catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
  finally { client.release(); }
});

// GET /api/wallet/customer/detail — full customer wallet info
app.get('/api/wallet/customer/detail', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id, name FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) return res.json({ balance: 0, transactions: [] });
    const userId = user.rows[0].id;
    const w = await db.query('SELECT balance FROM customer_wallet WHERE user_id=$1', [userId]);
    const txns = await db.query(
      `SELECT id, type, amount, description, created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [userId]
    );
    const stats = await db.query(
      `SELECT
        COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE 0 END),0) AS total_credited,
        COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE 0 END),0) AS total_spent,
        COALESCE(SUM(CASE WHEN type='credit' AND description LIKE '%reward%' THEN amount ELSE 0 END),0) AS total_rewards,
        COALESCE(SUM(CASE WHEN type='credit' AND description LIKE '%Referral%' THEN amount ELSE 0 END),0) AS referral_earned,
        COALESCE(SUM(CASE WHEN type='credit' AND description LIKE '%refund%' THEN amount ELSE 0 END),0) AS total_refunds
       FROM transactions WHERE user_id=$1`,
      [userId]
    );
    res.json({
      name: user.rows[0].name,
      balance: parseFloat(w.rows[0]?.balance || 0),
      transactions: txns.rows,
      stats: stats.rows[0],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/wallet/driver/detail — full driver wallet info
app.get('/api/wallet/driver/detail', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT u.id, u.name, d.vehicle_type, d.vehicle_no FROM users u JOIN drivers d ON u.id=d.id WHERE u.phone=$1', [phone]);
    if (!user.rows[0]) return res.json({ balance: 0, transactions: [] });
    const driverId = user.rows[0].id;
    const w = await db.query('SELECT balance, total_earned, COALESCE(total_withdrawn,0) AS total_withdrawn FROM driver_wallet WHERE driver_id=$1', [driverId]);
    // Driver txns — from rides completed + hourly
    const rides = await db.query(
      `SELECT r.id, r.fare, r.payment_method, r.ride_type, r.created_at, p.name AS passenger_name
       FROM rides r
       JOIN users d ON r.driver_id=d.id
       LEFT JOIN users p ON r.passenger_id=p.id
       WHERE d.phone=$1 AND r.status='completed'
       ORDER BY r.created_at DESC LIMIT 50`,
      [phone]
    );
    const hourly = await db.query(
      `SELECT id, base_fare, total_fare, driver_earning, vehicle_type, package_hours, customer_phone, created_at
       FROM hourly_bookings WHERE driver_phone=$1 AND status='completed'
       ORDER BY created_at DESC LIMIT 30`,
      [phone]
    );
    const payouts = await db.query(
      `SELECT amount, created_at FROM driver_commissions WHERE driver_phone=$1 ORDER BY created_at DESC LIMIT 20`,
      [phone]
    ).catch(() => ({ rows: [] }));
    res.json({
      name: user.rows[0].name,
      vehicle_type: user.rows[0].vehicle_type,
      vehicle_no: user.rows[0].vehicle_no,
      wallet: { balance: parseFloat(w.rows[0]?.balance||0), total_earned: parseFloat(w.rows[0]?.total_earned||0), total_withdrawn: parseFloat(w.rows[0]?.total_withdrawn||0) },
      rides: rides.rows,
      hourly_rides: hourly.rows,
      payouts: payouts.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════
//  ADMIN DASHBOARD API + HTML PORTAL
// ══════════════════════════════════════════════════

// GET /api/admin/dashboard — full platform stats
app.get('/api/admin/dashboard', async (req, res) => {
  try {
    const [users, drivers, rides, revenue, wallets, hourly, topups] = await Promise.all([
      db.query("SELECT COUNT(*) AS total FROM users WHERE role='passenger'"),
      db.query("SELECT COUNT(*) AS total, COUNT(CASE WHEN is_online THEN 1 END) AS online FROM drivers"),
      db.query("SELECT COUNT(*) AS total, COUNT(CASE WHEN status='completed' THEN 1 END) AS completed, COALESCE(SUM(CASE WHEN status='completed' THEN fare END),0) AS gross_revenue FROM rides"),
      db.query("SELECT COALESCE(SUM(commission_amount),0) AS platform_commission FROM rides WHERE status='completed'"),
      db.query("SELECT (SELECT COALESCE(SUM(balance),0) FROM customer_wallet) AS customer_wallets, (SELECT COALESCE(SUM(balance),0) FROM driver_wallet) AS driver_wallets"),
      db.query("SELECT COUNT(*) AS total, COUNT(CASE WHEN status='completed' THEN 1 END) AS completed, COALESCE(SUM(CASE WHEN status='completed' THEN total_fare END),0) AS hourly_revenue FROM hourly_bookings"),
      db.query("SELECT COALESCE(SUM(amount),0) AS total FROM razorpay_topups WHERE status IN ('confirmed','unverified')"),
    ]);
    res.json({
      customers: parseInt(users.rows[0].total),
      drivers: { total: parseInt(drivers.rows[0].total), online: parseInt(drivers.rows[0].online) },
      rides: { total: parseInt(rides.rows[0].total), completed: parseInt(rides.rows[0].completed), gross_revenue: parseFloat(rides.rows[0].gross_revenue) },
      hourly: { total: parseInt(hourly.rows[0].total), completed: parseInt(hourly.rows[0].completed), revenue: parseFloat(hourly.rows[0].hourly_revenue) },
      platform_commission: parseFloat(revenue.rows[0].platform_commission),
      wallets: { customer_total: parseFloat(wallets.rows[0]?.customer_wallets||0), driver_total: parseFloat(wallets.rows[0]?.driver_wallets||0) },
      topup_total: parseFloat(topups.rows[0].total),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/all-transactions — all platform transactions
app.get('/api/admin/all-transactions', async (req, res) => {
  const { limit = 100, offset = 0, type } = req.query;
  try {
    let q = `SELECT t.id, t.type, t.amount, t.description, t.created_at, u.name, u.phone
             FROM transactions t JOIN users u ON t.user_id=u.id`;
    const params = [];
    if (type) { q += ` WHERE t.type=$1`; params.push(type); }
    q += ` ORDER BY t.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(limit, offset);
    const result = await db.query(q, params);
    const count = await db.query(`SELECT COUNT(*) FROM transactions${type ? " WHERE type=$1" : ""}`, type ? [type] : []);
    res.json({ transactions: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/topups — all Razorpay topup records
app.get('/api/admin/topups', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM razorpay_topups ORDER BY created_at DESC LIMIT 200');
    res.json({ topups: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/topups/verify/:id — admin manually verifies a payment
app.post('/api/admin/topups/verify/:id', async (req, res) => {
  try {
    await db.query("UPDATE razorpay_topups SET status='verified' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════
//  MARKETING: Campaigns + Promo + Broadcast + Referral
// ══════════════════════════════════════════════════

// Active offers for apps
app.get('/api/offers/active', async (req, res) => {
  const { role } = req.query; // 'customer' | 'driver'
  try {
    const r = await db.query(
      `SELECT * FROM marketing_campaigns
       WHERE active=true AND (expires_at IS NULL OR expires_at > NOW())
       AND (target='all' OR target=$1)
       ORDER BY created_at DESC LIMIT 5`,
      [role || 'customer']
    );
    res.json({ offers: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: list all campaigns
app.get('/api/admin/campaigns', async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM marketing_campaigns ORDER BY created_at DESC');
    res.json({ campaigns: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: create campaign
app.post('/api/admin/campaigns', async (req, res) => {
  const { title, body, target, type, promo_code, cta_label, expires_at } = req.body;
  if (!title) return res.status(400).json({ error: 'Title zaroori hai' });
  try {
    const r = await db.query(
      `INSERT INTO marketing_campaigns (title,body,target,type,promo_code,cta_label,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, body || '', target || 'all', type || 'banner', promo_code || null, cta_label || null, expires_at || null]
    );
    res.json({ success: true, campaign: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: toggle campaign active
app.post('/api/admin/campaigns/toggle/:id', async (req, res) => {
  try {
    const r = await db.query('UPDATE marketing_campaigns SET active=NOT active WHERE id=$1 RETURNING active', [req.params.id]);
    res.json({ success: true, active: r.rows[0]?.active });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: delete campaign
app.delete('/api/admin/campaigns/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM marketing_campaigns WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: broadcast notification
app.post('/api/admin/notify-all', async (req, res) => {
  const { title, body, target } = req.body; // target: 'all'|'customers'|'drivers'
  if (!title || !body) return res.status(400).json({ error: 'Title aur body zaroori hai' });
  try {
    let roleFilter = '';
    if (target === 'customers') roleFilter = "WHERE role='passenger'";
    else if (target === 'drivers') roleFilter = "WHERE role='driver'";
    const users = await db.query(`SELECT phone, fcm_token FROM users ${roleFilter} WHERE fcm_token IS NOT NULL`);
    let sent = 0, failed = 0;
    // Fire-and-forget — respond first
    res.json({ success: true, total_targets: users.rows.length, message: `Notification bheja ja raha hai...` });
    for (const u of users.rows) {
      try { await sendFCM(u.phone, title, body); sent++; } catch (_e) { failed++; }
    }
    console.log(`📣 Broadcast done: ${sent} sent, ${failed} failed`);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: referral analytics
app.get('/api/admin/referrals', async (req, res) => {
  try {
    const total = await db.query('SELECT COUNT(*) AS cnt FROM referrals');
    const completed = await db.query("SELECT COUNT(*) AS cnt FROM referrals WHERE status='completed'");
    const totalReward = await db.query("SELECT COALESCE(SUM(reward_amount),0) AS total FROM referrals WHERE status='completed'");
    const topReferrers = await db.query(
      `SELECT u.name, u.phone, COUNT(r.id) AS referrals, SUM(r.reward_amount) AS earned
       FROM referrals r JOIN users u ON r.referrer_id=u.id
       WHERE r.status='completed'
       GROUP BY u.id,u.name,u.phone ORDER BY referrals DESC LIMIT 20`
    );
    const recent = await db.query(
      `SELECT r.*, u1.name AS referrer_name, u1.phone AS referrer_phone, u2.name AS referred_name, u2.phone AS referred_phone
       FROM referrals r
       JOIN users u1 ON r.referrer_id=u1.id
       JOIN users u2 ON r.referred_id=u2.id
       ORDER BY r.created_at DESC LIMIT 50`
    );
    res.json({ total: parseInt(total.rows[0].cnt), completed: parseInt(completed.rows[0].cnt), total_reward: parseFloat(totalReward.rows[0].total), top_referrers: topReferrers.rows, recent: recent.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin HTML Portal ────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/admin-portal.html');
});
app.get('/admin-old', (req, res) => {
  res.send(`<!DOCTYPE html>
<!-- MERGED PORTAL v2 -->
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RideApp Admin Portal</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#f0f2f5;color:#1a1a2e}
.header{background:#1a1a2e;padding:18px 28px;display:flex;align-items:center;justify-content:space-between}
.logo{color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px}
.logo span{color:#e94560}
.badge{background:#e94560;color:#fff;border-radius:8px;padding:4px 12px;font-size:12px;font-weight:700}
.main{max-width:1200px;margin:0 auto;padding:24px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:28px}
.stat-card{background:#fff;border-radius:16px;padding:22px;box-shadow:0 2px 12px rgba(0,0,0,.07)}
.stat-icon{font-size:28px;margin-bottom:8px}
.stat-value{font-size:30px;font-weight:800;color:#1a1a2e}
.stat-label{font-size:13px;color:#888;margin-top:4px}
.stat-card.red .stat-value{color:#e94560}
.stat-card.green .stat-value{color:#4CAF50}
.stat-card.blue .stat-value{color:#2196F3}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px}
@media(max-width:768px){.grid2{grid-template-columns:1fr}}
.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 2px 12px rgba(0,0,0,.07)}
.card-title{font-size:15px;font-weight:700;margin-bottom:16px;color:#1a1a2e;display:flex;align-items:center;gap:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;background:#f8f9fa;color:#666;font-weight:600;border-bottom:2px solid #f0f0f0}
td{padding:10px 12px;border-bottom:1px solid #f8f9fa;vertical-align:middle}
tr:hover td{background:#fafafa}
.badge-credit{background:#e8f5e9;color:#2e7d32;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700}
.badge-debit{background:#ffebee;color:#c62828;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700}
.badge-pending{background:#fff3e0;color:#e65100;border-radius:6px;padding:2px 8px;font-size:11px}
.badge-verified{background:#e8f5e9;color:#2e7d32;border-radius:6px;padding:2px 8px;font-size:11px}
.badge-unverified{background:#fff3e0;color:#e65100;border-radius:6px;padding:2px 8px;font-size:11px}
.tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.tab{padding:8px 18px;border-radius:24px;cursor:pointer;font-size:13px;font-weight:600;border:none;background:#f0f0f0;color:#666}
.tab.active{background:#1a1a2e;color:#fff}
.section{display:none}.section.active{display:block}
.refresh-btn{background:#e94560;color:#fff;border:none;border-radius:10px;padding:8px 18px;cursor:pointer;font-size:13px;font-weight:600;margin-left:auto}
.refresh-btn:hover{opacity:.85}
.verify-btn{background:#4CAF50;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600}
.verify-btn:hover{opacity:.85}
.loading{text-align:center;color:#999;padding:30px}
.amount-green{color:#2e7d32;font-weight:700}
.amount-red{color:#c62828;font-weight:700}
.chip{display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700}
.online{background:#e8f5e9;color:#2e7d32}
.offline{background:#f5f5f5;color:#999}
</style>
</head>
<body>
<div class="header">
  <div class="logo">Ride<span>App</span> Admin</div>
  <div style="display:flex;gap:12px;align-items:center">
    <span class="badge" id="last-refresh">Loading...</span>
    <button class="refresh-btn" onclick="loadAll()">⟳ Refresh</button>
  </div>
</div>
<div class="main">
  <div class="stats" id="stats-grid"><div class="loading">Loading dashboard...</div></div>
  <div class="tabs">
    <button class="tab active" onclick="showSection('transactions')">📋 Transactions</button>
    <button class="tab" onclick="showSection('customers')">👥 Customers</button>
    <button class="tab" onclick="showSection('drivers')">🚗 Drivers</button>
    <button class="tab" onclick="showSection('topups')">💳 Topups</button>
    <button class="tab" onclick="showSection('marketing')">📣 Marketing</button>
    <button class="tab" onclick="showSection('settings')">⚙️ Settings</button>
  </div>
  <div id="transactions" class="section active">
    <div class="card"><div class="card-title">📋 All Transactions <button class="refresh-btn" onclick="loadTransactions()">Reload</button></div>
    <div style="overflow-x:auto"><table id="txn-table"><thead><tr><th>Date</th><th>User</th><th>Phone</th><th>Type</th><th>Amount</th><th>Description</th></tr></thead><tbody id="txn-body"><tr><td colspan=6 class=loading>Loading...</td></tr></tbody></table></div></div>
  </div>
  <div id="customers" class="section">
    <div class="card"><div class="card-title">👥 All Customers</div>
    <div style="overflow-x:auto"><table id="cust-table"><thead><tr><th>Name</th><th>Phone</th><th>Total Rides</th><th>Wallet Balance</th><th>Joined</th></tr></thead><tbody id="cust-body"><tr><td colspan=5 class=loading>Loading...</td></tr></tbody></table></div></div>
  </div>
  <div id="drivers" class="section">
    <div class="card"><div class="card-title">🚗 All Drivers</div>
    <div style="overflow-x:auto"><table id="drv-table"><thead><tr><th>Name</th><th>Phone</th><th>Vehicle</th><th>Status</th><th>Balance</th><th>Total Earned</th></tr></thead><tbody id="drv-body"><tr><td colspan=6 class=loading>Loading...</td></tr></tbody></table></div></div>
  </div>
  <div id="topups" class="section">
    <div class="card"><div class="card-title">💳 Razorpay Topups</div>
    <div style="overflow-x:auto"><table id="topup-table"><thead><tr><th>Date</th><th>Phone</th><th>Amount</th><th>Payment ID</th><th>Status</th><th>Action</th></tr></thead><tbody id="topup-body"><tr><td colspan=6 class=loading>Loading...</td></tr></tbody></table></div></div>
  </div>
  <div id="marketing" class="section">
    <!-- Campaign/Banner Manager -->
    <div class="grid2" style="margin-bottom:20px">
      <div class="card">
        <div class="card-title">📣 Create Campaign / Banner</div>
        <input id="camp-title" placeholder="Title (e.g. 🎉 Weekend Offer!)" style="width:100%;padding:9px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:8px;font-size:13px">
        <textarea id="camp-body" placeholder="Description (e.g. Sabhi rides pe 20% off!)" style="width:100%;padding:9px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:8px;font-size:13px;resize:none;height:60px"></textarea>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <select id="camp-target" style="flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px">
            <option value="all">All (Customers + Drivers)</option>
            <option value="customer">Customers Only</option>
            <option value="driver">Drivers Only</option>
          </select>
          <select id="camp-type" style="flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px">
            <option value="banner">Banner</option>
            <option value="promo">Promo Code</option>
            <option value="incentive">Driver Incentive</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <input id="camp-promo" placeholder="Promo code (optional)" style="flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px">
          <input id="camp-cta" placeholder="Button label (e.g. Book Now!)" style="flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px">
        </div>
        <input id="camp-expires" type="datetime-local" style="width:100%;padding:9px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:10px;font-size:13px">
        <button onclick="createCampaign()" style="width:100%;background:#e94560;color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;font-weight:700;font-size:13px">🚀 Launch Campaign</button>
        <div id="camp-status" style="font-size:13px;color:#4CAF50;margin-top:8px"></div>
      </div>
      <div class="card">
        <div class="card-title">📲 Broadcast Notification</div>
        <p style="font-size:12px;color:#888;margin-bottom:10px">FCM push notification seedha users ke phones pe bhejo</p>
        <input id="notif-title" placeholder="Notification title" style="width:100%;padding:9px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:8px;font-size:13px">
        <textarea id="notif-body" placeholder="Message text..." style="width:100%;padding:9px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:8px;font-size:13px;resize:none;height:60px"></textarea>
        <select id="notif-target" style="width:100%;padding:9px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:10px;font-size:13px">
          <option value="all">All Users</option>
          <option value="customers">Customers Only</option>
          <option value="drivers">Drivers Only</option>
        </select>
        <button onclick="sendBroadcast()" style="width:100%;background:#1a1a2e;color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;font-weight:700;font-size:13px">📨 Send Notification</button>
        <div id="notif-status" style="font-size:13px;margin-top:8px"></div>
      </div>
    </div>
    <!-- Active Campaigns List -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-title">🗓️ Active Campaigns <button class="refresh-btn" onclick="loadCampaigns()">Reload</button></div>
      <div id="campaigns-list"><div class="loading">Loading...</div></div>
    </div>
    <!-- Promo Code Manager -->
    <div class="grid2" style="margin-bottom:20px">
      <div class="card">
        <div class="card-title">🎫 Create Promo Code</div>
        <input id="promo-code" placeholder="Code (e.g. RIDE50)" style="width:100%;padding:9px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:8px;font-size:13px;text-transform:uppercase">
        <select id="promo-type" style="width:100%;padding:9px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:8px;font-size:13px">
          <option value="flat">Flat Discount (₹)</option>
          <option value="percent">Percent Discount (%)</option>
        </select>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <input id="promo-value" type="number" placeholder="Discount value" style="flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px">
          <input id="promo-max" type="number" placeholder="Max discount (₹)" style="flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px">
        </div>
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <input id="promo-minfare" type="number" placeholder="Min fare (₹)" style="flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px">
          <input id="promo-limit" type="number" placeholder="Usage limit" style="flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px">
        </div>
        <button onclick="createPromo()" style="width:100%;background:#4CAF50;color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;font-weight:700;font-size:13px">➕ Add Promo Code</button>
        <div id="promo-create-status" style="font-size:13px;color:#4CAF50;margin-top:8px"></div>
      </div>
      <div class="card">
        <div class="card-title">📋 All Promo Codes <button class="refresh-btn" onclick="loadPromos()">Reload</button></div>
        <div id="promos-list"><div class="loading">Loading...</div></div>
      </div>
    </div>
    <!-- Referral Analytics -->
    <div class="card">
      <div class="card-title">👥 Referral Analytics <button class="refresh-btn" onclick="loadReferrals()">Reload</button></div>
      <div id="referral-stats" style="margin-bottom:14px"></div>
      <div style="overflow-x:auto"><table id="referral-table"><thead><tr><th>Date</th><th>Referrer</th><th>Referred</th><th>Reward</th></tr></thead><tbody id="referral-body"><tr><td colspan=4 class=loading>Loading...</td></tr></tbody></table></div>
    </div>
  </div>

  <div id="settings" class="section">
    <div class="grid2">
      <div class="card">
        <div class="card-title">⚡ Surge Pricing</div>
        <p style="font-size:13px;color:#666;margin-bottom:12px">Current multiplier is applied to all new rides/hourly bookings</p>
        <div style="display:flex;gap:10px;margin-bottom:10px">
          <input id="surge-input" type="number" step="0.1" min="1" max="3" value="1.0" style="flex:1;padding:10px;border:1px solid #e0e0e0;border-radius:8px;font-size:14px">
          <button onclick="setSurge()" style="background:#e94560;color:#fff;border:none;border-radius:8px;padding:10px 16px;cursor:pointer;font-weight:700">Set Surge</button>
        </div>
        <div id="surge-status" style="font-size:13px;color:#4CAF50"></div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button onclick="document.getElementById('surge-input').value=1.0;setSurge()" style="flex:1;background:#f5f5f5;border:none;border-radius:8px;padding:8px;cursor:pointer;font-size:12px;font-weight:700">1.0x Normal</button>
          <button onclick="document.getElementById('surge-input').value=1.5;setSurge()" style="flex:1;background:#fff3e0;border:none;border-radius:8px;padding:8px;cursor:pointer;font-size:12px;font-weight:700">1.5x Surge</button>
          <button onclick="document.getElementById('surge-input').value=2.0;setSurge()" style="flex:1;background:#ffebee;border:none;border-radius:8px;padding:8px;cursor:pointer;font-size:12px;font-weight:700">2.0x Peak</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">📋 Hourly Fare Editor</div>
        <p style="font-size:13px;color:#666;margin-bottom:12px">Update fare for specific vehicle + package (changes apply instantly)</p>
        <select id="fare-vehicle" style="width:100%;padding:9px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:8px;font-size:13px">
          <option value="auto">Auto</option><option value="bike">Bike</option><option value="car">Car</option><option value="eriksha">E-Riksha</option>
        </select>
        <select id="fare-hours" style="width:100%;padding:9px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:8px;font-size:13px">
          <option value="2">2 Hours</option><option value="4">4 Hours</option><option value="6">6 Hours</option><option value="8">Full Day (8h)</option>
          <option value="24">1 Day (24h)</option><option value="48">2 Days (48h)</option><option value="72">3 Days (72h)</option>
        </select>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <input id="fare-amount" type="number" placeholder="Fare (₹)" style="flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px">
          <input id="fare-km" type="number" placeholder="KM included" style="flex:1;padding:9px;border:1px solid #e0e0e0;border-radius:8px;font-size:13px">
        </div>
        <button onclick="updateFare()" style="width:100%;background:#1a1a2e;color:#fff;border:none;border-radius:8px;padding:10px;cursor:pointer;font-weight:700;font-size:13px">Update Fare</button>
        <div id="fare-status" style="font-size:13px;color:#4CAF50;margin-top:8px"></div>
      </div>
    </div>
    <div class="card" style="margin-top:0">
      <div class="card-title">📊 Current Hourly Fares</div>
      <div id="fares-display" style="font-size:13px;color:#666">Loading...</div>
    </div>
  </div>
</div>
<script>
const API = '';
function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  event.target.classList.add('active');
  if (id==='customers' && document.getElementById('cust-body').children[0]?.colSpan) loadCustomers();
  if (id==='drivers' && document.getElementById('drv-body').children[0]?.colSpan) loadDrivers();
  if (id==='topups' && document.getElementById('topup-body').children[0]?.colSpan) loadTopups();
  if (id==='settings') loadFares();
  if (id==='marketing') { loadCampaigns(); loadPromos(); loadReferrals(); }
}
function fmt(d){return new Date(d).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
function rupee(n){return '₹'+parseFloat(n||0).toFixed(0)}

async function loadDashboard() {
  const d = await fetch(API+'/api/admin/dashboard').then(r=>r.json());
  document.getElementById('stats-grid').innerHTML = \`
    <div class="stat-card red"><div class="stat-icon">👥</div><div class="stat-value">\${d.customers}</div><div class="stat-label">Total Customers</div></div>
    <div class="stat-card"><div class="stat-icon">🚗</div><div class="stat-value">\${d.drivers.total}</div><div class="stat-label">Drivers · \${d.drivers.online} online</div></div>
    <div class="stat-card blue"><div class="stat-icon">🛺</div><div class="stat-value">\${d.rides.completed}</div><div class="stat-label">Completed Rides</div></div>
    <div class="stat-card green"><div class="stat-icon">💰</div><div class="stat-value">\${rupee(d.rides.gross_revenue)}</div><div class="stat-label">Gross Revenue</div></div>
    <div class="stat-card red"><div class="stat-icon">🏦</div><div class="stat-value">\${rupee(d.platform_commission)}</div><div class="stat-label">Platform Commission</div></div>
    <div class="stat-card"><div class="stat-icon">⏱️</div><div class="stat-value">\${d.hourly.completed}</div><div class="stat-label">Hourly Rides · \${rupee(d.hourly.revenue)}</div></div>
    <div class="stat-card blue"><div class="stat-icon">💳</div><div class="stat-value">\${rupee(d.topup_total)}</div><div class="stat-label">Total Topups</div></div>
    <div class="stat-card"><div class="stat-icon">👛</div><div class="stat-value">\${rupee(d.wallets.customer_total)}</div><div class="stat-label">Customer Wallets</div></div>
    <div class="stat-card green"><div class="stat-icon">🏧</div><div class="stat-value">\${rupee(d.wallets.driver_total)}</div><div class="stat-label">Driver Wallets</div></div>
  \`;
}
async function loadTransactions() {
  const d = await fetch(API+'/api/admin/all-transactions?limit=200').then(r=>r.json());
  document.getElementById('txn-body').innerHTML = d.transactions.map(t=>\`<tr>
    <td>\${fmt(t.created_at)}</td><td>\${t.name||'-'}</td><td>\${t.phone}</td>
    <td><span class="badge-\${t.type}">\${t.type.toUpperCase()}</span></td>
    <td class="\${t.type==='credit'?'amount-green':'amount-red'}">\${rupee(t.amount)}</td>
    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="\${t.description}">\${t.description}</td>
  </tr>\`).join('');
}
async function loadCustomers() {
  const d = await fetch(API+'/api/admin/customers').then(r=>r.json());
  document.getElementById('cust-body').innerHTML = d.customers.map(c=>\`<tr>
    <td>\${c.name||'-'}</td><td>\${c.phone}</td><td>\${c.total_rides}</td>
    <td class="amount-green">\${rupee(c.wallet_balance)}</td>
    <td>\${fmt(c.created_at)}</td>
  </tr>\`).join('');
}
async function loadDrivers() {
  const d = await fetch(API+'/api/admin/drivers').then(r=>r.json());
  document.getElementById('drv-body').innerHTML = d.drivers.map(dr=>\`<tr>
    <td>\${dr.name||'-'}</td><td>\${dr.phone}</td>
    <td>\${dr.vehicle_type} · \${dr.vehicle_no||'-'}</td>
    <td><span class="chip \${dr.is_online?'online':'offline'}">\${dr.is_online?'🟢 Online':'⚫ Offline'}</span></td>
    <td class="amount-green">\${rupee(dr.balance)}</td>
    <td class="amount-green">\${rupee(dr.total_earned)}</td>
  </tr>\`).join('');
}
async function loadTopups() {
  const d = await fetch(API+'/api/admin/topups').then(r=>r.json());
  document.getElementById('topup-body').innerHTML = d.topups.map(t=>\`<tr>
    <td>\${fmt(t.created_at)}</td><td>\${t.user_phone}</td>
    <td class="amount-green">\${rupee(t.amount)}</td>
    <td style="font-family:monospace;font-size:11px">\${t.payment_id||'—'}</td>
    <td><span class="badge-\${t.status}">\${t.status}</span></td>
    <td>\${t.status==='unverified'?'<button class=verify-btn onclick=verifyTopup('+t.id+')>✓ Verify</button>':''}</td>
  </tr>\`).join('');
}
async function verifyTopup(id) {
  await fetch(API+'/api/admin/topups/verify/'+id, {method:'POST'});
  loadTopups();
}
async function setSurge() {
  const m = parseFloat(document.getElementById('surge-input').value);
  const d = await fetch(API+'/api/admin/surge', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({multiplier:m})}).then(r=>r.json());
  document.getElementById('surge-status').textContent = d.success ? \`✅ Surge set to \${d.surge}x\` : '❌ '+d.error;
}
async function updateFare() {
  const v = document.getElementById('fare-vehicle').value;
  const h = parseInt(document.getElementById('fare-hours').value);
  const fare = parseInt(document.getElementById('fare-amount').value);
  const km = parseInt(document.getElementById('fare-km').value);
  const d = await fetch(API+'/api/admin/hourly-fares', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vehicle_type:v,package_hours:h,fare,km})}).then(r=>r.json());
  document.getElementById('fare-status').textContent = d.success ? \`✅ Updated: ₹\${d.updated.fare}, \${d.updated.km}km\` : '❌ '+d.error;
  loadFares();
}
async function loadFares() {
  const d = await fetch(API+'/api/hourly/fares').then(r=>r.json());
  document.getElementById('surge-input').value = d.surge || 1.0;
  const vehicles = Object.keys(d.fares);
  const pkgs = [2,4,6,8,24,48,72];
  let html = \`<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="padding:8px;background:#f5f5f5;text-align:left">Vehicle</th>\${pkgs.map(p=>\`<th style="padding:8px;background:#f5f5f5;text-align:center">\${p>=24?p/24+'d':p+'h'}</th>\`).join('')}<th style="padding:8px;background:#f5f5f5;text-align:center">Extra/km</th></tr></thead><tbody>\`;
  vehicles.forEach(v => {
    html += \`<tr><td style="padding:8px;font-weight:700;text-transform:capitalize">\${v}</td>\`;
    pkgs.forEach(p => {
      const pkg = d.fares[v][p];
      html += pkg ? \`<td style="padding:8px;text-align:center">₹\${pkg.fare}<br><span style="color:#888;font-size:10px">\${pkg.km}km</span></td>\` : '<td style="padding:8px;text-align:center;color:#ccc">—</td>';
    });
    html += \`<td style="padding:8px;text-align:center">₹\${d.fares[v].extra}/km</td></tr>\`;
  });
  html += '</tbody></table></div>';
  document.getElementById('fares-display').innerHTML = html;
}
async function createCampaign() {
  const title = document.getElementById('camp-title').value.trim();
  const body = document.getElementById('camp-body').value.trim();
  const target = document.getElementById('camp-target').value;
  const type = document.getElementById('camp-type').value;
  const promo_code = document.getElementById('camp-promo').value.trim() || null;
  const cta_label = document.getElementById('camp-cta').value.trim() || null;
  const expires_at = document.getElementById('camp-expires').value || null;
  if (!title) { document.getElementById('camp-status').textContent = '❌ Title zaroori hai'; return; }
  const d = await fetch(API+'/api/admin/campaigns', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,body,target,type,promo_code,cta_label,expires_at})}).then(r=>r.json());
  document.getElementById('camp-status').textContent = d.success ? '✅ Campaign launch ho gaya!' : '❌ '+d.error;
  if (d.success) { document.getElementById('camp-title').value=''; document.getElementById('camp-body').value=''; loadCampaigns(); }
}
async function loadCampaigns() {
  const d = await fetch(API+'/api/admin/campaigns').then(r=>r.json());
  const now = new Date();
  document.getElementById('campaigns-list').innerHTML = d.campaigns.length ? d.campaigns.map(c => \`
    <div style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:10px;background:\${c.active?'#f8f9fa':'#fff'};margin-bottom:8px;border:1px solid #f0f0f0">
      <div style="flex:1">
        <div style="font-weight:700;font-size:14px">\${c.title}</div>
        <div style="font-size:12px;color:#666;margin-top:2px">\${c.body||''}</div>
        <div style="font-size:11px;color:#aaa;margin-top:4px">Target: \${c.target} · Type: \${c.type}\${c.promo_code?' · Code: '+c.promo_code:''}\${c.expires_at?' · Expires: '+fmt(c.expires_at):' · No expiry'}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <span style="background:\${c.active?'#e8f5e9':'#f5f5f5'};color:\${c.active?'#2e7d32':'#999'};padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700">\${c.active?'ACTIVE':'PAUSED'}</span>
        <button onclick="toggleCampaign(\${c.id})" style="background:\${c.active?'#fff3e0':'#e8f5e9'};color:\${c.active?'#e65100':'#2e7d32'};border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:11px;font-weight:700">\${c.active?'Pause':'Resume'}</button>
        <button onclick="deleteCampaign(\${c.id})" style="background:#ffebee;color:#c62828;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:11px;font-weight:700">Delete</button>
      </div>
    </div>
  \`).join('') : '<div style="text-align:center;color:#bbb;padding:20px">Koi campaign nahi</div>';
}
async function toggleCampaign(id) {
  await fetch(API+'/api/admin/campaigns/toggle/'+id, {method:'POST'});
  loadCampaigns();
}
async function deleteCampaign(id) {
  if (!confirm('Delete this campaign?')) return;
  await fetch(API+'/api/admin/campaigns/'+id, {method:'DELETE'});
  loadCampaigns();
}
async function sendBroadcast() {
  const title = document.getElementById('notif-title').value.trim();
  const body = document.getElementById('notif-body').value.trim();
  const target = document.getElementById('notif-target').value;
  if (!title || !body) { document.getElementById('notif-status').textContent = '❌ Title aur body zaroori hai'; return; }
  document.getElementById('notif-status').textContent = '⏳ Bhej raha hai...';
  document.getElementById('notif-status').style.color = '#e65100';
  const d = await fetch(API+'/api/admin/notify-all', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,body,target})}).then(r=>r.json());
  document.getElementById('notif-status').textContent = d.success ? \`✅ Bheja! Target: \${d.total_targets} users\` : '❌ '+d.error;
  document.getElementById('notif-status').style.color = d.success ? '#2e7d32' : '#c62828';
}
async function createPromo() {
  const code = document.getElementById('promo-code').value.toUpperCase().trim();
  const discount_type = document.getElementById('promo-type').value;
  const discount_value = parseFloat(document.getElementById('promo-value').value) || 0;
  const max_discount = parseFloat(document.getElementById('promo-max').value) || null;
  const min_fare = parseFloat(document.getElementById('promo-minfare').value) || 0;
  const usage_limit = parseInt(document.getElementById('promo-limit').value) || null;
  if (!code || !discount_value) { document.getElementById('promo-create-status').textContent = '❌ Code aur discount zaroori hai'; return; }
  const d = await fetch(API+'/api/admin/promos', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,discount_type,discount_value,max_discount,min_fare,usage_limit})}).then(r=>r.json());
  document.getElementById('promo-create-status').textContent = d.success ? '✅ Promo create ho gaya!' : '❌ '+d.error;
  if (d.success) loadPromos();
}
async function loadPromos() {
  const d = await fetch(API+'/api/admin/promos').then(r=>r.json());
  document.getElementById('promos-list').innerHTML = d.promos.length ? \`<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr><th style="padding:7px;background:#f5f5f5">Code</th><th style="padding:7px;background:#f5f5f5">Type</th><th style="padding:7px;background:#f5f5f5">Value</th><th style="padding:7px;background:#f5f5f5">Used</th><th style="padding:7px;background:#f5f5f5">Status</th><th style="padding:7px;background:#f5f5f5">Action</th></tr></thead>
    <tbody>\${d.promos.map(p=>\`<tr>
      <td style="padding:7px;font-weight:700;font-family:monospace">\${p.code}</td>
      <td style="padding:7px">\${p.discount_type==='flat'?'Flat ₹':'%'}</td>
      <td style="padding:7px">\${p.discount_type==='flat'?'₹':''}\${p.discount_value}\${p.discount_type==='percent'?'%':''}</td>
      <td style="padding:7px">\${p.used_count||0}\${p.usage_limit?'/'+p.usage_limit:''}</td>
      <td style="padding:7px"><span style="background:\${p.active?'#e8f5e9':'#ffebee'};color:\${p.active?'#2e7d32':'#c62828'};padding:2px 8px;border-radius:8px;font-size:10px;font-weight:700">\${p.active?'ACTIVE':'OFF'}</span></td>
      <td style="padding:7px"><button onclick="togglePromo('\${p.code}',\${!p.active})" style="background:#f5f5f5;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px">\${p.active?'Disable':'Enable'}</button></td>
    </tr>\`).join('')}</tbody></table>\` : '<div style="color:#bbb;padding:20px;text-align:center">Koi promo nahi</div>';
}
async function togglePromo(code, active) {
  await fetch(API+'/api/admin/promos/toggle', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,active})});
  loadPromos();
}
async function loadReferrals() {
  const d = await fetch(API+'/api/admin/referrals').then(r=>r.json());
  document.getElementById('referral-stats').innerHTML = \`
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <div style="background:#e8f5e9;border-radius:10px;padding:12px 20px;text-align:center"><div style="font-size:22px;font-weight:800;color:#2e7d32">\${d.total}</div><div style="font-size:11px;color:#666">Total Referrals</div></div>
      <div style="background:#e8f5e9;border-radius:10px;padding:12px 20px;text-align:center"><div style="font-size:22px;font-weight:800;color:#2e7d32">\${d.completed}</div><div style="font-size:11px;color:#666">Completed</div></div>
      <div style="background:#fff3e0;border-radius:10px;padding:12px 20px;text-align:center"><div style="font-size:22px;font-weight:800;color:#e65100">\${rupee(d.total_reward)}</div><div style="font-size:11px;color:#666">Total Rewarded</div></div>
    </div>
  \`;
  document.getElementById('referral-body').innerHTML = d.recent.map(r=>\`<tr>
    <td>\${fmt(r.created_at)}</td>
    <td>\${r.referrer_name||'-'} (\${r.referrer_phone})</td>
    <td>\${r.referred_name||'-'} (\${r.referred_phone})</td>
    <td class="amount-green">\${rupee(r.reward_amount)}</td>
  </tr>\`).join('');
}
async function loadAll() {
  document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString('en-IN');
  await loadDashboard();
  await loadTransactions();
}
loadAll();
</script>
</body>
</html>`);
});

// ══════════════════════════════════════════════════
//  ADMIN: Hourly Fares + Surge Control
// ══════════════════════════════════════════════════

app.get('/api/hourly/fares', (req, res) => res.json({ fares: HOURLY_FARES, surge: SURGE_MULTIPLIER }));

app.post('/api/admin/hourly-fares', (req, res) => {
  const { vehicle_type, package_hours, fare, km } = req.body;
  if (!HOURLY_FARES[vehicle_type]) return res.status(400).json({ error: 'Invalid vehicle type' });
  if (!HOURLY_FARES[vehicle_type][package_hours]) HOURLY_FARES[vehicle_type][package_hours] = {};
  if (fare) HOURLY_FARES[vehicle_type][package_hours].fare = fare;
  if (km) HOURLY_FARES[vehicle_type][package_hours].km = km;
  res.json({ success: true, updated: HOURLY_FARES[vehicle_type][package_hours] });
});

app.post('/api/admin/surge', (req, res) => {
  const { multiplier } = req.body;
  if (!multiplier || multiplier < 1 || multiplier > 3) return res.status(400).json({ error: '1.0 to 3.0 ke beech rakho' });
  SURGE_MULTIPLIER = parseFloat(multiplier);
  res.json({ success: true, surge: SURGE_MULTIPLIER });
});

// ══════════════════════════════════════════════════
//  DRIVER: Daily Bonus System
// ══════════════════════════════════════════════════
const BONUS_TIERS = [
  { rides: 5,  bonus: 30,  tier: 1 },
  { rides: 10, bonus: 50,  tier: 2 },
  { rides: 15, bonus: 100, tier: 3 },
];

app.get('/api/driver/bonus-today', async (req, res) => {
  const { phone } = req.query;
  try {
    const rides = await db.query(
      `SELECT COUNT(*) as cnt FROM rides r JOIN users u ON r.driver_id=u.id WHERE u.phone=$1 AND r.status='completed' AND DATE(r.created_at)=CURRENT_DATE`,
      [phone]
    );
    const ridesCount = parseInt(rides.rows[0].cnt);
    const claimed = await db.query(
      `SELECT bonus_tier FROM driver_bonus_claims WHERE driver_phone=$1 AND claim_date=CURRENT_DATE`,
      [phone]
    );
    const claimedTiers = claimed.rows.map(r => r.bonus_tier);
    const available = BONUS_TIERS.filter(t => ridesCount >= t.rides && !claimedTiers.includes(t.tier));
    const next = BONUS_TIERS.find(t => ridesCount < t.rides);
    res.json({ rides_today: ridesCount, available_bonuses: available, claimed_tiers: claimedTiers, next_target: next || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/driver/bonus-claim', async (req, res) => {
  const { phone, tier } = req.body;
  const tierInfo = BONUS_TIERS.find(t => t.tier === tier);
  if (!tierInfo) return res.status(400).json({ error: 'Invalid tier' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const rides = await client.query(
      `SELECT COUNT(*) as cnt FROM rides r JOIN users u ON r.driver_id=u.id WHERE u.phone=$1 AND r.status='completed' AND DATE(r.created_at)=CURRENT_DATE`,
      [phone]
    );
    if (parseInt(rides.rows[0].cnt) < tierInfo.rides) { await client.query('ROLLBACK'); return res.json({ success: false, error: `${tierInfo.rides} rides chahiye` }); }
    await client.query(
      `INSERT INTO driver_bonus_claims (driver_phone, claim_date, rides_at_claim, bonus_tier, bonus_amount) VALUES ($1, CURRENT_DATE, $2, $3, $4)`,
      [phone, parseInt(rides.rows[0].cnt), tier, tierInfo.bonus]
    );
    const u = await client.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (u.rows[0]) {
      await client.query('UPDATE driver_wallet SET balance=balance+$1, total_earned=total_earned+$1 WHERE driver_id=$2', [tierInfo.bonus, u.rows[0].id]);
      await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Daily bonus reward')", [u.rows[0].id, tierInfo.bonus]);
    }
    await client.query('COMMIT');
    res.json({ success: true, bonus_amount: tierInfo.bonus, message: `₹${tierInfo.bonus} bonus wallet mein add ho gaya!` });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.json({ success: false, error: 'Is tier ka bonus aaj already claim hua' });
    res.status(500).json({ error: err.message });
  }
  finally { client.release(); }
});

// ══════════════════════════════════════════════════
//  CUSTOMER: Loyalty Points System
// ══════════════════════════════════════════════════
app.get('/api/loyalty/my-points', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) return res.json({ points: 0, redeemed: 0, rides: 0 });
    const userId = user.rows[0].id;
    await db.query('INSERT INTO customer_loyalty (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const loyalty = await db.query('SELECT total_points, total_redeemed FROM customer_loyalty WHERE user_id=$1', [userId]);
    const rides = await db.query(`SELECT COUNT(*) as cnt FROM rides WHERE passenger_id=$1 AND status='completed'`, [userId]);
    const pts = loyalty.rows[0] || { total_points: 0, total_redeemed: 0 };
    res.json({ points: parseInt(pts.total_points), redeemed: parseInt(pts.total_redeemed), rides: parseInt(rides.rows[0].cnt), cashback_available: Math.floor(parseInt(pts.total_points) / 100) * 10 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auto-add loyalty points after ride payment (call this from payment-complete)
const addLoyaltyPoints = async (userId, points) => {
  try {
    await db.query('INSERT INTO customer_loyalty (user_id, total_points) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET total_points=customer_loyalty.total_points+$2, updated_at=NOW()', [userId, points]);
  } catch (_e) {}
};

// ══════════════════════════════════════════════════
//  START SERVER ─────────────────────────────────────
// ══════════════════════════════════════════════════

// ── Start Server ────────────────────────────────
server.listen(process.env.PORT, '0.0.0.0', () => {
  console.log('🚀 Server running on port ' + process.env.PORT);
});

// ── Graceful Shutdown ────────────────────────────
async function shutdown() {
  console.log('⏳ Graceful shutdown started...');
  try { await rideWorker.close(); } catch (_e) {}
  try { await rideQueue.close(); } catch (_e) {}
  server.close(() => {
    console.log('✅ Server closed cleanly');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000); // Force exit after 10s
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);