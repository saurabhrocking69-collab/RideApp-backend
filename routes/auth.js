const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { sendOtpSms, smsProviderName } = require('../services/sms');
const axios = require('axios');
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
   Only verify-otp uses it today, but it stays factored out on purpose: the
   account rules — what counts as a new signup, when a partner may claim one,
   how a name is allowed to change — must not get copied into whatever second
   way in gets added next, because copies drift. The caller is responsible for
   having actually proven the number first; this does not check anything. */
/* A phone that was only claimed, taken by somebody who can prove it.

   A Google signup types a number; it does not demonstrate holding the handset.
   An OTP does. So if this number is sitting on an account that never proved it
   (phone_verified = false) and somebody now arrives having read the code sent
   to it, the prover is the owner and the claim loses.

   The claiming account is NOT handed over. It may have rides and a wallet
   behind it, and giving those to a different person because they proved a
   phone number would be its own kind of theft. Its phone is released instead -
   rewritten to something no signup can collide with - and it keeps everything
   it had. Its owner still signs in through Google, and is asked for a number
   again, because the one they typed was not theirs.

   Costs one extra SELECT on a path that runs once per login. */
async function releaseClaimedPhone(phone) {
  const held = await db.query(
    'SELECT id, google_sub, phone_verified FROM users WHERE phone = $1', [phone]);
  if (!held.rows.length) return false;
  const u = held.rows[0];
  if (u.phone_verified !== false) return false;   // proved, or an old account: leave it alone
  // Not ten digits, so no future signup can ever be handed this string, and
  // the Google route reads it as "this account still needs a number".
  await db.query('UPDATE users SET phone = $1 WHERE id = $2', ['released:' + u.id, u.id]);
  console.warn('[auth] phone ' + phone + ' released from unproven account ' + u.id + ' — proved by OTP');
  return true;
}

