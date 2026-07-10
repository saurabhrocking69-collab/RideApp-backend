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
const healthCheck      = require('./services/healthCheck');

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

// ── Matching diagnostics — shows exactly what the worker sees ────────────────
app.get('/debug/match-state', async (req, res) => {
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
app.get('/debug/driver/:phone', async (req, res) => {
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
app.get('/debug/worker-query', async (req, res) => {
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
        AND (d.vehicle_type = $1 OR (d.vehicle_type = 'ultra_luxury' AND $1 = 'luxury'))
        AND NOT EXISTS (
          SELECT 1 FROM rides r2
          WHERE r2.driver_id = d.id AND r2.status IN ('matched','arrived','started')
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
app.post('/debug/approve-driver', async (req, res) => {
  if (req.headers['x-debug-secret'] !== (process.env.DEBUG_SECRET || 'sppero-debug-2024')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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
app.get('/debug/bullmq', async (req, res) => {
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
app.get('/debug/open-rides', async (req, res) => {
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
app.post('/debug/trigger-match', async (req, res) => {
  if (req.headers['x-debug-secret'] !== (process.env.DEBUG_SECRET || 'sppero-debug-2024')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
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

  // Ensure all vehicle types have fare_settings rows; also repair NULL per_km_rate (causes NaN fare bug)
  await db.query(`
    INSERT INTO fare_settings (vehicle_type, base_fare, per_km_rate, night_multiplier)
    VALUES
      ('bike',          15,  8, 1.3),
      ('auto',          25, 12, 1.5),
      ('car',           40, 15, 1.8),
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
        WHEN 'eriksha' THEN 10 WHEN 'green_bike' THEN 6
        WHEN 'electric_auto' THEN 9 WHEN 'luxury' THEN 25
        ELSE 10 END
    WHERE per_km_rate IS NULL
  `).catch(() => {});
  await db.query(`
    UPDATE fare_settings SET
      base_fare = CASE vehicle_type
        WHEN 'bike' THEN 15 WHEN 'auto' THEN 25 WHEN 'car' THEN 40
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
  await db.query(`ALTER TABLE fare_settings ADD COLUMN IF NOT EXISTS commission_rate NUMERIC NOT NULL DEFAULT 15`).catch(() => {});
  // Seed proposed defaults for new columns (WHERE time_rate=0 ensures first-run only; admin edits are preserved)
  await db.query(`
    UPDATE fare_settings SET
      time_rate = CASE vehicle_type
        WHEN 'bike'          THEN 0.5  WHEN 'green_bike'    THEN 0.4
        WHEN 'auto'          THEN 0.75 WHEN 'electric_auto' THEN 0.6
        WHEN 'eriksha'       THEN 0.65 WHEN 'car'           THEN 1.0
        WHEN 'luxury'        THEN 1.5  ELSE 0.5 END,
      platform_fee = CASE vehicle_type
        WHEN 'car'    THEN 2.5 WHEN 'luxury' THEN 3.0 ELSE 2.0 END,
      min_fare = CASE vehicle_type
        WHEN 'bike'          THEN 30  WHEN 'green_bike'    THEN 25
        WHEN 'auto'          THEN 45  WHEN 'electric_auto' THEN 38
        WHEN 'eriksha'       THEN 35  WHEN 'car'           THEN 65
        WHEN 'luxury'        THEN 120 ELSE 30 END,
      per_km_rate_t2 = CASE vehicle_type
        WHEN 'bike'          THEN 9   WHEN 'green_bike'    THEN 7
        WHEN 'auto'          THEN 14  WHEN 'electric_auto' THEN 11
        WHEN 'eriksha'       THEN 11  WHEN 'car'           THEN 17
        WHEN 'luxury'        THEN 28  ELSE per_km_rate END,
      per_km_rate_t3 = CASE vehicle_type
        WHEN 'bike'          THEN 10  WHEN 'green_bike'    THEN 8
        WHEN 'auto'          THEN 15  WHEN 'electric_auto' THEN 12
        WHEN 'eriksha'       THEN 12  WHEN 'car'           THEN 18
        WHEN 'luxury'        THEN 30  ELSE per_km_rate END,
      commission_rate = CASE vehicle_type
        WHEN 'green_bike' THEN 12 WHEN 'electric_auto' THEN 12 ELSE 15 END
    WHERE time_rate = 0
  `).catch(() => {});

  // ── New rides columns for phase 2 fare system ────────────────────────────────
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS trip_started_at TIMESTAMP`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS distance_km     NUMERIC`).catch(() => {});
  await db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS platform_fee    NUMERIC DEFAULT 0`).catch(() => {});

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

  // ── Cancel stuck matched/arrived rides at startup ────────────────────────
  // These hold drivers hostage: worker excludes any driver with an active matched/arrived/started ride.
  // A ride is "stuck" if it was created 30+ minutes ago and never progressed past matched/arrived.
  try {
    const stuckMatched = await db.query(
      `UPDATE rides SET status='cancelled'
       WHERE status IN ('matched','arrived')
         AND created_at < NOW() - INTERVAL '30 minutes'
       RETURNING id, passenger_id, driver_id`
    );
    for (const r of stuckMatched.rows) {
      emitToRoom('ride_' + r.id, 'rideUpdate', { rideId: r.id, status: 'cancelled', reason: 'auto_timeout' });
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
      }
      console.log(`🧹 Auto-cancelled ${stalePreAssignedRows.rows.length} stuck pre_assigned rides`);
    }

    // 3. Cancel stuck matched/arrived rides older than 30 min — these block drivers from future matches
    const stuckMatched = await db.query(
      `UPDATE rides SET status='cancelled'
       WHERE status IN ('matched','arrived')
         AND created_at < NOW() - INTERVAL '30 minutes'
       RETURNING id, passenger_id, driver_id`
    );
    for (const row of stuckMatched.rows) {
      emitToRoom('ride_' + row.id, 'rideUpdate', { rideId: row.id, status: 'cancelled', reason: 'auto_timeout' });
      try {
        const pRes = await db.query('SELECT phone FROM users WHERE id=$1', [row.passenger_id]);
        if (pRes.rows[0]) sendFCM(pRes.rows[0].phone, '🚫 Ride Cancel Ho Gayi', 'Driver ke saath connection nahi raha. Dobara try karo.', { type: 'ride_cancelled', ride_id: String(row.id) }, { role: 'customer' }).catch(() => {});
      } catch (_e) {}
    }
    if (stuckMatched.rows.length) console.log(`🧹 Auto-cancelled ${stuckMatched.rows.length} stuck matched/arrived rides`);

    // 3. Cancel stuck 'started' rides older than 4 hours — driver vanished mid-trip
    const stuckStarted = await db.query(
      `UPDATE rides SET status='cancelled'
       WHERE status = 'started'
         AND created_at < NOW() - INTERVAL '4 hours'
       RETURNING id, passenger_id`
    );
    for (const row of stuckStarted.rows) {
      emitToRoom('ride_' + row.id, 'rideUpdate', { rideId: row.id, status: 'cancelled', reason: 'auto_timeout' });
    }
    if (stuckStarted.rows.length) console.log(`🧹 Auto-cancelled ${stuckStarted.rows.length} stuck started rides (>4h)`);
  } catch (_e) {}
}, 60_000);

// ── Cron: cleanup stale in-memory driver locations (every 5 min) ──
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const phone of Object.keys(driverLocations)) {
    if (driverLocations[phone].updated < cutoff) delete driverLocations[phone];
  }
}, 5 * 60 * 1000);

// ── Cron: scheduled ride reminders + dispatch (every 30s) ───
db.query(`ALTER TABLE scheduled_rides ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT FALSE`).catch(() => {});
db.query(`ALTER TABLE scheduled_rides ADD COLUMN IF NOT EXISTS ride_id INTEGER`).catch(() => {});
db.query(`ALTER TABLE scheduled_rides ADD COLUMN IF NOT EXISTS dispatch_attempts INTEGER DEFAULT 0`).catch(() => {});
db.query(`ALTER TABLE scheduled_rides ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMP`).catch(() => {});
db.query(`ALTER TABLE scheduled_rides ADD COLUMN IF NOT EXISTS failed_reason TEXT`).catch(() => {});
db.query(`ALTER TABLE scheduled_rides ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`).catch(() => {});
db.query(`ALTER TABLE scheduled_rides ADD COLUMN IF NOT EXISTS payment_mode TEXT DEFAULT 'cash'`).catch(() => {});
db.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_rides_status ON scheduled_rides(status)`).catch(() => {});
db.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_rides_scheduled_at ON scheduled_rides(scheduled_at)`).catch(() => {});

// Pre-assignment queue columns
db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pre_accepted_driver_phone TEXT`).catch(() => {});
db.query(`ALTER TABLE rides ADD COLUMN IF NOT EXISTS pre_accepted_at TIMESTAMPTZ`).catch(() => {});

// Startup recovery: reset any 'dispatching' rides that got stuck during a previous crash
db.query(
  `UPDATE scheduled_rides SET status='pending'
   WHERE status='dispatching' AND scheduled_at > NOW()`
).then(r => {
  if (r.rowCount > 0)
    console.log(`[SCHEDULED] Startup: recovered ${r.rowCount} stuck 'dispatching' ride(s) → pending`);
}).catch(() => {});

// IST formatter — server runs in UTC (Railway), always force Asia/Kolkata
function toIST(date) {
  return new Date(date).toLocaleTimeString('hi-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata',
  });
}

setInterval(async () => {
  try {
    // ── 0. Recovery: unstick any 'dispatching' rides older than 2 min ─────────
    // Handles the case where the server crashed between atomic claim and INSERT.
    await db.query(
      `UPDATE scheduled_rides SET status='pending'
       WHERE status='dispatching'
         AND scheduled_at > NOW()
         AND updated_at < NOW() - INTERVAL '2 minutes'`
    ).catch(() => {});

    // ── 1. Reminder: 30–32 min window (sent once, before dispatch window) ─────
    const reminders = await db.query(
      `SELECT * FROM scheduled_rides
       WHERE status = 'pending'
         AND reminder_sent = FALSE
         AND scheduled_at BETWEEN NOW() + INTERVAL '30 minutes' AND NOW() + INTERVAL '32 minutes'`
    );
    for (const ride of reminders.rows) {
      const timeStr = toIST(ride.scheduled_at);
      await sendFCM(
        ride.customer_phone,
        '🚖 Aapki ride 30 minute mein!',
        `${timeStr} baje ke liye ready ho jao — ${ride.pickup} se ${ride.drop_location}`,
        { type: 'scheduled_ride_reminder', scheduled_ride_id: String(ride.id) },
        { channelId: 'default', role: 'customer' }
      ).catch(() => {});
      await db.query(`UPDATE scheduled_rides SET reminder_sent = TRUE WHERE id = $1`, [ride.id]);
      console.log(`⏰ Reminder sent → ${ride.customer_phone} (scheduled_ride #${ride.id} at ${timeStr} IST)`);
    }

    // ── 2. Dispatch: 20–28 min window — driver search starts well before ride time ──
    // Atomic UPDATE claim prevents two Railway instances from double-dispatching
    // the same scheduled ride during a zero-downtime deploy.
    const toDispatch = await db.query(
      `UPDATE scheduled_rides SET status = 'dispatching', updated_at = NOW()
       WHERE status = 'pending'
         AND ride_id IS NULL
         AND scheduled_at BETWEEN NOW() + INTERVAL '20 minutes' AND NOW() + INTERVAL '28 minutes'
       RETURNING *`
    );
    for (const sr of toDispatch.rows) {
      try {
        // Phone normalization: stored phones may or may not have +91 prefix
        const rawPhone = sr.customer_phone;
        const stripped = rawPhone.replace(/^\+91/, '');
        const withCode = '+91' + stripped;
        const userRes = await db.query(
          `SELECT id FROM users WHERE phone = $1 OR phone = $2 LIMIT 1`,
          [withCode, stripped]
        );
        if (!userRes.rows[0]) {
          console.error(`[SCHEDULED] No user for phone=${rawPhone} (scheduled_ride #${sr.id}) — reverting`);
          await db.query(
            `UPDATE scheduled_rides SET status='pending', failed_reason='user not found', updated_at=NOW() WHERE id=$1`,
            [sr.id]
          ).catch(() => {});
          continue;
        }

        // Create live ride
        const rideRes = await db.query(
          `INSERT INTO rides
             (passenger_id, pickup, drop_location, ride_type, fare, status,
              pickup_lat, pickup_lng, drop_lat, drop_lng, payment_mode)
           VALUES ($1,$2,$3,$4,$5,'requested',$6,$7,$8,$9,$10)
           RETURNING id`,
          [userRes.rows[0].id, sr.pickup, sr.drop_location,
           sr.vehicle_type || 'auto', sr.fare_estimate || 0,
           sr.pickup_lat || null, sr.pickup_lng || null,
           sr.drop_lat || null, sr.drop_lng || null,
           sr.payment_mode || 'cash']
        );
        const rideId = rideRes.rows[0].id;

        // Mark fully dispatched
        await db.query(
          `UPDATE scheduled_rides SET status='dispatched', ride_id=$1, dispatched_at=NOW(),
           dispatch_attempts=COALESCE(dispatch_attempts,0)+1, updated_at=NOW() WHERE id=$2`,
          [rideId, sr.id]
        );

        // Broadcast to drivers — use extended 120s acceptance window for scheduled rides
        assignRideToNextDriver(rideId, sr.pickup_lat, sr.pickup_lng, sr.vehicle_type || 'auto', null, null, false, true)
          .catch(e => console.error(`[SCHEDULED] assignRide error ride=${rideId}:`, e.message));

        // Tell customer their ride is being searched
        const timeStr = toIST(sr.scheduled_at);
        sendFCM(
          sr.customer_phone,
          '🔍 Driver dhundh rahe hain!',
          `${timeStr} ki scheduled ride ke liye driver search shuru ho gayi`,
          { type: 'scheduled_ride_dispatched', ride_id: String(rideId), scheduled_ride_id: String(sr.id) },
          { channelId: 'default', role: 'customer' }
        ).catch(() => {});

        console.log(`🚖 Scheduled ride #${sr.id} dispatched → live ride #${rideId} (${sr.vehicle_type || 'auto'}, ${sr.customer_phone}, window=120s)`);
      } catch (e) {
        console.error(`[SCHEDULED] Dispatch failed for #${sr.id}:`, e.message);
        // Revert so next cron tick can retry
        await db.query(
          `UPDATE scheduled_rides SET status='pending', failed_reason=$1, updated_at=NOW() WHERE id=$2`,
          [e.message, sr.id]
        ).catch(() => {});
      }
    }
  } catch (_e) { console.error('[SCHEDULED CRON] error:', _e.message); }
}, 30_000);

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
        sendFCM(b.customer_phone, '⏰ Hourly Booking Expired', 'Driver nahi mila — aapka paisa 24 ghante mein wallet mein wapis aa jayega.', { type: 'hourly_expired' }, { channelId: 'default', role: 'customer' }).catch(() => {});
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
