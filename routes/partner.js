/* ══════════════════════════════════════════════════════════════════════════
   EARN WITH SPPERO — partner programme
   ══════════════════════════════════════════════════════════════════════════

   A partner brings customers and drivers onto Sppero and earns a share of the
   commission those people generate. Single level only: a partner earns from
   people they personally brought, never from people those people brought.
   Going deeper turns this into a money-circulation scheme under the Prize
   Chits and Money Circulation Schemes (Banning) Act, 1978 — do not add depth
   without legal advice.

   THE SPLIT, when a ride has two partners
   A ride produces ONE commission. If the customer was brought by partner A
   and the driver by partner B, they cannot both take 60% of it. So the rule
   is: the partner pool is `rate` % of the ride's commission, divided equally
   between the distinct partners on that ride. Sppero therefore always keeps
   at least (100 - rate)%, whatever the referral situation, and a partner who
   brought both sides takes the whole pool.

   IDEMPOTENCY
   Accrual runs from ride settlement, which has two entry points and can be
   retried. The unique index on (ride_id, partner_id) is what prevents a
   double payment — not a counter, and not an application check. Every wallet
   bug this platform has had was a guard living in code that ran twice.
   ══════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

// ── Schema ────────────────────────────────────────────────────────────────
db.query(`
  CREATE TABLE IF NOT EXISTS partners (
    id             SERIAL PRIMARY KEY,
    name           TEXT NOT NULL,
    -- Phone is the login and is deliberately NOT verified: money goes to the
    -- bank account entered at withdrawal, never to this number, so a typo
    -- costs the partner nothing and misdirects nothing.
    phone          VARCHAR(20) NOT NULL UNIQUE,
    email          TEXT,
    password_hash  TEXT NOT NULL,
    -- Recovery. The answer is hashed exactly like the password: it is a
    -- credential, not a profile field.
    security_q     TEXT,
    security_a_hash TEXT,
    reset_attempts INTEGER DEFAULT 0,
    locked_until   TIMESTAMPTZ,
    code           VARCHAR(16) NOT NULL UNIQUE,
    pan            VARCHAR(10),
    bank_name      TEXT,
    bank_account   TEXT,
    bank_ifsc      TEXT,
    upi_id         TEXT,
    -- Set whenever bank details change. Withdrawals are held until it passes,
    -- so an account takeover cannot immediately redirect the money.
    bank_hold_until TIMESTAMPTZ,
    terms_version  TEXT,
    terms_accepted_at TIMESTAMPTZ,
    status         TEXT NOT NULL DEFAULT 'active',
    created_at     TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() => db.query(`
  CREATE TABLE IF NOT EXISTS partner_referrals (
    id           SERIAL PRIMARY KEY,
    partner_id   INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    -- users.id is a UUID on this platform
    user_id      TEXT NOT NULL,
    user_phone   VARCHAR(20),
    role         TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'code',
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )
`)).then(() =>
  // ONE attribution per referred person, ever. Two partners claiming the same
  // driver stops being an argument and becomes a timestamp.
  db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_partner_referral_user
            ON partner_referrals (user_id)`)
).then(() => db.query(`
  CREATE TABLE IF NOT EXISTS partner_earnings (
    id           SERIAL PRIMARY KEY,
    partner_id   INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    -- rides.id is a UUID on this platform, as is every other ride_id column
    -- in the schema. An INTEGER here would have failed on the first real ride.
    ride_id      UUID NOT NULL,
    referred_user_id TEXT,
    referred_role TEXT,
    fare         NUMERIC(10,2),
    commission   NUMERIC(10,2) NOT NULL,
    rate_percent NUMERIC(5,2) NOT NULL,
    share_of     INTEGER NOT NULL DEFAULT 1,
    amount       NUMERIC(10,2) NOT NULL,
    -- Sits in holding until this passes, so a refund or reversal claws back
    -- before the money has left.
    available_at TIMESTAMPTZ NOT NULL,
    state        TEXT NOT NULL DEFAULT 'accrued',
    payout_id    INTEGER,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )
`)).then(() =>
  // The real guard. A ride can legitimately produce two rows (customer's
  // partner and driver's partner) but never two for the SAME partner.
  db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_partner_earning_ride
            ON partner_earnings (ride_id, partner_id)`)
).then(() => db.query(`
  CREATE TABLE IF NOT EXISTS partner_claims (
    id           SERIAL PRIMARY KEY,
    partner_id   INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    phone        VARCHAR(20) NOT NULL,
    role_claimed TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    admin_note   TEXT,
    reviewed_by  TEXT,
    reviewed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )
`)).then(() => db.query(`
  CREATE TABLE IF NOT EXISTS partner_payouts (
    id           SERIAL PRIMARY KEY,
    partner_id   INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    gross        NUMERIC(10,2) NOT NULL,
    tds          NUMERIC(10,2) NOT NULL DEFAULT 0,
    net          NUMERIC(10,2) NOT NULL,
    method       TEXT,
    reference    TEXT,
    status       TEXT NOT NULL DEFAULT 'requested',
    admin_note   TEXT,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    settled_at   TIMESTAMPTZ
  )
`)).then(() => db.query(`
  CREATE TABLE IF NOT EXISTS partner_events (
    id         SERIAL PRIMARY KEY,
    partner_id INTEGER REFERENCES partners(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    detail     TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`)).catch(err => console.error('[partner] schema init failed:', err.message));

// ── Settings ──────────────────────────────────────────────────────────────
// Everything tunable lives in reward_settings so it can be changed from admin
// without a deploy. That is what makes an open-ended rate safe to promise:
// the policy reserves the right to change it, and this is how it is changed.
/* reward_settings.value is NUMERIC(10,2), and node-postgres hands numerics
   back as STRINGS to avoid precision loss — so a stored 0 arrives as '0.00',
   not '0'. Everything here is therefore compared as a number. Written the
   other way, `value !== '0'` would have been true for '0.00' and the kill
   switch would have silently left the programme running. */
