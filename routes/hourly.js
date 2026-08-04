const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sendFCM } = require('../config/firebase');
const { emitToRoom, getIO } = require('../config/socket');
const { HOURLY_FARES, getSurge } = require('../services/pricing');
const { useSubscriptionIfActive } = require('../services/subscription');
const { vehicleServesSql } = require('../services/matching');

async function doCompleteHourly(booking_id, actual_km) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM hourly_bookings WHERE id=$1', [booking_id]);
    if (!r.rows[0]) { await client.query('ROLLBACK'); client.release(); return null; }
    const b = r.rows[0];
    const extraKm = Math.max(0, (actual_km || 0) - parseFloat(b.km_included));
    const extraCharge = extraKm * (HOURLY_FARES[b.vehicle_type]?.extra || 8);
    const extensionFare = parseFloat(b.extend_total_fare || 0);
    const totalFare = parseFloat(b.base_fare) + extraCharge + extensionFare;
    const fsRate = await client.query('SELECT hourly_commission_rate FROM fare_settings WHERE vehicle_type=$1 LIMIT 1', [b.vehicle_type]);
    const commPct = parseFloat(fsRate.rows[0]?.hourly_commission_rate ?? 12) / 100;
    const normalCommission = Math.round(totalFare * commPct * 100) / 100;
    const { commission } = await useSubscriptionIfActive(b.driver_phone, booking_id, 'hourly', normalCommission, client);
    const driverEarning = Math.round((totalFare - commission) * 100) / 100;
    const actualHours = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) / 3600000 : b.package_hours;
    const driverUser = await client.query('SELECT id FROM users WHERE phone=$1', [b.driver_phone]);
    if (driverUser.rows[0]) await client.query('UPDATE driver_wallet SET balance=balance+$1, total_earned=total_earned+$1 WHERE driver_id=$2', [driverEarning, driverUser.rows[0].id]);
    if (extraCharge > 0) {
      const cu = await client.query(
        `SELECT u.id, COALESCE(cw.balance, 0) AS balance
         FROM users u LEFT JOIN customer_wallet cw ON cw.user_id = u.id
         WHERE u.phone = $1`,
        [b.customer_phone]
      );
      if (cu.rows[0]) {
        const available = Math.max(0, parseFloat(cu.rows[0].balance));
        const chargeableExtra = Math.min(extraCharge, available);
        if (chargeableExtra > 0) {
          await client.query('UPDATE customer_wallet SET balance=balance-$1 WHERE user_id=$2', [chargeableExtra, cu.rows[0].id]);
          await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'debit',$2,'Hourly - extra km charge')", [cu.rows[0].id, chargeableExtra]);
        }
      }
    }
    await client.query(
      `UPDATE hourly_bookings SET status='completed', ended_at=NOW(), actual_km=$1, extra_km=$2, extra_km_charge=$3, total_fare=$4, actual_hours=$5, driver_earning=$6, platform_fee=$7, payment_status='released', pending_customer_confirm=false WHERE id=$8`,
      [actual_km || 0, extraKm, extraCharge, totalFare, actualHours, driverEarning, commission, booking_id]
    );
    await client.query('COMMIT');
    sendFCM(b.customer_phone, '⏱️ Hourly Trip Complete!', `Trip complete! Total: ₹${totalFare.toFixed(0)}`, {}, { role: 'customer' });
    sendFCM(b.driver_phone, '✅ Trip Complete', `₹${driverEarning.toFixed(0)} earned!`, {}, { role: 'driver' });
    client.release();
    return { total_fare: totalFare, driver_earning: driverEarning, extra_km: extraKm, extra_km_charge: extraCharge };
  } catch (err) {
    await client.query('ROLLBACK'); client.release(); throw err;
  }
}

// GET /api/hourly/packages
router.get('/packages', (req, res) => res.json({ fares: HOURLY_FARES }));

