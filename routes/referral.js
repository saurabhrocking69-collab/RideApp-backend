const express = require('express');
const router = express.Router();
const db = require('../config/db');

function genReferralCode(name) {
  const base = (name || 'USER').substring(0, 4).toUpperCase().replace(/[^A-Z]/g, '');
  return base + Math.floor(1000 + Math.random() * 9000);
}

// GET /api/referral/my-code
router.get('/my-code', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query('SELECT id, name, referral_code FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) return res.json({ code: null });
    let code = user.rows[0].referral_code;
    if (!code) {
      code = genReferralCode(user.rows[0].name);
      await db.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, user.rows[0].id]);
    }
    const count = await db.query('SELECT COUNT(*) FROM referrals WHERE referrer_id = $1', [user.rows[0].id]);
    const earned = await db.query("SELECT COALESCE(SUM(reward_amount),0) AS total FROM referrals WHERE referrer_id = $1 AND status = 'completed'", [user.rows[0].id]);
    res.json({ code, total_referrals: parseInt(count.rows[0].count), total_earned: parseFloat(earned.rows[0].total) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/referral/apply
router.post('/apply', async (req, res) => {
  const { phone, referral_code } = req.body;
  try {
    const newUser = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (newUser.rows.length === 0) return res.json({ success: false, message: 'User nahi mila' });
    const referrer = await db.query('SELECT id FROM users WHERE referral_code = $1', [referral_code.toUpperCase()]);
    if (referrer.rows.length === 0) return res.json({ success: false, message: 'Galat referral code' });
    if (referrer.rows[0].id === newUser.rows[0].id) return res.json({ success: false, message: 'Apna hi code use nahi kar sakte' });
    const exists = await db.query('SELECT id FROM referrals WHERE referred_id = $1', [newUser.rows[0].id]);
    if (exists.rows.length > 0) return res.json({ success: false, message: 'Aap pehle referral use kar chuke' });
    const settingRow = await db.query(`SELECT value FROM reward_settings WHERE key='referral_reward'`);
    const reward = settingRow.rows[0] ? parseFloat(settingRow.rows[0].value) : 50;
    await db.query(
      `INSERT INTO referrals (referrer_id, referred_id, referral_code, reward_amount, status) VALUES ($1,$2,$3,$4,'completed')`,
      [referrer.rows[0].id, newUser.rows[0].id, referral_code.toUpperCase(), reward]
    );
    for (const uid of [referrer.rows[0].id, newUser.rows[0].id]) {
      await db.query('INSERT INTO customer_wallet (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [uid]);
      await db.query('UPDATE customer_wallet SET balance = balance + $1 WHERE user_id = $2', [reward, uid]);
      await db.query("INSERT INTO transactions (user_id, type, amount, description) VALUES ($1,'credit',$2,'Referral reward')", [uid, reward]);
    }
    res.json({ success: true, message: `₹${reward} reward dono ko mil gaya!` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
