const express      = require('express');
const cors         = require('cors');
const http         = require('http');
const { Server }   = require('socket.io');
const { Pool }     = require('pg');
const { createClient } = require('redis');
const jwt          = require('jsonwebtoken');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ── PostgreSQL ──────────────────────────────────
const db = new Pool({ 
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: process.env.DATABASE_PUBLIC_URL ? { rejectUnauthorized: false } : false
});
db.connect()
  .then(() => console.log('✅ PostgreSQL connected!'))
  .catch(err => console.log('❌ PostgreSQL error:', err.message));

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
    user = await db.query(
      "INSERT INTO users (phone, name, role) VALUES ($1, $2, 'passenger') RETURNING *",
      [phone, name || 'User']
    );
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
  const { passenger_phone, pickup, drop_location, ride_type } = req.body;
  try {
    const passenger = await db.query(
      'SELECT * FROM users WHERE phone = $1', [passenger_phone]
    );
    if (passenger.rows.length === 0)
      return res.status(404).json({ error: 'Passenger nahi mila' });

    const rates    = { auto: 12, bike: 8, taxi: 18 };
    const base     = { auto: 25, bike: 20, taxi: 40 };
    const distance = req.body.distance || 5;
    const fare     = Math.round(base[ride_type] + (distance * rates[ride_type]));

    console.log('Distance:', distance, 'km | Fare: ₹' + fare);

    const ride = await db.query(
      "INSERT INTO rides (passenger_id, pickup, drop_location, ride_type, fare, status) VALUES ($1, $2, $3, $4, $5, 'searching') RETURNING *",
      [passenger.rows[0].id, pickup, drop_location, ride_type, fare]
    );

    const driver = await db.query(
      `SELECT u.name, u.phone, d.vehicle_no, d.vehicle_type, d.id 
 FROM drivers d JOIN users u ON d.id = u.id 
 WHERE (d.is_online = false OR d.is_online IS NULL) LIMIT 1`
      
    );

    if (driver.rows.length === 0) {
      return res.json({
        message: 'Ride booked! Driver dhundh rahe hain...',
        ride: ride.rows[0],
        fare: '₹' + fare,
        distance: distance + ' km'
      });
    }

    await db.query(
      "UPDATE rides SET driver_id = $1, status = 'matched' WHERE id = $2",
      [driver.rows[0].id, ride.rows[0].id]
    );

    res.json({
      message:  'Driver mil gaya!',
      fare:     '₹' + fare,
      distance: distance + ' km',
      driver: {
        name:       driver.rows[0].name,
        phone:      driver.rows[0].phone,
        vehicle_no: driver.rows[0].vehicle_no
      },
      ride_id: ride.rows[0].id
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

// ── Driver Pending Ride ─────────────────────────
app.get('/api/driver/pending-ride', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(
      `SELECT r.* FROM rides r
       JOIN users u ON r.driver_id = u.id
       WHERE u.phone = $1 AND r.status = 'matched'
       ORDER BY r.created_at DESC LIMIT 1`,
      [phone]
    );
    if (result.rows.length > 0) {
      res.json({ ride: result.rows[0] });
    } else {
      res.json({ ride: null });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Driver Accept Ride ──────────────────────────
app.post('/api/rides/accept', async (req, res) => {
  const { ride_id, driver_phone } = req.body;
  try {
    await db.query(
      `UPDATE rides SET status = 'started' WHERE id = $1`,
      [ride_id]
    );
    res.json({ success: true, message: 'Ride accepted!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start Server ────────────────────────────────
server.listen(process.env.PORT, '0.0.0.0', () => {
  console.log('🚀 Server running on port ' + process.env.PORT);
})