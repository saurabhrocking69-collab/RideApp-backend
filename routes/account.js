const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const { sendFCM } = require('../config/firebase');

// ── Account deletion ─────────────────────────────────────────────────────────
// Google Play requires an in-app route to delete an account, not just an email
// address to write to. The request is raised here, held for a review window,
// and carried out by an admin (or by anyone re-running the sweep after the
// window closes).
//
// DELETION MEANS ANONYMISE, NOT DROP THE ROW. rides, driver_commissions,
// driver_transactions and support tickets all reference users.id, and those are
// financial and dispute records that both sides may need long after the account
// is gone — a hard DELETE would either fail on the foreign keys or shred trip
// history belonging to the OTHER party to the ride. So every piece of personal
// data is scrubbed and the row is left as an unidentifiable stub.
const REVIEW_DAYS = 7;

db.query(`
  CREATE TABLE IF NOT EXISTS account_deletion_requests (
    id            SERIAL PRIMARY KEY,
    role          TEXT NOT NULL,
    user_phone    VARCHAR(20) NOT NULL,
    -- users.id is a UUID here (see emergency_contacts' FK), so this is TEXT
    -- rather than INTEGER — storing it as text avoids every cast at the call
    -- sites and this column is only ever read for reference, never joined on.
    user_id       TEXT,
    reason        TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    scheduled_for TIMESTAMPTZ NOT NULL,
    admin_note    TEXT,
    reviewed_by   TEXT,
    reviewed_at   TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )
`).then(() =>
  // One OPEN request per phone. A partial unique index rather than a plain one:
  // a customer who cancels and later asks again must be able to, and someone
  // who was rejected must not be locked out forever.
  db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_deletion_req
            ON account_deletion_requests (user_phone) WHERE status = 'pending'`)
).catch(() => {});

// What would stop us honouring this request today. Returned to the app BEFORE
// it lets someone confirm, so the reason is visible up front rather than as a
// failure after they have already decided.
async function deletionBlockers(phone, role) {
  const blockers = [];
  const notes    = [];

  // Both sides cast to text: passenger_id and driver_id are not stored with
  // identical types across this schema, and every other query in the codebase
  // compares them this way.
  const ride = await db.query(
    `SELECT r.id FROM rides r
     JOIN users u ON (r.passenger_id::text = u.id::text OR r.driver_id::text = u.id::text)
     WHERE u.phone = $1 AND r.status IN ('requested','matched','arrived','started','batch_offered')
     LIMIT 1`, [phone]
  ).catch(() => ({ rows: [] }));
  if (ride.rows[0]) blockers.push('A ride is still in progress. Finish or cancel it first.');

  if (role === 'driver') {
    const owed = await db.query(
      `SELECT COALESCE(w.pending_commission, 0) AS due
       FROM driver_wallet w JOIN users u ON w.driver_id = u.id WHERE u.phone = $1`, [phone]
    ).catch(() => ({ rows: [] }));
    const due = parseFloat(owed.rows[0]?.due || 0);
    // Money owed to the platform cannot be written off by deleting the account.
    if (due > 0) blockers.push(`₹${due.toFixed(0)} commission is still due. Clear it first.`);
  }

  const walletTable = role === 'driver' ? 'driver_wallet' : 'customer_wallet';
  const idCol       = role === 'driver' ? 'driver_id'     : 'user_id';
  const bal = await db.query(
    `SELECT COALESCE(w.balance, 0) AS bal FROM ${walletTable} w
     JOIN users u ON w.${idCol} = u.id WHERE u.phone = $1`, [phone]
  ).catch(() => ({ rows: [] }));
  const balance = parseFloat(bal.rows[0]?.bal || 0);
  // Not a blocker — their money, their call — but they must be told, because
  // it is not refundable once the account is gone.
  if (balance > 0) notes.push(`Your ₹${balance.toFixed(0)} wallet balance will be forfeited.`);

  return { blockers, notes, balance };
}

// GET /api/account/deletion — current state, plus what would block it
router.get('/deletion', async (req, res) => {
  const { phone, role } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await db.query(
      `SELECT id, status, reason, scheduled_for, created_at, admin_note
       FROM account_deletion_requests
       WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 1`, [phone]
    );
    const { blockers, notes } = await deletionBlockers(phone, role === 'driver' ? 'driver' : 'customer');
    const cur = r.rows[0];
    res.json({
      request: cur && cur.status === 'pending' ? cur : null,
      last: cur || null,
      blockers, notes, review_days: REVIEW_DAYS,
    });
  } catch (err) { console.error('[account]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/account/deletion — raise the request
router.post('/deletion', async (req, res) => {
  const { phone, role, reason } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const roleVal = role === 'driver' ? 'driver' : 'customer';
  try {
    const u = await db.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (!u.rows[0]) return res.status(404).json({ error: 'No account found for that number' });

    const { blockers } = await deletionBlockers(phone, roleVal);
    if (blockers.length) return res.status(409).json({ error: blockers[0], blockers });

    const scheduledFor = new Date(Date.now() + REVIEW_DAYS * 24 * 60 * 60 * 1000);
    const ins = await db.query(
      `INSERT INTO account_deletion_requests (role, user_phone, user_id, reason, scheduled_for)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_phone) WHERE status = 'pending' DO NOTHING
       RETURNING id, scheduled_for`,
      [roleVal, phone, u.rows[0].id, (reason || '').slice(0, 500) || null, scheduledFor]
    );
    // Nothing returned = the partial unique index rejected it, i.e. one is
    // already open. Report the existing one instead of an error; asking twice
    // is not a mistake worth punishing.
    if (!ins.rows[0]) {
      const cur = await db.query(
        `SELECT id, scheduled_for FROM account_deletion_requests
         WHERE user_phone = $1 AND status = 'pending' LIMIT 1`, [phone]
      );
      return res.json({ success: true, already: true, ...cur.rows[0], review_days: REVIEW_DAYS });
    }

    sendFCM(phone, 'Account deletion requested',
      `We've received your request. Your account will be deleted within ${REVIEW_DAYS} days. You can cancel any time before that from the app.`,
      { type: 'account_deletion' }, { role: roleVal }).catch(() => {});

    res.json({ success: true, id: ins.rows[0].id, scheduled_for: ins.rows[0].scheduled_for, review_days: REVIEW_DAYS });
  } catch (err) { console.error('[account]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// POST /api/account/deletion/cancel — change of mind, any time before it runs
router.post('/deletion/cancel', async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const r = await db.query(
      `UPDATE account_deletion_requests SET status = 'cancelled', updated_at = NOW()
       WHERE user_phone = $1 AND status = 'pending' RETURNING id`, [phone]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'No pending deletion request to cancel' });
    res.json({ success: true });
  } catch (err) { console.error('[account]', err.message); res.status(500).json({ error: 'Something went wrong — please try again' }); }
});

