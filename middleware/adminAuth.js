const adminAuth = (req, res, next) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return next();
  const provided = req.headers['x-admin-key'] || req.query._ak;
  if (provided !== secret) {
    return res.status(401).json({ error: 'Admin access denied', hint: 'Pass x-admin-key header or _ak query param' });
  }
  next();
};

module.exports = adminAuth;
