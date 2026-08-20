const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const userAuth = require('../middleware/userAuth');
const ownPhone = require('../middleware/ownPhone');
const { redis } = require('../config/redis');
// A number whose account was deleted is held closed for a while before it can
// be used again — see routes/account.js. Checked in BOTH otp endpoints: the
// test-OTP path skips send-otp entirely, so guarding only there would leave
// the hold trivially bypassable.
const { phoneDeletionHold } = require('./account');

/* TEST OTP — deliberately narrow, because the wide version was a live account
   takeover of the entire user base.

   It used to be one switch, ALLOW_TEST_OTP=true, which did two things at once:
   send-otp put the real OTP into its own RESPONSE BODY, and verify-otp accepted
   '000000' for ANY number. That switch was on in production. Anyone who could
   POST to a public endpoint could ask for a phone they did not own, read the
   OTP straight out of the JSON, and log in as that person. Both apps sign in
   through these two endpoints, so it covered riders and drivers alike —
   wallets, ride history, earnings, saved addresses, and the ability to book or
   accept rides in someone else's name.

   Testing still needs a door, so one survives: it opens only for numbers named
   in TEST_OTP_PHONES. Unset or empty means no bypass exists at all, and that is
   what production should run with. ALLOW_TEST_OTP now grants nothing — leaving
   it set somewhere can no longer reopen this. */
const testPhones = () => String(process.env.TEST_OTP_PHONES || '')
  .split(',').map(s => s.trim()).filter(s => /^[0-9]{10}$/.test(s));
const isTestPhone = (phone) => testPhones().includes(String(phone || ''));

/* One place that turns a PROVEN phone number into a logged-in session.
   verify-otp and the Truecaller route both end here, so the account rules —
   what counts as a new signup, when a partner may claim one, how a name is
   allowed to change — cannot drift apart between the two ways in. The caller
   is responsible for having actually proven the number first. */
