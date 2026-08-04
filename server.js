// Log-and-continue, don't crash — this is a single-instance server with
// every active ride's socket connections living in this one process. Node's
// default for an unhandled rejection is to crash the whole process, which
// would drop every live ride/socket over one bug in an unrelated request or
// background job, not just fail that one thing. A crash here is strictly
// worse than one bad request failing, so we log loudly and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('❌ UNHANDLED REJECTION:', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ UNCAUGHT EXCEPTION:', err?.stack || err);
});

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
const { rideQueue, assignRideToNextDriver, broadcastToRadius } = require('./workers/rideWorker');

// ── Services ────────────────────────────────────
const { driverLocations, vehicleServesSql } = require('./services/matching');
const { startLocationJobs } = require('./services/locationIntelligence');
const db                  = require('./config/db');
const { clearRide: clearRideCache } = require('./services/rideCache');

// ── Middleware ───────────────────────────────────
const adminAuth = require('./middleware/adminAuth');
const { refundToWallet } = require('./services/advance');

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
const adminRouter        = require('./routes/admin');
const favouritesRouter   = require('./routes/favourites');
const bonusRouter        = require('./routes/bonus');
const supportRouter      = require('./routes/support');
const adminSupportRouter = require('./routes/adminSupport');
const healthCheck      = require('./services/healthCheck');

// ── Allowed browser origins (mobile apps don't send Origin, so this only gates web clients) ──
// When ALLOWED_ORIGINS is not set, all origins are allowed (admin key still required for admin routes).
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null;