const SETTING_DEFAULTS = {
  partner_enabled:         1,
  partner_rate_percent:    60,
  partner_min_payout:      200,
  partner_hold_days:       7,
  partner_bank_hold_hours: 48,
  partner_tds_percent:     5,
  partner_tds_threshold:   15000,
};
const SETTING_LABELS = {
  partner_enabled:         'Partner programme on (1) / off (0)',
  partner_rate_percent:    'Partner share of ride commission (%)',
  partner_min_payout:      'Minimum partner withdrawal (₹)',
  partner_hold_days:       'Days earnings are held before withdrawal',
  partner_bank_hold_hours: 'Hours withdrawals are held after a bank change',
  partner_tds_percent:     'TDS on partner payouts (%, s194H)',
  partner_tds_threshold:   'TDS threshold per financial year (₹)',
};

// Seeded with labels so they appear meaningfully in the existing admin
// rewards screen, which lists every reward_settings row.
db.query(`INSERT INTO reward_settings (key, value, label)
          VALUES ${Object.keys(SETTING_DEFAULTS).map((_, i) => `($${i*3+1},$${i*3+2},$${i*3+3})`).join(',')}
          ON CONFLICT (key) DO NOTHING`,
  Object.entries(SETTING_DEFAULTS).flatMap(([k, v]) => [k, v, SETTING_LABELS[k]]))
  .catch(() => { /* table not ready yet on a cold boot — defaults still apply */ });

async function partnerSettings() {
  const out = { ...SETTING_DEFAULTS };
  try {
    const r = await db.query(`SELECT key, value FROM reward_settings WHERE key LIKE 'partner_%'`);
    r.rows.forEach(row => {
      const n = parseFloat(row.value);
      if (Number.isFinite(n)) out[row.key] = n;
    });
  } catch (_) { /* table missing on a fresh db — defaults stand */ }
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  return {
    enabled:      num(out.partner_enabled, 1) !== 0,
    rate:         Math.min(100, Math.max(0, num(out.partner_rate_percent, 60))),
    minPayout:    Math.max(0, num(out.partner_min_payout, 200)),
    holdDays:     Math.max(0, Math.round(num(out.partner_hold_days, 7))),
    bankHoldHrs:  Math.max(0, Math.round(num(out.partner_bank_hold_hours, 48))),
    tdsPercent:   Math.max(0, num(out.partner_tds_percent, 5)),
    tdsThreshold: Math.max(0, num(out.partner_tds_threshold, 15000)),
  };
}

// ── Codes ─────────────────────────────────────────────────────────────────
// No 0/O/1/I — these get read off a shop counter and typed by someone else.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(name) {
  const base = String(name || 'SPP').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'SPP';
  let tail = '';
  for (let i = 0; i < 4; i++) tail += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return base + tail;
}

async function uniqueCode(name) {
  for (let i = 0; i < 12; i++) {
    const c = makeCode(name);
    const hit = await db.query('SELECT 1 FROM partners WHERE code = $1', [c]);
    if (!hit.rows.length) return c;
  }
  return 'SPP' + Date.now().toString(36).toUpperCase().slice(-6);
}

/* ══ ACCRUAL ══════════════════════════════════════════════════════════════
   Called from ride settlement once the ride is completed and paid. Never at
   booking, never on a cancelled ride.

   Deliberately does its own lookup rather than trusting what settlement
   passes in: the caller knows the ride and the commission, but the partner
   attribution is this module's business.

   Never throws. A partner-programme failure must not roll back a driver's
   payment — the earning can be reconciled later, a failed ride settlement
   cannot.
   ═══════════════════════════════════════════════════════════════════════ */
async function accruePartnerEarnings(rideId, commission) {
  try {
    const s = await partnerSettings();
    if (!s.enabled || !(commission > 0) || !rideId) return;

    const ride = await db.query(
      `SELECT r.id, r.fare, r.discount, r.passenger_id, r.driver_id
         FROM rides r WHERE r.id = $1`, [rideId]
    );
    if (!ride.rows[0]) return;
    const { passenger_id, driver_id } = ride.rows[0];
    const fare = Math.max(0, parseFloat(ride.rows[0].fare || 0) - parseFloat(ride.rows[0].discount || 0));

    // Who has a partner on this ride — customer side, driver side, or both.
    const ids = [passenger_id, driver_id].filter(Boolean).map(String);
    if (!ids.length) return;
    const refs = await db.query(
      `SELECT pr.partner_id, pr.user_id, pr.role
         FROM partner_referrals pr
         JOIN partners p ON p.id = pr.partner_id AND p.status = 'active'
        WHERE pr.user_id = ANY($1::text[])`, [ids]
    );
    if (!refs.rows.length) return;

    // One partner may hold both sides of the same ride — they are one earner,
    // not two, and take the whole pool.
    const byPartner = new Map();
    refs.rows.forEach(r => { if (!byPartner.has(r.partner_id)) byPartner.set(r.partner_id, r); });

    const pool  = Math.round(commission * (s.rate / 100) * 100) / 100;
    const share = byPartner.size;
    const each  = Math.round((pool / share) * 100) / 100;
    if (!(each > 0)) return;

    for (const [partnerId, ref] of byPartner) {
      await db.query(
        `INSERT INTO partner_earnings
           (partner_id, ride_id, referred_user_id, referred_role, fare, commission,
            rate_percent, share_of, amount, available_at, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW() + ($10 || ' days')::interval, 'accrued')
         ON CONFLICT (ride_id, partner_id) DO NOTHING`,
        [partnerId, rideId, ref.user_id, ref.role, fare, commission,
         s.rate, share, each, String(s.holdDays)]
      );
    }
  } catch (err) {
    console.error('[partner] accrual failed for ride', rideId, err.message);
  }
}

