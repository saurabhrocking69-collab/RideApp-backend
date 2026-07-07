const express      = require('express');
const cors         = require('cors');
const compression  = require('compression');
const http         = require('http');
const { Server }   = require('socket.io');
const rateLimit    = require('express-rate-limit');
const { createAdapter } = require('@socket.io/redis-adapter');

// ── Config singletons ────────────────────────────
require('./config/db');
const { redis }         = require('./config/redis');
const socketConfig      = require('./config/socket');
const { sendFCM } = require('./config/firebase');
require('./config/cloudinary');

// ── Workers (starts BullMQ on import) ────────────
const { rideQueue, assignRideToNextDriver } = require('./workers/rideWorker');

// ── Services ────────────────────────────────────
const { driverLocations } = require('./services/matching');
const { startLocationJobs } = require('./services/locationIntelligence');
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
const bonusRouter      = require('./routes/bonus');

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
app.use(compression());

// CRITICAL: Razorpay webhook needs raw Buffer for HMAC verification.
// Must be registered BEFORE express.json() consumes the stream.
app.post(
  '/api/payment/razorpay-webhook',
  express.raw({ type: 'application/json' }),
  require('./routes/payments').webhookHandler
);

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

// ── Live ride tracking page — shareable link for family/friends ───────────
app.get('/track/:rideId', (req, res) => {
  const { rideId } = req.params;
  const BACKEND = process.env.BACKEND_URL || 'https://rideapp-backend-production-5e1c.up.railway.app';
  res.type('html').send(`<!DOCTYPE html>
<html lang="hi">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
  <meta name="theme-color" content="#0F172A"/>
  <title>Sppero Live Tracking</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0F172A;color:#fff;overflow:hidden}
    #app{display:flex;flex-direction:column;height:100vh}
    /* ── Top bar ── */
    #topbar{background:linear-gradient(135deg,#E91E63,#9C27B0);padding:14px 16px 12px;display:flex;align-items:center;gap:12;z-index:1000;box-shadow:0 4px 20px rgba(233,30,99,0.35)}
    #topbar .logo{font-size:20px;font-weight:900;letter-spacing:0.5px}
    #topbar .logo span{font-size:11px;font-weight:500;opacity:0.8;display:block;margin-top:1px}
    #status-pill{margin-left:auto;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:0.5px}
    .pill-searching{background:rgba(255,255,255,0.2);color:#fff}
    .pill-en-route{background:#16A34A;color:#fff}
    .pill-arrived{background:#F59E0B;color:#000}
    .pill-completed{background:#334155;color:#94A3B8}
    /* ── Map ── */
    #map{flex:1;z-index:1}
    /* ── Bottom panel ── */
    #panel{background:#1E293B;padding:16px;border-top:1px solid rgba(255,255,255,0.06);z-index:1000}
    #panel .driver-row{display:flex;align-items:center;gap:12;margin-bottom:12px}
    #panel .avatar{width:44px;height:44px;border-radius:14px;background:linear-gradient(135deg,#E91E63,#9C27B0);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0}
    #panel .driver-info{}
    #panel .driver-name{font-size:15px;font-weight:800;color:#F1F5F9}
    #panel .vehicle-info{font-size:12px;color:#64748B;margin-top:2px}
    #panel .route{display:flex;flex-direction:column;gap:6px}
    .route-item{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#94A3B8;line-height:1.4}
    .route-dot{width:8px;height:8px;border-radius:50%;margin-top:3px;flex-shrink:0}
    .dot-green{background:#4ADE80}
    .dot-pink{background:#F472B6}
    #no-driver{color:#64748B;font-size:13px;text-align:center;padding:8px 0}
    /* ── Loading overlay ── */
    #loading{position:fixed;inset:0;background:#0F172A;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:9999}
    .spinner{width:40px;height:40px;border:3px solid rgba(233,30,99,0.2);border-top-color:#E91E63;border-radius:50%;animation:spin 0.8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    #loading p{color:#64748B;font-size:13px}
    /* ── Driver marker ── */
    .driver-pin{background:linear-gradient(135deg,#E91E63,#9C27B0);color:#fff;border-radius:12px;padding:5px 10px;font-size:18px;font-weight:900;box-shadow:0 4px 16px rgba(233,30,99,0.5);white-space:nowrap;border:2px solid rgba(255,255,255,0.3)}
    .pickup-pin,.drop-pin{background:#fff;border-radius:50%;width:14px;height:14px;border:3px solid #E91E63;box-shadow:0 2px 8px rgba(0,0,0,0.3)}
    .drop-pin{border-color:#16A34A}
  </style>
</head>
<body>
<div id="loading"><div class="spinner"></div><p>Loading live tracking...</p></div>
<div id="app" style="display:none">
  <div id="topbar">
    <div class="logo">🚖 Sppero<span>Live Tracking</span></div>
    <div id="status-pill" class="pill-searching">Searching...</div>
  </div>
  <div id="map"></div>
  <div id="panel">
    <div id="driver-section">
      <div id="no-driver">Driver assign hone ka wait kar rahe hain...</div>
    </div>
    <div class="route" id="route-section" style="display:none">
      <div class="route-item"><div class="route-dot dot-green"></div><div id="pickup-text"></div></div>
      <div class="route-item"><div class="route-dot dot-pink"></div><div id="drop-text"></div></div>
    </div>
  </div>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
const RIDE_ID  = ${JSON.stringify(rideId)};
const API_BASE = ${JSON.stringify(BACKEND)};

const VEHICLE_EMOJI = { bike:'🏍️', auto:'🛺', car:'🚕', eriksha:'🛵', green_bike:'⚡', electric_auto:'🌿', luxury:'🚙', ultra_luxury:'🚙' };

let map, driverMarker, pickupMarker, dropMarker;
let rideData = null;

// ── Init Leaflet map ──────────────────────────────────────────────────────
function initMap(lat, lng) {
  map = L.map('map', { zoomControl: false, attributionControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.setView([lat || 26.84, lng || 80.94], 14);
}

// ── Custom map icons ──────────────────────────────────────────────────────
function driverIcon(emoji) {
  return L.divIcon({ html: '<div class="driver-pin">' + emoji + '</div>', className: '', iconAnchor: [24, 20] });
}
const greenDot = L.divIcon({ html: '<div class="pickup-pin"></div>', className: '', iconAnchor: [7, 7] });
const pinkDot  = L.divIcon({ html: '<div class="drop-pin"></div>',   className: '', iconAnchor: [7, 7] });

// ── Status pill helper ────────────────────────────────────────────────────
function setStatus(status) {
  const pill = document.getElementById('status-pill');
  const labels = { requested:'🔍 Searching', accepted:'🚗 En Route', arrived:'⏳ Arrived', active:'🛣️ In Ride', completed:'✅ Done', cancelled:'❌ Cancelled' };
  const classes = { requested:'pill-searching', accepted:'pill-en-route', arrived:'pill-arrived', active:'pill-en-route', completed:'pill-completed', cancelled:'pill-completed' };
  pill.textContent = labels[status] || status;
  pill.className = 'status-pill ' + (classes[status] || 'pill-searching');
}

// ── Update driver info panel ──────────────────────────────────────────────
function renderDriver(data) {
  const sec = document.getElementById('driver-section');
  if (!data.driver) { sec.innerHTML = '<div id="no-driver">Driver assign hone ka wait kar rahe hain...</div>'; return; }
  const emoji = VEHICLE_EMOJI[data.rideType] || '🚖';
  sec.innerHTML = \`<div class="driver-row">
    <div class="avatar">\${emoji}</div>
    <div class="driver-info">
      <div class="driver-name">\${data.driver.name}</div>
      <div class="vehicle-info">\${data.driver.vehicle || ''} • \${data.driver.vehicleNo}</div>
    </div>
  </div>\`;
}

// ── Fetch ride data + init ────────────────────────────────────────────────
fetch(API_BASE + '/api/rides/track-info/' + RIDE_ID)
  .then(r => r.json())
  .then(data => {
    rideData = data;
    document.getElementById('loading').style.display = 'none';
    document.getElementById('app').style.display = 'flex';

    const lat = data.pickupLat || 26.84;
    const lng = data.pickupLng || 80.94;
    initMap(lat, lng);

    // Pickup marker
    if (data.pickupLat && data.pickupLng) {
      pickupMarker = L.marker([data.pickupLat, data.pickupLng], { icon: greenDot })
        .addTo(map).bindTooltip('📍 ' + (data.pickup || 'Pickup'), { permanent: false });
    }
    // Drop marker
    if (data.dropLat && data.dropLng) {
      dropMarker = L.marker([data.dropLat, data.dropLng], { icon: pinkDot })
        .addTo(map).bindTooltip('🎯 ' + (data.drop || 'Drop'), { permanent: false });
      // Fit both pins
      if (pickupMarker) {
        map.fitBounds([[data.pickupLat, data.pickupLng], [data.dropLat, data.dropLng]], { padding: [40, 40] });
      }
    }

    setStatus(data.status);
    renderDriver(data);

    // Route section
    if (data.pickup || data.drop) {
      document.getElementById('route-section').style.display = 'flex';
      document.getElementById('pickup-text').textContent = data.pickup || '';
      document.getElementById('drop-text').textContent   = data.drop   || '';
    }

    connectSocket();
  })
  .catch(() => {
    document.getElementById('loading').innerHTML = '<p style="color:#EF4444;padding:20px;text-align:center">Ride track nahi ho pa rahi. Link expire ho gaya hoga.</p>';
  });

// ── Socket.io — real-time driver location ─────────────────────────────────
function connectSocket() {
  const socket = io(API_BASE, { transports: ['websocket', 'polling'] });
  socket.on('connect', () => {
    socket.emit('joinRide', { rideId: RIDE_ID });
  });
  socket.on('driverMoved', ({ lat, lng }) => {
    const latlng = [parseFloat(lat), parseFloat(lng)];
    const emoji = rideData ? (VEHICLE_EMOJI[rideData.rideType] || '🚖') : '🚖';
    if (driverMarker) {
      driverMarker.setLatLng(latlng);
    } else {
      driverMarker = L.marker(latlng, { icon: driverIcon(emoji) }).addTo(map);
    }
    // Smooth pan toward driver
    const center = map.getCenter();
    const dist = map.distance(center, latlng);
    if (dist > 500) map.panTo(latlng, { animate: true, duration: 1.2 });
  });
  // Keep attempting if disconnected
  socket.on('disconnect', () => setTimeout(() => socket.connect(), 3000));
}
</script>
</body>
</html>`);
});

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
app.use('/api/bonus',      bonusRouter);


