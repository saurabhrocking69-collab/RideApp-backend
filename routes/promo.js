const express = require('express');
const router = express.Router();
const db = require('../config/db');

// POST /api/promo/validate
router.post('/validate', async (req, res) => {
  const { code, fare, phone } = req.body;
  try {
    const promo = await db.query(`SELECT * FROM promo_codes WHERE UPPER(code) = UPPER($1) AND active = true`, [code]);
    if (promo.rows.length === 0) return res.json({ valid: false, message: 'Galat promo code' });
    const p = promo.rows[0];
    if (p.expires_at && new Date(p.expires_at) < new Date())
      return res.json({ valid: false, message: 'Promo code expire ho gaya' });
    if (p.used_count >= p.usage_limit)
      return res.json({ valid: false, message: 'Promo code limit khatam' });
    if (parseFloat(fare) < parseFloat(p.min_fare))
      return res.json({ valid: false, message: `Minimum ₹${p.min_fare} ki ride chahiye` });
    const user = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (user.rows.length > 0) {
      const used = await db.query('SELECT id FROM promo_usage WHERE user_id = $1 AND promo_code = $2', [user.rows[0].id, code.toUpperCase()]);
      if (used.rows.length > 0) return res.json({ valid: false, message: 'Aap yeh code pehle use kar chuke' });
    }
    let discount = p.discount_type === 'percent'
      ? Math.round(parseFloat(fare) * parseFloat(p.discount_value) / 100)
      : parseFloat(p.discount_value);
    if (discount > parseFloat(p.max_discount)) discount = parseFloat(p.max_discount);
    res.json({ valid: true, discount, final_fare: Math.max(0, Math.round(parseFloat(fare) - discount)), message: `₹${discount} discount!` });
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

module.exports = router;