/* Reverses a ride's partner earnings — a refund, a reversed payment, a ride
   voided after settlement. Only touches money still in holding; anything
   already paid out is left alone and becomes an admin matter, because
   clawing back cash already sent is a conversation, not a database update. */
async function reversePartnerEarnings(rideId) {
  try {
    await db.query(
      `UPDATE partner_earnings SET state = 'reversed'
        WHERE ride_id = $1 AND state = 'accrued' AND payout_id IS NULL`, [rideId]
    );
  } catch (err) {
    console.error('[partner] reversal failed for ride', rideId, err.message);
  }
}

/* Attribution. Called when a customer or driver signs up with a partner code.
   Returns true only if this signup was newly attributed. */
async function attributeSignup(userId, phone, role, code, source = 'code') {
  try {
    if (!userId || !code) return false;
    const s = await partnerSettings();
    if (!s.enabled) return false;
    const p = await db.query(
      `SELECT id FROM partners WHERE code = $1 AND status = 'active'`,
      [String(code).trim().toUpperCase()]
    );
    if (!p.rows[0]) return false;
    // A partner cannot refer themselves. Phone is unverified so this is a
    // courtesy check, not the real defence — that runs at the payout gate
    // against PAN and bank account.
    const own = await db.query('SELECT 1 FROM partners WHERE id = $1 AND phone = $2', [p.rows[0].id, phone]);
    if (own.rows.length) return false;

    const ins = await db.query(
      `INSERT INTO partner_referrals (partner_id, user_id, user_phone, role, source)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING id`,
      [p.rows[0].id, String(userId), phone, role, source]
    );
    return !!ins.rows[0];
  } catch (err) {
    console.error('[partner] attribution failed:', err.message);
    return false;
  }
}

/* ══ PARTNER API ══════════════════════════════════════════════════════════
   Phone + password, no OTP and no email verification. The identity checking
   all happens at the withdrawal gate, where it matters, rather than in front
   of someone who has not earned anything yet.
   ═══════════════════════════════════════════════════════════════════════ */

const TERMS_VERSION = '2026-08-09';
const norm  = v => String(v || '').trim();
const nphone = v => norm(v).replace(/\D/g, '').slice(-10);
// Answers are compared case- and space-insensitively, or "St Marys" and
// "st marys" lock a real partner out of their own account.
const normAnswer = v => norm(v).toLowerCase().replace(/\s+/g, ' ');

function signPartner(p) {
  return jwt.sign({ pid: p.id, phone: p.phone, kind: 'partner' }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// Brute force is the whole risk with security-question recovery: a three-word
// answer is guessed by a script in seconds without this.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});

async function partnerAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please log in' });
    const d = jwt.verify(token, process.env.JWT_SECRET);
    if (d.kind !== 'partner') return res.status(401).json({ error: 'Please log in' });
    const p = await db.query('SELECT * FROM partners WHERE id = $1', [d.pid]);
    if (!p.rows[0]) return res.status(401).json({ error: 'Please log in' });
    if (p.rows[0].status === 'blocked') return res.status(403).json({ error: 'This partner account is suspended. Contact Sppero support.' });
    req.partner = p.rows[0];
    next();
  } catch (_) { return res.status(401).json({ error: 'Please log in' }); }
}

// What a partner may know about themselves. Never the password or answer
// hashes, and never the full bank account back.
function publicPartner(p) {
  return {
    id: p.id, name: p.name, phone: p.phone, email: p.email || '', code: p.code,
    status: p.status,
    has_pan: !!p.pan, has_bank: !!(p.bank_account || p.upi_id),
    bank_hold_until: p.bank_hold_until,
    security_q: p.security_q || null,
  };
}

// Deliberately not "mother's name": it is the most commonly known answer of
// the lot and is already written on half the forms a person has filled in.
const SECURITY_QUESTIONS = [
  'What was the name of your first school?',
  'What was your childhood nickname?',
  'What was your first vehicle’s number?',
  'What is your best friend’s first name?',
  'What was the name of the street you grew up on?',
];

router.get('/config', async (_req, res) => {
  const s = await partnerSettings();
  res.json({
    enabled: s.enabled, rate_percent: s.rate, min_payout: s.minPayout,
    hold_days: s.holdDays, terms_version: TERMS_VERSION,
    security_questions: SECURITY_QUESTIONS,
  });
});