async function issueSession(phone, name, partnerCode) {
  let user = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
  const isNew = user.rows.length === 0;
  if (isNew) {
    user = await db.query("INSERT INTO users (phone, name, role) VALUES ($1, $2, 'passenger') RETURNING *", [phone, name || 'User']);
    // Partner attribution, only ever on a genuinely NEW account. Attaching an
    // existing rider to a partner would let anyone claim the whole existing
    // user base by entering a code on a later login.
    if (partnerCode) {
      require('./partner')
        .attributeSignup(user.rows[0].id, phone, 'passenger', partnerCode, 'code')
        .catch(() => {});
    }
  } else if (name && name.trim() !== '' && name !== 'Rider') {
    await db.query('UPDATE users SET name = $1 WHERE phone = $2', [name.trim(), phone]);
    user.rows[0].name = name.trim();
  }
  const token = jwt.sign({ id: user.rows[0].id, phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
  return { token, user: user.rows[0], isNew };
}

/* Indian mobile numbers arrive from Truecaller as E.164 (+919876543210) and
   from the apps as ten digits. Everything downstream — the users table, redis
   keys, the driver's call button — assumes ten digits, so anything else is
   rejected rather than stored in a shape nothing else understands. */
function toTenDigit(raw) {
  const d = String(raw || '').replace(/[^0-9]/g, '');
  const ten = d.length > 10 && d.startsWith('91') ? d.slice(-10) : d;
  return /^[6-9][0-9]{9}$/.test(ten) ? ten : null;
}

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length !== 10) return res.status(400).json({ error: 'Please enter a valid 10-digit phone number' });
  try {
    const hold = await phoneDeletionHold(phone);
    if (hold) return res.status(403).json({
      error: `This number's account was deleted. You can create a new account with it in ${hold.days_left} day${hold.days_left === 1 ? '' : 's'}.`,
      account_deleted: true, days_left: hold.days_left,
    });
    const blocked = await redis.get('otp:block:' + phone);
    if (blocked) {
      const ttl = await redis.ttl('otp:block:' + phone);
      return res.status(429).json({ error: `Too many attempts! Please try again in ${Math.ceil(ttl / 60)} min` });
    }
    const recentSend = await redis.get('otp:sent:' + phone);
    if (recentSend) {
      const ttl = await redis.ttl('otp:sent:' + phone);
      return res.status(429).json({ error: `Please wait ${ttl} seconds before resending` });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await redis.setEx('otp:' + phone, 600, otp);
    await redis.setEx('otp:sent:' + phone, 30, '1');
    await redis.del('otp:attempts:' + phone);
    /* Delivery is reported honestly. This used to fire Fast2SMS, swallow any
       error, and answer "OTP sent, success: true" regardless — including when
       no provider was configured at all, in which case nothing was ever sent
       and the person just watched a code that did not exist never arrive. */
    if (isTestPhone(phone)) {
      return res.json({ message: 'Test number — OTP returned here', success: true, otp });
    }
    if (!process.env.FAST2SMS_API_KEY) {
      console.error('send-otp: no SMS provider configured (FAST2SMS_API_KEY unset)');
      return res.status(503).json({ error: 'We cannot send SMS right now. Please try again shortly.' });
    }
    try {
      const smsRes = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: { authorization: process.env.FAST2SMS_API_KEY },
        body: new URLSearchParams({ route: 'otp', variables_values: otp, flash: '0', numbers: phone }),
      });
      const body = await smsRes.json().catch(() => null);
      // Fast2SMS answers 200 with { return: false } for a rejected send, so the
      // status code on its own is not enough to call this delivered.
      if (!smsRes.ok || (body && body.return === false)) {
        console.error('send-otp: Fast2SMS rejected', smsRes.status, JSON.stringify(body || '').slice(0, 200));
        await redis.del('otp:sent:' + phone);   // let them retry at once
        return res.status(502).json({ error: 'Could not send the OTP. Please try again.' });
      }
    } catch (smsErr) {
      console.error('send-otp: SMS send failed:', smsErr.message);
      await redis.del('otp:sent:' + phone);
      return res.status(502).json({ error: 'Could not send the OTP. Check your connection and try again.' });
    }

    res.json({ message: 'OTP sent', success: true });
  } catch (err) {
    console.error('send-otp error:', err.message);
    res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  const { phone, otp, name } = req.body;
  try {
    const hold = await phoneDeletionHold(phone);
    if (hold) return res.status(403).json({
      error: `This number's account was deleted. You can create a new account with it in ${hold.days_left} day${hold.days_left === 1 ? '' : 's'}.`,
      account_deleted: true, days_left: hold.days_left,
    });
    const blocked = await redis.get('otp:block:' + phone);
    if (blocked) {
      const ttl = await redis.ttl('otp:block:' + phone);
      return res.status(429).json({ error: `Account blocked! Please try again in ${Math.ceil(ttl / 60)} min` });
    }
    const isTestOtp = otp === '000000' && isTestPhone(phone);
    const savedOtp = await redis.get('otp:' + phone);
    if (!savedOtp && !isTestOtp) return res.status(400).json({ error: 'OTP has expired! Please request a new one' });
    if (!isTestOtp && savedOtp !== otp) {
      const attempts = await redis.incr('otp:attempts:' + phone);
      await redis.expire('otp:attempts:' + phone, 300);
      if (attempts >= 3) {
        await redis.setEx('otp:block:' + phone, 1800, '1');
        await redis.del('otp:' + phone);
        return res.status(429).json({ error: '3 incorrect OTPs! Account blocked for 30 min' });
      }
      return res.status(400).json({ error: `Incorrect OTP! ${3 - attempts} attempt(s) remaining` });
    }
    if (!isTestOtp) {
      await redis.del('otp:' + phone);
      await redis.del('otp:attempts:' + phone);
      await redis.del('otp:sent:' + phone);
    }
    const { token, user } = await issueSession(phone, name, req.body.partner_code);
    res.json({ message: 'Login successful!', token, user });
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

/* The number a driver reaches you on, when you'd rather it not be your login
   number. Optional; blank means the login number is used, exactly as before.
   Resolution order lives in routes/call.js and routes/drivers.js:
     ride.rider_phone  >  users.call_phone  >  users.phone

   userAuth + ownPhone are NOT optional here. /update-name right below takes a
   phone straight from the body with no auth at all, and adding this field to
   that endpoint would have let anyone point another person's driver calls at a
   number they control — a rider waiting for a call that a stranger answers.
   A new endpoint can carry the check from day one without 403-ing the apps
   already installed, which is why this is separate rather than folded in. */
router.post('/call-phone', userAuth, ownPhone(), async (req, res) => {
  const { phone, call_phone } = req.body;
  try {
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS call_phone VARCHAR(15)').catch(() => {});
    const given = String(call_phone == null ? '' : call_phone).trim();
    let raw = given.replace(/\D/g, '');
    // People paste "+91 98765 43210" and "098765 43210" as often as they type
    // ten bare digits. Drop a country/trunk prefix only when doing so leaves
    // exactly ten — never a blind slice(-10), which would silently turn an
    // 11-digit typo into a valid-looking number belonging to someone else.
    if (raw.length === 12 && raw.startsWith('91')) raw = raw.slice(2);
    else if (raw.length === 11 && raw.startsWith('0')) raw = raw.slice(1);

    // Blank clears it. But "abc" also strips to blank, and treating that as a
    // clear would silently wipe a number the user had already saved while they
    // thought they were editing it — so only a genuinely empty input clears.
    if (!given) {
      await db.query('UPDATE users SET call_phone=NULL WHERE phone=$1', [phone]);
      return res.json({ success: true, call_phone: null });
    }
    if (!/^[6-9][0-9]{9}$/.test(raw))
      return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
    await db.query('UPDATE users SET call_phone=$1 WHERE phone=$2', [raw, phone]);
    res.json({ success: true, call_phone: raw });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/call-phone — what's currently set (blank = login number is used)
router.get('/call-phone', userAuth, ownPhone(), async (req, res) => {
  try {
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS call_phone VARCHAR(15)').catch(() => {});
    const r = await db.query('SELECT call_phone FROM users WHERE phone=$1', [req.query.phone]);
    res.json({ call_phone: r.rows[0]?.call_phone || null });
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


/* ── POST /api/auth/truecaller ───────────────────────────────────────────
   One-tap sign-in for the ~90% of Indian Android users who already have
   Truecaller installed. It matters here for a reason beyond convenience: it
   proves a number without sending an SMS at all, so it works even while no
   SMS provider is configured, and it costs nothing per login.

   The security rule is the whole point of doing this server-side. The app
   sends an authorization code, NEVER a phone number. Only the number that
   Truecaller's own profile API hands back is treated as proven. If the app
   were allowed to say who it is, this endpoint would be a worse hole than the
   test-OTP one it helps replace.

   Endpoints are overridable because Truecaller routes EU and non-EU traffic to
   different hosts; the defaults are the non-EU (India) pair. */
const TC_TOKEN_URL = process.env.TRUECALLER_TOKEN_URL || 'https://oauth-account-noneu.truecaller.com/v1/token';
const TC_USERINFO_URL = process.env.TRUECALLER_USERINFO_URL || 'https://oauth-account-noneu.truecaller.com/v1/userinfo';

/* Truecaller issues a separate credential per Android package, so the two apps
   have two different client ids. The token exchange has to use the SAME one
   that produced the authorization code, so the app tells us which it used and
   we check it against the ids we actually know — anything else is refused
   rather than forwarded. A client id is not a secret (it ships inside the APK
   and PKCE is what makes that safe), so the check is about sending the right
   one, not about guarding it.
   TRUECALLER_CLIENT_ID stays supported as a single-app fallback. */
const tcClients = () => ({
  customer: process.env.TRUECALLER_CLIENT_ID_CUSTOMER || process.env.TRUECALLER_CLIENT_ID || '',
  driver:   process.env.TRUECALLER_CLIENT_ID_DRIVER   || process.env.TRUECALLER_CLIENT_ID || '',
});

router.post('/truecaller', async (req, res) => {
  const { authorizationCode, codeVerifier, partner_code, client_id, role } = req.body || {};
  const known = tcClients();
  if (!known.customer && !known.driver) {
    return res.status(503).json({ error: 'Truecaller sign-in is not set up yet.' });
  }
  // Prefer the id the app names; fall back to its role; then to whichever is
  // configured. Never fall back to "some other app's id" — that exchange would
  // fail at Truecaller anyway, just with a far less obvious error.
  const clientId = client_id
    ? (Object.values(known).includes(client_id) ? client_id : null)
    : (role === 'driver' ? known.driver : known.customer);
  if (!clientId) {
    console.error('[truecaller] unrecognised client_id from app');
    return res.status(400).json({ error: 'Truecaller sign-in could not be verified. Please use OTP.' });
  }
  if (!authorizationCode || !codeVerifier) {
    return res.status(400).json({ error: 'Truecaller sign-in did not complete. Please use OTP.' });
  }
  try {
    // 1. Code + verifier -> access token. PKCE, so there is no client secret.
    const tokenRes = await fetch(TC_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: authorizationCode,
        code_verifier: codeVerifier,
      }),
    });
    const tokenBody = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokenBody || !tokenBody.access_token) {
      console.error('truecaller: token exchange failed', tokenRes.status, JSON.stringify(tokenBody || '').slice(0, 200));
      return res.status(401).json({ error: 'Could not verify with Truecaller. Please use OTP.' });
    }

    // 2. The only source of the phone number we will trust.
    const infoRes = await fetch(TC_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    const profile = await infoRes.json().catch(() => null);
    if (!infoRes.ok || !profile) {
      console.error('truecaller: userinfo failed', infoRes.status);
      return res.status(401).json({ error: 'Could not read your Truecaller profile. Please use OTP.' });
    }

    const phone = toTenDigit(profile.phone_number || profile.phoneNumber);
    if (!phone) {
      console.error('truecaller: unusable phone in profile');
      return res.status(400).json({ error: 'Truecaller did not return an Indian mobile number. Please use OTP.' });
    }

    // The same closed-account hold the OTP path enforces. Skipping it here
    // would make Truecaller the way around a deletion.
    const hold = await phoneDeletionHold(phone);
    if (hold) return res.status(403).json({
      error: `This number's account was deleted. You can create a new account with it in ${hold.days_left} day${hold.days_left === 1 ? '' : 's'}.`,
      account_deleted: true, days_left: hold.days_left,
    });

    const name = [profile.given_name, profile.family_name].filter(Boolean).join(' ').trim();
    const { token, user, isNew } = await issueSession(phone, name, partner_code);
    res.json({ message: 'Login successful!', token, user, phone, is_new: isNew, via: 'truecaller' });
  } catch (err) {
    console.error('truecaller error:', err.message);
    res.status(500).json({ error: 'Sign-in failed. Please use OTP.' });
  }
});
module.exports = router;
