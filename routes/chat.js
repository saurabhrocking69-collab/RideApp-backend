const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { emitToRoom } = require('../config/socket');
const { sendFCM } = require('../config/firebase');

// POST /api/chat/send
router.post('/send', async (req, res) => {
  const { ride_id, sender, message } = req.body;
  try {
    // First-message FCM: notify customer only on driver's very first message
    if (sender === 'driver') {
      const prev = await db.query(
        `SELECT 1 FROM chat_messages WHERE ride_id=$1 AND sender='driver' LIMIT 1`,
        [ride_id]
      );
      if (prev.rows.length === 0) {
        const r = await db.query(
          `SELECT u.phone FROM rides ri JOIN users u ON ri.passenger_id = u.id WHERE ri.id=$1`,
          [ride_id]
        );
        if (r.rows[0]) {
          sendFCM(
            r.rows[0].phone,
            '💬 Driver ne Message Kiya!',
            message.length > 60 ? message.slice(0, 57) + '...' : message,
            { type: 'new_chat_message', ride_id: String(ride_id) },
            { role: 'customer' }
          );
        }
      }
    }

    await db.query('INSERT INTO chat_messages (ride_id, sender, message) VALUES ($1,$2,$3)', [ride_id, sender, message]);
    emitToRoom('ride_' + ride_id, 'chatMessage', { sender, message, created_at: new Date() });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/chat/:rideId
router.get('/:rideId', async (req, res) => {
  try {
    const r = await db.query('SELECT sender, message, created_at FROM chat_messages WHERE ride_id = $1 ORDER BY created_at ASC', [req.params.rideId]);
    res.json({ messages: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