// Admin portal HTML
app.get('/admin', (_req, res) =>
  res.sendFile(__dirname + '/admin-portal.html')
);

// ── Socket.io events ─────────────────────────────
function _haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

io.on('connection', (socket) => {
  socket.on('joinRide',    ({ rideId })    => socket.join('ride_' + rideId));
  socket.on('joinHourly',  ({ bookingId }) => socket.join('hourly_' + bookingId));

  // Per-connection Set: prevents re-delivering the same offer on repeated driverJoin calls
  // (screen transitions, reconnects) from the same socket. New connection = new Set = clean state.
  const _deliveredOffers = new Set();

  async function _redeliverIfPending(phone) {
    if (!phone) return;
    try {
      const r = await db.query(
        `SELECT id, GREATEST(0, EXTRACT(EPOCH FROM (assignment_expires_at - NOW()))::int) AS secs_left
         FROM rides WHERE assigned_to_phone=$1 AND status='requested' AND driver_id IS NULL
         AND assignment_expires_at > NOW()`,
        [phone]
      );
      if (r.rows[0] && parseInt(r.rows[0].secs_left) > 2) {
        const rideId = r.rows[0].id;
        if (!_deliveredOffers.has(rideId)) {
          _deliveredOffers.add(rideId);
          socket.emit('newRideAssigned', { rideId, secondsToAccept: parseInt(r.rows[0].secs_left) });
        }
      }
    } catch (_e) {}
  }

  socket.on('driverJoin',   async ({ phone })            => { socket.join('driver_' + phone); await _redeliverIfPending(phone); });
  socket.on('driverOnline', async ({ driverId, phone })  => { const p = phone || driverId; socket.join('driver_' + p); await _redeliverIfPending(p); });

  socket.on('locationUpdate', ({ driverId, lat, lng, rideId }) => {
    if (rideId) {
      io.to('ride_' + rideId).emit('driverMoved', { lat, lng });
    } else {
      socket.broadcast.emit('driverMoved_' + driverId, { lat, lng });
    }
  });

  // Driver-to-driver zone alerts — broadcast to all drivers within 3 km
  const _zoneAlertThrottle = new Map(); // phone → last sent timestamp (per-connection)
  socket.on('driverZoneAlert', ({ phone, lat, lng, alertType, message }) => {
    if (!phone || lat == null || lng == null || !alertType) return;
    // Rate-limit: max 1 alert per 30 seconds per driver
    const now = Date.now();
    if (now - (_zoneAlertThrottle.get(phone) || 0) < 30_000) {
      socket.emit('zoneAlertSent', { count: 0, rateLimited: true });
      return;
    }
    _zoneAlertThrottle.set(phone, now);
    const RADIUS_KM = 3;
    let count = 0;
    for (const [driverPhone, loc] of Object.entries(driverLocations)) {
      if (driverPhone === phone) continue;
      const dist = _haversineKm(parseFloat(lat), parseFloat(lng), loc.lat, loc.lng);
      if (dist <= RADIUS_KM) {
        io.to('driver_' + driverPhone).emit('zoneAlertReceived', {
          from: '**' + String(phone).slice(-4),
          alertType,
          message: (message || '').slice(0, 100),
          distKm: Math.round(dist * 10) / 10,
          sentAt: new Date().toISOString(),
        });
        count++;
      }
    }
    socket.emit('zoneAlertSent', { count });
    console.log(`📢 Zone alert "${alertType}" from ${phone} → ${count} nearby drivers`);
  });
});