router.post('/signup', authLimiter, async (req, res) => {
  try {
    const s = await partnerSettings();
    if (!s.enabled) return res.status(403).json({ error: 'The partner programme is not open right now.' });
    const name = norm(req.body.name), phone = nphone(req.body.phone);
    const password = norm(req.body.password);
    const q = norm(req.body.security_q), a = norm(req.body.security_a);
    if (!name)                return res.status(400).json({ error: 'Please enter your name' });
    if (phone.length !== 10)  return res.status(400).json({ error: 'Please enter a 10-digit mobile number' });
    if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (!q || !a)             return res.status(400).json({ error: 'Please choose a security question and answer it' });
    if (!req.body.accept_terms) return res.status(400).json({ error: 'Please accept the terms to continue' });

    const exists = await db.query('SELECT 1 FROM partners WHERE phone = $1', [phone]);
    if (exists.rows.length) return res.status(409).json({ error: 'This number is already registered. Try logging in.' });

    const code = await uniqueCode(name);
    const ins = await db.query(
      `INSERT INTO partners (name, phone, email, password_hash, security_q, security_a_hash,
                             code, terms_version, terms_accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *`,
      [name, phone, norm(req.body.email) || null, bcrypt.hashSync(password, 10),
       q, bcrypt.hashSync(normAnswer(a), 10), code, TERMS_VERSION]
    );
    const p = ins.rows[0];
    await db.query(`INSERT INTO partner_events (partner_id, kind, detail) VALUES ($1,'signup',$2)`,
      [p.id, 'terms ' + TERMS_VERSION]).catch(() => {});
    res.json({ success: true, token: signPartner(p), partner: publicPartner(p) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const phone = nphone(req.body.phone), password = norm(req.body.password);
    const p = await db.query('SELECT * FROM partners WHERE phone = $1', [phone]);
    // Same message either way — telling a stranger which numbers are
    // registered is free reconnaissance.
    if (!p.rows[0] || !bcrypt.compareSync(password, p.rows[0].password_hash || ''))
      return res.status(401).json({ error: 'Wrong number or password' });
    if (p.rows[0].status === 'blocked') return res.status(403).json({ error: 'This partner account is suspended. Contact Sppero support.' });
    res.json({ success: true, token: signPartner(p.rows[0]), partner: publicPartner(p.rows[0]) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 1 of recovery — which question this partner chose.
router.post('/forgot', authLimiter, async (req, res) => {
  try {
    const p = await db.query('SELECT security_q, locked_until FROM partners WHERE phone = $1', [nphone(req.body.phone)]);
    if (!p.rows[0] || !p.rows[0].security_q) return res.status(404).json({ error: 'No partner account found for this number' });
    if (p.rows[0].locked_until && new Date(p.rows[0].locked_until) > new Date())
      return res.status(429).json({ error: 'Too many wrong answers. Try again in an hour.' });
    res.json({ security_q: p.rows[0].security_q });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Step 2 — answer it and set a new password. Five wrong answers locks the
// account for an hour; without that a short answer is simply enumerated.
router.post('/reset', authLimiter, async (req, res) => {
  try {
    const phone = nphone(req.body.phone);
    const answer = norm(req.body.security_a), password = norm(req.body.password);
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const r = await db.query('SELECT * FROM partners WHERE phone = $1', [phone]);
    const p = r.rows[0];
    if (!p) return res.status(404).json({ error: 'No partner account found for this number' });
    if (p.locked_until && new Date(p.locked_until) > new Date())
      return res.status(429).json({ error: 'Too many wrong answers. Try again in an hour.' });

    if (!bcrypt.compareSync(normAnswer(answer), p.security_a_hash || '')) {
      const n = (p.reset_attempts || 0) + 1;
      await db.query(
        `UPDATE partners SET reset_attempts = $1,
                locked_until = CASE WHEN $1 >= 5 THEN NOW() + INTERVAL '1 hour' ELSE locked_until END
          WHERE id = $2`, [n, p.id]);
      return res.status(401).json({ error: n >= 5 ? 'Too many wrong answers. Try again in an hour.' : 'That answer does not match' });
    }
    await db.query(
      `UPDATE partners SET password_hash = $1, reset_attempts = 0, locked_until = NULL WHERE id = $2`,
      [bcrypt.hashSync(password, 10), p.id]);
    // Shown on the partner's own dashboard, so a takeover is visible to the
    // person it happened to.
    await db.query(`INSERT INTO partner_events (partner_id, kind, detail) VALUES ($1,'password_reset','via security question')`, [p.id]).catch(() => {});
    res.json({ success: true, token: signPartner(p), partner: publicPartner(p) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/me', partnerAuth, async (req, res) => {
  const ev = await db.query(
    `SELECT kind, detail, created_at FROM partner_events WHERE partner_id = $1 ORDER BY id DESC LIMIT 10`,
    [req.partner.id]).catch(() => ({ rows: [] }));
  res.json({ partner: publicPartner(req.partner), events: ev.rows });
});

// Balances, computed from the ledger rather than stored — a running total kept
// in a column is a running total that eventually disagrees with its own rows.
async function balances(partnerId) {
  const r = await db.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE state IN ('accrued','paid')), 0)              AS lifetime,
       COALESCE(SUM(amount) FILTER (WHERE state = 'accrued' AND available_at <= NOW()), 0) AS available,
       COALESCE(SUM(amount) FILTER (WHERE state = 'accrued' AND available_at >  NOW()), 0) AS holding,
       COALESCE(SUM(amount) FILTER (WHERE state = 'processing'), 0)                     AS processing,
       COALESCE(SUM(amount) FILTER (WHERE state = 'paid'), 0)                           AS paid,
       COALESCE(SUM(amount) FILTER (WHERE state IN ('accrued','paid')
                 AND created_at >= date_trunc('month', NOW())), 0)                      AS this_month,
       COUNT(*) FILTER (WHERE state <> 'reversed')                                      AS rides
     FROM partner_earnings WHERE partner_id = $1`, [partnerId]);
  const b = r.rows[0] || {};
  const n = v => Math.round(parseFloat(v || 0) * 100) / 100;
  return { lifetime: n(b.lifetime), available: n(b.available), holding: n(b.holding),
           processing: n(b.processing), paid: n(b.paid), this_month: n(b.this_month),
           rides: parseInt(b.rides || 0, 10) };
}

router.get('/dashboard', partnerAuth, async (req, res) => {
  try {
    const s = await partnerSettings();
    const bal = await balances(req.partner.id);
    const people = await db.query(
      `SELECT role, COUNT(*)::int AS n FROM partner_referrals WHERE partner_id = $1 GROUP BY role`,
      [req.partner.id]);
    const counts = { driver: 0, passenger: 0 };
    people.rows.forEach(r => { counts[r.role] = r.n; });
    res.json({
      partner: publicPartner(req.partner),
      balances: bal, counts,
      rate_percent: s.rate, min_payout: s.minPayout, hold_days: s.holdDays,
      can_withdraw: bal.available >= s.minPayout,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The people a partner brought. Phone numbers are masked: introducing someone
// does not entitle you to a contact list of Sppero's riders and drivers.
const mask = p => (p && p.length >= 10) ? p.slice(0, 5) + '•••' + p.slice(-2) : '•••';
router.get('/people', partnerAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT pr.user_id, pr.user_phone, pr.role, pr.source, pr.created_at,
              u.name,
              COUNT(pe.id)::int                     AS rides,
              COALESCE(SUM(pe.commission), 0)       AS commission,
              COALESCE(SUM(pe.amount), 0)           AS earned
         FROM partner_referrals pr
         LEFT JOIN users u ON u.id::text = pr.user_id
         LEFT JOIN partner_earnings pe
                ON pe.partner_id = pr.partner_id
               AND pe.referred_user_id = pr.user_id
               AND pe.state <> 'reversed'
        WHERE pr.partner_id = $1
        GROUP BY pr.user_id, pr.user_phone, pr.role, pr.source, pr.created_at, u.name
        ORDER BY earned DESC, pr.created_at DESC`, [req.partner.id]);
    res.json(r.rows.map(x => ({
      name: (x.name || 'User').split(' ')[0],
      phone: mask(x.user_phone), role: x.role, source: x.source, joined: x.created_at,
      rides: x.rides,
      commission: Math.round(parseFloat(x.commission) * 100) / 100,
      earned: Math.round(parseFloat(x.earned) * 100) / 100,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ride-level statement. This is what makes the number believable — a total
// nobody can take apart is a total nobody trusts.
router.get('/earnings', partnerAuth, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const r = await db.query(
      `SELECT pe.ride_id, pe.referred_role, pe.fare, pe.commission, pe.rate_percent,
              pe.share_of, pe.amount, pe.state, pe.available_at, pe.created_at,
              r.ride_type, u.name AS rider_name
         FROM partner_earnings pe
         LEFT JOIN rides r ON r.id = pe.ride_id
         LEFT JOIN users u ON u.id::text = pe.referred_user_id
        WHERE pe.partner_id = $1
        ORDER BY pe.id DESC LIMIT $2 OFFSET $3`, [req.partner.id, limit, offset]);
    res.json(r.rows.map(x => ({
      ride_id: x.ride_id, date: x.created_at, vehicle: x.ride_type,
      through: (x.rider_name || 'User').split(' ')[0], role: x.referred_role,
      fare: parseFloat(x.fare || 0), commission: parseFloat(x.commission || 0),
      rate: parseFloat(x.rate_percent), shared_with: x.share_of > 1 ? x.share_of : 0,
      amount: parseFloat(x.amount),
      state: x.state === 'accrued' && new Date(x.available_at) > new Date() ? 'holding' : x.state,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manual attribution — the offline case, where the partner installed the app
// for someone who never typed the code.
router.post('/claims', partnerAuth, async (req, res) => {
  try {
    const phone = nphone(req.body.phone);
    if (phone.length !== 10) return res.status(400).json({ error: 'Please enter a 10-digit mobile number' });
    if (phone === req.partner.phone) return res.status(400).json({ error: 'You cannot claim your own number' });
    const dupe = await db.query(
      `SELECT 1 FROM partner_claims WHERE partner_id = $1 AND phone = $2 AND status = 'pending'`,
      [req.partner.id, phone]);
    if (dupe.rows.length) return res.status(409).json({ error: 'You have already submitted this number' });
    await db.query(
      `INSERT INTO partner_claims (partner_id, phone, role_claimed) VALUES ($1,$2,$3)`,
      [req.partner.id, phone, norm(req.body.role) || null]);
    res.json({ success: true, message: 'Submitted. Sppero will verify it shortly.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/claims', partnerAuth, async (req, res) => {
  const r = await db.query(
    `SELECT phone, role_claimed, status, admin_note, created_at, reviewed_at
       FROM partner_claims WHERE partner_id = $1 ORDER BY id DESC LIMIT 100`, [req.partner.id]);
  res.json(r.rows.map(x => ({ ...x, phone: mask(x.phone) })));
});

/* Bank details. Changing them starts a hold, so an account taken over through
   the security question cannot immediately redirect the money — the real
   partner waits once, a thief loses the race. */
router.post('/bank', partnerAuth, async (req, res) => {
  try {
    const s = await partnerSettings();
    const pan  = norm(req.body.pan).toUpperCase();
    const upi  = norm(req.body.upi_id);
    const acct = norm(req.body.bank_account);
    const ifsc = norm(req.body.bank_ifsc).toUpperCase();
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan))
      return res.status(400).json({ error: 'That PAN does not look right — it should be like ABCDE1234F' });
    if (!upi && !(acct && ifsc))
      return res.status(400).json({ error: 'Add a UPI ID, or an account number with its IFSC' });
    if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc))
      return res.status(400).json({ error: 'That IFSC does not look right' });

    const p = req.partner;
    const changed = (upi !== (p.upi_id || '')) || (acct !== (p.bank_account || '')) || (ifsc !== (p.bank_ifsc || ''));
    await db.query(
      `UPDATE partners SET pan = COALESCE(NULLIF($1,''), pan), upi_id = $2,
              bank_account = $3, bank_ifsc = $4, bank_name = $5,
              bank_hold_until = CASE WHEN $6 THEN NOW() + ($7 || ' hours')::interval ELSE bank_hold_until END
        WHERE id = $8`,
      [pan, upi || null, acct || null, ifsc || null, norm(req.body.bank_name) || null,
       changed, String(s.bankHoldHrs), p.id]);
    if (changed) {
      await db.query(`INSERT INTO partner_events (partner_id, kind, detail) VALUES ($1,'bank_changed',$2)`,
        [p.id, `withdrawals held ${s.bankHoldHrs}h`]).catch(() => {});
    }
    const fresh = await db.query('SELECT * FROM partners WHERE id = $1', [p.id]);
    res.json({ success: true, partner: publicPartner(fresh.rows[0]),
               held_hours: changed ? s.bankHoldHrs : 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Withdrawal request. Moves the money to 'processing' as it is requested, so
   the same rupees cannot be requested twice while an admin is looking at it. */
router.post('/withdraw', partnerAuth, async (req, res) => {
  try {
    const s = await partnerSettings();
    const p = req.partner;
    if (!p.pan) return res.status(400).json({ error: 'Add your PAN before withdrawing — it is required for tax on commission payments.' });
    if (!p.bank_account && !p.upi_id) return res.status(400).json({ error: 'Add a UPI ID or bank account first' });
    if (p.bank_hold_until && new Date(p.bank_hold_until) > new Date()) {
      const hrs = Math.ceil((new Date(p.bank_hold_until) - Date.now()) / 3600000);
      return res.status(400).json({ error: `Your bank details changed recently. Withdrawals open in about ${hrs} hour${hrs === 1 ? '' : 's'}.` });
    }
    const pending = await db.query(
      `SELECT 1 FROM partner_payouts WHERE partner_id = $1 AND status IN ('requested','approved')`, [p.id]);
    if (pending.rows.length) return res.status(409).json({ error: 'You already have a withdrawal in progress' });

    const bal = await balances(p.id);
    if (bal.available < s.minPayout)
      return res.status(400).json({ error: `You need at least ₹${s.minPayout} available to withdraw. You have ₹${bal.available}.` });

    // TDS on commission under s194H, once the year's payouts pass the
    // threshold. Verified against the settings, not hard-coded.
    const paidThisYear = await db.query(
      `SELECT COALESCE(SUM(gross),0) AS t FROM partner_payouts
        WHERE partner_id = $1 AND status = 'paid'
          AND requested_at >= date_trunc('year', NOW()) - INTERVAL '3 months'`, [p.id]);
    const priorGross = parseFloat(paidThisYear.rows[0].t || 0);
    const gross = bal.available;
    const tds = (priorGross + gross) > s.tdsThreshold ? Math.round(gross * (s.tdsPercent / 100) * 100) / 100 : 0;
    const net = Math.round((gross - tds) * 100) / 100;

    const pay = await db.query(
      `INSERT INTO partner_payouts (partner_id, gross, tds, net, method, status)
       VALUES ($1,$2,$3,$4,$5,'requested') RETURNING *`,
      [p.id, gross, tds, net, p.upi_id ? 'upi' : 'bank']);

    // Only the rows that were counted into `available` move — anything that
    // matured a second later stays for the next request.
    await db.query(
      `UPDATE partner_earnings SET state = 'processing', payout_id = $1
        WHERE partner_id = $2 AND state = 'accrued' AND available_at <= NOW()`,
      [pay.rows[0].id, p.id]);

    res.json({ success: true, payout: pay.rows[0],
               message: tds > 0 ? `Requested. ₹${tds} TDS will be deducted.` : 'Withdrawal requested.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/payouts', partnerAuth, async (req, res) => {
  const r = await db.query(
    `SELECT id, gross, tds, net, method, status, admin_note, requested_at, settled_at
       FROM partner_payouts WHERE partner_id = $1 ORDER BY id DESC LIMIT 50`, [req.partner.id]);
  res.json(r.rows);
});

/* ══ ADMIN ════════════════════════════════════════════════════════════════
   Mounted behind adminAuth in server.js. Same tables the partner reads, so
   the two views cannot disagree — that is the whole point of not building a
   second store and syncing it.
   ═══════════════════════════════════════════════════════════════════════ */
const adminRouter = express.Router();

// Overview: every partner, what they brought, what they are owed.
adminRouter.get('/', async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT p.id, p.name, p.phone, p.code, p.status, p.pan, p.created_at,
              p.bank_account, p.upi_id,
              (SELECT COUNT(*) FROM partner_referrals x WHERE x.partner_id = p.id)::int AS people,
              (SELECT COUNT(*) FROM partner_referrals x WHERE x.partner_id = p.id AND x.role='driver')::int AS drivers,
              COALESCE(SUM(pe.commission) FILTER (WHERE pe.state <> 'reversed'), 0) AS commission_generated,
              COALESCE(SUM(pe.amount) FILTER (WHERE pe.state = 'accrued' AND pe.available_at <= NOW()), 0) AS available,
              COALESCE(SUM(pe.amount) FILTER (WHERE pe.state = 'accrued' AND pe.available_at > NOW()), 0) AS holding,
              COALESCE(SUM(pe.amount) FILTER (WHERE pe.state = 'paid'), 0) AS paid
         FROM partners p
         LEFT JOIN partner_earnings pe ON pe.partner_id = p.id
        GROUP BY p.id
        ORDER BY available DESC, commission_generated DESC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Exactly what you asked to see: which driver or customer, their number, how
// many rides they did, what Sppero earned from them, what the partner gets.
adminRouter.get('/:id', async (req, res) => {
  try {
    const p = await db.query('SELECT * FROM partners WHERE id = $1', [req.params.id]);
    if (!p.rows[0]) return res.status(404).json({ error: 'Partner not found' });
    const people = await db.query(
      `SELECT pr.user_id, pr.user_phone, pr.role, pr.source, pr.created_at, u.name,
              COUNT(pe.id)::int               AS rides,
              COALESCE(SUM(pe.commission),0)  AS commission,
              COALESCE(SUM(pe.amount),0)      AS partner_share
         FROM partner_referrals pr
         LEFT JOIN users u ON u.id::text = pr.user_id
         LEFT JOIN partner_earnings pe ON pe.partner_id = pr.partner_id
              AND pe.referred_user_id = pr.user_id AND pe.state <> 'reversed'
        WHERE pr.partner_id = $1
        GROUP BY pr.user_id, pr.user_phone, pr.role, pr.source, pr.created_at, u.name
        ORDER BY partner_share DESC`, [req.params.id]);
    const bal = await balances(req.params.id);
    const payouts = await db.query(
      `SELECT * FROM partner_payouts WHERE partner_id = $1 ORDER BY id DESC LIMIT 20`, [req.params.id]);
    const events = await db.query(
      `SELECT kind, detail, created_at FROM partner_events WHERE partner_id = $1 ORDER BY id DESC LIMIT 20`, [req.params.id]);
    const { password_hash, security_a_hash, ...safe } = p.rows[0];
    res.json({ partner: safe, balances: bal, people: people.rows, payouts: payouts.rows, events: events.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Daily totals — what the programme cost and produced, day by day.
adminRouter.get('/report/daily', async (req, res) => {
  try {
    const days = Math.min(120, Math.max(1, parseInt(req.query.days, 10) || 30));
    const r = await db.query(
      `SELECT date_trunc('day', created_at)::date AS day,
              COUNT(*)::int                       AS rides,
              COUNT(DISTINCT partner_id)::int     AS partners,
              COALESCE(SUM(commission),0)         AS commission,
              COALESCE(SUM(amount),0)             AS partner_share
         FROM partner_earnings
        WHERE state <> 'reversed' AND created_at >= NOW() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY 1 DESC`, [String(days)]);
    res.json(r.rows.map(x => ({
      day: x.day, rides: x.rides, partners: x.partners,
      commission: parseFloat(x.commission),
      partner_share: parseFloat(x.partner_share),
      // What Sppero kept after the partner share on those same rides.
      sppero_share: Math.round((parseFloat(x.commission) - parseFloat(x.partner_share)) * 100) / 100,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Claims queue — each submitted number shown beside the real account, so the
// person ticking it can see what they are approving.
adminRouter.get('/claims/pending', async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.phone, c.role_claimed, c.created_at,
              p.id AS partner_id, p.name AS partner_name, p.code, p.created_at AS partner_joined,
              u.id::text AS user_id, u.name AS user_name, u.role AS user_role, u.created_at AS user_joined,
              (SELECT COUNT(*) FROM rides r WHERE r.passenger_id = u.id OR r.driver_id = u.id)::int AS rides,
              held.partner_id AS already_held_by,
              -- Decided here rather than in the browser, so the list and the
              -- approval endpoint can never disagree about what is allowed.
              (u.id IS NOT NULL AND u.created_at < p.created_at) AS predates_partner
         FROM partner_claims c
         JOIN partners p ON p.id = c.partner_id
         LEFT JOIN users u ON u.phone = c.phone
         LEFT JOIN partner_referrals held ON held.user_id = u.id::text
        WHERE c.status = 'pending'
        ORDER BY c.id ASC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.post('/claims/:id/decide', async (req, res) => {
  try {
    const approve = req.body.approve === true || req.body.approve === 'true';
    const note = String(req.body.note || '').slice(0, 300);
    const by = String(req.body.by || 'admin').slice(0, 60);
    const c = await db.query(`SELECT * FROM partner_claims WHERE id = $1 AND status = 'pending'`, [req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Claim not found or already decided' });

    if (approve) {
      const u = await db.query('SELECT id, role, created_at FROM users WHERE phone = $1', [c.rows[0].phone]);
      if (!u.rows[0]) return res.status(400).json({ error: 'No Sppero account exists for that number yet' });

      /* You cannot have brought someone who was already using Sppero before
         you were a partner. Without this the programme pays out on the
         existing user base: every partner's first move would be to submit the
         numbers of people already riding, and Sppero would start paying 60%
         of commission it was already earning, for nothing.

         Keyed on the PARTNER's join date rather than a fixed launch date, so
         it stays correct for everyone who joins later too. */
      const p = await db.query('SELECT created_at FROM partners WHERE id = $1', [c.rows[0].partner_id]);
      if (p.rows[0] && new Date(u.rows[0].created_at) < new Date(p.rows[0].created_at)) {
        const joined = new Date(u.rows[0].created_at).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' });
        return res.status(400).json({
          error: `This person joined Sppero on ${joined}, before this partner signed up. Only people who join after a partner does can be added to them.`,
        });
      }
      // The same one-attribution rule the code path obeys. If somebody already
      // holds this person, approving must fail rather than silently do nothing.
      const ins = await db.query(
        `INSERT INTO partner_referrals (partner_id, user_id, user_phone, role, source)
         VALUES ($1,$2,$3,$4,'manual') ON CONFLICT (user_id) DO NOTHING RETURNING id`,
        [c.rows[0].partner_id, String(u.rows[0].id), c.rows[0].phone, u.rows[0].role]);
      if (!ins.rows[0]) return res.status(409).json({ error: 'That person is already attributed to another partner' });
    }
    await db.query(
      `UPDATE partner_claims SET status = $1, admin_note = $2, reviewed_by = $3, reviewed_at = NOW() WHERE id = $4`,
      [approve ? 'approved' : 'rejected', note || null, by, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.get('/payouts/pending', async (_req, res) => {
  try {
    const r = await db.query(
      `SELECT po.*, p.name, p.phone, p.code, p.pan, p.upi_id, p.bank_account, p.bank_ifsc, p.bank_name,
              p.bank_hold_until,
              (SELECT COUNT(*) FROM partner_events e
                WHERE e.partner_id = p.id AND e.kind = 'password_reset'
                  AND e.created_at > NOW() - INTERVAL '7 days')::int AS recent_resets
         FROM partner_payouts po JOIN partners p ON p.id = po.partner_id
        WHERE po.status IN ('requested','approved') ORDER BY po.id ASC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Approve and send. Reuses the driver payout rails rather than a second
   integration — one place that knows how to move money out of Razorpay. */
adminRouter.post('/payouts/:id/settle', async (req, res) => {
  try {
    const action = String(req.body.action || 'pay');
    const po = await db.query(
      `SELECT po.*, p.name, p.phone, p.upi_id, p.bank_account, p.bank_ifsc
         FROM partner_payouts po JOIN partners p ON p.id = po.partner_id
        WHERE po.id = $1 AND po.status IN ('requested','approved')`, [req.params.id]);
    if (!po.rows[0]) return res.status(404).json({ error: 'Payout not found or already settled' });
    const row = po.rows[0];

    if (action === 'reject') {
      await db.query(`UPDATE partner_payouts SET status='rejected', admin_note=$1, settled_at=NOW() WHERE id=$2`,
        [String(req.body.note || '').slice(0, 300) || null, row.id]);
      // The money goes back to available — a rejected request must not strand it.
      await db.query(`UPDATE partner_earnings SET state='accrued', payout_id=NULL WHERE payout_id=$1`, [row.id]);
      return res.json({ success: true, status: 'rejected' });
    }

    let reference = String(req.body.reference || '').slice(0, 120) || null;
    if (req.body.send_via_razorpay) {
      try {
        const { ensureContact, createFundAccount, initiatePayout } = require('../services/razorpayPayout');
        const contact = await ensureContact(row.phone, row.name);
        const fa = await createFundAccount(contact, {
          upi_id: row.upi_id, bank_account: row.bank_account, bank_ifsc: row.bank_ifsc, name: row.name,
        });
        const out = await initiatePayout(fa, parseFloat(row.net), row.id, row.upi_id ? 'UPI' : 'IMPS');
        reference = (out && (out.id || out.reference)) || reference;
      } catch (e) {
        return res.status(502).json({ error: 'Razorpay payout failed: ' + e.message });
      }
    }
    await db.query(`UPDATE partner_payouts SET status='paid', reference=$1, settled_at=NOW() WHERE id=$2`,
      [reference, row.id]);
    await db.query(`UPDATE partner_earnings SET state='paid' WHERE payout_id=$1`, [row.id]);
    res.json({ success: true, status: 'paid', reference });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.post('/:id/status', async (req, res) => {
  try {
    const status = ['active', 'blocked'].includes(req.body.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Status must be active or blocked' });
    await db.query('UPDATE partners SET status = $1 WHERE id = $2', [status, req.params.id]);
    await db.query(`INSERT INTO partner_events (partner_id, kind, detail) VALUES ($1,'status',$2)`,
      [req.params.id, status]).catch(() => {});
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

adminRouter.get('/settings/all', async (_req, res) => res.json(await partnerSettings()));

adminRouter.post('/settings/all', async (req, res) => {
  try {
    const allowed = Object.keys(SETTING_DEFAULTS);
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!allowed.includes(k)) continue;
      await db.query(
        `INSERT INTO reward_settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, String(v)]);
    }
    res.json({ success: true, settings: await partnerSettings() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.adminRouter = adminRouter;
module.exports.accruePartnerEarnings = accruePartnerEarnings;
module.exports.reversePartnerEarnings = reversePartnerEarnings;
module.exports.attributeSignup = attributeSignup;
module.exports.partnerSettings = partnerSettings;
module.exports.uniqueCode = uniqueCode;
