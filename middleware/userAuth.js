const jwt = require('jsonwebtoken');

// Verifies the Bearer JWT issued at login (routes/auth.js) and attaches
// req.user = { id, phone } from its payload. Used on ride-mutation endpoints
// so a caller can only ever act as the phone number they actually logged in
// as — not whatever phone happens to be typed into the request body.
function userAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id, phone: decoded.phone };
    next();
  } catch (_e) {
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
}

module.exports = userAuth;