// Scrub every identifying field, keeping the row so the financial and trip
// records that point at it stay intact. Exported so the admin route and any
// future scheduled sweep both go through exactly one implementation.
/* How long a deleted number stays closed before it can sign up again.
   Deleting an account renames the phone to a tombstone, which frees the real
   number immediately — and /verify-otp creates a user for any number it does
   not recognise. So the person deleted yesterday could enter the same number,
   get straight in, and land in a brand-new empty account that looks exactly
   like the old one at the login screen. To the admin it read as "the delete
   did nothing", because the number reappeared in the customers list.
   The number is now held closed for this many days first. */
const REOPEN_AFTER_DAYS = 30;

db.query(`CREATE TABLE IF NOT EXISTS deleted_phones (
  phone       VARCHAR(15) PRIMARY KEY,
  user_id     TEXT,
  role        VARCHAR(20),
  deleted_at  TIMESTAMP DEFAULT NOW(),
  reopen_at   TIMESTAMP NOT NULL
)`).catch(() => {});

/* Returns null when the number is free to use, or { reopen_at, days_left }
   while it is still closed. Anything that lets someone in must call this. */
async function phoneDeletionHold(phone) {
  try {
    const r = await db.query(
      'SELECT reopen_at FROM deleted_phones WHERE phone = $1 AND reopen_at > NOW()', [phone]
    );
    if (!r.rows[0]) return null;
    const reopen = new Date(r.rows[0].reopen_at);
    return { reopen_at: reopen, days_left: Math.max(1, Math.ceil((reopen - Date.now()) / 86400000)) };
  } catch (_e) { return null; }   // never lock people out because a query failed
}

