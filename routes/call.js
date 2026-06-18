const express = require('express');
const router = express.Router();
const db = require('../config/db');

// POST /api/call/initiate — Call initiation
// Uses Exotel if configured; otherwise falls back to direct dial.
router.post('/initiate', async (req, res) => {
  const { ride_id, booking_id, caller_role } = req.body;
  if (!caller_role || !['customer', 'driver'].includes(caller_role))
    return res.status(400).json({ error: 'caller_role must be customer or driver' });

  try {
    let callerPhone, targetPhone;

    if (ride_id) {
      const r = await db.query(
        `SELECT p.phone AS customer_phone, u.phone AS driver_phone
         FROM rides r
         JOIN users p ON r.passenger_id = p.id
         LEFT JOIN users u ON r.driver_id = u.id
         WHERE r.id = $1 AND r.status IN ('matched','arrived','started')`,
        [ride_id]
      );
      if (!r.rows[0]) return res.status(404).json({ success: false, error: 'Active ride nahi mili' });
      callerPhone = caller_role === 'customer' ? r.rows[0].customer_phone : r.rows[0].driver_phone;
      targetPhone = caller_role === 'customer' ? r.rows[0].driver_phone   : r.rows[0].customer_phone;
    } else if (booking_id) {
      const b = await db.query(
        `SELECT customer_phone, driver_phone FROM hourly_bookings WHERE id=$1 AND status IN ('matched','active')`,
        [booking_id]
      );
      if (!b.rows[0]) return res.status(404).json({ success: false, error: 'Active booking nahi mili' });
      callerPhone = caller_role === 'customer' ? b.rows[0].customer_phone : b.rows[0].driver_phone;
      targetPhone = caller_role === 'customer' ? b.rows[0].driver_phone   : b.rows[0].customer_phone;
    } else {
      return res.status(400).json({ error: 'ride_id ya booking_id chahiye' });
    }

    if (!targetPhone) return res.json({ success: false, error: 'Driver abhi assign nahi hua' });

    if (process.env.EXOTEL_SID && process.env.EXOTEL_API_KEY && process.env.EXOTEL_TOKEN && process.env.EXOTEL_CALLER_ID) {
      try {
        const authHeader = 'Basic ' + Buffer.from(`${process.env.EXOTEL_API_KEY}:${process.env.EXOTEL_TOKEN}`).toString('base64');
        const resp = await fetch(
          `https://api.exotel.com/v1/Accounts/${process.env.EXOTEL_SID}/Calls/connect`,
          {
            method: 'POST',
            headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ From: callerPhone, To: targetPhone, CallerId: process.env.EXOTEL_CALLER_ID, TimeLimit: '300' }),
          }
        );
        if (resp.ok) return res.json({ success: true, method: 'exotel', message: 'Call shuru ho rahi hai...' });
      } catch (exoErr) {
        console.error('Exotel call error:', exoErr.message);
      }
    }

    // Fallback: direct call (opens dialer with target's number)
    res.json({ success: true, method: 'direct', call_number: targetPhone });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
