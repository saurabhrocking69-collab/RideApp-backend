const express      = require('express');
const cors         = require('cors');
const http         = require('http');
const { Server }   = require('socket.io');
const { Pool }     = require('pg');
const { createClient } = require('redis');
const jwt          = require('jsonwebtoken');

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

// ── PostgreSQL ──────────────────────────────────
const db = new Pool({ 
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: process.env.DATABASE_PUBLIC_URL ? { rejectUnauthorized: false } : false
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

// ── Redis ───────────────────────────────────────
const redis = createClient({ 
  url: process.env.REDIS_URL,
  socket: { tls: process.env.REDIS_URL?.includes('rediss') }
});
redis.connect();
redis.on('ready', () => console.log('✅ Redis connected!'));
redis.on('error', (err) => console.log('❌ Redis error:', err.message));

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
  res.json({ message: '🚖 RideApp backend chal raha hai!' });
});

app.get('/test-db', async (req, res) => {
  const result = await db.query('SELECT COUNT(*) FROM users');
  res.json({ users_count: result.rows[0].count });
});

// ── OTP Send ────────────────────────────────────
app.post('/api/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number do' });
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  await redis.setEx('otp:' + phone, 300, otp);
  console.log('📱 OTP for ' + phone + ': ' + otp);
  res.json({ message: 'OTP bheja gaya', otp });
});

