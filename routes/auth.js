const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { redis } = require('../config/redis');

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 10) return res.status(400).json({ error: 'Sahi phone number do' });
  try {
    const blocked = await redis.get('otp:block:' + phone);
    if (blocked) {
      const ttl = await redis.ttl('otp:block:' + phone);
      return res.status(429).json({ error: `Bahut zyada attempts! ${Math.ceil(ttl / 60)} min baad try karo` });
    }
    const recentSend = await redis.get('otp:sent:' + phone);
    if (recentSend) {
      const ttl = await redis.ttl('otp:sent:' + phone);
      return res.status(429).json({ error: `${ttl} second baad resend karo` });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await redis.setEx('otp:' + phone, 600, otp);
    await redis.setEx('otp:sent:' + phone, 30, '1');
    await redis.del('otp:attempts:' + phone);
    // Fast2SMS integration (set FAST2SMS_API_KEY env var)
    if (process.env.FAST2SMS_API_KEY) {
      try {
        await fetch('https://www.fast2sms.com/dev/bulkV2', {
          method: 'POST',
          headers: { authorization: process.env.FAST2SMS_API_KEY },
          body: new URLSearchParams({ route: 'otp', variables_values: otp, flash: '0', numbers: phone }),
        });
      } catch (smsErr) { console.log('SMS send error:', smsErr.message); }
    }

    const testMode = process.env.ALLOW_TEST_OTP === 'true';
    res.json({ message: 'OTP bheja gaya', success: true, ...(testMode ? { otp } : {}) });
  } catch (err) {
    console.error('send-otp error:', err.message);
    res.status(500).json({ error: 'OTP bhejne mein dikkat. Dobara try karo.' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  const { phone, otp, name } = req.body;
  try {
    const blocked = await redis.get('otp:block:' + phone);
    if (blocked) {
      const ttl = await redis.ttl('otp:block:' + phone);
      return res.status(429).json({ error: `Account blocked! ${Math.ceil(ttl / 60)} min baad try karo` });
    }
    const isTestOtp = otp === '000000' && process.env.ALLOW_TEST_OTP === 'true';
    const savedOtp = await redis.get('otp:' + phone);
    if (!savedOtp && !isTestOtp) return res.status(400).json({ error: 'OTP expire ho gaya! Dobara bhejwao' });
    if (!isTestOtp && savedOtp !== otp) {
      const attempts = await redis.incr('otp:attempts:' + phone);
      await redis.expire('otp:attempts:' + phone, 300);
      if (attempts >= 3) {
        await redis.setEx('otp:block:' + phone, 1800, '1');
        await redis.del('otp:' + phone);
        return res.status(429).json({ error: '3 baar galat OTP! 30 min ke liye block ho gaya' });
      }
      return res.status(400).json({ error: `Galat OTP! ${3 - attempts} aur chances bache hain` });
    }
    if (!isTestOtp) {
      await redis.del('otp:' + phone);
      await redis.del('otp:attempts:' + phone);
      await redis.del('otp:sent:' + phone);
    }
    let user = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (user.rows.length === 0) {
      user = await db.query("INSERT INTO users (phone, name, role) VALUES ($1, $2, 'passenger') RETURNING *", [phone, name || 'User']);
    } else {
      if (name && name.trim() !== '' && name !== 'Rider') {
        await db.query('UPDATE users SET name = $1 WHERE phone = $2', [name.trim(), phone]);
        user.rows[0].name = name.trim();
      }
    }
    const token = jwt.sign({ id: user.rows[0].id, phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ message: 'Login successful!', token, user: user.rows[0] });
  } catch (err) {
    console.error('verify-otp error:', err.message);
    res.status(500).json({ error: `Login error: ${err.message}` });
  }
});

// POST /api/auth/refresh — issue a new 30-day token from a valid existing one
router.post('/refresh', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await db.query('SELECT id, phone FROM users WHERE id = $1', [decoded.id]);
    if (!user.rows.length) return res.status(401).json({ error: 'User not found' });
    const newToken = jwt.sign(
      { id: user.rows[0].id, phone: user.rows[0].phone },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token: newToken });
  } catch {
    res.status(401).json({ error: 'Token expired or invalid — please login again' });
  }
});

// POST /api/auth/update-name
router.post('/update-name', async (req, res) => {
  const { phone, name, gender } = req.body;
  try {
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(10)').catch(() => {});
    await db.query('UPDATE users SET name=$1, gender=$2 WHERE phone=$3', [name, gender || null, phone]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/save-fcm-token
router.post('/save-fcm-token', async (req, res) => {
  const { phone, token, role } = req.body;
  try {
    // Ensure driver_fcm_token column exists (idempotent migration)
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_fcm_token TEXT').catch(() => {});
    if (role === 'driver') {
      await db.query('UPDATE users SET driver_fcm_token = $1 WHERE phone = $2', [token, phone]);
    } else {
      await db.query('UPDATE users SET fcm_token = $1 WHERE phone = $2', [token, phone]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/check-status
router.get('/check-status', async (req, res) => {
  const { phone } = req.query;
  try {
    const user = await db.query(
      `SELECT is_suspended, suspended_until, suspend_reason, is_blocked, block_reason, admin_message FROM users WHERE phone = $1`,
      [phone]
    );
    if (user.rows.length === 0) return res.json({ status: 'ok' });
    const u = user.rows[0];
    if (u.is_suspended && u.suspended_until && new Date(u.suspended_until) < new Date()) {
      await db.query(`UPDATE users SET is_suspended = false, suspended_until = NULL WHERE phone = $1`, [phone]);
      return res.json({ status: 'ok' });
    }
    if (u.is_blocked) return res.json({ status: 'blocked', reason: u.block_reason });
    if (u.is_suspended) {
      const minsLeft = u.suspended_until ? Math.ceil((new Date(u.suspended_until) - new Date()) / 60000) : 0;
      return res.json({ status: 'suspended', reason: u.suspend_reason, mins_left: minsLeft });
    }
    res.json({ status: 'ok', admin_message: u.admin_message });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
