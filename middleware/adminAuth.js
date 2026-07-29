const crypto = require('crypto');

// Fails CLOSED if ADMIN_SECRET isn't configured — previously this fell
// through to next() unauthenticated, silently opening every /api/admin/*
// route if the env var was ever missing on a deploy.
const adminAuth = (req, res, next) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ error: 'Admin access not configured' });
  const provided = req.headers['x-admin-key'];
  if (!provided || !timingSafeEqualStrings(String(provided), secret)) {
    return res.status(401).json({ error: 'Admin access denied', hint: 'Pass x-admin-key header' });
  }
  next();
};

// Constant-time string compare — hash both sides to a fixed-length digest
// first so crypto.timingSafeEqual (which requires equal-length buffers) never
// throws on a mismatched-length input, and so length itself leaks no timing signal.
function timingSafeEqualStrings(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = adminAuth;