// ── OTP Verify ──────────────────────────────────
app.post('/api/auth/verify-otp', async (req, res) => {
  const { phone, otp, name } = req.body;
  const savedOtp = await redis.get('otp:' + phone);
  if (!savedOtp) return res.status(400).json({ error: 'OTP expire ho gaya' });
  if (savedOtp !== otp) return res.status(400).json({ error: 'Wrong OTP' });

  let user = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
  if (user.rows.length === 0) {
    // Naya user — register karo
    user = await db.query(
      "INSERT INTO users (phone, name, role) VALUES ($1, $2, 'passenger') RETURNING *",
      [phone, name || 'User']
    );
  } else {
    // Pehle se registered — naam update karo agar naya naam diya
    if (name && name.trim() !== '' && name !== 'Rider') {
      await db.query('UPDATE users SET name = $1 WHERE phone = $2', [name.trim(), phone]);
      user.rows[0].name = name.trim();
    }
  }
  await redis.del('otp:' + phone);
  const token = jwt.sign(
    { id: user.rows[0].id, phone },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({ message: 'Login successful!', token, user: user.rows[0] });
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

// ── Ride Book ───────────────────────────────────
app.post('/api/rides/book', async (req, res) => {
  const { passenger_phone, pickup, drop_location, ride_type, pickup_lat, pickup_lng, drop_lat, drop_lng, discount, promo_code } = req.body;
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
    const fareSettings = fareRes.rows[0] || { base_fare: 25, per_km_rate: 12, night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' };
    
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
    } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ride Complete ───────────────────────────────
app.post('/api/rides/complete', async (req, res) => {
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
  console.log('🔌 Connected:', socket.id);
  socket.on('driverOnline', ({ driverId }) => {
    socket.join('driver_' + driverId);
    console.log('🟢 Driver online:', driverId);
  });
  socket.on('locationUpdate', ({ driverId, lat, lng }) => {
    console.log('📍 Driver ' + driverId + ': ' + lat + ', ' + lng);
    io.emit('driverMoved_' + driverId, { lat, lng });
  });
  socket.on('disconnect', () => {
    console.log('🔴 Disconnected:', socket.id);
  });
});


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
  try {
    // Driver ID nikalo
    const driver = await db.query(
      'SELECT id FROM users WHERE phone = $1', [driver_phone]
    );
    if (driver.rows.length === 0)
      return res.status(404).json({ success: false, message: 'Driver nahi mila' });

    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    // Driver assign karo + status matched + OTP set karo
    await db.query(
      `UPDATE rides SET status = 'matched', start_otp = $1, driver_id = $2 WHERE id = $3`,
      [otp, driver.rows[0].id, ride_id]
    );
    res.json({ success: true, message: 'Ride accepted!', otp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Ride Status Check ───────────────────────────
app.get('/api/rides/status/:rideId', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.*, u.name as driver_name, u.phone as driver_phone,
              d.vehicle_no
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
    res.json({ success: true, message: 'Trip shuru!' });
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
      `SELECT w.driver_id, w.balance FROM driver_wallet w
       JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`,
      [phone]
    );
    if (driver.rows.length === 0) return res.status(404).json({ error: 'Driver nahi mila' });
    const balance = parseFloat(driver.rows[0].balance);

    if (balance < amount) {
      return res.json({ success: false, message: 'Balance kam hai', balance });
    }
    const result = await db.query(
      'UPDATE driver_wallet SET balance = balance - $1, total_withdrawn = total_withdrawn + $1 WHERE driver_id = $2 RETURNING balance',
      [amount, driver.rows[0].driver_id]
    );
    res.json({ success: true, balance: parseFloat(result.rows[0].balance), message: 'Payout request submitted!' });
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

// ── Driver Registration (Spero Buddy) ───────────────
app.post('/api/driver/register-buddy', async (req, res) => {
  const {
    phone, name, vehicle_type, vehicle_no,
    dl_name, dl_photo, vehicle_photo, rc_photo,
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
        `INSERT INTO drivers (id, vehicle_type, vehicle_no, dl_name, dl_photo,
            vehicle_photo, rc_photo, aadhaar_number, aadhaar_photo, face_photo,
            verification_status, is_online, rating)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',false,5.0)`,
        [userId, vehicle_type, vehicle_no || null, dl_name, dl_photo,
         vehicle_photo, rc_photo || null, aadhaar_number, aadhaar_photo, face_photo]
      );
    } else {
      await db.query(
        `UPDATE drivers SET vehicle_type=$2, vehicle_no=$3, dl_name=$4, dl_photo=$5,
            vehicle_photo=$6, rc_photo=$7, aadhaar_number=$8, aadhaar_photo=$9,
            face_photo=$10, verification_status='pending', admin_message=NULL
         WHERE id=$1`,
        [userId, vehicle_type, vehicle_no || null, dl_name, dl_photo,
         vehicle_photo, rc_photo || null, aadhaar_number, aadhaar_photo, face_photo]
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
              d.vehicle_type, d.vehicle_no, d.dl_name, d.dl_photo,
              d.vehicle_photo, d.rc_photo, d.aadhaar_number, d.aadhaar_photo,
              d.face_photo, d.verification_status, d.admin_message
       FROM drivers d
       JOIN users u ON d.id = u.id
       ORDER BY 
         CASE d.verification_status 
           WHEN 'pending' THEN 1 
           WHEN 'rejected' THEN 2 
           WHEN 'approved' THEN 3 
           ELSE 4 END,
         u.name`
    );
    res.json({ drivers: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: Approve / Reject / Suspend driver ────────
app.post('/api/admin/verify-driver', async (req, res) => {
  const { driver_id, status, message } = req.body;
  // status: 'approved' | 'rejected' | 'suspended'
  try {
    await db.query(
      'UPDATE drivers SET verification_status = $1, admin_message = $2 WHERE id = $3',
      [status, message || null, driver_id]
    );
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
      return res.json({ success: false, message: 'Yeh number registered nahi hai. Pehle Spero Buddy banein.' });
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

// Admin: Update fare settings
app.post('/api/admin/fare-settings', async (req, res) => {
  const { vehicle_type, base_fare, per_km_rate, night_multiplier, night_start, night_end } = req.body;
  try {
    await db.query(
      `UPDATE fare_settings 
       SET base_fare = $1, per_km_rate = $2, night_multiplier = $3,
           night_start = $4, night_end = $5, updated_at = NOW()
       WHERE vehicle_type = $6`,
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
    // Ride details lo
    const rideRes = await db.query(
      `SELECT *, EXTRACT(EPOCH FROM (NOW() - created_at)) AS seconds_since_book FROM rides WHERE id = $1`,
      [ride_id]
    );
    if (rideRes.rows.length === 0) return res.json({ success: false, message: 'Ride nahi mili' });
    const ride = rideRes.rows[0];
    const secondsAfterBook = Math.round(ride.seconds_since_book || 0);

    let penalty = 0;
    let message = 'Ride cancel ho gayi';

    // ─── CUSTOMER CANCEL ───
    if (cancelled_by === 'customer') {
      // Daily cancel count
      const today = new Date().toISOString().split('T')[0];
      let cm = await db.query('SELECT * FROM customer_metrics WHERE phone = $1', [phone]);
      if (cm.rows.length === 0) {
        await db.query('INSERT INTO customer_metrics (phone) VALUES ($1)', [phone]);
        cm = await db.query('SELECT * FROM customer_metrics WHERE phone = $1', [phone]);
      }
      let metrics = cm.rows[0];
      let cancelsToday = metrics.last_cancel_date && metrics.last_cancel_date.toISOString().split('T')[0] === today ? metrics.cancels_today : 0;

      // Penalty rules
      if (secondsAfterBook <= 60) {
        penalty = 0; message = 'Free cancellation (1 min ke andar)';
      } else if (ride.driver_id) {
        // Driver assign ho gaya tha
        if (cancelsToday >= 3) { penalty = 10; message = 'Cancel fee ₹10 (aaj 3 se zyada cancel)'; }
        else { penalty = ride.status === 'arrived' ? 15 : 10; message = `Cancel fee ₹${penalty}`; }
      }

      // Update customer metrics
      const newTrust = Math.max(0, (metrics.trust_score || 100) - (penalty > 0 ? 5 : 2));
      await db.query(
        `UPDATE customer_metrics SET total_cancels = total_cancels + 1, cancels_today = $1, last_cancel_date = $2, trust_score = $3, is_flagged = $4 WHERE phone = $5`,
        [cancelsToday + 1, today, newTrust, newTrust < 50, phone]
      );
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
        suspendedUntil = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours
        message = '⚠️ Bahut zyada cancel! 2 ghante suspend.';
      } else if (cancelRate > 15) {
        message = '⚠️ Warning: Cancel rate zyada hai, kam rides milengi';
      }

      await db.query(
        `UPDATE driver_metrics SET rides_cancelled = $1, cancels_today = $2, last_cancel_date = $3, cancellation_rate = $4, suspended_until = $5 WHERE phone = $6`,
        [totalCancelled, cancelsToday, today, cancelRate.toFixed(2), suspendedUntil, phone]
      );
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

// ─── Smart pending-ride (geohash + scoring + fairness) ───
app.get('/api/driver/pending-ride', async (req, res) => {
  const { phone } = req.query;
  try {
    // Suspension check
    const susp = await db.query('SELECT suspended_until FROM driver_metrics WHERE phone = $1', [phone]);
    if (susp.rows[0]?.suspended_until && new Date(susp.rows[0].suspended_until) > new Date()) {
      return res.json({ ride: null, suspended: true });
    }

    // Driver vehicle type + metrics
    const driverResult = await db.query(
      `SELECT d.vehicle_type, d.rating FROM drivers d JOIN users u ON d.id = u.id WHERE u.phone = $1`,
      [phone]
    );
    if (driverResult.rows.length === 0) return res.json({ ride: null });
    const vehicleType = driverResult.rows[0].vehicle_type;
    const driverRating = driverResult.rows[0].rating;

    // Driver metrics
    const dm = await db.query('SELECT * FROM driver_metrics WHERE phone = $1', [phone]);
    const metrics = dm.rows[0] || { acceptance_rate: 100, idle_since: new Date() };

    // Driver location + geocell
    const locRes = await db.query('SELECT lat, lng, geocell FROM driver_locations WHERE phone = $1', [phone]);
    const driverLoc = locRes.rows[0];

    // Matching unassigned rides
    const ridesRes = await db.query(
      `SELECT r.*, p.name AS passenger_name, p.phone AS passenger_phone
       FROM rides r JOIN users p ON r.passenger_id = p.id
       WHERE r.status = 'requested' AND r.driver_id IS NULL AND r.ride_type = $1
       ORDER BY r.created_at ASC`,
      [vehicleType]
    );
    if (ridesRes.rows.length === 0) return res.json({ ride: null });

    // Agar location nahi → oldest ride
    if (!driverLoc || !driverLoc.lat) return res.json({ ride: ridesRes.rows[0] });

    // Nearby cells of driver
    const nearbyCells = getNearbyCells(parseFloat(driverLoc.lat), parseFloat(driverLoc.lng));

    // Best ride pick karo — nearest within range
    let bestRide = null, minDist = Infinity;
    for (const ride of ridesRes.rows) {
      if (ride.pickup_lat && ride.pickup_lng) {
        const dist = haversineKm(parseFloat(driverLoc.lat), parseFloat(driverLoc.lng), parseFloat(ride.pickup_lat), parseFloat(ride.pickup_lng));
        if (dist < minDist && dist <= 5) { minDist = dist; bestRide = ride; }
      }
    }

    if (bestRide) {
      bestRide.distance_to_pickup = minDist.toFixed(1) + ' km';
      // Track offered
      await db.query(`INSERT INTO driver_metrics (phone, rides_offered) VALUES ($1, 1) ON CONFLICT (phone) DO UPDATE SET rides_offered = driver_metrics.rides_offered + 1`, [phone]);
      return res.json({ ride: bestRide });
    }

    // Koi nearby nahi → oldest fallback
    res.json({ ride: ridesRes.rows[0] });
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
    const f = fareRes.rows[0] || { base_fare: 25, per_km_rate: 12, night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' };
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
// ── Start Server ────────────────────────────────
server.listen(process.env.PORT, '0.0.0.0', () => {
  console.log('🚀 Server running on port ' + process.env.PORT);
})