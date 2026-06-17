const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { emitToRoom } = require('../config/socket');

// POST /api/chat/send
router.post('/send', async (req, res) => {
  const { ride_id, sender, message } = req.body;
  try {
    await db.query('INSERT INTO chat_messages (ride_id, sender, message) VALUES ($1,$2,$3)', [ride_id, sender, message]);
    // Real-time push via Socket.io
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
