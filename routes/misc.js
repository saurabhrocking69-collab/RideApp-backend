const express = require('express');
const router = express.Router();
const db = require('../config/db');

// GET /api/fare-settings
router.get('/fare-settings', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM fare_settings ORDER BY vehicle_type');
    res.json({ fares: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/app/config — single endpoint for all dynamic config: fares, surge, hourly packages
// App fetches this at startup + every 5 min to stay in sync with admin panel changes
router.get('/app/config', async (req, res) => {
  try {
    const { getSurge, HOURLY_FARES } = require('../services/pricing');
    const faresResult = await db.query('SELECT * FROM fare_settings ORDER BY vehicle_type');
    const faresMap = {};
    for (const row of faresResult.rows) {
      const r1 = parseFloat(row.per_km_rate);
      const r2 = row.per_km_rate_t2 != null ? parseFloat(row.per_km_rate_t2) : r1;
      const r3 = row.per_km_rate_t3 != null ? parseFloat(row.per_km_rate_t3) : r2;
      faresMap[row.vehicle_type] = {
        base_fare:        parseFloat(row.base_fare),
        per_km_rate:      r1,
        per_km_rate_t2:   r2,
        per_km_rate_t3:   r3,
        time_rate:        parseFloat(row.time_rate    || 0),
        platform_fee:     parseFloat(row.platform_fee || 2),
        min_fare:         parseFloat(row.min_fare     || 0),
        commission_rate:  parseFloat(row.commission_rate || 15),
        night_multiplier: parseFloat(row.night_multiplier || 1.3),
        night_start:      row.night_start || '22:00',
        night_end:        row.night_end   || '06:00',
      };
    }
    const cancelRes = await db.query('SELECT * FROM cancellation_settings ORDER BY id LIMIT 1').catch(() => ({ rows: [] }));
    const cancelSettings = cancelRes.rows[0] || { enabled: true, free_cancel_sec: 60, base_cancel_fee: 10, arrived_cancel_fee: 15, wait_fee_free_min: 3, wait_fee_per_min: 5 };
    res.json({
      fares:               faresMap,
      surge:               getSurge(),
      hourly_fares:        HOURLY_FARES,
      cancel_settings:     cancelSettings,
      fetched_at:          new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/fare-estimate — accepts distance km (preferred) OR lat/lng coords + optional duration_min
router.post('/fare-estimate', async (req, res) => {
  const { pickup_lat, pickup_lng, drop_lat, drop_lng, ride_type, distance, duration_min } = req.body;
  try {
    const { calculateFare } = require('../services/pricing');
    const fares = await db.query('SELECT * FROM fare_settings WHERE vehicle_type = $1', [ride_type]);
    if (!fares.rows[0]) return res.json({ error: 'Ride type not found' });
    const f = fares.rows[0];
    let distKm = distance != null ? parseFloat(distance) : NaN;
    if (isNaN(distKm)) {
      const R = 6371;
      const dLat = (parseFloat(drop_lat) - parseFloat(pickup_lat)) * Math.PI / 180;
      const dLon = (parseFloat(drop_lng) - parseFloat(pickup_lng)) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(parseFloat(pickup_lat)*Math.PI/180)*Math.cos(parseFloat(drop_lat)*Math.PI/180)*Math.sin(dLon/2)**2;
      distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    // If duration not provided, estimate from distance at 20 km/h city average
    const durMin = duration_min != null ? parseFloat(duration_min) : (distKm / 20) * 60;
    const { getISTHour: _getISTHour } = require('../services/pricing');
    const hour = _getISTHour();
    const isNight = hour >= parseInt(String(f.night_start || '22').split(':')[0]) || hour < parseInt(String(f.night_end || '6').split(':')[0]);
    const result = calculateFare(f, distKm, durMin, isNight);
    if (isNaN(result.fare)) return res.status(500).json({ error: 'Fare calculation failed — invalid DB values' });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/fare-estimate/batch — all vehicle fares for a distance in ONE call
// (the app used to fire 7 separate /fare-estimate requests per route; this is
// one DB read + one response, so fares appear noticeably faster).
router.post('/fare-estimate/batch', async (req, res) => {
  const { distance, duration_min, pickup_lat, pickup_lng, drop_lat, drop_lng } = req.body;
  try {
    const { calculateFare, getISTHour } = require('../services/pricing');
    let distKm = distance != null ? parseFloat(distance) : NaN;
    if (isNaN(distKm) && pickup_lat != null && drop_lat != null) {
      const R = 6371;
      const dLat = (parseFloat(drop_lat) - parseFloat(pickup_lat)) * Math.PI / 180;
      const dLon = (parseFloat(drop_lng) - parseFloat(pickup_lng)) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(parseFloat(pickup_lat)*Math.PI/180)*Math.cos(parseFloat(drop_lat)*Math.PI/180)*Math.sin(dLon/2)**2;
      distKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    if (isNaN(distKm)) return res.status(400).json({ error: 'distance or coords required' });
    const durMin = duration_min != null ? parseFloat(duration_min) : (distKm / 20) * 60;
    const hour = getISTHour();
    const all = await db.query('SELECT * FROM fare_settings');
    const fares = {};
    for (const f of all.rows) {
      const isNight = hour >= parseInt(String(f.night_start || '22').split(':')[0]) || hour < parseInt(String(f.night_end || '6').split(':')[0]);
      const r = calculateFare(f, distKm, durMin, isNight);
      if (!isNaN(r.fare)) fares[f.vehicle_type] = r;
    }
    res.json({ fares, distance_km: Math.round(distKm * 10) / 10, duration_min: Math.round(durMin) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sos
router.post('/sos', async (req, res) => {
  const { phone, ride_id, lat, lng, type } = req.body;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    await db.query(
      'INSERT INTO sos_alerts (user_id, ride_id, lat, lng, type) VALUES ($1,$2,$3,$4,$5)',
      [user.rows[0]?.id || null, ride_id || null, lat || null, lng || null, type || 'emergency']
    );
    console.log('🆘 SOS ALERT:', phone, lat, lng);
    res.json({ success: true, message: 'Emergency alert sent', helplines: { police: '100', ambulance: '108', women: '1091' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/places/saved
router.get('/places/saved', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ places: [] });
    const r = await db.query('SELECT id, label, address, lat, lng FROM saved_places WHERE user_id = $1', [user.rows[0].id]);
    res.json({ places: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/places/save
router.post('/places/save', async (req, res) => {
  const { phone, label, address, lat, lng } = req.body;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ success: false });
    await db.query('INSERT INTO saved_places (user_id, label, address, lat, lng) VALUES ($1,$2,$3,$4,$5)',
      [user.rows[0].id, label, address, lat || null, lng || null]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/places/delete
router.post('/places/delete', async (req, res) => {
  const { id } = req.body;
  try {
    await db.query('DELETE FROM saved_places WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/scratch-card/create
router.post('/scratch-card/create', async (req, res) => {
  const { phone, ride_id } = req.body;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ success: false });
    const cfg = await db.query(`SELECT key, value FROM reward_settings WHERE key IN ('scratch_card_min','scratch_card_max')`);
    const cfgMap = Object.fromEntries(cfg.rows.map(r => [r.key, parseFloat(r.value)]));
    const scMin = cfgMap['scratch_card_min'] ?? 1;
    const scMax = cfgMap['scratch_card_max'] ?? 5;
    const reward = Math.floor(Math.random() * (scMax - scMin + 1)) + scMin;
    const card = await db.query(
      `INSERT INTO scratch_cards (user_id, ride_id, reward_amount) VALUES ($1, $2, $3) RETURNING id, reward_amount`,
      [user.rows[0].id, ride_id || null, reward]
    );
    res.json({ success: true, card_id: card.rows[0].id, reward: parseFloat(card.rows[0].reward_amount) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/scratch-card/scratch
router.post('/scratch-card/scratch', async (req, res) => {
  const { card_id, phone } = req.body;
  try {
    const card = await db.query('SELECT * FROM scratch_cards WHERE id = $1', [card_id]);
    if (card.rows.length === 0) return res.json({ success: false, message: 'Card not found' });
    if (card.rows[0].is_scratched) return res.json({ success: false, message: 'Already scratched' });
    const reward = parseFloat(card.rows[0].reward_amount);
    const userId = card.rows[0].user_id;
    await db.query('UPDATE scratch_cards SET is_scratched = true WHERE id = $1', [card_id]);
    await db.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const wallet = await db.query('UPDATE customer_wallet SET balance = balance + $1 WHERE user_id = $2 RETURNING balance', [reward, userId]);
    await db.query("INSERT INTO transactions (user_id, type, amount, description) VALUES ($1, 'credit', $2, 'Scratch card reward')", [userId, reward]);
    res.json({ success: true, reward, balance: parseFloat(wallet.rows[0].balance) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/loyalty/my-points
router.get('/loyalty/my-points', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (!user.rows[0]) return res.json({ points: 0, redeemed: 0, rides: 0 });
    const userId = user.rows[0].id;
    await db.query('INSERT INTO customer_loyalty (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const loyalty = await db.query('SELECT total_points, total_redeemed FROM customer_loyalty WHERE user_id=$1', [userId]);
    const rides = await db.query(`SELECT COUNT(*) as cnt FROM rides WHERE passenger_id=$1 AND status='completed'`, [userId]);
    const pts = loyalty.rows[0] || { total_points: 0, total_redeemed: 0 };
    res.json({ points: parseInt(pts.total_points), redeemed: parseInt(pts.total_redeemed), rides: parseInt(rides.rows[0].cnt), cashback_available: Math.floor(parseInt(pts.total_points) / 100) * 10 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/loyalty/redeem
router.post('/loyalty/redeem', async (req, res) => {
  const { phone, points } = req.body;
  if (!phone || !points || points < 100) return res.status(400).json({ error: 'Minimum 100 points required' });
  if (points % 100 !== 0) return res.status(400).json({ error: 'Points must be a multiple of 100' });
  try {
    const user = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) return res.status(404).json({ error: 'User not found' });
    const userId = user.rows[0].id;
    const loyalty = await db.query('SELECT total_points FROM customer_loyalty WHERE user_id=$1', [userId]);
    const available = parseInt(loyalty.rows[0]?.total_points || 0);
    if (available < points) return res.json({ success: false, message: `Sirf ${available} points hain` });
    const cashback = Math.floor(points / 100) * 10;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE customer_loyalty SET total_points=total_points-$1, total_redeemed=total_redeemed+$1 WHERE user_id=$2', [points, userId]);
      await client.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
      const w = await client.query('UPDATE customer_wallet SET balance=balance+$1, updated_at=NOW() WHERE user_id=$2 RETURNING balance', [cashback, userId]);
      await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Loyalty points redeem')", [userId, cashback]);
      await client.query('COMMIT');
      res.json({ success: true, points_used: points, cashback_credited: cashback, new_balance: parseFloat(w.rows[0].balance) });
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/rewards/dashboard?phone=X
router.get('/rewards/dashboard', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (!user.rows[0]) return res.json({ rides_today: 0, total_cashback: 0, cashback_history: [], rules: [] });
    const userId = user.rows[0].id;
    const today = new Date().toISOString().slice(0, 10);

    const [todayRides, totalCashback, history, walletRes] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FROM rides WHERE passenger_id=$1 AND status='completed' AND DATE(created_at AT TIME ZONE 'Asia/Kolkata')=$2`,
        [userId, today]
      ),
      db.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM cashback_events WHERE user_id=$1`,
        [userId]
      ),
      db.query(
        `SELECT ce.rule_type, ce.amount, ce.created_at, r.fare
         FROM cashback_events ce LEFT JOIN rides r ON ce.ride_id=r.id
         WHERE ce.user_id=$1 ORDER BY ce.created_at DESC LIMIT 20`,
        [userId]
      ),
      db.query(`SELECT COALESCE(balance,0) AS balance FROM customer_wallet WHERE user_id=$1`, [userId]),
    ]);

    const rideCount = parseInt(todayRides.rows[0].count);
    const rules = [
      { id: 'fare_over_100',  icon: '💎', label: '₹100+ Ride',       desc: 'Koi bhi ride ₹100 se zyada ki hogi',     cashback: 10,  unlocked: false, claimed_today: false },
      { id: 'second_ride_day',icon: '✌️',  label: '2nd Ride Today',   desc: 'Complete 2 rides today',               cashback: 10,  unlocked: rideCount >= 2, claimed_today: rideCount >= 2 },
      { id: 'third_ride_day', icon: '🔥',  label: '3rd Ride Streak',  desc: 'Complete your 3rd ride today',              cashback: 15,  unlocked: rideCount >= 3, claimed_today: rideCount >= 3 },
      { id: 'wallet_pay',     icon: '👛',  label: 'Wallet Pay Bonus', desc: 'Pay with wallet (on rides ₹50+)',       cashback: 5,   unlocked: false, claimed_today: false },
    ];

    res.json({
      rides_today: rideCount,
      wallet_balance: parseFloat(walletRes.rows[0]?.balance || 0),
      total_cashback_earned: parseFloat(totalCashback.rows[0].total),
      cashback_history: history.rows,
      rules,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/notifications (in-app notifications)
// ?target=PHONE&role=customer|driver
router.get('/notifications', async (req, res) => {
  const { target, role } = req.query;
  try {
    const r = await db.query(
      `SELECT title,
              COALESCE(message, body) AS message,
              created_at,
              type,
              image_url
       FROM notifications
       WHERE target = 'all'
          OR target = $1
          OR user_phone = $1
          OR (target = 'customers' AND $2 = 'customer')
          OR (target = 'drivers'   AND $2 = 'driver')
       ORDER BY created_at DESC LIMIT 30`,
      [target || '', role || 'customer']
    );
    res.json({ notifications: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/notifications/latest
router.get('/notifications/latest', async (req, res) => {
  const { phone } = req.query;
  try {
    const result = await db.query(
      `SELECT * FROM notifications WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    res.json({ notification: result.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/offers/active
router.get('/offers/active', async (req, res) => {
  const { role } = req.query;
  try {
    const r = await db.query(
      `SELECT * FROM marketing_campaigns WHERE active=true AND (expires_at IS NULL OR expires_at > NOW()) AND (target='all' OR target=$1) ORDER BY created_at DESC LIMIT 5`,
      [role || 'customer']
    );
    res.json({ offers: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rides/check-range
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
router.post('/rides/check-range', async (req, res) => {
  const { ride_id, driver_lat, driver_lng, type } = req.body;
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

// GET /api/customer/rating?phone=X
router.get('/customer/rating', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await db.query(
      `SELECT u.customer_rating,
         (SELECT COUNT(*) FROM rides WHERE passenger_id=u.id AND customer_rating IS NOT NULL) AS rating_count
       FROM users u WHERE u.phone=$1`,
      [phone]
    );
    res.json({
      rating: r.rows[0]?.customer_rating ? parseFloat(r.rows[0].customer_rating) : null,
      count:  parseInt(r.rows[0]?.rating_count || '0'),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/customer/tier?phone=X — loyalty tier based on all-time completed rides
router.get('/customer/tier', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await db.query(
      `SELECT COUNT(*) AS total
       FROM rides r JOIN users u ON r.passenger_id = u.id
       WHERE u.phone = $1 AND r.status = 'completed'`,
      [phone]
    );
    const total = parseInt(r.rows[0]?.total || '0');

    const TIERS = [
      { tier: 'starter', label: 'Starter',  emoji: '🌱', min: 0,  next_min: 5,   color: '#059669' },
      { tier: 'regular', label: 'Regular',  emoji: '⭐', min: 5,  next_min: 20,  color: '#1D4ED8' },
      { tier: 'expert',  label: 'Expert',   emoji: '🔥', min: 20, next_min: 50,  color: '#FF7A00' },
      { tier: 'elite',   label: 'Elite',    emoji: '👑', min: 50, next_min: null, color: '#F59E0B' },
    ];
    const current = [...TIERS].reverse().find(t => total >= t.min) || TIERS[0];
    const idx = TIERS.indexOf(current);
    const next = TIERS[idx + 1] || null;

    res.json({
      total_rides:   total,
      tier:          current.tier,
      label:         current.label,
      emoji:         current.emoji,
      color:         current.color,
      rides_to_next: next ? Math.max(0, next.min - total) : 0,
      next_tier:     next ? { tier: next.tier, label: next.label, emoji: next.emoji, min: next.min } : null,
      progress_pct:  next ? Math.min(100, Math.round(((total - current.min) / (next.min - current.min)) * 100)) : 100,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