const corsOptions = {
  origin: (origin, cb) => {
    // No origin = native mobile app / server-to-server / curl — allow
    if (!origin) return cb(null, true);
    // No allowlist configured → open (admin key guards sensitive endpoints)
    if (!ALLOWED_ORIGINS) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin not allowed — ${origin}`));
  },
  credentials: true,
};

// ── App + HTTP + Socket.io ───────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: corsOptions,
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
app.use(cors(corsOptions));
app.use(compression());

// CRITICAL: Razorpay webhook needs raw Buffer for HMAC verification.
// Must be registered BEFORE express.json() consumes the stream.
app.post(
  '/api/payment/razorpay-webhook',
  express.raw({ type: 'application/json' }),
  require('./routes/payments').webhookHandler
);

app.use(express.json({ limit: '12mb' }));

// Railway sits behind a reverse proxy — trust it so rate-limit IP detection works
app.set('trust proxy', 1);

// ── Rate limiting ────────────────────────────────
app.use('/api/auth/send-otp', rateLimit({
  windowMs: 60_000, max: 3,
  message: { error: 'Too many attempts! Please try again in 1 minute' },
}));
app.use('/api/', rateLimit({
  windowMs: 60_000, max: 400,
  message: { error: 'Too many requests, slow down' },
}));

// ── Health ───────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ts: Date.now() })
);

// ── Debug auth — requires DEBUG_SECRET env var; no env var = always 403 ──────
const debugAuth = (req, res, next) => {
  const secret = process.env.DEBUG_SECRET;
  if (!secret || req.headers['x-debug-secret'] !== secret) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// ── Matching diagnostics — shows exactly what the worker sees ────────────────
app.get('/debug/match-state', debugAuth, async (req, res) => {
  try {
    const [driversRes, ridesRes, locRes, stuckRes] = await Promise.all([
      db.query(`
        SELECT u.phone, d.vehicle_type, d.is_online, d.verification_status, d.rating
        FROM drivers d JOIN users u ON d.id = u.id
        ORDER BY d.is_online DESC, d.verification_status
      `),
      db.query(`
        SELECT id, ride_type, status, assigned_to_phone, offered_phones,
               assignment_expires_at, created_at
        FROM rides WHERE status='requested' AND driver_id IS NULL
        ORDER BY created_at DESC LIMIT 10
      `),
      db.query(`SELECT phone, lat, lng, geocell, updated_at FROM driver_locations ORDER BY updated_at DESC LIMIT 20`).catch(() => ({ rows: [] })),
      db.query(`
        SELECT r.id, r.status, r.created_at,
               u.phone AS driver_phone, u.name AS driver_name,
               NOW() - r.created_at AS stuck_for
        FROM rides r JOIN users u ON r.driver_id = u.id
        WHERE r.status IN ('matched','arrived','started')
        ORDER BY r.created_at ASC
      `),
    ]);
    const onlineApproved = driversRes.rows.filter(d => d.is_online && d.verification_status === 'approved');
    const blockedDrivers = stuckRes.rows.map(r => r.driver_phone);
    res.json({
      summary: {
        online_approved_count: onlineApproved.length,
        stuck_rides_count: stuckRes.rows.length,
        WARNING: onlineApproved.length === 0 ? '⚠️ NO online approved drivers — no one will receive rides!' :
                 blockedDrivers.length > 0 ? `⚠️ ${blockedDrivers.length} driver(s) blocked by stuck rides` : '✅ OK',
      },
      online_approved_drivers: onlineApproved,
      all_drivers: driversRes.rows,
      stuck_active_rides: stuckRes.rows,
      pending_rides: ridesRes.rows,
      driver_locations_in_db: locRes.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Deep-dive: why didn't a specific driver get the last ride? ────────────────
app.get('/debug/driver/:phone', debugAuth, async (req, res) => {
  const { phone } = req.params;
  try {
    const [driverRes, locRes, activeRideRes, recentOfferedRes] = await Promise.all([
      db.query(`
        SELECT u.name, u.phone, u.role,
               d.vehicle_type, d.is_online, d.verification_status,
               d.rating, d.admin_message,
               dm.acceptance_rate, dm.rides_offered, dm.rides_accepted,
               dm.suspended_until, dm.idle_since
        FROM users u
        JOIN drivers d ON u.id = d.id
        LEFT JOIN driver_metrics dm ON dm.phone = u.phone
        WHERE u.phone = $1
      `, [phone]),
      db.query(`SELECT phone, lat, lng, geocell, updated_at FROM driver_locations WHERE phone=$1`, [phone]),
      db.query(`
        SELECT r.id, r.status, r.ride_type, r.created_at
        FROM rides r JOIN users u ON r.driver_id = u.id
        WHERE u.phone = $1 AND r.status IN ('matched','arrived','started')
        LIMIT 5
      `, [phone]),
      db.query(`
        SELECT id, ride_type, status, assigned_to_phone, offered_phones, created_at
        FROM rides
        WHERE offered_phones @> ARRAY[$1::text]
        ORDER BY created_at DESC LIMIT 10
      `, [phone]),
    ]);

    if (!driverRes.rows[0]) return res.json({ error: `Driver ${phone} not found in DB — not registered?` });
    const d = driverRes.rows[0];

    const issues = [];
    if (d.verification_status !== 'approved') issues.push(`❌ verification_status='${d.verification_status}' — must be 'approved' to receive rides. Approve via admin panel.`);
    if (!d.is_online) issues.push(`❌ is_online=false — driver must toggle online in app`);
    if (activeRideRes.rows.length > 0) issues.push(`❌ Has active ride(s) in status '${activeRideRes.rows.map(r => r.status).join(',')}' — blocks new assignments until those complete/cancel`);
    if (d.suspended_until && new Date(d.suspended_until) > new Date()) issues.push(`❌ Suspended until ${d.suspended_until}`);
    if (issues.length === 0) issues.push('✅ Driver state looks OK — if still not getting rides, check /debug/worker-query?type=' + d.vehicle_type);

    res.json({
      DIAGNOSIS: issues,
      driver: d,
      location_in_db: locRes.rows[0] || null,
      active_rides_blocking: activeRideRes.rows,
      recent_rides_offered: recentOfferedRes.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dry-run the exact worker matching query for a vehicle type ────────────────
app.get('/debug/worker-query', debugAuth, async (req, res) => {
  const rideType = req.query.type || 'bike';
  try {
    const drRes = await db.query(`
      SELECT u.phone,
             COALESCE(d.rating, 5.0)                                AS rating,
             COALESCE(dm.acceptance_rate, 100)                      AS acceptance_rate,
             COALESCE(dm.idle_since, NOW() - INTERVAL '30 minutes') AS idle_since,
             dl.lat, dl.lng, dl.updated_at AS loc_updated_at,
             d.vehicle_type, d.is_online, d.verification_status
      FROM drivers d
      JOIN users u ON d.id = u.id
      LEFT JOIN driver_metrics dm ON dm.phone = u.phone
      LEFT JOIN driver_locations dl ON dl.phone = u.phone
      WHERE d.verification_status = 'approved'
        AND d.is_online = true
        AND ${vehicleServesSql('d.vehicle_type', '$1')}
        AND NOT EXISTS (
          SELECT 1 FROM rides r2
          WHERE r2.driver_id = d.id AND r2.status IN ('matched','arrived','started') AND r2.parcel_parked_at IS NULL
        )
    `, [rideType]);

    const allOnlineNotApproved = await db.query(`
      SELECT u.phone, d.vehicle_type, d.is_online, d.verification_status
      FROM drivers d JOIN users u ON d.id = u.id
      WHERE d.is_online = true AND d.verification_status != 'approved'
    `);

    res.json({
      ride_type_queried: rideType,
      drivers_worker_would_find: drRes.rows.length,
      drivers: drRes.rows,
      online_but_not_approved: allOnlineNotApproved.rows,
      note: 'drivers_worker_would_find=0 means NO ONE gets this ride type. Check online_but_not_approved.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quick admin: force-approve a driver for testing (secret header required) ──
app.post('/debug/approve-driver', debugAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await db.query(
      `UPDATE drivers SET verification_status='approved' WHERE id=(SELECT id FROM users WHERE phone=$1) RETURNING id`,
      [phone]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Driver not found' });
    res.json({ success: true, message: `Driver ${phone} approved` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BullMQ queue health + manual trigger ─────────────────────────────────────
app.get('/debug/bullmq', debugAuth, async (req, res) => {
  try {
    const [waiting, active, failed, completed, delayed] = await Promise.all([
      rideQueue.getWaitingCount(),
      rideQueue.getActiveCount(),
      rideQueue.getFailedCount(),
      rideQueue.getCompletedCount(),
      rideQueue.getDelayedCount(),
    ]);
    const failedJobs = await rideQueue.getFailed(0, 5);
    res.json({
      queue_counts: { waiting, active, failed, completed, delayed },
      last_5_failed_jobs: failedJobs.map(j => ({ id: j.id, data: j.data, failedReason: j.failedReason, attemptsMade: j.attemptsMade })),
      note: 'waiting>0 = jobs queued but not processed = BullMQ worker likely disconnected from Redis',
    });
  } catch (e) {
    res.status(500).json({ error: e.message, note: 'If this errors, BullMQ itself cannot reach Redis' });
  }
});

// ── Show all open rides + their assignment state ──────────────────────────────
app.get('/debug/open-rides', debugAuth, async (req, res) => {
  try {
    const [ridesRes, driversRes] = await Promise.all([
      db.query(`
        SELECT r.id, r.ride_type, r.status, r.assigned_to_phone,
               r.assignment_expires_at,
               CASE WHEN r.assignment_expires_at > NOW()
                    THEN EXTRACT(EPOCH FROM (r.assignment_expires_at - NOW()))::int
                    ELSE -1 END AS secs_left,
               r.offered_phones,
               r.created_at,
               EXTRACT(EPOCH FROM (NOW() - r.created_at))::int AS age_sec,
               u.phone AS customer_phone
        FROM rides r
        LEFT JOIN users u ON r.passenger_id::text = u.id::text
        WHERE r.status IN ('requested','matched')
        ORDER BY r.created_at DESC LIMIT 20
      `),
      db.query(`
        SELECT u.phone, d.vehicle_type, d.is_online, d.verification_status,
               dl.lat, dl.lng, dl.updated_at AS loc_ts
        FROM drivers d
        JOIN users u ON d.id = u.id
        LEFT JOIN driver_locations dl ON dl.phone = u.phone
        WHERE d.is_online = true AND d.verification_status = 'approved'
        ORDER BY d.vehicle_type
      `),
    ]);
    res.json({
      timestamp: new Date().toISOString(),
      open_rides: ridesRes.rows.map(r => ({
        id: r.id,
        type: r.ride_type,
        status: r.status,
        customer: r.customer_phone,
        age_sec: r.age_sec,
        assigned_to: r.assigned_to_phone || null,
        secs_left: r.secs_left,
        offered_to: r.offered_phones || [],
        created: r.created_at,
      })),
      online_approved_drivers: driversRes.rows,
      hint: ridesRes.rows.length === 0
        ? 'No open rides right now — book a ride then call this immediately'
        : `${ridesRes.rows.length} open ride(s). Check assigned_to and offered_to fields.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Manually trigger match for a specific ride (bypasses BullMQ entirely) ────
app.post('/debug/trigger-match', debugAuth, async (req, res) => {
  const { ride_id } = req.body;
  if (!ride_id) return res.status(400).json({ error: 'ride_id required' });
  try {
    const r = await db.query(
      `SELECT id, pickup_lat, pickup_lng, ride_type FROM rides WHERE id=$1 AND status='requested' AND driver_id IS NULL`,
      [ride_id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Ride not found or already matched' });
    const ride = r.rows[0];
    res.json({ ok: true, message: `Triggering broadcast for ride ${ride_id} (${ride.ride_type}) at 500m` });
    assignRideToNextDriver(ride.id, ride.pickup_lat, ride.pickup_lng, ride.ride_type)
      .catch(e => console.error('[BROADCAST] manual trigger error:', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Customer status check + unrestrict (debug) ───────────────────────────
app.get('/debug/customer-status', debugAuth, async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const u = await db.query(
      `SELECT id, name, phone, booking_restricted, booking_restricted_reason, trust_score
       FROM users WHERE phone=$1`, [phone]
    );
    if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });
    const activeRides = await db.query(
      `SELECT id, status, ride_type, created_at FROM rides WHERE passenger_id=$1 AND status IN ('requested','matched','arrived','started') ORDER BY created_at DESC`,
      [u.rows[0].id]
    );
    res.json({ user: u.rows[0], active_rides: activeRides.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/debug/unrestrict-customer', debugAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    await db.query(
      `UPDATE users SET booking_restricted=false, booking_restricted_reason=NULL, trust_score=LEAST(100, COALESCE(trust_score,0)+20) WHERE phone=$1`,
      [phone]
    );
    res.json({ success: true, message: `${phone} unrestricted` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cancel stuck rides for a passenger (cleanup old requested rides) ───────
app.post('/debug/cancel-stuck-rides', debugAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const u = await db.query(`SELECT id FROM users WHERE phone=$1`, [phone]);
    if (!u.rows[0]) return res.status(404).json({ error: 'User not found' });
    const result = await db.query(
      `UPDATE rides SET status='cancelled', cancelled_by='admin' WHERE passenger_id=$1 AND status IN ('requested','matched','arrived') RETURNING id, status, ride_type`,
      [u.rows[0].id]
    );
    for (const row of result.rows) clearRideCache(row.id).catch(() => {});
    res.json({ cancelled: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

const VEHICLE_EMOJI = { bike:'🏍️', auto:'🛺', car:'🚕', car_7:'🚐', eriksha:'🛵', green_bike:'⚡', electric_auto:'🌿', luxury:'🚙', ultra_luxury:'🚙' };

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
    document.getElementById('loading').innerHTML = '<p style="color:#EF4444;padding:20px;text-align:center">Could not load ride tracking. The link may have expired.</p>';
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
    if (!image) return res.status(400).json({ error: 'Image not found' });
    const result = await cloudinary.uploader.upload(image, { folder: 'rideapp_drivers', resource_type: 'image' });
    res.json({ success: true, url: result.secure_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health endpoint — public, no auth, used by Railway + UptimeRobot ─────────
app.get('/api/health', async (req, res) => {
  try {
    const results = await healthCheck.getStatus();
    const allOk   = results.every(r => r.status === 'ok');
    res.status(allOk ? 200 : 503).json({
      status:  allOk ? 'ok' : 'degraded',
      checks:  results,
      ts:      new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
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
app.use('/api/rides',     ridesRouter);
app.use('/api/scheduled', require('./routes/scheduled'));
app.use('/api/intercity', require('./routes/intercity'));
app.use('/api/parcel',    require('./routes/parcel'));
app.use('/api/advance',   require('./routes/advance'));
app.use('/api/driver',   driversRouter);
app.use('/api/hourly',   hourlyRouter);
app.use('/api/admin/support', adminAuth, adminSupportRouter);
app.use('/api/admin',         adminAuth, adminRouter);
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/buddy-fund',    require('./routes/buddyFund'));
app.use('/api/support',       supportRouter);
app.use('/api/favourites',    favouritesRouter);
app.use('/api/bonus',         bonusRouter);


// Admin portal HTML
app.get('/admin', (_req, res) =>
  res.sendFile(__dirname + '/admin-portal.html')
);

// Public legal pages — required for Play Store / App Store listings
app.get('/privacy', (_req, res) =>
  res.sendFile(__dirname + '/privacy-policy.html')
);
app.get('/terms', (_req, res) =>
  res.sendFile(__dirname + '/terms.html')
);

// Global JSON error handler — overrides Express default HTML error page
// Must be AFTER all routes so it only catches unhandled next(err) calls
app.use((err, req, res, _next) => {
  console.error('[SERVER ERROR]', req.method, req.url, err.message);
  if (!res.headersSent) {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

// ── Socket.io events ─────────────────────────────
function _haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

io.on('connection', (socket) => {
  socket.on('joinRide',    ({ rideId })    => socket.join('ride_' + rideId));
  socket.on('leaveRide',   ({ rideId })    => socket.leave('ride_' + rideId));
  socket.on('joinHourly',  ({ bookingId }) => socket.join('hourly_' + bookingId));

  // Per-connection Set: prevents re-delivering the same offer on repeated driverJoin calls
  // (screen transitions, reconnects) from the same socket. New connection = new Set = clean state.
  const _deliveredOffers = new Set();

  async function _redeliverIfPending(phone) {
    if (!phone) return;
    try {
      // Broadcast system: driver eligible if phone in offered_phones, not rejected, window open
      const r = await db.query(
        `SELECT id, GREATEST(0, EXTRACT(EPOCH FROM (assignment_expires_at - NOW()))::int) AS secs_left
         FROM rides
         WHERE $1 = ANY(COALESCE(offered_phones, '{}'))
           AND NOT ($1 = ANY(COALESCE(rejected_phones, '{}')))
           AND status='requested' AND driver_id IS NULL
           AND assignment_expires_at > NOW()
         ORDER BY assignment_expires_at ASC LIMIT 1`,
        [phone]
      );
      if (r.rows[0] && parseInt(r.rows[0].secs_left) > 2) {
        const rideId = r.rows[0].id;
        if (!_deliveredOffers.has(rideId)) {
          _deliveredOffers.add(rideId);
          socket.emit('newRideRequest', { rideId, secondsToAccept: parseInt(r.rows[0].secs_left) });
          socket.emit('newRideAssigned', { rideId, secondsToAccept: parseInt(r.rows[0].secs_left) }); // backward compat
        }
      }
    } catch (_e) {}
  }

  // The live 'rideTaken' broadcast (emitted once, at the moment another driver
  // accepts) is missed entirely if this driver's socket happened to be
  // disconnected/reconnecting at that exact instant (weak signal, backgrounded
  // app) — their accept card + countdown then keeps showing an offer that's
  // actually already gone until their own local countdown times out. Since the
  // client tells us which ride it's still showing a pending offer for on every
  // (re)connect, we can check it against the DB immediately and correct it
  // right away instead of waiting for the client-side timer.
  async function _correctStaleOffer(phone, pendingRideId) {
    if (!phone || !pendingRideId) return;
    try {
      const r = await db.query(
        `SELECT 1 FROM rides
         WHERE id=$1 AND $2 = ANY(COALESCE(offered_phones, '{}'))
           AND NOT ($2 = ANY(COALESCE(rejected_phones, '{}')))
           AND status='requested' AND driver_id IS NULL
           AND assignment_expires_at > NOW()`,
        [pendingRideId, phone]
      );
      if (!r.rows[0]) socket.emit('rideTaken', { rideId: pendingRideId, message: 'Ride was taken by another driver' });
    } catch (_e) {}
  }

  socket.on('driverJoin',   async ({ phone, pendingRideId })            => { socket.join('driver_' + phone); await _redeliverIfPending(phone); await _correctStaleOffer(phone, pendingRideId); });
  socket.on('driverOnline', async ({ driverId, phone, pendingRideId })  => { const p = phone || driverId; socket.join('driver_' + p); await _redeliverIfPending(p); await _correctStaleOffer(p, pendingRideId); });

  socket.on('locationUpdate', ({ driverId, lat, lng, rideId }) => {
    if (rideId) {
      io.to('ride_' + rideId).emit('driverMoved', { lat, lng });
    } else {
      socket.broadcast.emit('driverMoved_' + driverId, { lat, lng });
    }
  });

  // Driver-to-driver zone alerts — broadcast to all drivers within 3 km
  const _zoneAlertThrottle = new Map(); // phone → last sent timestamp (per-connection)
  socket.on('driverZoneAlert', async ({ phone, lat, lng, alertType, message }) => {
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
    // Query DB so zone alerts work correctly across all cluster workers
    const nearby = await db.query(
      `SELECT phone, lat, lng FROM driver_locations
       WHERE phone != $1 AND updated_at > NOW() - INTERVAL '3 minutes'`,
      [phone]
    ).catch(() => ({ rows: [] }));
    for (const loc of nearby.rows) {
      const dist = _haversineKm(parseFloat(lat), parseFloat(lng), parseFloat(loc.lat), parseFloat(loc.lng));
      if (dist <= RADIUS_KM) {
        io.to('driver_' + loc.phone).emit('zoneAlertReceived', {
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


// ── Startup tasks ────────────────────────────────
setTimeout(async () => {
  // ── Matching tables — must exist before indexes below ────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS driver_locations (
      phone      VARCHAR(15) PRIMARY KEY,
      lat        DECIMAL(10,7),
      lng        DECIMAL(10,7),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`ALTER TABLE driver_locations ADD COLUMN IF NOT EXISTS geocell VARCHAR(40)`).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS driver_metrics (
      phone           VARCHAR(15) PRIMARY KEY,
      rides_offered   INT DEFAULT 0,
      rides_accepted  INT DEFAULT 0,
      rides_cancelled INT DEFAULT 0,
      idle_since      TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});
  console.log('✅ Matching tables ready');

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
  // ── Broadcast matching columns ────────────────────────────────────────────────────────────
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS assigned_to_phone VARCHAR(20) DEFAULT NULL`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS assignment_expires_at TIMESTAMP DEFAULT NULL`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS assignment_queue JSONB DEFAULT '[]'`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS offered_phones TEXT[] DEFAULT '{}'`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS rejected_phones TEXT[] DEFAULT '{}'`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS current_radius_m INTEGER DEFAULT NULL`).catch(() => {});
  // Hourly booking — track drivers who cancelled so same driver is not re-offered
  await db.query(`ALTER TABLE hourly_bookings ADD COLUMN IF NOT EXISTS rejected_drivers TEXT[] DEFAULT '{}'`).catch(() => {});
  // driver_metrics scoring columns (added by add-cancellation.js; must also exist here)
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS acceptance_rate DECIMAL(5,2) DEFAULT 100`).catch(() => {});
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS cancellation_rate DECIMAL(5,2) DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP`).catch(() => {});
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS cancels_today INT DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS last_cancel_date DATE`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS customer_rating INT`).catch(() => {});
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_rating NUMERIC(3,1)`).catch(() => {});
  // rides.rating/review (customer → driver rating) — referenced by /api/rides/rate and
  // the admin rides views since day one, but never actually had a migration creating
  // them, so every post-ride rating submission has been silently failing.
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS rating INT`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS review TEXT`).catch(() => {});
  // Early completion + payment skip tracking columns
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS early_completion BOOLEAN DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_lat_at_complete FLOAT`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_lng_at_complete FLOAT`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS completion_dist_from_drop FLOAT`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS payment_not_received BOOLEAN DEFAULT FALSE`).catch(() => {});
  // Where the driver actually was when they marked "arrived" — the training
  // signal behind suggested pickup points (services/pickupPoints.js). Mirrors
  // the driver_lat/lng_at_complete pair above.
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_lat_at_pickup FLOAT`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_lng_at_pickup FLOAT`).catch(() => {});
  // Human landmark for the pickup ("near Charbagh Metro Station"), resolved at
  // booking time and frozen onto the ride so the driver sees the same phrase
  // the customer confirmed, even if the cache is later refreshed.
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pickup_landmark TEXT`).catch(() => {});
  // The customer's own words for the last 100 metres ("gali 3, behind Sharma
  // Medical"). Indian addresses are landmark-relative, and that sentence gets
  // a driver to the door when even a rooftop-accurate pin leaves them circling.
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS drop_note TEXT`).catch(() => {});
  // Structured delivery address. Kept as separate columns rather than one blob
  // so the driver's screen can render them as a checklist, and — the reason
  // that actually matters — so a repeat parcel to the same receiver can be
  // auto-filled from the last one. A free-text blob can be shown but not
  // reused.
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS drop_building TEXT`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS drop_floor    TEXT`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS drop_landmark TEXT`).catch(() => {});
  // Customer account control columns
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_score INTEGER DEFAULT 100`).catch(() => {});
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_restricted BOOLEAN DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS booking_restricted_reason TEXT`).catch(() => {});
  // Driver metrics strike count
  await db.query(`ALTER TABLE driver_metrics ADD COLUMN IF NOT EXISTS strike_count INTEGER DEFAULT 0`).catch(() => {});
  // driver_wallet: pending_commission was missing from original CREATE TABLE
  await db.query(`ALTER TABLE driver_wallet ADD COLUMN IF NOT EXISTS pending_commission NUMERIC(10,2) DEFAULT 0`).catch(() => {});
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

  // ── Support Tickets tables ────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id               SERIAL PRIMARY KEY,
      ticket_no        TEXT UNIQUE,
      role             TEXT NOT NULL,
      user_phone       VARCHAR(20) NOT NULL,
      ride_id          TEXT,
      category         TEXT NOT NULL,
      title            TEXT NOT NULL,
      description      TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'open',
      priority         TEXT NOT NULL DEFAULT 'normal',
      sla_deadline     TIMESTAMPTZ,
      assigned_to      TEXT,
      resolution_note  TEXT,
      action_taken     TEXT,
      refund_amount    NUMERIC(10,2),
      resolved_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS ticket_messages (
      id          SERIAL PRIMARY KEY,
      ticket_id   INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender      TEXT NOT NULL,
      sender_name TEXT,
      message     TEXT NOT NULL,
      is_internal BOOLEAN DEFAULT FALSE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS ticket_attachments (
      id          SERIAL PRIMARY KEY,
      ticket_id   INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
      image_url   TEXT NOT NULL,
      uploaded_by TEXT DEFAULT 'user',
      caption     TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_phone    ON support_tickets(user_phone)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_status   ON support_tickets(status, priority)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_role     ON support_tickets(role, status)`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ticket_msgs      ON ticket_messages(ticket_id, created_at)`).catch(() => {});
  console.log('✅ Support tickets tables ready');

  // ── Emergency contacts — backend-synced so they survive reinstall/device change ──
  await db.query(`
    CREATE TABLE IF NOT EXISTS emergency_contacts (
      id            SERIAL PRIMARY KEY,
      user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      contact_phone VARCHAR(15) NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_emergency_contacts_user ON emergency_contacts(user_id)`).catch(() => {});

  // ── SOS alerts — add resolution tracking so ops can actually work the queue ──
  await db.query(`ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS resolved BOOLEAN DEFAULT FALSE`).catch(() => {});
  await db.query(`ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`).catch(() => {});
  await db.query(`ALTER TABLE sos_alerts ADD COLUMN IF NOT EXISTS resolved_note TEXT`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_sos_alerts_resolved ON sos_alerts(resolved, created_at)`).catch(() => {});
  console.log('✅ Emergency contacts + SOS resolution tracking ready');

  console.log('✅ DB indexes ready');

// Ensure all vehicle types have fare_settings rows; also repair NULL per_km_rate (causes NaN fare bug)
  await db.query(`
    INSERT INTO fare_settings (vehicle_type, base_fare, per_km_rate, night_multiplier)
    VALUES
      ('bike',          15,  8, 1.3),
      ('auto',          25, 12, 1.5),
      ('car',           40, 15, 1.8),
      ('car_7',         55, 19, 1.8),
      ('eriksha',       20, 10, 1.4),
      ('green_bike',    12,  6, 1.2),
      ('electric_auto', 20,  9, 1.3),
      ('luxury',        80, 25, 2.0)
    ON CONFLICT (vehicle_type) DO NOTHING
  `).catch(() => {});
  // Enforce NOT NULL on financial columns — repairs any existing NULLs and locks the column going forward
  await db.query(`
    UPDATE fare_settings SET
      per_km_rate = CASE vehicle_type
        WHEN 'bike' THEN 8 WHEN 'auto' THEN 12 WHEN 'car' THEN 15
        WHEN 'car_7' THEN 19
        WHEN 'eriksha' THEN 10 WHEN 'green_bike' THEN 6
        WHEN 'electric_auto' THEN 9 WHEN 'luxury' THEN 25
        ELSE 10 END
    WHERE per_km_rate IS NULL
  `).catch(() => {});
  await db.query(`
    UPDATE fare_settings SET
      base_fare = CASE vehicle_type
        WHEN 'bike' THEN 15 WHEN 'auto' THEN 25 WHEN 'car' THEN 40
        WHEN 'car_7' THEN 55
        WHEN 'eriksha' THEN 20 WHEN 'green_bike' THEN 12
        WHEN 'electric_auto' THEN 20 WHEN 'luxury' THEN 80
        ELSE 20 END
    WHERE base_fare IS NULL
  `).catch(() => {});
  // Add NOT NULL constraints — safe after the repair above
  await db.query(`ALTER TABLE fare_settings ALTER COLUMN base_fare SET NOT NULL`).catch(() => {});
  await db.query(`ALTER TABLE fare_settings ALTER COLUMN per_km_rate SET NOT NULL`).catch(() => {});
  await db.query(`ALTER TABLE fare_settings ALTER COLUMN night_multiplier SET NOT NULL`).catch(() => {});

  // ── Phase 2 fare system: new fare_settings columns ──────────────────────────
  await db.query(`ALTER TABLE fare_settings ADD COLUMN IF NOT EXISTS time_rate      NUMERIC NOT NULL DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE fare_settings ADD COLUMN IF NOT EXISTS platform_fee   NUMERIC NOT NULL DEFAULT 2`).catch(() => {});
  await db.query(`ALTER TABLE fare_settings ADD COLUMN IF NOT EXISTS min_fare       NUMERIC NOT NULL DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE fare_settings ADD COLUMN IF NOT EXISTS per_km_rate_t2 NUMERIC`).catch(() => {});
  await db.query(`ALTER TABLE fare_settings ADD COLUMN IF NOT EXISTS per_km_rate_t3 NUMERIC`).catch(() => {});
  await db.query(`ALTER TABLE fare_settings ADD COLUMN IF NOT EXISTS commission_rate         NUMERIC NOT NULL DEFAULT 15`).catch(() => {});
  await db.query(`ALTER TABLE fare_settings ADD COLUMN IF NOT EXISTS hourly_commission_rate  NUMERIC NOT NULL DEFAULT 12`).catch(() => {});
  // Seed proposed defaults for new columns (WHERE time_rate=0 ensures first-run only; admin edits are preserved)
  await db.query(`
    UPDATE fare_settings SET
      time_rate = CASE vehicle_type
        WHEN 'bike'          THEN 0.5  WHEN 'green_bike'    THEN 0.4
        WHEN 'auto'          THEN 0.75 WHEN 'electric_auto' THEN 0.6
        WHEN 'eriksha'       THEN 0.65 WHEN 'car'           THEN 1.0
        WHEN 'car_7'         THEN 1.3
        WHEN 'luxury'        THEN 1.5  ELSE 0.5 END,
      platform_fee = CASE vehicle_type
        WHEN 'car'    THEN 2.5 WHEN 'car_7' THEN 2.5
        WHEN 'luxury' THEN 3.0 ELSE 2.0 END,
      min_fare = CASE vehicle_type
        WHEN 'bike'          THEN 30  WHEN 'green_bike'    THEN 25
        WHEN 'auto'          THEN 45  WHEN 'electric_auto' THEN 38
        WHEN 'eriksha'       THEN 35  WHEN 'car'           THEN 65
        WHEN 'car_7'         THEN 85
        WHEN 'luxury'        THEN 120 ELSE 30 END,
      per_km_rate_t2 = CASE vehicle_type
        WHEN 'bike'          THEN 9   WHEN 'green_bike'    THEN 7
        WHEN 'auto'          THEN 14  WHEN 'electric_auto' THEN 11
        WHEN 'eriksha'       THEN 11  WHEN 'car'           THEN 17
        WHEN 'car_7'         THEN 21
        WHEN 'luxury'        THEN 28  ELSE per_km_rate END,
      per_km_rate_t3 = CASE vehicle_type
        WHEN 'bike'          THEN 10  WHEN 'green_bike'    THEN 8
        WHEN 'auto'          THEN 15  WHEN 'electric_auto' THEN 12
        WHEN 'eriksha'       THEN 12  WHEN 'car'           THEN 18
        WHEN 'car_7'         THEN 22
        WHEN 'luxury'        THEN 30  ELSE per_km_rate END,
      commission_rate = CASE vehicle_type
        WHEN 'green_bike' THEN 12 WHEN 'electric_auto' THEN 12 ELSE 15 END
    WHERE time_rate = 0
  `).catch(() => {});

  // ── Repair corrupted fare_settings rows (per_km_rate accidentally set to 1) ──
  await db.query(`
    UPDATE fare_settings SET
      base_fare   = CASE vehicle_type WHEN 'bike' THEN 15 WHEN 'auto' THEN 25 ELSE base_fare END,
      per_km_rate = CASE vehicle_type WHEN 'bike' THEN 8  WHEN 'auto' THEN 12 ELSE per_km_rate END
    WHERE vehicle_type IN ('bike','auto') AND per_km_rate <= 2
  `).catch(() => {});

  // ── New rides columns for phase 2 fare system ────────────────────────────────
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS trip_started_at TIMESTAMP`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS distance_km     NUMERIC`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS platform_fee    NUMERIC DEFAULT 0`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_by    VARCHAR(20)`).catch(() => {});

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
        description: 'Daily ride targets for Bike/Green Bike drivers' },
      { vehicle_type: 'three_wheeler', bonus_type: 'daily_rides',   label: 'Daily Ride Challenge — Auto',
        config: { tiers: [{ rides: 4, amount: 25 }, { rides: 8, amount: 60 }, { rides: 12, amount: 110 }] },
        description: 'Daily ride targets for Auto/E-Auto drivers' },
      { vehicle_type: 'four_wheeler',  bonus_type: 'daily_rides',   label: 'Daily Ride Challenge — Car',
        config: { tiers: [{ rides: 3, amount: 40 }, { rides: 6, amount: 100 }, { rides: 10, amount: 180 }] },
        description: 'Daily ride targets for Car/Taxi/Premium drivers' },
      { vehicle_type: 'all',           bonus_type: 'peak_hour',     label: 'Peak Hour Bonus',
        config: { per_ride: 8, slots: [{ start: 7, end: 9 }, { start: 17, end: 20 }] },
        description: 'Automatic bonus on every completed ride between 7-9 AM and 5-8 PM' },
      { vehicle_type: 'all',           bonus_type: 'weekly_streak', label: 'Weekly Warrior',
        config: { target_days: 5, rides_per_day: 4, amount: 250 },
        description: '5 days a week, 4+ rides each day — claim your streak bonus' },
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
  // Repair: early migration created ride_id as UUID; cast to TEXT so 'h_55' works
  await db.query(`ALTER TABLE chat_messages ALTER COLUMN ride_id TYPE TEXT USING ride_id::text`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_chat_ride ON chat_messages(ride_id, created_at)`).catch(() => {});
  // Repair: package_hours was INTEGER; decimal extension hours (e.g. 2.25h) require NUMERIC
  await db.query(`ALTER TABLE hourly_bookings ALTER COLUMN package_hours TYPE NUMERIC(10,2) USING package_hours::numeric`).catch(() => {});
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
      ('referral_reward',   10, 'Referral Reward (₹ to both referrer & referred)'),
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
  // Unique constraint prevents double-commission on concurrent /payment-complete calls
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_commissions_ride_id ON driver_commissions(ride_id)`).catch(() => {});
  console.log('✅ driver_commission_payments table ready');

  // ── Driver Subscription System ────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id               SERIAL PRIMARY KEY,
      name             TEXT NOT NULL,
      vehicle_category TEXT NOT NULL,
      ride_count       INT NOT NULL,
      price            NUMERIC NOT NULL,
      original_price   NUMERIC,
      is_active        BOOL DEFAULT true,
      sort_order       INT DEFAULT 0,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS driver_subscriptions (
      id                   SERIAL PRIMARY KEY,
      driver_phone         TEXT NOT NULL,
      plan_id              INT REFERENCES subscription_plans(id),
      vehicle_category     TEXT NOT NULL,
      rides_total          INT NOT NULL,
      rides_used           INT DEFAULT 0,
      rides_remaining      INT NOT NULL,
      starts_at            TIMESTAMPTZ,
      expires_at           TIMESTAMPTZ,
      amount_paid          NUMERIC NOT NULL,
      razorpay_order_id    TEXT,
      razorpay_payment_id  TEXT,
      status               TEXT DEFAULT 'pending',
      created_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscription_ride_log (
      id               SERIAL PRIMARY KEY,
      subscription_id  INT REFERENCES driver_subscriptions(id),
      ride_id          TEXT,
      ride_type        TEXT DEFAULT 'standard',
      commission_saved NUMERIC NOT NULL,
      logged_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  // Migrate: ride_id was INT, must be TEXT for UUID ride IDs
  await db.query(`ALTER TABLE subscription_ride_log ALTER COLUMN ride_id TYPE TEXT USING ride_id::TEXT`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_driver_subs_phone ON driver_subscriptions(driver_phone, status)`).catch(() => {});
  // Add validity_days column if not present (default 60 for all existing plans)
  await db.query(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS validity_days INT DEFAULT 60`).catch(() => {});
  // Seed default plans once
  const subPlanCount = await db.query(`SELECT COUNT(*) FROM subscription_plans`).catch(() => ({ rows: [{ count: '1' }] }));
  if (parseInt(subPlanCount.rows[0].count) === 0) {
    await db.query(`
      INSERT INTO subscription_plans (name, vehicle_category, ride_count, price, original_price, validity_days, sort_order) VALUES
        ('15 Ride Pack', 'bike', 15,  99,  149, 60, 1),
        ('30 Ride Pack', 'bike', 30, 179,  249, 60, 2),
        ('45 Ride Pack', 'bike', 45, 249,  349, 60, 3),
        ('60 Ride Pack', 'bike', 60, 299,  399, 60, 4),
        ('15 Ride Pack', 'auto', 15, 129,  189, 60, 1),
        ('30 Ride Pack', 'auto', 30, 239,  329, 60, 2),
        ('45 Ride Pack', 'auto', 45, 329,  449, 60, 3),
        ('60 Ride Pack', 'auto', 60, 399,  549, 60, 4),
        ('15 Ride Pack', 'car',  15, 199,  279, 60, 1),
        ('30 Ride Pack', 'car',  30, 369,  499, 60, 2),
        ('45 Ride Pack', 'car',  45, 519,  699, 60, 3),
        ('60 Ride Pack', 'car',  60, 649,  849, 60, 4)
    `).catch(() => {});
  }
  // Special daily bike trial plan — insert once if not present
  await db.query(`
    INSERT INTO subscription_plans (name, vehicle_category, ride_count, price, original_price, validity_days, sort_order)
    SELECT '9 Ride Day Pass', 'bike', 9, 9, 19, 1, 0
    WHERE NOT EXISTS (
      SELECT 1 FROM subscription_plans WHERE name='9 Ride Day Pass' AND vehicle_category='bike'
    )
  `).catch(() => {});
  console.log('✅ Subscription system tables ready');

  // ── Buddy Fund ───────────────────────────────────────────────────────────
  await db.query(`CREATE TABLE IF NOT EXISTS buddy_fund_contributions (
    id SERIAL PRIMARY KEY,
    contributor_phone TEXT,
    amount NUMERIC NOT NULL,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`).catch(() => {});
  console.log('✅ Buddy Fund table ready');

  // ── Cancel stuck matched/arrived rides at startup ────────────────────────
  // These hold drivers hostage: worker excludes any driver with an active matched/arrived/started ride.
  // Only cancel a GENUINELY abandoned ride — deliberately very conservative so
  // real-world India conditions never kill a live ride:
  //   • matched >2h ago (no city pickup approach takes 2 hours — even a bad jam),
  //   • AND driver GPS dead >20min (a traffic jam keeps GPS fresh; brief rain /
  //     dead-zone network blips are far shorter than 20min).
  // Both required, so a driver stuck in traffic or with flaky network is safe.
  try {
    const stuckMatched = await db.query(
      `UPDATE rides SET status='cancelled'
       WHERE status IN ('matched','arrived')
         AND COALESCE(driver_matched_at, created_at) < NOW() - INTERVAL '2 hours'
         AND driver_id IN (
           SELECT u.id FROM users u
           LEFT JOIN driver_locations dl ON dl.phone = u.phone
           WHERE dl.updated_at IS NULL OR dl.updated_at < NOW() - INTERVAL '20 minutes'
         )
       RETURNING id, passenger_id, driver_id`
    );
    for (const r of stuckMatched.rows) {
      emitToRoom('ride_' + r.id, 'rideUpdate', { rideId: r.id, status: 'cancelled', reason: 'auto_timeout' });
      clearRideCache(r.id).catch(() => {});
    }
    if (stuckMatched.rows.length) console.log(`✅ Cancelled ${stuckMatched.rows.length} stuck matched/arrived rides`);
  } catch (_e) {}

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
    // 1. Cancel unmatched rides older than 15 min
    const stale = await db.query(
      `UPDATE rides SET status='cancelled'
       WHERE status='requested' AND driver_id IS NULL
       AND created_at < NOW() - INTERVAL '15 minutes'
       RETURNING id, passenger_id, advance_amount, advance_status`
    );
    for (const row of stale.rows) {
      try {
        const u = await db.query('SELECT phone FROM users WHERE id=$1', [row.passenger_id]);
        if (u.rows[0]) {
          // No driver found → full refund of any advance paid
          const advAmt = parseFloat(row.advance_amount || 0);
          if (advAmt > 0 && row.advance_status === 'paid') {
            await refundToWallet(null, u.rows[0].phone, advAmt, row.id, 'Advance refund (no driver found)').catch(() => {});
            await db.query("UPDATE rides SET advance_status='refunded' WHERE id=$1", [row.id]).catch(() => {});
            sendFCM(u.rows[0].phone, '💸 Advance Refunded', `No driver found — ₹${advAmt} refunded to your wallet.`, { type: 'advance_refunded', ride_id: String(row.id) }, { role: 'customer' }).catch(() => {});
          } else {
            sendFCM(u.rows[0].phone, '😔 No Driver Found', 'No driver is available right now — please try again shortly.', { type: 'no_driver_found', ride_id: String(row.id) }, { role: 'customer' }).catch(() => {});
          }
          emitToRoom('ride_' + row.id, 'rideUpdate', { rideId: row.id, status: 'cancelled', reason: 'no_driver' });
          clearRideCache(row.id).catch(() => {});
        }
      } catch (_e) {}
    }

    // 2. Cancel pre_assigned rides stuck >15 min (BullMQ timeout job may have failed)
    const stalePreAssignedRows = await db.query(
      `SELECT id, passenger_id, pre_accepted_driver_phone FROM rides
       WHERE status='pre_assigned' AND pre_accepted_at < NOW() - INTERVAL '15 minutes'`
    );
    if (stalePreAssignedRows.rows.length) {
      const ids = stalePreAssignedRows.rows.map(r => r.id);
      await db.query(
        `UPDATE rides SET status='cancelled', pre_accepted_driver_phone=NULL, pre_accepted_at=NULL WHERE id = ANY($1)`,
        [ids]
      );
      for (const row of stalePreAssignedRows.rows) {
        emitToRoom('ride_' + row.id, 'rideUpdate', { rideId: row.id, status: 'cancelled', reason: 'no_driver' });
        if (row.pre_accepted_driver_phone) {
          emitToRoom('driver_' + row.pre_accepted_driver_phone, 'preRideCancelled', { rideId: row.id });
        }
        clearRideCache(row.id).catch(() => {});
      }
      console.log(`🧹 Auto-cancelled ${stalePreAssignedRows.rows.length} stuck pre_assigned rides`);
    }

    // 3. Cancel stuck matched/arrived rides — ONLY a genuinely abandoned one:
    //    matched >2h ago AND driver GPS dead >20min (both required). A driver in
    //    a traffic jam keeps posting fresh GPS → never cancelled; brief rain /
    //    dead-zone GPS gaps are far shorter than 20min. Deliberately conservative.
    const stuckMatched = await db.query(
      `UPDATE rides SET status='cancelled'
       WHERE status IN ('matched','arrived')
         AND COALESCE(driver_matched_at, created_at) < NOW() - INTERVAL '2 hours'
         AND driver_id IN (
           SELECT u.id FROM users u
           LEFT JOIN driver_locations dl ON dl.phone = u.phone
           WHERE dl.updated_at IS NULL OR dl.updated_at < NOW() - INTERVAL '20 minutes'
         )
       RETURNING id, passenger_id, driver_id`
    );
    for (const row of stuckMatched.rows) {
      emitToRoom('ride_' + row.id, 'rideUpdate', { rideId: row.id, status: 'cancelled', reason: 'auto_timeout' });
      clearRideCache(row.id).catch(() => {});
      try {
        const pRes = await db.query('SELECT phone FROM users WHERE id=$1', [row.passenger_id]);
        if (pRes.rows[0]) sendFCM(pRes.rows[0].phone, '🚫 Ride Cancelled', 'Lost connection with the driver. Please try again.', { type: 'ride_cancelled', ride_id: String(row.id) }, { role: 'customer' }).catch(() => {});
      } catch (_e) {}
    }
    if (stuckMatched.rows.length) console.log(`🧹 Auto-cancelled ${stuckMatched.rows.length} stuck matched/arrived rides`);

    // 3. Cancel a 'started' trip ONLY if the driver clearly forgot to end it.
    //    No fixed timer can be right for every trip length (a Kanyakumari round
    //    trip can run 2 weeks), so we tie the window to the trip's OWN expected
    //    duration instead of a guess:
    //      • city rides            → 24h from trip start (none run a full day)
    //      • intercity round trip  → 3 days PAST the return_at the customer
    //                                 booked (so a 12-day trip is safe till day 15)
    //      • intercity one-way / no return_at → generous 10-day fallback
    //    Hourly rides live in hourly_bookings (not here) and are untouched.
    const stuckStarted = await db.query(
      `UPDATE rides SET status='cancelled'
       WHERE status = 'started'
         AND (
           (COALESCE(is_intercity, false) = false
              AND COALESCE(trip_started_at, created_at) < NOW() - INTERVAL '24 hours')
           OR (is_intercity = true AND return_at IS NOT NULL
              AND return_at < NOW() - INTERVAL '3 days')
           OR (is_intercity = true AND return_at IS NULL
              AND COALESCE(trip_started_at, created_at) < NOW() - INTERVAL '10 days')
         )
         -- Undelivered parcels are NOT stuck rides. A parcel awaiting the
         -- sender's decision, or parked with the driver, legitimately stays
         -- 'started' for hours and has its own settlement path
         -- (/api/parcel/close-unclaimed, which pays the driver and tells the
         -- sender where their package is). Cancelling one here would strand
         -- the sender's escrow on a cancelled ride AND rob the driver of a
         -- delivery they actually performed — both parties lose money and
         -- neither is told why.
         AND NOT (
           COALESCE(is_parcel, false) = true
           AND (parcel_parked_at IS NOT NULL
                OR return_status IN ('pending_decision','awaiting_payment','accepted'))
         )
       RETURNING id, passenger_id`
    );
    for (const row of stuckStarted.rows) {
      emitToRoom('ride_' + row.id, 'rideUpdate', { rideId: row.id, status: 'cancelled', reason: 'auto_timeout' });
      clearRideCache(row.id).catch(() => {});
    }
    if (stuckStarted.rows.length) console.log(`🧹 Auto-cancelled ${stuckStarted.rows.length} stuck started rides (>4h)`);
  } catch (_e) {}
}, 60_000);

// ── Cron: flip time-lapsed driver subscriptions to 'expired' (every 5 min) ──
// The ride-consumption path already re-checks expires_at>NOW() independently on every
// use, so this never affected what benefit a driver actually got — but without this,
// a subscription that expires with rides still unused sits at status='active' forever
// (nothing else ever writes to it again), which made admin's subscriber list lie.
setInterval(async () => {
  try {
    const r = await db.query(
      `UPDATE driver_subscriptions SET status='expired'
       WHERE status='active' AND expires_at < NOW()
       RETURNING id`
    );
    if (r.rows.length) console.log(`🧹 Marked ${r.rows.length} time-lapsed subscription(s) as expired`);
  } catch (_e) {}
}, 5 * 60_000);

// ── Cron: cleanup stale in-memory driver locations (every 5 min) ──
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const phone of Object.keys(driverLocations)) {
    if (driverLocations[phone].updated < cutoff) delete driverLocations[phone];
  }
}, 5 * 60 * 1000);

// Pre-assignment queue columns
db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pre_accepted_driver_phone TEXT`).catch(() => {});
db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pre_accepted_at TIMESTAMPTZ`).catch(() => {});

// ── Stale ride cleanup — cancel requested rides with no driver after 10 min ──
// Prevents orphaned rides (e.g. from partially failed buddy bookings) from
// surfacing repeatedly to drivers through the fallback poll mechanism.
setInterval(async () => {
  try {
    const r = await db.query(
      `UPDATE rides SET status='cancelled'
       WHERE status='requested' AND driver_id IS NULL
         AND created_at < NOW() - INTERVAL '10 minutes'
       RETURNING id`
    );
    for (const row of r.rows) clearRideCache(row.id).catch(() => {});
    if (r.rowCount > 0) console.log(`[CLEANUP] Auto-cancelled ${r.rowCount} stale requested ride(s)`);
  } catch (_e) {}
}, 2 * 60 * 1000); // runs every 2 minutes

// ── Cron: auto-offline inactive drivers (no GPS update in 24h, every 30 min) ──
setInterval(async () => {
  try {
    const r = await db.query(
      `UPDATE drivers SET is_online = false
       WHERE is_online = true
         AND id IN (
           SELECT d.id FROM drivers d
           JOIN users u ON d.id = u.id
           LEFT JOIN driver_locations dl ON dl.phone = u.phone
           WHERE dl.updated_at IS NULL
              OR dl.updated_at < NOW() - INTERVAL '24 hours'
         )
       RETURNING id`
    );
    if (r.rowCount > 0) console.log(`[CLEANUP] Auto-offlined ${r.rowCount} inactive driver(s) (no GPS in 24h)`);
  } catch (_e) {}
}, 30 * 60 * 1000); // runs every 30 minutes

// ── Cron: nudge senders sitting on an undelivered-parcel decision ──
// When a receiver refuses or can't be reached, the sender gets ONE push asking
// them to choose (try again / get it back). If they miss it, the driver is left
// holding the package until the decision window runs out. These reminders give
// a distracted sender two more chances inside that window, and warn them before
// it closes — the whole point is that the window expiring should be a genuine
// non-response, not "they never saw the first notification".
setInterval(async () => {
  try {
    const RETURN_REMINDER_HOURS = [2, 4];      // must match routes/parcel.js
    const RETURN_DECISION_TIMEOUT_HOURS = 5;
    const PARK_AFTER_MINUTES = 20;             // must match routes/parcel.js
    const due = await db.query(
      `SELECT r.id, r.return_reminders_sent, r.parcel_parked_at, r.close_prompt_sent_at,
              u.phone AS passenger_phone, dv.phone AS driver_phone,
              EXTRACT(EPOCH FROM (NOW() - r.return_requested_at))/3600 AS hours_waited
       FROM rides r JOIN users u ON r.passenger_id = u.id
       LEFT JOIN users dv ON r.driver_id = dv.id
       WHERE r.is_parcel = true AND r.status = 'started'
         AND r.return_status IN ('pending_decision','awaiting_payment')
         AND r.return_requested_at IS NOT NULL
         AND r.return_requested_at > NOW() - INTERVAL '24 hours'`
    );

    // ── Park the parcel once the sender has gone quiet for PARK_AFTER_MINUTES.
    // The driver keeps the package but stops being pinned to this job, so they
    // can take rides again instead of sitting idle for hours waiting on someone
    // who may never reply. Claimed conditionally so two passes can't both fire
    // the notification.
    for (const row of due.rows) {
      if (row.parcel_parked_at) continue;
      if (parseFloat(row.hours_waited || 0) * 60 < PARK_AFTER_MINUTES) continue;
      const parked = await db.query(
        'UPDATE rides SET parcel_parked_at = NOW() WHERE id = $1 AND parcel_parked_at IS NULL RETURNING id',
        [row.id]
      );
      if (!parked.rows[0]) continue;
      row.parcel_parked_at = new Date();
      await clearRideCache(row.id).catch(() => {});
      if (row.driver_phone) {
        sendFCM(row.driver_phone, '✅ You can take rides again',
          'The sender still hasn\'t replied, so this parcel has moved to your queue. Keep it safe with you — you\'re free to accept other rides now.',
          { type: 'parcel_parked', ride_id: String(row.id) }, { role: 'driver' }).catch(() => {});
      }
      emitToRoom('ride_' + row.id, 'rideUpdate', { rideId: row.id, parcel_parked: true });
      console.log(`[parcel] ride ${row.id} parked — driver released back to dispatch`);
    }

    // ── Tell the driver once their parked parcel can be closed. Without this a
    // driver who parked one and moved on has no reason to look at it again —
    // and an un-closed parked parcel keeps blocking them from NEW parcel jobs
    // indefinitely, quietly costing them delivery income they'd never connect
    // to the forgotten package.
    for (const row of due.rows) {
      if (!row.parcel_parked_at || row.close_prompt_sent_at || !row.driver_phone) continue;
      if (parseFloat(row.hours_waited || 0) < RETURN_DECISION_TIMEOUT_HOURS) continue;
      const claim = await db.query(
        'UPDATE rides SET close_prompt_sent_at = NOW() WHERE id = $1 AND close_prompt_sent_at IS NULL RETURNING id',
        [row.id]
      );
      if (!claim.rows[0]) continue;
      sendFCM(row.driver_phone, '📦 Parcel still with you',
        `The sender never replied. You can close this delivery now and get paid — keep the package safe in case they contact you.`,
        { type: 'parcel_closeable', ride_id: String(row.id) }, { role: 'driver' }).catch(() => {});
    }

    for (const row of due.rows) {
      const waited = parseFloat(row.hours_waited || 0);
      const sent = parseInt(row.return_reminders_sent || 0);
      // How many reminder marks this ride has now passed.
      const owed = RETURN_REMINDER_HOURS.filter(h => waited >= h).length;
      if (owed <= sent) continue;
      // Claim the send first (conditional on the count we read) so a slow push
      // can't let the next cron pass fire the same reminder twice.
      const claim = await db.query(
        'UPDATE rides SET return_reminders_sent = $1 WHERE id = $2 AND COALESCE(return_reminders_sent,0) = $3 RETURNING id',
        [owed, row.id, sent]
      );
      if (!claim.rows[0]) continue;
      const left = Math.max(0, RETURN_DECISION_TIMEOUT_HOURS - waited);
      sendFCM(row.passenger_phone, '📦 Your parcel is still waiting',
        left <= 1.5
          ? `Last call — decide in about ${Math.max(1, Math.round(left * 60))} min, or your delivery partner will close the trip and keep the parcel until you contact them.`
          : `Your delivery partner is still holding your package. Tap to choose: try again, or get it back.`,
        { type: 'return_decision_needed', ride_id: String(row.id) }, { role: 'customer' }).catch(() => {});
      console.log(`[parcel] reminder ${owed} sent for ride ${row.id} (${waited.toFixed(1)}h waited)`);
    }
  } catch (_e) {}
}, 5 * 60 * 1000); // every 5 min — parking at 20min and a 5h window both need fine-grained checks

// ── Cron: auto-resolve emergency ride disputes after 2 days ──
// If admin hasn't decided within the 2-day hold, refund the full held advance
// to the customer (benefit of the doubt for a reported emergency).
setInterval(async () => {
  try {
    const stale = await db.query(
      `SELECT * FROM ride_disputes WHERE status='pending' AND created_at < NOW() - INTERVAL '2 days'`
    );
    for (const d of stale.rows) {
      const refund = parseFloat(d.held_advance || 0);
      if (refund > 0 && d.customer_phone) await refundToWallet(null, d.customer_phone, refund, d.ride_id, 'Emergency ride refund (auto — no admin decision in 2 days)').catch(() => {});
      await db.query("UPDATE ride_disputes SET status='auto_refunded', admin_refund=$1, admin_penalty=0, resolved_at=NOW() WHERE id=$2", [refund, d.id]).catch(() => {});
      await db.query("UPDATE rides SET advance_status='refunded' WHERE id=$1", [d.ride_id]).catch(() => {});
      if (d.customer_phone) sendFCM(d.customer_phone, '💸 Advance Refunded', `₹${refund} refunded to your wallet.`, { type: 'advance_refunded', ride_id: String(d.ride_id) }, { role: 'customer' }).catch(() => {});
    }
    if (stale.rows.length) console.log(`[CLEANUP] Auto-refunded ${stale.rows.length} unresolved ride dispute(s) after 2 days`);
  } catch (_e) {}
}, 60 * 60 * 1000); // hourly

// ── Hourly booking cleanup — auto-cancel pending bookings older than 30 min ──
setInterval(async () => {
  try {
    const stale = await db.query(
      `SELECT id, customer_phone, base_fare FROM hourly_bookings
       WHERE status='pending' AND created_at < NOW() - INTERVAL '30 minutes'`
    );
    for (const b of stale.rows) {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE hourly_bookings SET status='cancelled', payment_status='refunded' WHERE id=$1`, [b.id]);
        const cu = await client.query('SELECT id FROM users WHERE phone=$1', [b.customer_phone]);
        if (cu.rows[0] && b.base_fare > 0) {
          await client.query('UPDATE customer_wallet SET balance=balance+$1 WHERE user_id=$2', [b.base_fare, cu.rows[0].id]);
          await client.query(`INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Hourly booking expired - auto refund')`, [cu.rows[0].id, b.base_fare]);
        }
        await client.query('COMMIT');
        sendFCM(b.customer_phone, '⏰ Hourly Booking Expired', 'No driver was found — your payment will be refunded to your wallet within 24 hours.', { type: 'hourly_expired' }, { channelId: 'default', role: 'customer' }).catch(() => {});
        console.log(`[HOURLY CLEANUP] Booking #${b.id} auto-cancelled (pending >30min)`);
      } catch (e) { await client.query('ROLLBACK'); console.error('[HOURLY CLEANUP] error:', e.message); }
      finally { client.release(); }
    }
  } catch (_e) { console.error('[HOURLY CLEANUP] error:', _e.message); }
}, 5 * 60_000); // every 5 minutes

// ── Start server ─────────────────────────────────
server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
  console.log('🚀 Server running on port ' + (process.env.PORT || 3000));
  startLocationJobs();
  healthCheck.start();
  // Run DB migrations only in PM2 worker 0 (or single-process mode) to avoid race
  if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0') {
    require('./config/runMigrations').runMigrations().catch(() => {});
  }
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
