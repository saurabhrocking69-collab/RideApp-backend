const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { emitToRoom } = require('../config/socket');
const { sendFCM } = require('../config/firebase');

// POST /api/chat/send  (works for standard rides AND hourly rides via 'h_' prefix)
router.post('/send', async (req, res) => {
  const { ride_id, sender, message } = req.body;
  if (!ride_id || !sender || !message) return res.status(400).json({ error: 'ride_id, sender, message required' });

  const isHourly  = typeof ride_id === 'string' && ride_id.startsWith('h_');
  const bookingId = isHourly ? ride_id.slice(2) : null;

  try {
    // First-message FCM — notify the other party only once
    if (sender === 'driver') {
      const prev = await db.query(
        `SELECT 1 FROM chat_messages WHERE ride_id=$1 AND sender='driver' LIMIT 1`,
        [ride_id]
      );
      if (prev.rows.length === 0) {
        let customerPhone = null;
        if (isHourly) {
          const b = await db.query('SELECT customer_phone FROM hourly_bookings WHERE id=$1', [bookingId]);
          customerPhone = b.rows[0]?.customer_phone;
        } else {
          const r = await db.query(
            `SELECT u.phone FROM rides ri JOIN users u ON ri.passenger_id::text = u.id::text WHERE ri.id=$1`,
            [ride_id]
          );
          customerPhone = r.rows[0]?.phone;
        }
        if (customerPhone) {
          sendFCM(
            customerPhone,
            '💬 Driver ne Message Kiya!',
            message.length > 60 ? message.slice(0, 57) + '...' : message,
            { type: 'new_chat_message', ride_id: String(ride_id) },
            { role: 'customer' }
          );
        }
      }
    }

    await db.query(
      'INSERT INTO chat_messages (ride_id, sender, message) VALUES ($1,$2,$3)',
      [ride_id, sender, message]
    );

    // Emit to the correct socket room
    if (isHourly) {
      emitToRoom('hourly_' + bookingId, 'hourlyChatMessage', { sender, message, created_at: new Date() });
    } else {
      emitToRoom('ride_' + ride_id, 'chatMessage', { sender, message, created_at: new Date() });
    }

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/chat/:rideId  (works for both standard 'rideId' and hourly 'h_55')
router.get('/:rideId', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT sender, message, created_at FROM chat_messages WHERE ride_id = $1 ORDER BY created_at ASC',
      [req.params.rideId]
    );
    res.json({ messages: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
