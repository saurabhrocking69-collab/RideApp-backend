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
const adminRouter      = require('./routes/admin');
const favouritesRouter = require('./routes/favourites');
const complaintsRouter = require('./routes/complaints');

// ── App + HTTP + Socket.io ───────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000, // ping every 10s (default 25s) — keeps mobile connections alive through NAT
  pingTimeout:  5000,  // 5s to respond (default 20s) — detect dead connections faster
});

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
app.use('/api/admin',      adminAuth, adminRouter);
app.use('/api/favourites', favouritesRouter);
app.use('/api/complaints', complaintsRouter);

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

// ── Critical tables — created immediately, no delay ──────────────────────────
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ride_id INTEGER REFERENCES rides(id) ON DELETE SET NULL,
        filed_by INTEGER NOT NULL REFERENCES users(id),
        filed_against INTEGER NOT NULL REFERENCES users(id),
        filer_role VARCHAR(10) NOT NULL CHECK (filer_role IN ('customer','driver')),
        complaint_type VARCHAR(50) NOT NULL,
        title VARCHAR(200) NOT NULL,
        description TEXT NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','under_review','awaiting_response','evidence_requested','escalated','resolved','closed','appealed')),
        priority VARCHAR(10) NOT NULL DEFAULT 'normal'
          CHECK (priority IN ('low','normal','high','urgent')),
        assigned_admin VARCHAR(100),
        resolution VARCHAR(30)
          CHECK (resolution IN ('favor_complainant','favor_respondent','partial','inconclusive','withdrawn')),
        resolution_note TEXT,
        action_taken VARCHAR(50),
        resolved_at TIMESTAMPTZ,
        source VARCHAR(30) DEFAULT 'manual',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS complaint_messages (
        id SERIAL PRIMARY KEY,
        complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
        sender_id INTEGER REFERENCES users(id),
        sender_role VARCHAR(10) NOT NULL,
        sender_name VARCHAR(100),
        message TEXT NOT NULL,
        is_internal BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS complaint_evidence (
        id SERIAL PRIMARY KEY,
        complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
        uploaded_by INTEGER NOT NULL REFERENCES users(id),
        file_url TEXT NOT NULL,
        file_type VARCHAR(20) DEFAULT 'image',
        caption TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS complaint_timeline (
        id SERIAL PRIMARY KEY,
        complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
        event VARCHAR(50) NOT NULL,
        description TEXT NOT NULL,
        actor_role VARCHAR(10),
        actor_name VARCHAR(100),
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_complaints_filed_by      ON complaints(filed_by)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_complaints_filed_against  ON complaints(filed_against)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_complaints_status         ON complaints(status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_complaint_msgs_cid        ON complaint_messages(complaint_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_complaint_tl_cid          ON complaint_timeline(complaint_id)`);
    await db.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'manual'`);
    console.log('✅ Complaint tables ready (immediate)');
  } catch (e) {
    console.error('❌ Complaint table init error:', e.message);
  }
})();

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
  // offered_phones tracks which drivers were already sent this ride request — skip on surge rebuild
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS offered_phones TEXT[] DEFAULT '{}'`).catch(() => {});
  // Early completion + payment skip tracking columns
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS early_completion BOOLEAN DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_lat_at_complete FLOAT`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_lng_at_complete FLOAT`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS completion_dist_from_drop FLOAT`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS payment_not_received BOOLEAN DEFAULT FALSE`).catch(() => {});
  // Customer account control columns
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_score INTEGER DEFAULT 100`).catch(() => {});
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_restricted BOOLEAN DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_restricted_reason TEXT`).catch(() => {});
  // Driver metrics strike count
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS strike_count INTEGER DEFAULT 0`).catch(() => {});
  // Source column on complaints (manual vs system_auto vs driver_report)
  await db.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'manual'`).catch(() => {});
  // Ride incidents table — all system-detected events
  await db.query(`
    CREATE TABLE IF NOT EXISTS ride_incidents (
      id SERIAL PRIMARY KEY,
      ride_id INTEGER REFERENCES rides(id) ON DELETE SET NULL,
      incident_type VARCHAR(50) NOT NULL,
      detected_by VARCHAR(10) NOT NULL DEFAULT 'system',
      driver_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      metadata JSONB,
      resolved BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_incidents_ride_id ON ride_incidents(ride_id)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_incidents_customer ON ride_incidents(customer_id)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_incidents_driver ON ride_incidents(driver_id)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_incidents_type ON ride_incidents(incident_type)`).catch(() => {});
  console.log('✅ DB indexes ready');

  // ── Complaint system tables ───────────────────────
  const complaintTables = [
    `CREATE TABLE IF NOT EXISTS complaints (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ride_id INTEGER REFERENCES rides(id) ON DELETE SET NULL,
      filed_by INTEGER NOT NULL REFERENCES users(id),
      filed_against INTEGER NOT NULL REFERENCES users(id),
      filer_role VARCHAR(10) NOT NULL CHECK (filer_role IN ('customer','driver')),
      complaint_type VARCHAR(50) NOT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','under_review','awaiting_response','evidence_requested','escalated','resolved','closed','appealed')),
      priority VARCHAR(10) NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low','normal','high','urgent')),
      assigned_admin VARCHAR(100),
      resolution VARCHAR(30)
        CHECK (resolution IN ('favor_complainant','favor_respondent','partial','inconclusive','withdrawn')),
      resolution_note TEXT,
      action_taken VARCHAR(50),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS complaint_evidence (
      id SERIAL PRIMARY KEY,
      complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      uploaded_by INTEGER NOT NULL REFERENCES users(id),
      file_url TEXT NOT NULL,
      file_type VARCHAR(20) DEFAULT 'image',
      caption TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS complaint_messages (
      id SERIAL PRIMARY KEY,
      complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id),
      sender_role VARCHAR(10) NOT NULL,
      sender_name VARCHAR(100),
      message TEXT NOT NULL,
      is_internal BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS complaint_timeline (
      id SERIAL PRIMARY KEY,
      complaint_id UUID NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
      event VARCHAR(50) NOT NULL,
      description TEXT NOT NULL,
      actor_role VARCHAR(10),
      actor_name VARCHAR(100),
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_filed_by ON complaints(filed_by)`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_filed_against ON complaints(filed_against)`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status)`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_ride_id ON complaints(ride_id)`,
    `CREATE INDEX IF NOT EXISTS idx_complaint_msgs_cid ON complaint_messages(complaint_id)`,
    `CREATE INDEX IF NOT EXISTS idx_complaint_tl_cid ON complaint_timeline(complaint_id)`,
    `CREATE INDEX IF NOT EXISTS idx_complaint_ev_cid ON complaint_evidence(complaint_id)`,
  ];
  for (const sql of complaintTables) await db.query(sql).catch((e) => console.error('Complaint table error:', e.message));
  console.log('✅ Complaint tables ready');

  // Ensure green_bike, electric_auto, luxury have fare_settings rows
  await db.query(`
    INSERT INTO fare_settings (vehicle_type, base_fare, per_km_rate, night_multiplier)
    VALUES
      ('green_bike',    12,  6, 1.2),
      ('electric_auto', 20,  9, 1.3),
      ('luxury',        80, 25, 2.0)
    ON CONFLICT (vehicle_type) DO NOTHING
  `).catch(() => {});

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
