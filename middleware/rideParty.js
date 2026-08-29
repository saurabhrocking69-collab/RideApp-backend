/* "Is ride me tumhara koi rishta hai kya?"

   ownPhone un endpoints ke liye hai jo insaan ko phone se pehchante hain.
   Par rides.js ke kai endpoint sirf ek ride id lete hain — /status/:rideId,
   /payment-complete, /rate, /driver-location/:rideId. Un par ownPhone lag hi
   nahi sakta: request me koi phone hai hi nahi.

   Aur wahi sabse khule the. Ride id ek chhota sa number hai; use badal-badal
   kar koi bhi kisi ki bhi ride ki poori haalat padh sakta tha — kaun aa raha
   hai, kahan hai, kitna paisa — aur /payment-complete par to kisi ki bhi ride
   ko "paisa mil gaya" bhi likh sakta tha.

   Isliye yahan sawal ulta poochha jaata hai: ride uthao, aur dekho ki jo call
   kar raha hai wo iska passenger hai ya iska driver. Teesra koi nahi.

   Usage:  router.get('/status/:rideId', userAuth, rideParty('rideId'), h)
           router.post('/rate',          userAuth, rideParty('ride_id'), h)
           router.post('/extension-accept', userAuth, extParty('extension_id'), h)

   Dhyan: ride abhi 'requested' me ho to driver_id khali hota hai — tab sirf
   passenger andar aata hai, jo sahi hai. Driver ko jo ride ABHI offer hui hai
   par usne li nahi, uske liye ye pehra nahi lagta (/accept par ownPhone
   ('driver_phone') hai) — warna naya offer lete hi matching tut jaati. */
const db = require('../config/db');

// Aakhri 10 ank par milaan, taaki +91 ya space wala number khud ko hi na roke
const norm = v => String(v || '').replace(/\D/g, '').slice(-10);

const pick = (req, field) => String(
  (req.body   && req.body[field])   ??
  (req.query  && req.query[field])  ??
  (req.params && req.params[field]) ??
  ''
).trim();

const rideParty = (field = 'ride_id') => async (req, res, next) => {
  const rideId = pick(req, field);
  if (!rideId) return res.status(400).json({ error: `${field} is required` });
  try {
    const r = await db.query(
      `SELECT r.id, r.status, p.phone AS passenger_phone, d.phone AS driver_phone
         FROM rides r
         LEFT JOIN users p ON p.id = r.passenger_id
         LEFT JOIN users d ON d.id = r.driver_id
        WHERE r.id = $1`, [rideId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Ride not found' });
    const me = norm(req.user && req.user.phone);
    const row = r.rows[0];
    if (me !== norm(row.passenger_phone) && me !== norm(row.driver_phone))
      return res.status(403).json({ error: 'This is not your ride' });
    req.ride = row;          // handler ko dobara query na karni pade
    next();
  } catch (e) {
    console.error('[rideParty]', e.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
};

/* Ride extension ka apna table hai, aur usme dono phone seedhe pade hain —
   ride tak jaane ki zaroorat hi nahi. */
const extParty = (field = 'extension_id') => async (req, res, next) => {
  const id = pick(req, field);
  if (!id) return res.status(400).json({ error: `${field} is required` });
  try {
    const r = await db.query(
      'SELECT id, customer_phone, driver_phone FROM ride_extensions WHERE id = $1', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Extension not found' });
    const me = norm(req.user && req.user.phone);
    const row = r.rows[0];
    if (me !== norm(row.customer_phone) && me !== norm(row.driver_phone))
      return res.status(403).json({ error: 'This is not your ride' });
    req.extension = row;
    next();
  } catch (e) {
    console.error('[extParty]', e.message);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
};

module.exports = rideParty;
module.exports.rideParty = rideParty;
module.exports.extParty = extParty;
