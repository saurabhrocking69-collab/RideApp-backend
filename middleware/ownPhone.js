/* "The phone in this request must be the caller's own."
   Most endpoints on this platform identify a person by a phone number in the
   body or query. userAuth proves WHO is calling; this proves they are asking
   about themselves. Both are needed — without this, any logged-in user can
   read or spend any other account simply by typing their number.

   Lives here rather than being copied into each router so the rule has one
   definition. It was written four times in four files before this, which is
   how a fifth file ends up quietly not having it.

   Usage:  router.post('/redeem', userAuth, ownPhone(), handler)
           router.post('/accept', userAuth, ownPhone('driver_phone'), handler)
*/
module.exports = (field = 'phone') => (req, res, next) => {
  // Body, query or path. /driver/level/:phone carries it in the URL, and a
  // check that only read the body would pass it through untested.
  const given = String(
    (req.body && req.body[field]) ??
    (req.query && req.query[field]) ??
    (req.params && req.params[field]) ??
    ''
  ).trim();
  if (!given) return res.status(400).json({ error: `${field} is required` });
  // Compared on the last 10 digits, so a number stored or sent with +91 or
  // spaces does not lock a legitimate caller out of their own account.
  const norm = v => String(v).replace(/\D/g, '').slice(-10);
  if (norm(req.user && req.user.phone) !== norm(given))
    return res.status(403).json({ error: 'You can only act on your own account' });
  next();
};
