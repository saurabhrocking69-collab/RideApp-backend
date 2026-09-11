const express = require('express');
const router = express.Router();
const userAuth = require('../middleware/userAuth');
const { ridePartyOrBooking } = require('../middleware/rideParty');
const db = require('../config/db');
const { emitToRoom } = require('../config/socket');
const { sendFCM } = require('../config/firebase');
/* Pehra ek switch ke peeche - wahi jo baaki niji data par hai.

   Bina iske koi bhi ride id badal-badal kar kisi ki baat-cheet padh sakta
   hai, uski ride me sandesh bhej sakta hai, aur uske driver ko phone bhi
   laga sakta hai - jo Exotel par asli paisa kharch karta hai. */
const ENFORCE_PDATA = String(process.env.PDATA_AUTH_ENFORCE || '').trim().toLowerCase() === 'true';

/* Chat ka apna switch - aur uske hone ki ek thos wajah hai.

   PDATA chalu karte hi driver ki chat toot gayi. Live log ne pakda:

       [auth 401] token-nahi  GET /api/chat/<ride>
       [auth 401] token-nahi  POST /api/chat/send

   Source me `authFetch` hai (commit 345556c, 8 sept), par driver ke phone par
   usse PURANA build pada hai jo saada `fetch` karta hai. Source theek hona aur
   LOGON KE PHONE par theek hona do alag baatein hain, aur ek pehra doosri wali
   par girta hai.

   Poora PDATA band kar dena sabse aasan hota - aur teen darjan darwaze dobara
   khol deta. Ek chhoti toot ke badle ek badi. Isliye sirf yahi ek raasta.

   Default PDATA hi hai: kuchh set na ho to bartaav aaj jaisa. Ise 'false'
   karna SIRF utni der ke liye hai jab tak naya build phone tak na pahunche,
   aur uske baad ye env line hata deni hai. */
const CHAT_ENFORCE = (() => {
  const v = String(process.env.CHAT_AUTH_ENFORCE || '').trim().toLowerCase();
  if (v === 'true')  return true;
  if (v === 'false') return false;
  return ENFORCE_PDATA;
})();
if (!CHAT_ENFORCE && ENFORCE_PDATA)
  console.warn('[chat] pehra ASTHAYI ROOP SE BAND hai (CHAT_AUTH_ENFORCE=false) '
             + '- purane driver build ke liye. Naya build pahunchte hi ise hataao.');

const openDoorPD = (_req, _res, next) => next();
const gUser = CHAT_ENFORCE ? userAuth : openDoorPD;
const gParty = (f, b) => (CHAT_ENFORCE ? ridePartyOrBooking(f, b) : openDoorPD);


// POST /api/chat/send  (works for standard rides AND hourly rides via 'h_' prefix)
router.post('/send', gUser, gParty('ride_id'), async (req, res) => {
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
            '💬 New Message from Driver!',
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
router.get('/:rideId', gUser, gParty('rideId'), async (req, res) => {
  try {
    const r = await db.query(
      'SELECT sender, message, created_at FROM chat_messages WHERE ride_id = $1 ORDER BY created_at ASC',
      [req.params.rideId]
    );
    res.json({ messages: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
