const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const { Server } = require('socket.io');
const rateLimit  = require('express-rate-limit');
const { createAdapter } = require('@socket.io/redis-adapter');

// ── Config singletons ────────────────────────────
require('./config/db');
const { redis }         = require('./config/redis');
const socketConfig      = require('./config/socket');
require('./config/firebase');
require('./config/cloudinary');

// ── Workers (starts BullMQ on import) ────────────
const { rideQueue, assignRideToNextDriver } = require('./workers/rideWorker');

// ── Services ────────────────────────────────────
const { driverLocations } = require('./services/matching');
const db                  = require('./config/db');

// ── Middleware ───────────────────────────────────
const adminAuth = require('./middleware/adminAuth');

// ── Routes ───────────────────────────────────────
const authRouter    = require('./routes/auth');
const callRouter    = require('./routes/call');
const chatRouter    = require('./routes/chat');
const promoRouter   = require('./routes/promo');
const referralRouter = require('./routes/referral');
const miscRouter    = require('./routes/misc');
const walletRouter  = require('./routes/wallet');
const paymentsRouter = require('./routes/payments');
const ridesRouter   = require('./routes/rides');
const driversRouter = require('./routes/drivers');
const hourlyRouter  = require('./routes/hourly');
const adminRouter   = require('./routes/admin');

// ── App + HTTP + Socket.io ───────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

socketConfig.init(io);

// ── Redis adapter for Socket.io (multi-instance) ─
redis.on('ready', async () => {
  console.log('✅ Redis connected!');
  try {
    const subClient = redis.duplicate();
    await subClient.connect();
    io.adapter(createAdapter(redis, subClient));
    console.log('✅ Socket.io Redis adapter ready');
  } catch (e) {
    console.log('⚠️ Socket.io Redis adapter failed:', e.message);
  }
});

// ── Core middleware ──────────────────────────────
app.use(cors());
app.use(express.json({ limit: '12mb' }));

// ── Rate limiting ────────────────────────────────
app.use('/api/auth/send-otp', rateLimit({
  windowMs: 60_000, max: 3,
  message: { error: 'Bahut zyada attempts! 1 minute baad try karo' },
}));
app.use('/api/', rateLimit({
  windowMs: 60_000, max: 400,
  message: { error: 'Too many requests, slow down' },
}));

// ── Health ───────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: Date.now() })
);

// ── Upload (needs /api/upload, not /api/driver/upload) ──
const cloudinary = require('./config/cloudinary');
app.post('/api/upload', async (req, res) => {
  const { image } = req.body;
  try {
    if (!image) return res.status(400).json({ error: 'Image nahi mili' });
    const result = await cloudinary.uploader.upload(image, { folder: 'rideapp_drivers', resource_type: 'image' });
    res.json({ success: true, url: result.secure_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Route mounts ─────────────────────────────────
app.use('/api/auth',     authRouter);
app.use('/api/call',     callRouter);
app.use('/api/chat',     chatRouter);
app.use('/api/promo',    promoRouter);
app.use('/api/referral', referralRouter);
app.use('/api',          miscRouter);      // /api/fare-settings, /api/sos, etc.
app.use('/api/wallet',   walletRouter);
app.use('/api/payment',  paymentsRouter);
app.use('/api/rides',    ridesRouter);
app.use('/api/driver',   driversRouter);
app.use('/api/hourly',   hourlyRouter);
app.use('/api/admin',    adminAuth, adminRouter);

// Admin portal HTML
app.get('/admin', (_req, res) =>
  res.sendFile(__dirname + '/admin-portal.html')
);

// ── Socket.io events ─────────────────────────────
io.on('connection', (socket) => {
  socket.on('joinRide',    ({ rideId })    => socket.join('ride_' + rideId));
  socket.on('joinHourly',  ({ bookingId }) => socket.join('hourly_' + bookingId));
  socket.on('driverJoin',  ({ phone })     => socket.join('driver_' + phone));
  socket.on('driverOnline',({ driverId })  => socket.join('driver_' + driverId));

  socket.on('locationUpdate', ({ driverId, lat, lng, rideId }) => {
    if (rideId) {
      io.to('ride_' + rideId).emit('driverMoved', { lat, lng });
    } else {
      socket.broadcast.emit('driverMoved_' + driverId, { lat, lng });
    }
  });
});

// ── Startup tasks ────────────────────────────────
setTimeout(async () => {
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_rides_status            ON rides(status)`,
    `CREATE INDEX IF NOT EXISTS idx_rides_driver_id         ON rides(driver_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rides_passenger_id      ON rides(passenger_id)`,
    `CREATE INDEX IF NOT EXISTS idx_rides_assigned_phone    ON rides(assigned_to_phone)`,
    `CREATE INDEX IF NOT EXISTS idx_rides_created_at        ON rides(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_driver_locations_phone  ON driver_locations(phone)`,
    `CREATE INDEX IF NOT EXISTS idx_driver_locations_geocell ON driver_locations(geocell)`,
    `CREATE INDEX IF NOT EXISTS idx_drivers_online          ON drivers(is_online, verification_status)`,
    `CREATE INDEX IF NOT EXISTS idx_driver_metrics_phone    ON driver_metrics(phone)`,
    `CREATE INDEX IF NOT EXISTS idx_hourly_customer_phone   ON hourly_bookings(customer_phone, status)`,
    `CREATE INDEX IF NOT EXISTS idx_hourly_driver_phone     ON hourly_bookings(driver_phone, status)`,
  ];
  for (const sql of indexes) await db.query(sql).catch(() => {});
  console.log('✅ DB indexes ready');

  try {
    const stuck = await db.query(
      `SELECT id, pickup_lat, pickup_lng, ride_type FROM rides WHERE status='requested' AND driver_id IS NULL`
    );
    for (const r of stuck.rows) {
      await rideQueue.add('ride-assignment', {
        type: 'assign-next', rideId: r.id, pickupLat: r.pickup_lat, pickupLng: r.pickup_lng,
        rideType: r.ride_type, queue: null, radiusKm: 5,
      });
    }
    if (stuck.rows.length) console.log(`✅ Re-queued ${stuck.rows.length} stuck rides`);
  } catch (_e) {}
}, 3000);

// ── Cron: auto-cancel stale rides (every 1 min) ──
setInterval(async () => {
  try {
    await db.query(
      `UPDATE rides SET status='cancelled'
       WHERE status='requested' AND driver_id IS NULL
       AND created_at < NOW() - INTERVAL '15 minutes'`
    );
  } catch (_e) {}
}, 60_000);

// ── Cron: cleanup stale in-memory driver locations (every 5 min) ──
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const phone of Object.keys(driverLocations)) {
    if (driverLocations[phone].updated < cutoff) delete driverLocations[phone];
  }
}, 5 * 60 * 1000);

// ── Start server ─────────────────────────────────
server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('🚀 Server running on port ' + (process.env.PORT || 3000));
});

// ── Graceful shutdown ────────────────────────────
async function shutdown() {
  console.log('⚡ Shutting down...');
  server.close();
  await db.end().catch(() => {});
  await redis.disconnect().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
