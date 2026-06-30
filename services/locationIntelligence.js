const { haversineKm } = require('./matching');
const { sendFCM } = require('../config/firebase');
const db = require('../config/db');

// ── Surge Pricing ─────────────────────────────────────────────────────────────
// Count active + recent ride requests within ~1.5km of pickup in last 30 min
async function getSurgeMultiplier(lat, lng) {
  if (!lat || !lng || isNaN(lat) || isNaN(lng)) return 1.0;
  try {
    const r = await db.query(`
      SELECT COUNT(*) AS cnt FROM rides
      WHERE created_at > NOW() - INTERVAL '30 minutes'
        AND pickup_lat BETWEEN $1 - 0.014 AND $1 + 0.014
        AND pickup_lng BETWEEN $2 - 0.014 AND $2 + 0.014
        AND status NOT IN ('cancelled')
    `, [lat, lng]);
    const cnt = parseInt(r.rows[0].cnt) || 0;
    if (cnt >= 15) return 2.0;
    if (cnt >= 10) return 1.5;
    if (cnt >= 6)  return 1.3;
    if (cnt >= 3)  return 1.2;
    return 1.0;
  } catch { return 1.0; }
}

// ── Demand Prediction ─────────────────────────────────────────────────────────
// Hourly ride counts for current weekday from last 30 days
async function getDemandPrediction() {
  try {
    const r = await db.query(`
      SELECT
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Kolkata') AS hour,
        COUNT(*) AS rides,
        ROUND(AVG(CAST(REGEXP_REPLACE(COALESCE(fare,'0'), '[^0-9.]', '', 'g') AS numeric))) AS avg_fare
      FROM rides
      WHERE created_at > NOW() - INTERVAL '30 days'
        AND EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Kolkata') =
            EXTRACT(DOW FROM NOW() AT TIME ZONE 'Asia/Kolkata')
        AND status NOT IN ('cancelled')
      GROUP BY hour
      ORDER BY hour
    `);
    const hourly = Array.from({ length: 24 }, (_, h) => {
      const row = r.rows.find(x => parseInt(x.hour) === h);
      return { hour: h, rides: parseInt(row?.rides) || 0, avg_fare: parseInt(row?.avg_fare) || 0 };
    });
    const max = Math.max(...hourly.map(h => h.rides), 1);
    return hourly.map(h => ({ ...h, intensity: Math.round((h.rides / max) * 100) }));
  } catch { return []; }
}

// ── Background Jobs: Positioning Alerts + Coverage Gap ───────────────────────
let _alertCooldowns = {}; // phone → last_alert_ts  (avoid spam)

async function runPositioningAlerts() {
  const now = Date.now();

  // High-demand zones from last 30 min
  const zones = await db.query(`
    SELECT
      ROUND(pickup_lat::numeric / 0.018) * 0.018 AS zone_lat,
      ROUND(pickup_lng::numeric / 0.018) * 0.018 AS zone_lng,
      COUNT(*) AS ride_count
    FROM rides
    WHERE created_at > NOW() - INTERVAL '30 minutes'
      AND pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL
      AND status NOT IN ('cancelled')
    GROUP BY zone_lat, zone_lng
    HAVING COUNT(*) >= 3
    ORDER BY ride_count DESC
    LIMIT 5
  `).catch(() => ({ rows: [] }));

  if (!zones.rows.length) return;

  // Idle online drivers with recent location
  const drivers = await db.query(`
    SELECT u.phone, dl.lat, dl.lng
    FROM driver_locations dl
    JOIN users u ON u.phone = dl.phone
    JOIN drivers d ON d.id = u.id
    WHERE d.is_online = true
      AND d.status = 'idle'
      AND dl.updated > NOW() - INTERVAL '8 minutes'
  `).catch(() => ({ rows: [] }));

  if (!drivers.rows.length) return;

  for (const zone of zones.rows) {
    const zLat = parseFloat(zone.zone_lat);
    const zLng = parseFloat(zone.zone_lng);
    const count = parseInt(zone.ride_count);

    const withDist = drivers.rows
      .map(d => ({ ...d, dist: haversineKm(parseFloat(d.lat), parseFloat(d.lng), zLat, zLng) }))
      .filter(d => d.dist <= 6)
      .sort((a, b) => a.dist - b.dist);

    const inZone  = withDist.filter(d => d.dist <= 1.0);
    const outside = withDist.filter(d => d.dist >  1.0);

    // Coverage gap: demand but NO driver within 1km
    if (inZone.length === 0 && outside.length > 0 && count >= 3) {
      for (const drv of outside.slice(0, 3)) {
        if (now - (_alertCooldowns[drv.phone] || 0) < 10 * 60 * 1000) continue; // 10 min cooldown
        _alertCooldowns[drv.phone] = now;
        sendFCM(
          drv.phone,
          '🚨 Rides without a driver!',
          `${count} ride request${count > 1 ? 's' : ''} hain ${drv.dist.toFixed(1)}km door — abhi koi driver nahi! Jaldi aao.`,
          { type: 'coverage_gap', zone_lat: String(zLat), zone_lng: String(zLng), ride_count: String(count) },
          { role: 'driver', channelId: 'default' }
        ).catch(() => {});
      }
    }

    // Smart positioning: hot zone, idle drivers nearby but outside — nudge them
    if (count >= 5 && outside.length > 0 && inZone.length < 2) {
      for (const drv of outside.slice(0, 2)) {
        if (now - (_alertCooldowns[drv.phone] || 0) < 10 * 60 * 1000) continue;
        _alertCooldowns[drv.phone] = now;
        sendFCM(
          drv.phone,
          '🔥 Hot Zone — Move Karo!',
          `${count} rides maang rahe hain, sirf ${drv.dist.toFixed(1)}km door. Yahan aao, ride pakdo!`,
          { type: 'positioning_alert', zone_lat: String(zLat), zone_lng: String(zLng), ride_count: String(count) },
          { role: 'driver', channelId: 'default' }
        ).catch(() => {});
      }
    }
  }

  // Clean up old cooldown entries every hour
  if (Math.random() < 0.02) {
    const cutoff = now - 60 * 60 * 1000;
    for (const phone of Object.keys(_alertCooldowns)) {
      if (_alertCooldowns[phone] < cutoff) delete _alertCooldowns[phone];
    }
  }
}

function startLocationJobs() {
  // Run every 5 minutes
  setInterval(() => {
    runPositioningAlerts().catch(e => console.log('Location intelligence error:', e.message));
  }, 5 * 60 * 1000);
  console.log('✅ Location intelligence jobs started (5-min interval)');
}

module.exports = { getSurgeMultiplier, getDemandPrediction, startLocationJobs };
