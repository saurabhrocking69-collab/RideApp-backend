const jwt = require('jsonwebtoken');
const { authDenied } = require('./authDenied');

// Verifies the Bearer JWT issued at login (routes/auth.js) and attaches
// req.user = { id, phone } from its payload. Used on ride-mutation endpoints
// so a caller can only ever act as the phone number they actually logged in
// as — not whatever phone happens to be typed into the request body.
function userAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  /* "token tha hi nahi" aur "token galat tha" - do alag baatein, aur alag-alag
     likhi jaati hain. Pehli ka matlab hai koi app us raaste par token bhejti hi
     nahi: wo asli gadbad hai aur usi din theek honi chahiye. Doosri ka matlab
     hai kisi ka session khatam ho gaya - wo roz hota hai aur theek hai. Dono ko
     ek hi naam se likhte to pehli wali doosri ke shor me kho jaati. */
  if (!token) { authDenied(req, 'token-nahi'); return res.status(401).json({ error: 'Login required' }); }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id, phone: decoded.phone };
    next();
  } catch (_e) {
    authDenied(req, 'token-galat');
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
}

module.exports = userAuth;