// ── Critical tables — created immediately, no delay ──────────────────────────
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id               SERIAL PRIMARY KEY,
        ride_id          TEXT,
        filed_by         TEXT NOT NULL,
        filed_against    TEXT NOT NULL,
        filer_role       VARCHAR(20) NOT NULL,
        complaint_type   VARCHAR(60) NOT NULL,
        title            TEXT NOT NULL,
        description      TEXT NOT NULL,
        priority         VARCHAR(20) NOT NULL DEFAULT 'normal',
        status           VARCHAR(30) NOT NULL DEFAULT 'open',
        source           VARCHAR(30) NOT NULL DEFAULT 'manual',
        resolution       TEXT,
        resolution_note  TEXT,
        action_taken     TEXT,
        assigned_admin   TEXT,
        refund_amount    NUMERIC(10,2) DEFAULT 0,
        resolved_at      TIMESTAMP,
        created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS complaint_messages (
        id             SERIAL PRIMARY KEY,
        complaint_id   INTEGER NOT NULL,
        sender_id      TEXT,
        sender_role    VARCHAR(20),
        sender_name    VARCHAR(100),
        message        TEXT NOT NULL,
        is_internal    BOOLEAN NOT NULL DEFAULT FALSE,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS complaint_evidence (
        id             SERIAL PRIMARY KEY,
        complaint_id   INTEGER NOT NULL,
        uploaded_by    TEXT,
        file_url       TEXT NOT NULL,
        caption        TEXT,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS complaint_timeline (
        id             SERIAL PRIMARY KEY,
        complaint_id   INTEGER NOT NULL,
        event          VARCHAR(60),
        description    TEXT,
        actor_role     VARCHAR(20),
        actor_name     VARCHAR(100),
        metadata       TEXT,
        created_at     TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_complaints_filed_by      ON complaints(filed_by)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_complaints_filed_against  ON complaints(filed_against)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_complaints_status         ON complaints(status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_complaint_msgs_cid        ON complaint_messages(complaint_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_complaint_tl_cid          ON complaint_timeline(complaint_id)`);
    await db.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'manual'`).catch(() => {});
    await db.query(`ALTER TABLE complaint_messages ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
    await db.query(`ALTER TABLE complaint_messages ADD COLUMN IF NOT EXISTS sender_role VARCHAR(20)`).catch(() => {});
    await db.query(`ALTER TABLE complaint_messages ADD COLUMN IF NOT EXISTS sender_name VARCHAR(100)`).catch(() => {});
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
  // ── BullMQ matching columns (were only in server.old.js; now idempotent here too) ─────────
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS assigned_to_phone VARCHAR(20) DEFAULT NULL`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS assignment_expires_at TIMESTAMP DEFAULT NULL`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS assignment_queue JSONB DEFAULT '[]'`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS offered_phones TEXT[] DEFAULT '{}'`).catch(() => {});
  // driver_metrics scoring columns (added by add-cancellation.js; must also exist here)
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS acceptance_rate DECIMAL(5,2) DEFAULT 100`).catch(() => {});
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS cancellation_rate DECIMAL(5,2) DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP`).catch(() => {});
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS cancels_today INT DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS last_cancel_date DATE`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS customer_rating INT`).catch(() => {});
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_rating NUMERIC(3,1)`).catch(() => {});
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
  // driver_wallet: pending_commission was missing from original CREATE TABLE
  await db.query(`ALTER TABLE driver_wallet ADD COLUMN IF NOT EXISTS pending_commission NUMERIC(10,2) DEFAULT 0`).catch(() => {});
  // Source column on complaints (manual vs system_auto vs driver_report)
  await db.query(`ALTER TABLE complaints ADD COLUMN IF NOT EXISTS source VARCHAR(30) DEFAULT 'manual'`).catch(() => {});
  // Hourly booking extension columns (trip extension feature)
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS extend_requested_hours DECIMAL`).catch(() => {});
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS extend_escrow DECIMAL DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS extend_total_minutes INTEGER DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS extend_total_fare DECIMAL DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS pending_customer_confirm BOOLEAN DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS dispute_raised BOOLEAN DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS early_end_reject_count INTEGER DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS early_end_last_rejected_at TIMESTAMP`).catch(() => {});
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS km_alert_sent BOOLEAN DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS time_alert_sent BOOLEAN DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS early_end_requested_by VARCHAR(20)`).catch(() => {});
  // Ride incidents table — all system-detected events
  await db.query(`
    CREATE TABLE IF NOT EXISTS ride_incidents (
      id SERIAL PRIMARY KEY,
      ride_id TEXT,
      incident_type VARCHAR(50) NOT NULL,
      detected_by VARCHAR(10) NOT NULL DEFAULT 'system',
      driver_id TEXT,
      customer_id TEXT,
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
      id               SERIAL PRIMARY KEY,
      ride_id          TEXT,
      filed_by         TEXT NOT NULL,
      filed_against    TEXT NOT NULL,
      filer_role       VARCHAR(20) NOT NULL,
      complaint_type   VARCHAR(60) NOT NULL,
      title            TEXT NOT NULL,
      description      TEXT NOT NULL,
      priority         VARCHAR(20) NOT NULL DEFAULT 'normal',
      status           VARCHAR(30) NOT NULL DEFAULT 'open',
      source           VARCHAR(30) NOT NULL DEFAULT 'manual',
      resolution       TEXT,
      resolution_note  TEXT,
      action_taken     TEXT,
      assigned_admin   TEXT,
      refund_amount    NUMERIC(10,2) DEFAULT 0,
      resolved_at      TIMESTAMP,
      created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS complaint_messages (
      id             SERIAL PRIMARY KEY,
      complaint_id   INTEGER NOT NULL,
      sender_id      TEXT,
      sender_role    VARCHAR(20),
      sender_name    VARCHAR(100),
      message        TEXT NOT NULL,
      is_internal    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at     TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS complaint_evidence (
      id             SERIAL PRIMARY KEY,
      complaint_id   INTEGER NOT NULL,
      uploaded_by    TEXT,
      file_url       TEXT NOT NULL,
      caption        TEXT,
      created_at     TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS complaint_timeline (
      id             SERIAL PRIMARY KEY,
      complaint_id   INTEGER NOT NULL,
      event          VARCHAR(60),
      description    TEXT,
      actor_role     VARCHAR(20),
      actor_name     VARCHAR(100),
      metadata       TEXT,
      created_at     TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_filed_by      ON complaints(filed_by)`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_filed_against  ON complaints(filed_against)`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_status         ON complaints(status)`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_ride_id        ON complaints(ride_id)`,
    `CREATE INDEX IF NOT EXISTS idx_complaint_msgs_cid        ON complaint_messages(complaint_id)`,
    `CREATE INDEX IF NOT EXISTS idx_complaint_tl_cid          ON complaint_timeline(complaint_id)`,
    `CREATE INDEX IF NOT EXISTS idx_complaint_ev_cid          ON complaint_evidence(complaint_id)`,
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

  // ── Bonus System Tables ───────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS bonus_rules (
      id SERIAL PRIMARY KEY,
      vehicle_type VARCHAR(30) DEFAULT 'all',
      bonus_type VARCHAR(30) NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      label VARCHAR(100) NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      is_active BOOLEAN DEFAULT true,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS bonus_wallet (
      driver_phone VARCHAR(15) PRIMARY KEY,
      balance NUMERIC(10,2) DEFAULT 0,
      total_earned NUMERIC(10,2) DEFAULT 0,
      total_redeemed NUMERIC(10,2) DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS bonus_ledger (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      driver_phone VARCHAR(15) NOT NULL,
      rule_id INT REFERENCES bonus_rules(id) ON DELETE SET NULL,
      bonus_type VARCHAR(30),
      amount NUMERIC(10,2) NOT NULL,
      description VARCHAR(200),
      ref_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS bonus_claims_guard (
      driver_phone VARCHAR(15),
      rule_id INT,
      ref_key VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (driver_phone, rule_id, ref_key)
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_bonus_ledger_phone ON bonus_ledger(driver_phone, ref_date)`).catch(() => {});

  // Seed default bonus rules if none exist
  const ruleCount = await db.query(`SELECT COUNT(*) FROM bonus_rules`).catch(() => ({ rows: [{ count: '1' }] }));
  if (parseInt(ruleCount.rows[0].count) === 0) {
    const defaults = [
      { vehicle_type: 'two_wheeler',   bonus_type: 'daily_rides',   label: 'Daily Ride Challenge — Bike',
        config: { tiers: [{ rides: 4, amount: 20 }, { rides: 8, amount: 50 }, { rides: 12, amount: 90 }] },
        description: 'Bike/Green Bike drivers ke liye daily ride targets' },
      { vehicle_type: 'three_wheeler', bonus_type: 'daily_rides',   label: 'Daily Ride Challenge — Auto',
        config: { tiers: [{ rides: 4, amount: 25 }, { rides: 8, amount: 60 }, { rides: 12, amount: 110 }] },
        description: 'Auto/E-Auto drivers ke liye daily ride targets' },
      { vehicle_type: 'four_wheeler',  bonus_type: 'daily_rides',   label: 'Daily Ride Challenge — Car',
        config: { tiers: [{ rides: 3, amount: 40 }, { rides: 6, amount: 100 }, { rides: 10, amount: 180 }] },
        description: 'Car/Taxi/Premium drivers ke liye daily ride targets' },
      { vehicle_type: 'all',           bonus_type: 'peak_hour',     label: 'Peak Hour Bonus',
        config: { per_ride: 8, slots: [{ start: 7, end: 9 }, { start: 17, end: 20 }] },
        description: '7-9 AM aur 5-8 PM mein har completed ride pe automatic bonus' },
      { vehicle_type: 'all',           bonus_type: 'weekly_streak', label: 'Weekly Warrior',
        config: { target_days: 5, rides_per_day: 4, amount: 250 },
        description: 'Hafte mein 5 din, har din 4+ rides — streak bonus claim karo' },
    ];
    for (const r of defaults) {
      await db.query(
        `INSERT INTO bonus_rules (vehicle_type, bonus_type, config, label, description) VALUES ($1,$2,$3,$4,$5)`,
        [r.vehicle_type, r.bonus_type, JSON.stringify(r.config), r.label, r.description]
      ).catch(() => {});
    }
    console.log('✅ Default bonus rules seeded');
  }
  console.log('✅ Bonus system tables ready');

  // ── Customer Cashback Events Table ──────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS cashback_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      ride_id UUID REFERENCES rides(id) ON DELETE SET NULL,
      rule_type VARCHAR(30) NOT NULL,
      amount NUMERIC(8,2) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, ride_id, rule_type)
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cashback_user ON cashback_events(user_id, created_at)`).catch(() => {});
  console.log('✅ Cashback events table ready');

  // ── Chat Messages Table (standard + hourly, ride_id prefixed with 'h_' for hourly) ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         BIGSERIAL PRIMARY KEY,
      ride_id    TEXT NOT NULL,
      sender     TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_chat_ride ON chat_messages(ride_id, created_at)`).catch(() => {});
  console.log('✅ Chat messages table ready');

  // ── Reward Settings Table (admin-configurable amounts) ──────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS reward_settings (
      key        VARCHAR(60) PRIMARY KEY,
      value      NUMERIC(10,2) NOT NULL,
      label      TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`
    INSERT INTO reward_settings (key, value, label) VALUES
      ('referral_reward',   50, 'Referral Reward (₹ to both referrer & referred)'),
      ('scratch_card_min',   1, 'Scratch Card Min Amount (₹)'),
      ('scratch_card_max',   5, 'Scratch Card Max Amount (₹)')
    ON CONFLICT (key) DO NOTHING
  `).catch(() => {});
  console.log('✅ Reward settings table ready');

  // ── driver_payouts: ensure table exists with Razorpay columns ────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS driver_payouts (
      id                      SERIAL PRIMARY KEY,
      driver_phone            VARCHAR(20),
      amount                  DECIMAL(10,2),
      bank_account            VARCHAR(50),
      bank_ifsc               VARCHAR(20),
      bank_holder             VARCHAR(100),
      upi_id                  VARCHAR(100),
      method                  VARCHAR(20) DEFAULT 'bank',
      status                  VARCHAR(20) DEFAULT 'pending',
      admin_note              TEXT,
      transaction_ref         VARCHAR(100),
      requested_at            TIMESTAMP DEFAULT NOW(),
      settled_at              TIMESTAMP,
      razorpay_payout_id      VARCHAR(100),
      razorpay_status         VARCHAR(30),
      razorpay_fund_account_id VARCHAR(100),
      commission_deducted     DECIMAL(10,2) DEFAULT 0
    )
  `).catch(() => {});
  for (const col of [
    'razorpay_payout_id      VARCHAR(100)',
    'razorpay_status         VARCHAR(30)',
    'razorpay_fund_account_id VARCHAR(100)',
    'commission_deducted     DECIMAL(10,2) DEFAULT 0',
  ]) {
    await db.query(`ALTER TABLE driver_payouts ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
  }
  console.log('✅ Driver payouts table ready');

  // ── razorpay_topups: idempotency guard for wallet top-ups ────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS razorpay_topups (
      id          SERIAL PRIMARY KEY,
      user_phone  VARCHAR(15) NOT NULL,
      amount      DECIMAL(10,2) NOT NULL,
      payment_id  VARCHAR(100) UNIQUE NOT NULL,
      status      VARCHAR(20) NOT NULL DEFAULT 'confirmed',
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_razorpay_topups_payment ON razorpay_topups(payment_id)`).catch(() => {});
  console.log('✅ razorpay_topups table ready');

  // ── driver_commission_payments: track driver commission Razorpay payments ─────
  await db.query(`
    CREATE TABLE IF NOT EXISTS driver_commission_payments (
      id           SERIAL PRIMARY KEY,
      driver_phone VARCHAR(15) NOT NULL,
      amount       DECIMAL(10,2) NOT NULL,
      payment_id   VARCHAR(100) NOT NULL,
      status       VARCHAR(20) NOT NULL DEFAULT 'initiated',
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_dcp_phone ON driver_commission_payments(driver_phone)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_dcp_payment ON driver_commission_payments(payment_id)`).catch(() => {});
  console.log('✅ driver_commission_payments table ready');

  try {
    const stuck = await db.query(
      `SELECT id, pickup_lat, pickup_lng, ride_type FROM rides
       WHERE status='requested' AND driver_id IS NULL
         AND (assigned_to_phone IS NULL OR assignment_expires_at < NOW())`
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
    const stale = await db.query(
      `UPDATE rides SET status='cancelled'
       WHERE status='requested' AND driver_id IS NULL
       AND created_at < NOW() - INTERVAL '15 minutes'
       RETURNING id, passenger_id`
    );
    for (const row of stale.rows) {
      try {
        const u = await db.query('SELECT phone FROM users WHERE id=$1', [row.passenger_id]);
        if (u.rows[0]) {
          sendFCM(u.rows[0].phone, '😔 Driver Nahi Mila', 'Koi driver available nahi — thodi der baad try karo.', { type: 'no_driver_found', ride_id: String(row.id) }, { role: 'customer' }).catch(() => {});
          emitToRoom('ride_' + row.id, 'rideUpdate', { rideId: row.id, status: 'cancelled', reason: 'no_driver' });
        }
      } catch (_e) {}
    }
  } catch (_e) {}
}, 60_000);

// ── Cron: cleanup stale in-memory driver locations (every 5 min) ──
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const phone of Object.keys(driverLocations)) {
    if (driverLocations[phone].updated < cutoff) delete driverLocations[phone];
  }
}, 5 * 60 * 1000);

// ── Cron: scheduled ride reminders (every 60s) ───
// Ensure reminder_sent column exists (safe to run at startup)
db.query(`ALTER TABLE scheduled_rides ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT FALSE`).catch(() => {});

setInterval(async () => {
  try {
    // Find scheduled rides whose time is 14–16 minutes away and haven't been notified yet
    const due = await db.query(
      `SELECT * FROM scheduled_rides
       WHERE status = 'pending'
         AND reminder_sent = FALSE
         AND scheduled_at BETWEEN NOW() + INTERVAL '14 minutes' AND NOW() + INTERVAL '16 minutes'`
    );
    for (const ride of due.rows) {
      const timeStr = new Date(ride.scheduled_at).toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
      // Notify customer
      await sendFCM(
        ride.customer_phone,
        '🚖 Aapki ride 15 minute mein!',
        `${timeStr} baje ki ride ke liye ready ho jao — ${ride.pickup} se ${ride.drop_location}`,
        { type: 'scheduled_ride_reminder', rideId: String(ride.id) },
        { channelId: 'default', role: 'customer' }
      );
      // Mark reminder sent so it doesn't fire again
      await db.query(`UPDATE scheduled_rides SET reminder_sent = TRUE WHERE id = $1`, [ride.id]);
      console.log(`⏰ Scheduled ride reminder sent → ${ride.customer_phone} (ride #${ride.id} at ${timeStr})`);
    }
  } catch (_e) {}
}, 60_000);

// ── Start server ─────────────────────────────────
server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('🚀 Server running on port ' + (process.env.PORT || 3000));
  startLocationJobs();
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