async function issueSession(phone, name, partnerCode) {
  await releaseClaimedPhone(phone);
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
    const provider = smsProviderName();

    /* Test number wali chhoot AB SIRF TAB hai jab koi provider hi na ho.

       Wo chhoot us daur ki hai jab prod par koi SMS provider tha hi nahi -
       bina uske kuch bhi jaancha nahi ja sakta tha. Uski keemat ye thi ki
       server OTP ko apne hi jawab me laut-a deta tha, jo ek khula darwaza hai.

       Ab SMS sach me jaata hai, to us darwaze ki koi wajah nahi bachi: test
       number ko bhi asli SMS milega, baaki sabki tarah. TEST_OTP_PHONES aur
       ALLOW_TEST_OTP ko hataya nahi gaya - agar kabhi provider band ho jaye to
       wo aakhri sahara bane rahe. */
    if (!provider && isTestPhone(phone)) {
      return res.json({ message: 'Test number — OTP returned here', success: true, otp });
    }
    if (!provider) {
      console.error('send-otp: no SMS provider configured');
      return res.status(503).json({ error: 'We cannot send SMS right now. Please try again shortly.' });
    }

    const sent = await sendOtpSms(phone, otp);
    if (!sent.ok) {
      // Wajah log me, aadmi ko nahi - usme provider ki apni baatein hoti hain.
      console.error('send-otp: ' + sent.provider + ' ne mana kiya:', sent.reason);
      await redis.del('otp:sent:' + phone);   // turant dobara try kar sake
      return res.status(502).json({ error: 'Could not send the OTP. Please try again.' });
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

/* ══ GOOGLE SIGN-IN ═══════════════════════════════════════════════════════

   Why this exists: there is no SMS provider on production, so send-otp has
   nothing to send and nobody new can get in at all. This is a second door.

   What it does NOT do, and this is the whole design: it does not let anybody
   into an account that already exists. Google proves an email; it does not
   prove a phone number, and in this app the phone IS the identity - it is what
   the driver rings at the pickup point. A flow that let somebody sign in with
   Google, type a stranger's number and land in their account would be a worse
   version of the OTP takeover that was closed in August, because it would not
   even need an OTP.

   So the rule is narrow and it is enforced below: a Google signup may only
   take a phone number that NO account holds. If the number is taken, it is
   refused - no merging, no "claiming", no exceptions. Two accounts belonging
   to the same person is a nuisance the shop can fix; one account belonging to
   the wrong person is not.

   And every number that arrives this way is written down as unproven
   (phone_verified = false), because it was typed, not demonstrated. When SMS
   comes back, that flag is what tells the two apart. */

const GOOGLE_AUDS = () => String(process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);

/* Verified with Google, not with the phone that sent it.

   The client hands over an ID token. Anyone can post anything to this route,
   so the token is checked against Google's own endpoint and the audience is
   checked against OUR client ids - a valid Google token minted for somebody
   else's app is still a valid Google token, and without the aud check it would
   be accepted here. */
async function verifyGoogleToken(idToken) {
  const auds = GOOGLE_AUDS();
  if (!auds.length) throw new Error('Google sign-in is not configured on the server.');
  /* axios, not fetch. fetch is only global from Node 18, and the deployed
     runtime here is not pinned anywhere - no engines field, no Dockerfile. A
     sign-in route that throws ReferenceError on the host is a worse bug than a
     dependency, and axios is already in this project. */
  let t;
  try {
    const r = await axios.get('https://oauth2.googleapis.com/tokeninfo',
      { params: { id_token: idToken }, timeout: 10000 });
    t = r.data || {};
  } catch (_e) {
    throw new Error('That Google sign-in could not be verified.');
  }
  if (!t.sub) throw new Error('That Google sign-in could not be verified.');
  if (!auds.includes(String(t.aud))) throw new Error('That Google sign-in was not issued for this app.');
  // Google's own word on whether the address is real. A Google account with an
  // unverified email is not proof of anything.
  if (String(t.email_verified) !== 'true') throw new Error('That Google account has no verified email.');
  return { sub: String(t.sub), email: String(t.email || '').toLowerCase(), name: String(t.name || '').trim() };
}

/* A short-lived ticket instead of trusting the client's second request.

   Signup is two steps - Google, then the phone - and the second step must not
   simply believe a `sub` posted to it, or anybody could claim any Google
   identity by typing its id. The ticket is signed by us, carries what Google
   told us, and dies in ten minutes. */
const googleTicket = (g) => jwt.sign(
  { gsub: g.sub, email: g.email, gname: g.name, kind: 'gsignup' },
  process.env.JWT_SECRET, { expiresIn: '10m' });

// POST /api/auth/google  { idToken, partner_code? }
router.post('/google', async (req, res) => {
  try {
    const g = await verifyGoogleToken(String(req.body.idToken || ''));

    const found = await db.query('SELECT * FROM users WHERE google_sub = $1', [g.sub]);
    if (found.rows.length) {
      const u = found.rows[0];
      // The email can change on Google's side; the sub cannot. Keep ours current.
      if (g.email && g.email !== u.email) {
        await db.query('UPDATE users SET email = $1 WHERE id = $2', [g.email, u.id]);
        u.email = g.email;
      }
      /* Their number may have been released to somebody who proved it by
         OTP - see releaseClaimedPhone. Then this account has no usable phone
         and cannot be ridden with, so ask for one before letting them in
         rather than handing back a session with a dead number in it. */
      if (!/^[0-9]{10}$/.test(String(u.phone || ''))) {
        return res.json({
          needPhone: true, ticket: googleTicket(g), email: g.email, name: u.name || g.name,
          reason: 'phone_released',
        });
      }
      const token = jwt.sign({ id: u.id, phone: u.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
      return res.json({ token, user: u, isNew: false });
    }

    /* Nobody yet. We cannot make an account without a phone - the column is
       NOT NULL and the driver has to be able to ring somebody. So the app is
       told to ask for one, and given a ticket to come back with. */
    res.json({
      needPhone: true,
      ticket: googleTicket(g),
      email: g.email,
      name: g.name,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/google/phone  { ticket, phone, name?, partner_code? }
router.post('/google/phone', async (req, res) => {
  try {
    let t;
    try { t = jwt.verify(String(req.body.ticket || ''), process.env.JWT_SECRET); }
    catch (_e) { return res.status(401).json({ error: 'That sign-in took too long. Please try again.' }); }
    if (t.kind !== 'gsignup' || !t.gsub) return res.status(401).json({ error: 'Please sign in with Google again.' });

    const phone = String(req.body.phone || '').replace(/\D/g, '');
    if (phone.length !== 10) return res.status(400).json({ error: 'Please enter a valid 10-digit phone number' });

    // Same hold a normal signup faces - a deleted number is closed to
    // everybody, and going around it through this door would make the hold a
    // formality.
    const hold = await phoneDeletionHold(phone);
    if (hold) return res.status(403).json({
      error: `This number's account was deleted. You can create a new account with it in ${hold.days_left} day${hold.days_left === 1 ? '' : 's'}.`,
      account_deleted: true, days_left: hold.days_left,
    });

    /* THE line. A Google sign-in has proved an email and nothing else, so it
       may only take a number that nobody holds. Refusing here is what stops
       this door from being a way into somebody else's account. */
    const taken = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (taken.rows.length) return res.status(409).json({
      /* Kya hua, aur ab kya karein - dono. Pehla sandesh sirf pehla aadha
         kehta tha ("us number se sign in karo"), aur wo salah abhi kaam ki
         bhi nahi hai: prod par koi SMS provider nahi hai, to OTP wala raasta
         band pada hai. Aadmi ko wahi batao jo wo sach me kar sakta hai. */
      error: 'This number is already registered to another account. Try a different number, or sign in with the Google account that already has it.',
      phone_taken: true,
    });

    /* Already known to us: either a repeat submit, or an account whose number
       was released to somebody who proved it. Give the number to the account
       they already have - a second account for the same Google identity would
       split their rides in half. */
    const already = await db.query('SELECT * FROM users WHERE google_sub = $1', [t.gsub]);
    if (already.rows.length) {
      const u = already.rows[0];
      if (!/^[0-9]{10}$/.test(String(u.phone || ''))) {
        const upd = await db.query(
          'UPDATE users SET phone = $1, phone_verified = FALSE WHERE id = $2 RETURNING *', [phone, u.id]);
        const fixed = upd.rows[0];
        const tok = jwt.sign({ id: fixed.id, phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
        return res.json({ token: tok, user: fixed, isNew: false });
      }
      const token = jwt.sign({ id: u.id, phone: u.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
      return res.json({ token, user: u, isNew: false });
    }

    const name = String(req.body.name || t.gname || 'User').trim().slice(0, 60) || 'User';
    const ins = await db.query(
      `INSERT INTO users (phone, name, role, google_sub, email, phone_verified)
       VALUES ($1, $2, 'passenger', $3, $4, FALSE) RETURNING *`,
      [phone, name, t.gsub, t.email || null]);
    const u = ins.rows[0];

    if (req.body.partner_code) {
      require('./partner')
        .attributeSignup(u.id, phone, 'passenger', req.body.partner_code, 'code')
        .catch(() => {});
    }

    const token = jwt.sign({ id: u.id, phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: u, isNew: true });
  } catch (err) {
    // A racing insert on the unique index lands here rather than as a 500.
    if (String(err.message || '').includes('users_phone_key'))
      return res.status(409).json({ error: 'That number already has an account.', phone_taken: true });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