async function anonymiseAccount(phone) {
  const u = await db.query('SELECT id, role FROM users WHERE phone = $1', [phone]);
  if (!u.rows[0]) return { ok: false, reason: 'not found' };
  const uid = u.rows[0].id;
  // Recorded BEFORE the row is tombstoned — after this the real number is gone
  // from users and there is nothing left to key the hold on.
  await db.query(
    `INSERT INTO deleted_phones (phone, user_id, role, reopen_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval)
     ON CONFLICT (phone) DO UPDATE
       SET deleted_at = NOW(), reopen_at = NOW() + ($4 || ' days')::interval,
           user_id = EXCLUDED.user_id, role = EXCLUDED.role`,
    [phone, String(uid), u.rows[0].role || null, String(REOPEN_AFTER_DAYS)]
  ).catch(() => {});
  // Phone is UNIQUE and is the login key, so it cannot simply be nulled — it is
  // replaced with a value that can never be dialled or re-registered.
  // MUST fit users.phone, which is VARCHAR(15).
  //
  // This used to be `deleted_${uid}_${Date.now()}`. users.id is a UUID, so that
  // string is 58 characters going into a 15-character column — every delete
  // failed with "value too long for type character varying(15)", the request
  // stayed pending, and the account was never touched. It had never once
  // worked. Nobody noticed because the "Account deleted" push was sent BEFORE
  // this line ran (fixed in admin.js), so the customer was told it was done
  // while the admin's screen correctly showed it was not.
  //
  // 13 chars: 'd' + base36 milliseconds + 4 random. Nothing is lost by it being
  // opaque — deleted_phones records which user this was, and that is where to
  // look now.
  const mkTombstone = () =>
    ('d' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).slice(0, 15);
  let tombstone = mkTombstone();

  // fcm_token / driver_fcm_token are columns on users, not a separate table —
  // clearing them here is what actually stops push reaching a deleted account.
  // phone is UNIQUE, so a collision would throw and abort the deletion. Two
  // extra tries costs nothing and removes the only way this can fail now.
  for (let attempt = 0; ; attempt++) {
    try {
      await db.query(
        `UPDATE users SET name = 'Deleted user', phone = $2, is_suspended = true,
                suspend_reason = 'Account deleted at user request',
                fcm_token = NULL, driver_fcm_token = NULL
         WHERE id = $1`, [uid, tombstone]
      );
      break;
    } catch (e) {
      if (attempt >= 2) throw e;
      tombstone = mkTombstone();
    }
  }
  await db.query(
    `UPDATE drivers SET dl_name = NULL, dl_number = NULL, dl_photo = NULL,
            aadhaar_number = NULL, aadhaar_photo = NULL, face_photo = NULL,
            vehicle_photo = NULL, rc_photo = NULL, vehicle_no = NULL,
            upi_id = NULL, bank_account = NULL, bank_ifsc = NULL, bank_holder = NULL,
            is_online = false, verification_status = 'deleted'
     WHERE id = $1`, [uid]
  ).catch(() => {});
  // Emergency contacts are someone ELSE's personal data held on this account —
  // a third party who never signed up here — so they go with it. Both of these
  // key on users.id, not phone.
  await db.query('DELETE FROM emergency_contacts WHERE user_id = $1', [uid]).catch(() => {});
  await db.query('DELETE FROM saved_places WHERE user_id = $1', [uid]).catch(() => {});
  return { ok: true, user_id: uid };
}

module.exports = router;
module.exports.anonymiseAccount = anonymiseAccount;
module.exports.phoneDeletionHold = phoneDeletionHold;
module.exports.REOPEN_AFTER_DAYS = REOPEN_AFTER_DAYS;
module.exports.REVIEW_DAYS = REVIEW_DAYS;