// POST /api/hourly/book
router.post('/book', async (req, res) => {
  const { phone, vehicle_type, package_hours, pickup, pickup_lat, pickup_lng, drop_location, drop_lat, drop_lng, is_roundtrip, stay_hours, scheduled_at } = req.body;
  const client = await db.connect();
  try {
    const pkg = HOURLY_FARES[vehicle_type]?.[package_hours];
    if (!pkg) return res.status(400).json({ error: `Invalid package: ${vehicle_type} ${package_hours}h` });
    const baseFare = Math.round(pkg.fare * getSurge());
    await client.query('BEGIN');
    const user = await client.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (!user.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'User not found' }); }
    const userId = user.rows[0].id;
    await client.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
    const wallet = await client.query('SELECT balance FROM customer_wallet WHERE user_id = $1', [userId]);
    const balance = wallet.rows[0] ? parseFloat(wallet.rows[0].balance) : 0;
    if (balance < baseFare) { await client.query('ROLLBACK'); return res.json({ success: false, error: `Wallet needs ₹${baseFare}, your balance is ₹${balance.toFixed(0)}` }); }
    await client.query('UPDATE customer_wallet SET balance = balance - $1 WHERE user_id = $2', [baseFare, userId]);
    await client.query("INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'debit',$2,'Hourly booking - escrow hold')", [userId, baseFare]);
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const schedAt = scheduled_at ? new Date(scheduled_at) : null;
    const bk = await client.query(
      `INSERT INTO hourly_bookings (customer_phone,vehicle_type,package_hours,km_included,base_fare,total_fare,pickup,pickup_lat,pickup_lng,drop_location,drop_lat,drop_lng,is_roundtrip,stay_hours,otp,scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [phone, vehicle_type, package_hours, pkg.km, baseFare, pickup, pickup_lat || null, pickup_lng || null, drop_location || null, drop_lat || null, drop_lng || null, is_roundtrip || false, stay_hours || 0, otp, schedAt]
    );
    await client.query('COMMIT');
    const bookingId = bk.rows[0].id;
    res.json({ success: true, booking_id: bookingId, fare: baseFare, km_included: pkg.km, scheduled_at: schedAt });

    // Notify online drivers with matching vehicle type (fire-and-forget, outside transaction)
    setImmediate(async () => {
      try {
        const io = getIO();
        const onlineDrivers = await db.query(
          `SELECT u.phone FROM drivers d JOIN users u ON d.id=u.id
           WHERE ${vehicleServesSql('d.vehicle_type', '$1')} AND d.is_online=true AND d.verification_status='approved'
             AND NOT EXISTS (
               SELECT 1 FROM hourly_bookings hb
               WHERE hb.driver_phone = u.phone AND hb.status IN ('matched','arrived','active')
             ) LIMIT 60`,
          [vehicle_type]
        );
        const hoursLabel = package_hours >= 8 ? 'Full Day (8h)' : `${package_hours}h`;
        const title = `⏱️ New Hourly Booking — ${hoursLabel}`;
        const body  = `${pickup} · ₹${baseFare} guaranteed — head to pickup!`;
        const data  = { type: 'hourly_available', booking_id: String(bookingId) };
        for (const dr of onlineDrivers.rows) {
          sendFCM(dr.phone, title, body, data, { channelId: 'ride_requests', role: 'driver' }).catch(() => {});
          if (io) io.to('driver_' + dr.phone).emit('newHourlyRideRequest');
        }
      } catch (e) { console.error('[hourly broadcast]', e.message); }
    });
  } catch (err) { await client.query('ROLLBACK'); console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
  finally { client.release(); }
});

// GET /api/hourly/status/:id
router.get('/status/:id', async (req, res) => {
  const { maskPhone } = require('../services/phone');
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Booking not found' });
    const b = { ...r.rows[0] };
    let driver = null;
    if (b.driver_phone) {
      const d = await db.query('SELECT u.name, d.vehicle_no, d.vehicle_brand, d.vehicle_model FROM users u JOIN drivers d ON u.id = d.id WHERE u.phone = $1', [b.driver_phone]);
      driver = d.rows[0] || null;
      b.driver_phone_masked = maskPhone(b.driver_phone);
      delete b.driver_phone;
    }
    let approaching_limit = null;
    if (b.status === 'active' && b.started_at) {
      const elapsedMin = (Date.now() - new Date(b.started_at).getTime()) / 60000;
      const totalMin = parseFloat(b.package_hours) * 60;
      const timePct = totalMin > 0 ? elapsedMin / totalMin : 0;
      const kmPct = parseFloat(b.km_included) > 0 ? (parseFloat(b.actual_km || 0) / parseFloat(b.km_included)) : 0;
      const minLeft = Math.max(0, Math.round(totalMin - elapsedMin));
      const extraKmNow = Math.max(0, parseFloat(b.actual_km || 0) - parseFloat(b.km_included));
      approaching_limit = {
        time_pct: Math.round(timePct * 100), km_pct: Math.round(kmPct * 100), min_left: minLeft,
        km_left: Math.max(0, Math.round(parseFloat(b.km_included) - parseFloat(b.actual_km || 0))),
        extra_km: Math.round(extraKmNow * 10) / 10,
        extra_km_charge: Math.round(extraKmNow * (HOURLY_FARES[b.vehicle_type]?.extra || 8)),
        is_roundtrip: b.is_roundtrip, warn: timePct >= 0.80, critical: timePct >= 0.95,
      };
    }
    res.json({ booking: b, driver, approaching_limit });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/hourly/driver-pending
router.get('/driver-pending', async (req, res) => {
  const { phone } = req.query;
  try {
    const dr = await db.query('SELECT d.vehicle_type FROM drivers d JOIN users u ON d.id = u.id WHERE u.phone = $1', [phone]);
    if (!dr.rows[0]) return res.json({ booking: null });
    const r = await db.query(
      // $1 is the DRIVER's vehicle, so the comparison is the other way round
      // here: find bookings this driver's vehicle can serve.
      `SELECT * FROM hourly_bookings WHERE status='pending' AND driver_phone IS NULL
       AND ${vehicleServesSql('$1', 'vehicle_type')}
       AND NOT ($2 = ANY(COALESCE(rejected_drivers, '{}')))
       AND ((scheduled_at IS NULL AND created_at > NOW() - INTERVAL '30 minutes') OR (scheduled_at IS NOT NULL AND scheduled_at BETWEEN NOW() - INTERVAL '15 minutes' AND NOW() + INTERVAL '75 minutes'))
       ORDER BY CASE WHEN scheduled_at IS NULL THEN 0 ELSE 1 END, COALESCE(scheduled_at, created_at) ASC LIMIT 1`,
      [dr.rows[0].vehicle_type, phone]
    );
    res.json({ booking: r.rows[0] || null });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/accept
router.post('/accept', async (req, res) => {
  const { booking_id, driver_phone } = req.body;
  try {
    const result = await db.query(`UPDATE hourly_bookings SET driver_phone=$1, status='matched' WHERE id=$2 AND status='pending' AND driver_phone IS NULL RETURNING *`, [driver_phone, booking_id]);
    if (result.rows.length === 0) return res.json({ success: false, message: 'Already taken' });
    const booking = result.rows[0];
    sendFCM(booking.customer_phone, '⏱️ Driver Found!', 'Your driver is on the way for the hourly booking!', { type: 'hourly_matched', booking_id: String(booking_id) }, { role: 'customer' });
    emitToRoom('hourly_' + booking_id, 'hourlyMatched', { status: 'matched', driver_phone, booking_id });
    res.json({ success: true });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/driver-cancel — driver backs out after accepting, either
// before or after marking arrival (before OTP/trip start). The app shows the
// Cancel button in both 'matched' and 'arrived' states, so this must accept
// both — it previously only matched 'matched', permanently 404ing any driver
// who'd already tapped "I've Arrived" and leaving the booking stuck forever
// since there was no other way for the driver to back out of it.
router.post('/driver-cancel', async (req, res) => {
  const { booking_id, driver_phone } = req.body;
  try {
    const r = await db.query(`SELECT * FROM hourly_bookings WHERE id=$1 AND driver_phone=$2 AND status IN ('matched','arrived')`, [booking_id, driver_phone]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Booking not found or already started' });
    const booking = r.rows[0];
    // Reset to pending AND record this driver so they are not re-offered the same booking
    await db.query(
      `UPDATE hourly_bookings SET driver_phone=NULL, status='pending',
       rejected_drivers = array_append(COALESCE(rejected_drivers, '{}'), $2)
       WHERE id=$1`,
      [booking_id, driver_phone]
    );
    sendFCM(booking.customer_phone, '⚠️ Driver Cancelled', 'Driver became unavailable — looking for a new driver', {}, { role: 'customer' });
    emitToRoom('hourly_' + booking_id, 'hourlyDriverCancelled', { booking_id });
    res.json({ success: true });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/arrived — driver marks arrival at pickup point
router.post('/arrived', async (req, res) => {
  const { booking_id, driver_phone } = req.body;
  try {
    const r = await db.query(
      `SELECT * FROM hourly_bookings WHERE id=$1 AND driver_phone=$2 AND status='matched'`,
      [booking_id, driver_phone]
    );
    if (!r.rows[0]) return res.status(404).json({ success: false, message: 'Booking not found or already started' });
    const b = r.rows[0];
    await db.query(`UPDATE hourly_bookings SET status='arrived' WHERE id=$1`, [booking_id]);
    sendFCM(
      b.customer_phone,
      '📍 Sppero Buddy Arrived!',
      'Your Sppero Buddy has arrived at the pickup point — share the OTP to start the trip!',
      { type: 'driver_arrived', booking_id: String(booking_id) },
      { role: 'customer' }
    );
    emitToRoom('hourly_' + booking_id, 'hourlyDriverArrived', { booking_id });
    res.json({ success: true });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/start
router.post('/start', async (req, res) => {
  const { booking_id, otp, driver_phone } = req.body;
  try {
    const r = await db.query('SELECT otp, driver_phone FROM hourly_bookings WHERE id=$1', [booking_id]);
    if (!r.rows[0] || r.rows[0].otp !== otp) return res.status(400).json({ success: false, message: 'Incorrect OTP!' });
    if (driver_phone && r.rows[0].driver_phone && r.rows[0].driver_phone !== driver_phone)
      return res.status(403).json({ success: false, message: 'You are not the driver for this booking' });
    const started_at = new Date().toISOString();
    await db.query(`UPDATE hourly_bookings SET status='active', started_at=NOW() WHERE id=$1`, [booking_id]);
    emitToRoom('hourly_' + booking_id, 'hourlyTripStarted', { booking_id, started_at });
    res.json({ success: true });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/hourly/driver-active
router.get('/driver-active', async (req, res) => {
  const { phone } = req.query;
  try {
    const r = await db.query(`SELECT * FROM hourly_bookings WHERE driver_phone=$1 AND status IN ('matched','arrived','active') ORDER BY created_at DESC LIMIT 1`, [phone]);
    res.json({ booking: r.rows[0] || null });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/hourly/active
router.get('/active', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    // Exclude pending bookings older than 30 min — driver was never found, treat as expired
    const r = await db.query(
      `SELECT * FROM hourly_bookings
       WHERE customer_phone=$1
         AND status IN ('pending','matched','arrived','active')
         AND NOT (status='pending' AND created_at < NOW() - INTERVAL '30 minutes')
       ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (!r.rows[0]) return res.json({ booking: null, driver: null });
    const b = r.rows[0];
    let driver = null;
    if (b.driver_phone) {
      const dr = await db.query(`SELECT u.name, u.phone, d.vehicle_type, d.vehicle_no, d.vehicle_brand, d.vehicle_model FROM users u JOIN drivers d ON d.id=u.id WHERE u.phone=$1`, [b.driver_phone]);
      driver = dr.rows[0] || null;
    }
    res.json({ booking: b, driver });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/complete
router.post('/complete', async (req, res) => {
  const { booking_id, actual_km } = req.body;
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE id=$1 AND status='active'", [booking_id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Active booking not found' });
    const b = r.rows[0];
    const elapsedMin = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) / 60000 : 0;
    const totalMin = parseFloat(b.package_hours) * 60;
    if (elapsedMin < 20) {
      const waitMin = Math.ceil(20 - elapsedMin);
      return res.json({ success: false, too_early: true, wait_mins: waitMin, message: `Trip started ${Math.floor(elapsedMin)} min ago — please wait ${waitMin} more min` });
    }
    if (elapsedMin < totalMin) {
      const remMin = Math.ceil(totalMin - elapsedMin);
      const remH = Math.floor(remMin / 60);
      const remM = remMin % 60;
      const remStr = remH > 0 ? `${remH}h ${remM > 0 ? remM + 'm' : ''}` : `${remMin}m`;
      return res.json({ success: false, time_locked: true, remaining_min: remMin, message: `Package time remaining — drive for ${remStr} more.` });
    }
    const result = await doCompleteHourly(booking_id, actual_km || 0);
    res.json({ success: true, ...result });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/early-end-request
router.post('/early-end-request', async (req, res) => {
  const { booking_id, requested_by } = req.body;
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id=$1', [booking_id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const b = r.rows[0];
    if ((b.early_end_reject_count || 0) >= 2) return res.json({ success: false, locked: true, message: 'Rejected twice — please contact support' });
    if (b.early_end_last_rejected_at) {
      const msSince = Date.now() - new Date(b.early_end_last_rejected_at).getTime();
      if (msSince < 15 * 60 * 1000) {
        const waitMin = Math.ceil((15 * 60 * 1000 - msSince) / 60000);
        return res.json({ success: false, cooldown: true, wait_mins: waitMin, message: `Please try again after ${waitMin} min` });
      }
    }
    await db.query('UPDATE hourly_bookings SET early_end_requested_by=$1 WHERE id=$2', [requested_by, booking_id]);
    if (requested_by === 'driver') sendFCM(b.customer_phone, '⚠️ Driver Wants to End the Trip', 'Please confirm or reject in the app.', {}, { role: 'customer' });
    else sendFCM(b.driver_phone, '⚠️ Customer Wants to End the Trip', 'Please confirm or reject in the app.', {}, { role: 'driver' });
    res.json({ success: true });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/early-end-confirm
router.post('/early-end-confirm', async (req, res) => {
  const { booking_id } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM hourly_bookings WHERE id=$1', [booking_id]);
    if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const b = r.rows[0];
    const actualHours = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) / 3600000 : 0;
    const isCustomerEnd = b.early_end_requested_by === 'customer';
    const proportion = isCustomerEnd ? 1.0 : Math.max(0.70, actualHours / b.package_hours);
    const driverAmount = Math.round(parseFloat(b.base_fare) * proportion);
    const refund = Math.round(parseFloat(b.base_fare) - driverAmount);
    const fsRate2 = await client.query('SELECT hourly_commission_rate FROM fare_settings WHERE vehicle_type=$1 LIMIT 1', [b.vehicle_type]);
    const commPct2 = parseFloat(fsRate2.rows[0]?.hourly_commission_rate ?? 12) / 100;
    const normalCommission2 = Math.round(driverAmount * commPct2);
    const { commission } = await useSubscriptionIfActive(b.driver_phone, booking_id, 'hourly', normalCommission2, client);
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
    await client.query(`UPDATE hourly_bookings SET status='completed', ended_at=NOW(), actual_hours=$1, driver_earning=$2, platform_fee=$3, refund_amount=$4, payment_status='released', early_end_confirmed=true WHERE id=$5`, [actualHours, driverEarning, commission, refund, booking_id]);
    await client.query('COMMIT');
    sendFCM(b.customer_phone, '✅ Trip Complete', isCustomerEnd ? 'Trip complete! Full payment sent to driver.' : `₹${refund} refunded to your wallet!`, {}, { role: 'customer' });
    sendFCM(b.driver_phone, '✅ Trip Complete!', `₹${driverEarning} earned — added to your wallet!`, {}, { role: 'driver' });
    res.json({ success: true, driver_earning: driverEarning, refund, actual_hours: actualHours.toFixed(1) });
  } catch (err) { await client.query('ROLLBACK'); console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
  finally { client.release(); }
});

// POST /api/hourly/customer-early-complete
router.post('/customer-early-complete', async (req, res) => {
  const { booking_id } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query("SELECT * FROM hourly_bookings WHERE id=$1 AND status='active'", [booking_id]);
    if (!r.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Active booking not found' }); }
    const b = r.rows[0];
    const actualHours = b.started_at ? (Date.now() - new Date(b.started_at).getTime()) / 3600000 : 0;
    const driverAmount = parseFloat(b.base_fare);
    const fsRate3 = await client.query('SELECT hourly_commission_rate FROM fare_settings WHERE vehicle_type=$1 LIMIT 1', [b.vehicle_type]);
    const commPct3 = parseFloat(fsRate3.rows[0]?.hourly_commission_rate ?? 12) / 100;
    const normalCommission3 = Math.round(driverAmount * commPct3);
    const { commission } = await useSubscriptionIfActive(b.driver_phone, booking_id, 'hourly', normalCommission3, client);
    const driverEarning = driverAmount - commission;
    const driverUser = await client.query('SELECT id FROM users WHERE phone=$1', [b.driver_phone]);
    if (driverUser.rows[0]) {
      await client.query('UPDATE driver_wallet SET balance=balance+$1, total_earned=total_earned+$1 WHERE driver_id=$2', [driverEarning, driverUser.rows[0].id]);
      await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Hourly - customer early complete full payment')", [driverUser.rows[0].id, driverEarning]);
    }
    await client.query(`UPDATE hourly_bookings SET status='completed', ended_at=NOW(), actual_hours=$1, driver_earning=$2, platform_fee=$3, refund_amount=0, payment_status='released', early_end_confirmed=true, early_end_requested_by='customer' WHERE id=$4`, [actualHours, driverEarning, commission, booking_id]);
    await client.query('COMMIT');
    const io = getIO();
    if (io) io.to('hourly_' + booking_id).emit('hourlyTripCompleted', { driver_earning: driverEarning });
    sendFCM(b.driver_phone, '✅ Customer Completed the Trip!', `Full payment ₹${driverEarning.toFixed(0)} earned — added to your wallet!`, {}, { role: 'driver' });
    res.json({ success: true, driver_earning: driverEarning, actual_hours: actualHours.toFixed(1) });
  } catch (err) { await client.query('ROLLBACK'); console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
  finally { client.release(); }
});

// POST /api/hourly/early-end-reject
router.post('/early-end-reject', async (req, res) => {
  const { booking_id } = req.body;
  try {
    const r = await db.query('UPDATE hourly_bookings SET early_end_requested_by=NULL, early_end_reject_count=COALESCE(early_end_reject_count,0)+1, early_end_last_rejected_at=NOW() WHERE id=$1 RETURNING early_end_reject_count', [booking_id]);
    const count = r.rows[0]?.early_end_reject_count || 1;
    res.json({ success: true, reject_count: count, locked: count >= 2 });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/cancel
router.post('/cancel', async (req, res) => {
  const { booking_id } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT * FROM hourly_bookings WHERE id=$1 AND status IN ('pending','matched','arrived')`,
      [booking_id]
    );
    if (!r.rows[0]) { await client.query('ROLLBACK'); return res.json({ success: false, message: 'Cannot cancel — ride is already started or completed' }); }
    const b = r.rows[0];
    const cu = await client.query('SELECT id FROM users WHERE phone=$1', [b.customer_phone]);
    if (cu.rows[0]) {
      await client.query('UPDATE customer_wallet SET balance=balance+$1 WHERE user_id=$2', [b.base_fare, cu.rows[0].id]);
      await client.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Hourly booking cancelled - refund')", [cu.rows[0].id, b.base_fare]);
    }
    await client.query("UPDATE hourly_bookings SET status='cancelled', payment_status='refunded' WHERE id=$1", [booking_id]);
    await client.query('COMMIT');
    // Notify driver if they were already assigned
    if (b.driver_phone) {
      sendFCM(b.driver_phone, '❌ Booking Cancelled', 'Customer cancelled the hourly booking', { type: 'hourly_cancelled', booking_id: String(booking_id) }, { role: 'driver' }).catch(() => {});
      emitToRoom('hourly_' + booking_id, 'hourlyCancelled', { booking_id });
    }
    res.json({ success: true, refunded: b.base_fare });
  } catch (err) { await client.query('ROLLBACK'); console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
  finally { client.release(); }
});

// POST /api/hourly/customer-confirm-complete
router.post('/customer-confirm-complete', async (req, res) => {
  const { booking_id } = req.body;
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE id=$1 AND pending_customer_confirm=true AND status='active'", [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'No confirmation pending' });
    const result = await doCompleteHourly(booking_id, r.rows[0].actual_km || 0);
    res.json({ success: true, ...result });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/customer-dispute-complete
router.post('/customer-dispute-complete', async (req, res) => {
  const { booking_id } = req.body;
  try {
    const r = await db.query("UPDATE hourly_bookings SET pending_customer_confirm=false, dispute_raised=true WHERE id=$1 AND pending_customer_confirm=true RETURNING driver_phone", [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'No pending confirmation' });
    sendFCM(r.rows[0].driver_phone, '⚠️ Customer Raised a Dispute', 'Admin will review — payment is in escrow', {}, { role: 'driver' });
    res.json({ success: true, message: 'Dispute raised — admin will resolve within 24h' });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/request-extend
router.post('/request-extend', async (req, res) => {
  const { booking_id, extra_hours, customer_phone } = req.body;
  if (!extra_hours || extra_hours < 1) return res.json({ success: false, message: 'Minimum 1 hour extension required' });
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE id=$1 AND status='active'", [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'Active booking not found' });
    const b = r.rows[0];
    if (b.extend_requested_hours) return res.json({ success: false, message: 'Extension request already pending' });
    const pkg = HOURLY_FARES[b.vehicle_type];
    const extraFare = pkg?.[extra_hours]?.fare
      ? Math.round(pkg[extra_hours].fare * getSurge())
      : Math.round((parseFloat(b.base_fare) / parseFloat(b.package_hours)) * extra_hours * getSurge());
    const cu = await db.query('SELECT id FROM users WHERE phone=$1', [customer_phone]);
    if (!cu.rows[0]) return res.json({ success: false, message: 'User not found' });
    const wallet = await db.query('SELECT balance FROM customer_wallet WHERE user_id=$1', [cu.rows[0].id]);
    const balance = parseFloat(wallet.rows[0]?.balance || 0);
    if (balance < extraFare) return res.json({ success: false, message: `Wallet needs ₹${extraFare}, your balance is ₹${balance.toFixed(0)}` });
    await db.query('UPDATE customer_wallet SET balance=balance-$1 WHERE user_id=$2', [extraFare, cu.rows[0].id]);
    await db.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'debit',$2,'Hourly extend request - escrow')", [cu.rows[0].id, extraFare]);
    await db.query('UPDATE hourly_bookings SET extend_requested_hours=$1, extend_escrow=$2 WHERE id=$3', [extra_hours, extraFare, booking_id]);
    sendFCM(b.driver_phone, `📅 Customer Wants +${extra_hours}h Extension`, `₹${extraFare} in escrow — accept or reject in the app`, {}, { role: 'driver' });
    res.json({ success: true, extra_fare: extraFare, message: `₹${extraFare} held — waiting for driver to accept` });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/accept-extend
router.post('/accept-extend', async (req, res) => {
  const { booking_id } = req.body;
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id=$1 AND extend_requested_hours IS NOT NULL', [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'No extension request found' });
    const b = r.rows[0];
    const extraHours = parseFloat(b.extend_requested_hours);
    const newHours = parseFloat(b.package_hours) + extraHours;
    const extraKm = Math.round((parseFloat(b.km_included) / parseFloat(b.package_hours)) * extraHours);
    const newKm = parseFloat(b.km_included) + extraKm;
    const newFare = parseFloat(b.base_fare) + parseFloat(b.extend_escrow);
    const extMinutes = Math.round(extraHours * 60);
    await db.query(
      `UPDATE hourly_bookings SET package_hours=$1, km_included=$2, base_fare=$3, total_fare=$3, extend_requested_hours=NULL, extend_escrow=0,
       extend_total_minutes=COALESCE(extend_total_minutes,0)+$4, extend_total_fare=COALESCE(extend_total_fare,0)+$5 WHERE id=$6`,
      [newHours, newKm, newFare, extMinutes, parseFloat(b.extend_escrow), booking_id]
    );
    sendFCM(b.customer_phone, '✅ Extension Accepted!', `Trip extended to ${newHours >= 24 ? (newHours/24)+'d' : newHours+'h'} — ${newKm} km included`, { type: 'hourly_extension_result', booking_id: String(booking_id), accepted: 'true' }, { role: 'customer' });
    const io = getIO();
    if (io) io.to('hourly_' + booking_id).emit('hourlyExtensionResult', { accepted: true, new_hours: newHours, new_km: newKm, new_fare: newFare });
    res.json({ success: true, new_hours: newHours, new_km: newKm, new_fare: newFare });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/reject-extend
router.post('/reject-extend', async (req, res) => {
  const { booking_id } = req.body;
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id=$1 AND extend_requested_hours IS NOT NULL', [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'No extension request found' });
    const b = r.rows[0];
    if (parseFloat(b.extend_escrow || 0) > 0) {
      const cu = await db.query('SELECT id FROM users WHERE phone=$1', [b.customer_phone]);
      if (cu.rows[0]) {
        await db.query('UPDATE customer_wallet SET balance=balance+$1 WHERE user_id=$2', [b.extend_escrow, cu.rows[0].id]);
        await db.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Hourly extend rejected - refund')", [cu.rows[0].id, b.extend_escrow]);
      }
    }
    await db.query('UPDATE hourly_bookings SET extend_requested_hours=NULL, extend_escrow=0 WHERE id=$1', [booking_id]);
    sendFCM(b.customer_phone, '❌ Extension Rejected', `₹${parseFloat(b.extend_escrow || 0).toFixed(0)} refunded to your wallet`, { type: 'hourly_extension_result', booking_id: String(booking_id), accepted: 'false' }, { role: 'customer' });
    const io = getIO();
    if (io) io.to('hourly_' + booking_id).emit('hourlyExtensionResult', { accepted: false, refund: parseFloat(b.extend_escrow || 0) });
    res.json({ success: true });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/update-km
router.post('/update-km', async (req, res) => {
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
    if (kmPct >= 0.80 && !b.km_alert_sent) {
      await db.query('UPDATE hourly_bookings SET km_alert_sent=TRUE WHERE id=$1', [booking_id]);
      sendFCM(b.customer_phone, '📍 Package KM Limit Reached', `${actual_km} km travelled — package included ${b.km_included} km. Extra charges of ₹${HOURLY_FARES[b.vehicle_type]?.extra || 8}/km will now apply.`, {}, { role: 'customer' });
      sendFCM(b.driver_phone, '📍 Customer Exceeded Package KM', `${actual_km}/${b.km_included} km. Extra charges will apply to the customer.`, {}, { role: 'driver' });
      alerts.push('km_alert');
    }
    if (timePct >= 0.80 && !b.time_alert_sent) {
      await db.query('UPDATE hourly_bookings SET time_alert_sent=TRUE WHERE id=$1', [booking_id]);
      const minLeft = Math.max(0, Math.round(totalMin - elapsedMin));
      sendFCM(b.customer_phone, '⏰ Time Almost Up!', `Only ~${minLeft} min left. Need more time? Extend from the app.`, {}, { role: 'customer' });
      sendFCM(b.driver_phone, '⏰ Trip Time 80% Complete', `${Math.round(elapsedMin)}/${Math.round(totalMin)} min elapsed.`, {}, { role: 'driver' });
      alerts.push('time_alert');
    }
    const extraKmCharge = Math.max(0, actual_km - parseFloat(b.km_included)) * (HOURLY_FARES[b.vehicle_type]?.extra || 8);
    res.json({ success: true, alerts, km_pct: Math.round(kmPct * 100), time_pct: Math.round(timePct * 100), extra_km_charge: extraKmCharge });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/hourly/extend-cost
router.get('/extend-cost', async (req, res) => {
  const { booking_id, extra_hours, extra_minutes } = req.query;
  try {
    const r = await db.query('SELECT * FROM hourly_bookings WHERE id=$1', [booking_id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Booking not found' });
    const b = r.rows[0];
    const pkg = HOURLY_FARES[b.vehicle_type];
    const extraHours = parseFloat(extra_hours || 0);
    const extraMin = parseInt(extra_minutes || 0);
    const totalExtraDecimalHours = extraHours + extraMin / 60;
    let extraFare = 0;
    if (extraHours >= 1 && pkg?.[extraHours]) {
      extraFare = Math.round(pkg[extraHours].fare * getSurge());
    } else {
      const perHourRate = parseFloat(b.base_fare) / parseFloat(b.package_hours);
      extraFare = Math.round(perHourRate * totalExtraDecimalHours * getSurge());
    }
    const extraKm = extraHours >= 1 && pkg?.[extraHours]
      ? pkg[extraHours].km
      : Math.round((parseFloat(b.km_included) / parseFloat(b.package_hours)) * totalExtraDecimalHours);
    res.json({ extra_fare: extraFare, extra_km: extraKm, extra_hours: extraHours, extra_minutes: extraMin, per_km_rate: pkg?.extra || 8 });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/request-extend-v2
router.post('/request-extend-v2', async (req, res) => {
  const { booking_id, extra_hours, extra_minutes, customer_phone } = req.body;
  const extraHours = parseFloat(extra_hours || 0);
  const extraMin = parseInt(extra_minutes || 0);
  const totalExtraDecimalHours = extraHours + extraMin / 60;
  if (totalExtraDecimalHours <= 0) return res.json({ success: false, message: 'Minimum 15 minutes extension required' });
  if (extraMin > 0 && extraMin < 15) return res.json({ success: false, message: 'Minutes must be at least 15 for an extension' });
  try {
    const r = await db.query("SELECT * FROM hourly_bookings WHERE id=$1 AND status='active'", [booking_id]);
    if (!r.rows[0]) return res.json({ success: false, message: 'Active booking not found' });
    const b = r.rows[0];
    if (b.extend_requested_hours) return res.json({ success: false, message: 'Extension request already pending' });
    const pkg = HOURLY_FARES[b.vehicle_type];
    let extraFare = 0;
    if (extraHours >= 1 && pkg?.[extraHours]) {
      extraFare = Math.round(pkg[extraHours].fare * getSurge());
    } else {
      const perHourRate = parseFloat(b.base_fare) / parseFloat(b.package_hours);
      extraFare = Math.round(perHourRate * totalExtraDecimalHours * getSurge());
    }
    const cu = await db.query('SELECT id FROM users WHERE phone=$1', [customer_phone]);
    if (!cu.rows[0]) return res.json({ success: false, message: 'User not found' });
    const wallet = await db.query('SELECT balance FROM customer_wallet WHERE user_id=$1', [cu.rows[0].id]);
    const balance = parseFloat(wallet.rows[0]?.balance || 0);
    if (balance < extraFare) return res.json({ success: false, message: `Wallet needs ₹${extraFare}, your balance is ₹${balance.toFixed(0)}` });
    await db.query('UPDATE customer_wallet SET balance=balance-$1 WHERE user_id=$2', [extraFare, cu.rows[0].id]);
    await db.query("INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'debit',$2,'Hourly extend request v2 - escrow')", [cu.rows[0].id, extraFare]);
    await db.query('UPDATE hourly_bookings SET extend_requested_hours=$1, extend_escrow=$2 WHERE id=$3', [totalExtraDecimalHours, extraFare, booking_id]);
    const label = extraHours >= 1 ? `${extraHours}h${extraMin > 0 ? ` ${extraMin}m` : ''}` : `${extraMin} min`;
    sendFCM(b.driver_phone, `📅 Customer Wants +${label} Extension`, `₹${extraFare} in escrow — accept or reject in the app`, { type: 'hourly_extend', booking_id: String(booking_id) }, { role: 'driver' });
    const io = getIO();
    if (io) io.to('hourly_' + booking_id).emit('hourlyExtendRequest', { booking_id, extra_hours: totalExtraDecimalHours, extra_fare: extraFare, label });
    res.json({ success: true, extra_fare: extraFare, label, message: `₹${extraFare} held — waiting for driver to accept` });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/hourly/chat/send
router.post('/chat/send', async (req, res) => {
  const { booking_id, sender, message } = req.body;
  if (!booking_id || !sender || !message) return res.status(400).json({ error: 'booking_id, sender, message required' });
  try {
    const created_at = new Date();

    // First-message FCM: notify the other party only on their very first message
    if (sender === 'driver') {
      const prev = await db.query(
        `SELECT 1 FROM chat_messages WHERE ride_id=$1 AND sender='driver' LIMIT 1`,
        [`h_${booking_id}`]
      );
      if (prev.rows.length === 0) {
        const b = await db.query('SELECT customer_phone FROM hourly_bookings WHERE id=$1', [booking_id]);
        if (b.rows[0]) {
          sendFCM(
            b.rows[0].customer_phone,
            '💬 New Message from Driver!',
            message.length > 60 ? message.slice(0, 57) + '...' : message,
            { type: 'new_chat_message', booking_id: String(booking_id) },
            { role: 'customer' }
          );
        }
      }
    }

    await db.query('INSERT INTO chat_messages (ride_id, sender, message) VALUES ($1,$2,$3)', [`h_${booking_id}`, sender, message]);
    emitToRoom('hourly_' + booking_id, 'hourlyChatMessage', { sender, message, created_at });
    res.json({ success: true });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// GET /api/hourly/chat/:id
router.get('/chat/:id', async (req, res) => {
  try {
    const r = await db.query('SELECT sender, message, created_at FROM chat_messages WHERE ride_id=$1 ORDER BY created_at ASC', [`h_${req.params.id}`]);
    res.json({ messages: r.rows });
  } catch (err) { console.error('[hourly]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

module.exports = router;
