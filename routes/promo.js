const express = require('express');
const router = express.Router();
const db = require('../config/db');

/* What a promo code is actually worth, decided here and nowhere else.

   This exists because /api/rides/book used to take the `discount` field
   straight out of the request body and write it onto the ride — no check that
   the code existed, was active, had not expired, was allowed for that rider,
   or was worth anything close to the number sent. Since net fare is
   `fare - discount`, a request carrying `discount: 5000` on a ₹200 ride simply
   produced a free ride. /validate had all the right rules; booking just never
   asked it.

   Returns the rupee value the code is genuinely worth, or 0 — with `reason`
   for the caller that wants to explain itself. */
async function resolvePromoDiscount(code, fare, phone) {
  if (!code) return { discount: 0, reason: 'No promo code' };
  const fareNum = parseFloat(fare) || 0;
  const promo = await db.query(`SELECT * FROM promo_codes WHERE UPPER(code) = UPPER($1) AND active = true`, [code]);
  if (promo.rows.length === 0) return { discount: 0, reason: 'Invalid promo code' };
  const p = promo.rows[0];
  if (p.expires_at && new Date(p.expires_at) < new Date())
    return { discount: 0, reason: 'Promo code has expired' };
  // The null check is load-bearing: `0 >= null` is TRUE in JS, so a promo with
  // no usage limit — which /api/promo/list explicitly allows and advertises —
  // used to report "usage limit reached" on its very first use and never work
  // at all.
  if (p.usage_limit != null && p.used_count >= p.usage_limit)
    return { discount: 0, reason: 'Promo code usage limit reached' };
  if (fareNum < parseFloat(p.min_fare))
    return { discount: 0, reason: `Minimum ₹${p.min_fare} ride required` };
  if (phone) {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length > 0) {
      const used = await db.query('SELECT id FROM promo_usage WHERE user_id = $1 AND promo_code = $2', [user.rows[0].id, String(code).toUpperCase()]);
      if (used.rows.length > 0) return { discount: 0, reason: 'You have already used this code' };
    }
  }
  let discount = p.discount_type === 'percent'
    ? Math.round(fareNum * parseFloat(p.discount_value) / 100)
    : parseFloat(p.discount_value);
  if (discount > parseFloat(p.max_discount)) discount = parseFloat(p.max_discount);
  // Never worth more than the ride itself.
  return { discount: Math.max(0, Math.min(discount, fareNum)), reason: null };
}

// POST /api/promo/validate
router.post('/validate', async (req, res) => {
  const { code, fare, phone } = req.body;
  try {
    // Same resolver booking uses. These rules were written out twice before,
    // which is how the screen and the charge end up disagreeing about what a
    // code is worth.
    const { discount, reason } = await resolvePromoDiscount(code, fare, phone);
    if (!discount) return res.json({ valid: false, message: reason || 'Invalid promo code' });
    res.json({ valid: true, discount, final_fare: Math.max(0, Math.round(parseFloat(fare) - discount)), message: `₹${discount} discount!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/promo/list
router.get('/list', async (req, res) => {
  try {
    const promos = await db.query(
      `SELECT code, discount_type, discount_value, max_discount, min_fare, expires_at
       FROM promo_codes WHERE active=true AND (expires_at IS NULL OR expires_at > NOW())
         AND (usage_limit IS NULL OR used_count < usage_limit)
       ORDER BY max_discount DESC LIMIT 20`
    );
    res.json({ promos: promos.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/promo/apply
router.post('/apply', async (req, res) => {
  const { code, phone, ride_id, discount } = req.body;
  try {
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ success: false });
    await db.query(`INSERT INTO promo_usage (user_id, promo_code, ride_id, discount_applied) VALUES ($1, $2, $3, $4)`,
      [user.rows[0].id, code.toUpperCase(), ride_id || null, discount]);
    await db.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE UPPER(code) = UPPER($1)`, [code]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The router stays the default export so app.use() is unchanged; the
// resolver hangs off it for routes/rides.js.
module.exports = router;
module.exports.resolvePromoDiscount = resolvePromoDiscount;
