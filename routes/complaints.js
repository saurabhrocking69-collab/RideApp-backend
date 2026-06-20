const express = require('express');
const router = express.Router();
const db = require('../config/db');
const cloudinary = require('../config/cloudinary');
const { sendFCM } = require('../config/firebase');
const auth = require('../middleware/auth');

// ─── helpers ─────────────────────────────────────────────────────────────────

async function isDriver(userId) {
  const r = await db.query('SELECT 1 FROM drivers WHERE id=$1', [userId]);
  return r.rows.length > 0;
}

async function getUserFcmToken(userId) {
  try {
    const r = await db.query('SELECT fcm_token FROM users WHERE id=$1', [userId]);
    return r.rows[0]?.fcm_token || null;
  } catch { return null; }
}

async function logTimeline(complaintId, event, description, actorRole, actorName, meta) {
  await db.query(
    `INSERT INTO complaint_timeline(complaint_id,event,description,actor_role,actor_name,metadata)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [complaintId, event, description, actorRole || null, actorName || null, meta ? JSON.stringify(meta) : null]
  );
}

// auto-priority based on complaint type
function calcPriority(type) {
  const urgent = ['harassment', 'physical_abuse', 'property_damage', 'reckless_driving'];
  const high   = ['overcharging', 'false_accusation', 'abusive_behavior'];
  if (urgent.includes(type)) return 'urgent';
  if (high.includes(type))   return 'high';
  return 'normal';
}

const COMPLAINT_TYPES_CUSTOMER = [
  'reckless_driving', 'route_deviation', 'overcharging', 'unprofessional',
  'vehicle_condition', 'driver_no_show', 'harassment', 'physical_abuse', 'other'
];
const COMPLAINT_TYPES_DRIVER = [
  'customer_no_show', 'property_damage', 'abusive_behavior', 'false_accusation',
  'wrong_location', 'payment_issue', 'other'
];

// ─── POST /api/complaints — file a complaint ──────────────────────────────────
router.post('/', auth, async (req, res) => {
  const userId = req.user.id;
  const { ride_id, complaint_type, title, description, against_id } = req.body;

  if (!complaint_type || !title || !description)
    return res.status(400).json({ error: 'complaint_type, title aur description zaroori hai' });
  if (!title.trim() || title.length > 200)
    return res.status(400).json({ error: 'Title 1-200 characters ka hona chahiye' });
  if (!description.trim() || description.length < 20)
    return res.status(400).json({ error: 'Description kam se kam 20 characters ka hona chahiye' });

  try {
    const driver = await isDriver(userId);
    const filerRole = driver ? 'driver' : 'customer';
    const allowedTypes = driver ? COMPLAINT_TYPES_DRIVER : COMPLAINT_TYPES_CUSTOMER;

    if (!allowedTypes.includes(complaint_type))
      return res.status(400).json({ error: 'Invalid complaint type' });

    let filedAgainstId = against_id;
    let rideData = null;

    if (ride_id) {
      const rideRes = await db.query(
        'SELECT r.*, u1.name AS pname, u2.name AS dname FROM rides r LEFT JOIN users u1 ON r.passenger_id=u1.id LEFT JOIN users u2 ON r.driver_id=u2.id WHERE r.id=$1',
        [ride_id]
      );
      if (rideRes.rows.length === 0)
        return res.status(404).json({ error: 'Ride nahi mili' });
      rideData = rideRes.rows[0];

      // verify this user was part of the ride
      if (rideData.passenger_id !== userId && rideData.driver_id !== userId)
        return res.status(403).json({ error: 'Aap is ride ke participant nahi hain' });

      // auto-set against_id from ride
      filedAgainstId = filerRole === 'customer' ? rideData.driver_id : rideData.passenger_id;
    }

    if (!filedAgainstId)
      return res.status(400).json({ error: 'Against user ID zaroori hai' });
    if (filedAgainstId === userId)
      return res.status(400).json({ error: 'Apne khilaf complaint nahi kar sakte' });

    // prevent duplicate open complaint for same ride+user
    if (ride_id) {
      const dup = await db.query(
        `SELECT id FROM complaints WHERE ride_id=$1 AND filed_by=$2 AND status NOT IN ('resolved','closed','withdrawn')`,
        [ride_id, userId]
      );
      if (dup.rows.length > 0)
        return res.status(409).json({ error: 'Is ride ke liye aapki complaint already open hai', complaint_id: dup.rows[0].id });
    }

    const priority = calcPriority(complaint_type);
    const userRes = await db.query('SELECT name FROM users WHERE id=$1', [userId]);
    const filerName = userRes.rows[0]?.name || 'Unknown';

    const result = await db.query(
      `INSERT INTO complaints(ride_id,filed_by,filed_against,filer_role,complaint_type,title,description,priority)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ride_id || null, userId, filedAgainstId, filerRole, complaint_type, title.trim(), description.trim(), priority]
    );
    const complaint = result.rows[0];

    await logTimeline(complaint.id, 'filed', `Complaint filed by ${filerName}`, filerRole, filerName, { complaint_type });

    // notify admin via FCM (if admin FCM token exists — optional)
    // notify the other party
    const otherToken = await getUserFcmToken(filedAgainstId);
    if (otherToken) {
      sendFCM(otherToken, {
        title: 'Aapke khilaf complaint aayi hai',
        body: `"${title}" — Sppero team review karegi`,
        data: { type: 'complaint_filed', complaint_id: complaint.id },
      }).catch(() => {});
    }

    res.status(201).json({ message: 'Complaint submit ho gayi', complaint });
  } catch (err) {
    console.error('File complaint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/complaints — my complaints ─────────────────────────────────────
router.get('/', auth, async (req, res) => {
  const userId = req.user.id;
  const { status, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  try {
    let where = 'WHERE (c.filed_by=$1 OR c.filed_against=$1)';
    const params = [userId];
    if (status) { where += ` AND c.status=$${params.length + 1}`; params.push(status); }

    const result = await db.query(
      `SELECT c.*,
              ub.name AS filed_by_name,
              ua.name AS filed_against_name,
              r.pickup, r.drop_location, r.fare,
              (SELECT COUNT(*) FROM complaint_messages cm WHERE cm.complaint_id=c.id AND cm.is_internal=false) AS message_count,
              (SELECT COUNT(*) FROM complaint_evidence ce WHERE ce.complaint_id=c.id) AS evidence_count
       FROM complaints c
       LEFT JOIN users ub ON c.filed_by=ub.id
       LEFT JOIN users ua ON c.filed_against=ua.id
       LEFT JOIN rides r  ON c.ride_id=r.id
       ${where}
       ORDER BY c.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    res.json({ complaints: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/complaints/:id — complaint detail ───────────────────────────────
router.get('/:id', auth, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await db.query(
      `SELECT c.*,
              ub.name AS filed_by_name, ub.phone AS filed_by_phone,
              ua.name AS filed_against_name, ua.phone AS filed_against_phone,
              r.pickup, r.drop_location, r.fare, r.ride_type, r.status AS ride_status, r.created_at AS ride_date
       FROM complaints c
       LEFT JOIN users ub ON c.filed_by=ub.id
       LEFT JOIN users ua ON c.filed_against=ua.id
       LEFT JOIN rides r  ON c.ride_id=r.id
       WHERE c.id=$1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Complaint nahi mili' });

    const c = result.rows[0];
    if (c.filed_by !== userId && c.filed_against !== userId)
      return res.status(403).json({ error: 'Access denied' });

    const [messages, evidence, timeline] = await Promise.all([
      db.query(
        `SELECT cm.*, u.name AS sender_name FROM complaint_messages cm LEFT JOIN users u ON cm.sender_id=u.id
         WHERE cm.complaint_id=$1 AND cm.is_internal=false ORDER BY cm.created_at ASC`,
        [c.id]
      ),
      db.query('SELECT * FROM complaint_evidence WHERE complaint_id=$1 ORDER BY created_at ASC', [c.id]),
      db.query('SELECT * FROM complaint_timeline WHERE complaint_id=$1 ORDER BY created_at ASC', [c.id]),
    ]);

    res.json({ complaint: c, messages: messages.rows, evidence: evidence.rows, timeline: timeline.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/complaints/:id/messages — add message/response ─────────────────
router.post('/:id/messages', auth, async (req, res) => {
  const userId = req.user.id;
  const { message } = req.body;
  if (!message || !message.trim())
    return res.status(400).json({ error: 'Message khali nahi ho sakta' });

  try {
    const cRes = await db.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
    if (cRes.rows.length === 0) return res.status(404).json({ error: 'Complaint nahi mili' });
    const c = cRes.rows[0];

    if (c.filed_by !== userId && c.filed_against !== userId)
      return res.status(403).json({ error: 'Access denied' });
    if (['resolved', 'closed'].includes(c.status))
      return res.status(400).json({ error: 'Closed/resolved complaint mein message nahi bhej sakte' });

    const userRes = await db.query('SELECT name FROM users WHERE id=$1', [userId]);
    const driver  = await isDriver(userId);
    const role    = driver ? 'driver' : 'customer';
    const name    = userRes.rows[0]?.name || 'Unknown';

    await db.query(
      'INSERT INTO complaint_messages(complaint_id,sender_id,sender_role,sender_name,message) VALUES($1,$2,$3,$4,$5)',
      [c.id, userId, role, name, message.trim()]
    );

    // update status to awaiting_response if under_review
    if (c.status === 'awaiting_response') {
      await db.query("UPDATE complaints SET status='under_review',updated_at=NOW() WHERE id=$1", [c.id]);
    }

    await logTimeline(c.id, 'message_added', `${name} ne reply kiya`, role, name, null);

    // notify the other party
    const otherId = userId === c.filed_by ? c.filed_against : c.filed_by;
    const token = await getUserFcmToken(otherId);
    if (token) sendFCM(token, { title: 'Complaint mein naya message', body: message.trim().substring(0, 80), data: { type: 'complaint_message', complaint_id: c.id } }).catch(() => {});

    res.json({ message: 'Message bheja gaya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/complaints/:id/evidence — upload image evidence ────────────────
router.post('/:id/evidence', auth, async (req, res) => {
  const userId = req.user.id;
  const { image, caption } = req.body; // base64 image
  if (!image) return res.status(400).json({ error: 'Image data zaroori hai' });

  try {
    const cRes = await db.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
    if (cRes.rows.length === 0) return res.status(404).json({ error: 'Complaint nahi mili' });
    const c = cRes.rows[0];

    if (c.filed_by !== userId && c.filed_against !== userId)
      return res.status(403).json({ error: 'Access denied' });
    if (['resolved', 'closed'].includes(c.status))
      return res.status(400).json({ error: 'Closed complaint mein evidence nahi de sakte' });

    // max 5 evidence per person per complaint
    const countRes = await db.query('SELECT COUNT(*) FROM complaint_evidence WHERE complaint_id=$1 AND uploaded_by=$2', [c.id, userId]);
    if (parseInt(countRes.rows[0].count) >= 5)
      return res.status(400).json({ error: 'Maximum 5 evidence allowed hai' });

    const upload = await cloudinary.uploader.upload(image, { folder: 'sppero_complaints', resource_type: 'image' });

    await db.query(
      'INSERT INTO complaint_evidence(complaint_id,uploaded_by,file_url,caption) VALUES($1,$2,$3,$4)',
      [c.id, userId, upload.secure_url, caption || null]
    );
    await logTimeline(c.id, 'evidence_uploaded', 'Evidence upload kiya gaya', null, null, null);

    res.json({ message: 'Evidence upload ho gaya', url: upload.secure_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/complaints/:id/withdraw — withdraw complaint ───────────────────
router.post('/:id/withdraw', auth, async (req, res) => {
  const userId = req.user.id;
  try {
    const cRes = await db.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
    if (cRes.rows.length === 0) return res.status(404).json({ error: 'Complaint nahi mili' });
    const c = cRes.rows[0];

    if (c.filed_by !== userId) return res.status(403).json({ error: 'Sirf complainant withdraw kar sakta hai' });
    if (['resolved', 'closed', 'withdrawn'].includes(c.status))
      return res.status(400).json({ error: 'Yeh complaint already close ho chuki hai' });

    await db.query(
      "UPDATE complaints SET status='closed',resolution='withdrawn',resolved_at=NOW(),updated_at=NOW() WHERE id=$1",
      [c.id]
    );
    await logTimeline(c.id, 'withdrawn', 'Complainant ne complaint withdraw ki', null, null, null);
    res.json({ message: 'Complaint withdraw ho gayi' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/complaints/:id/appeal — appeal a resolved complaint ────────────
router.post('/:id/appeal', auth, async (req, res) => {
  const userId = req.user.id;
  const { reason } = req.body;
  if (!reason || reason.length < 20)
    return res.status(400).json({ error: 'Appeal reason kam se kam 20 characters ka hona chahiye' });

  try {
    const cRes = await db.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
    if (cRes.rows.length === 0) return res.status(404).json({ error: 'Complaint nahi mili' });
    const c = cRes.rows[0];

    if (c.filed_by !== userId && c.filed_against !== userId)
      return res.status(403).json({ error: 'Access denied' });
    if (c.status !== 'resolved')
      return res.status(400).json({ error: 'Sirf resolved complaints ko appeal kar sakte hain' });

    const userRes = await db.query('SELECT name FROM users WHERE id=$1', [userId]);
    const name = userRes.rows[0]?.name || 'Unknown';

    await db.query("UPDATE complaints SET status='appealed',updated_at=NOW() WHERE id=$1", [c.id]);
    await db.query(
      'INSERT INTO complaint_messages(complaint_id,sender_id,sender_role,sender_name,message) VALUES($1,$2,$3,$4,$5)',
      [c.id, userId, 'customer', name, `[APPEAL] ${reason.trim()}`]
    );
    await logTimeline(c.id, 'appealed', `${name} ne appeal ki`, null, name, { reason });

    res.json({ message: 'Appeal submit ho gayi, team dobara review karegi' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/complaints/types/list — available complaint types ───────────────
router.get('/types/list', auth, async (req, res) => {
  try {
    const driver = await isDriver(req.user.id);
    const types = driver ? COMPLAINT_TYPES_DRIVER : COMPLAINT_TYPES_CUSTOMER;
    res.json({ types });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
