const express = require('express');
const router = express.Router();
const db = require('../config/db');
const cloudinary = require('../config/cloudinary');
const { sendFCM } = require('../config/firebase');

// ─── Phone-based auth (consistent with rest of app) ──────────────────────────
// Accepts phone via body (POST) or query (GET). Looks up user ID from DB.
async function phoneAuth(req, res, next) {
  const phone = req.body.phone || req.query.phone;
  if (!phone) return res.status(400).json({ error: 'phone number zaroori hai' });
  try {
    const r = await db.query('SELECT id, name FROM users WHERE phone=$1', [phone]);
    if (!r.rows[0]) return res.status(401).json({ error: 'User nahi mila' });
    req.user = { id: r.rows[0].id, phone, name: r.rows[0].name };
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function isDriver(phone) {
  const r = await db.query('SELECT 1 FROM drivers d JOIN users u ON d.id=u.id WHERE u.phone=$1', [phone]);
  return r.rows.length > 0;
}

async function getUserPhone(userId) {
  try {
    const r = await db.query('SELECT phone FROM users WHERE id=$1', [userId]);
    return r.rows[0]?.phone || null;
  } catch { return null; }
}

async function getUserPhoneAndRole(userId) {
  try {
    const r = await db.query('SELECT phone, role FROM users WHERE id=$1', [userId]);
    const row = r.rows[0];
    return { phone: row?.phone || null, fcmRole: row?.role === 'driver' ? 'driver' : 'customer' };
  } catch { return { phone: null, fcmRole: 'customer' }; }
}

async function logTimeline(complaintId, event, description, actorRole, actorName, meta) {
  await db.query(
    `INSERT INTO complaint_timeline(complaint_id,event,description,actor_role,actor_name,metadata)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [complaintId, event, description, actorRole || null, actorName || null, meta ? JSON.stringify(meta) : null]
  );
}

function calcPriority(type) {
  const urgent = ['harassment', 'physical_abuse', 'property_damage', 'reckless_driving', 'early_trip_end'];
  const high   = ['overcharging', 'false_accusation', 'abusive_behavior'];
  if (urgent.includes(type)) return 'urgent';
  if (high.includes(type))   return 'high';
  return 'normal';
}

// Human-readable title auto-generated from complaint type — no manual title needed
const TYPE_TITLE = {
  early_trip_end:     'Driver ne drop location se pehle trip complete kiya',
  reckless_driving:   'Reckless Driving / Dangerous Driving',
  route_deviation:    'Driver ne galat ya lamba route liya',
  overcharging:       'Driver ne zyada fare manga',
  unprofessional:     'Driver ka behavior unprofessional tha',
  vehicle_condition:  'Vehicle dirty ya unsafe thi',
  driver_no_show:     'Driver pickup pe nahi aaya',
  harassment:         'Driver ne harassment ki',
  physical_abuse:     'Driver ne physical abuse ki',
  customer_no_show:   'Customer pickup pe nahi aaya',
  property_damage:    'Customer ne vehicle ko damage kiya',
  abusive_behavior:   'Customer ne abusive behavior kiya',
  false_accusation:   'Customer ne galat complaint ki',
  wrong_location:     'Customer ne galat location diya',
  payment_issue:      'Customer ne payment nahi ki',
  other:              'Anya Shikayat',
};

const COMPLAINT_TYPES_CUSTOMER = [
  'early_trip_end', 'reckless_driving', 'route_deviation', 'overcharging',
  'unprofessional', 'vehicle_condition', 'driver_no_show', 'harassment', 'physical_abuse', 'other',
];
const COMPLAINT_TYPES_DRIVER = [
  'customer_no_show', 'property_damage', 'abusive_behavior', 'false_accusation',
  'wrong_location', 'payment_issue', 'other',
];

// ─── POST /api/complaints ─────────────────────────────────────────────────────
router.post('/', phoneAuth, async (req, res) => {
  const userId = req.user.id;
  const filerName = req.user.name || 'Unknown';
  const { ride_id, complaint_type, description, against_id } = req.body;

  if (!complaint_type || !description)
    return res.status(400).json({ error: 'complaint_type aur description zaroori hai' });
  if (!description.trim() || description.trim().length < 20)
    return res.status(400).json({ error: 'Description kam se kam 20 characters ka hona chahiye' });

  try {
    // Determine role from complaint_type — more reliable than isDriver() which fails
    // when the same phone is registered in both apps (driver + customer).
    let filerRole;
    if (COMPLAINT_TYPES_CUSTOMER.includes(complaint_type)) {
      filerRole = 'customer';
    } else if (COMPLAINT_TYPES_DRIVER.includes(complaint_type)) {
      filerRole = 'driver';
    } else {
      return res.status(400).json({ error: 'Invalid complaint type' });
    }

    // Auto-generate title from type
    const title = TYPE_TITLE[complaint_type] || 'Shikayat';

    let filedAgainstId = against_id ? parseInt(against_id) : null;

    if (ride_id) {
      const rideRes = await db.query(
        `SELECT r.*, u1.name AS pname, u1.id AS pid, u2.name AS dname, u2.id AS did
         FROM rides r
         LEFT JOIN users u1 ON r.passenger_id=u1.id
         LEFT JOIN users u2 ON r.driver_id=u2.id
         WHERE r.id=$1`,
        [ride_id]
      );
      if (!rideRes.rows[0]) return res.status(404).json({ error: 'Ride nahi mili' });
      const ride = rideRes.rows[0];

      if (ride.passenger_id !== userId && ride.driver_id !== userId)
        return res.status(403).json({ error: 'Aap is ride ke participant nahi hain' });

      filedAgainstId = filerRole === 'customer' ? ride.driver_id : ride.passenger_id;
    }

    if (!filedAgainstId)
      return res.status(400).json({ error: 'Ride select karo ya against_id do — kiske khilaf complaint hai?' });
    if (filedAgainstId === userId)
      return res.status(400).json({ error: 'Apne khilaf complaint nahi kar sakte' });

    // Prevent duplicate open complaint for same ride
    if (ride_id) {
      const dup = await db.query(
        `SELECT id FROM complaints WHERE ride_id=$1 AND filed_by=$2 AND status NOT IN ('resolved','closed')`,
        [ride_id, userId]
      );
      if (dup.rows.length > 0)
        return res.status(409).json({
          error: 'Is ride ki complaint already open hai',
          complaint_id: dup.rows[0].id,
        });
    }

    const priority = calcPriority(complaint_type);

    const result = await db.query(
      `INSERT INTO complaints(ride_id,filed_by,filed_against,filer_role,complaint_type,title,description,priority)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [ride_id || null, userId, filedAgainstId, filerRole, complaint_type, title, description.trim(), priority]
    );
    const complaint = result.rows[0];

    await logTimeline(complaint.id, 'filed', `Complaint filed by ${filerName}`, filerRole, filerName, { complaint_type });

    const { phone: otherPhone, fcmRole: otherFcmRole } = await getUserPhoneAndRole(filedAgainstId);
    if (otherPhone) {
      sendFCM(otherPhone, 'Aapke khilaf complaint aayi hai',
        `${title} — Sppero team review karegi`,
        { type: 'complaint_filed', complaint_id: complaint.id },
        { role: otherFcmRole }
      ).catch(() => {});
    }

    res.status(201).json({ message: 'Complaint submit ho gayi', complaint });
  } catch (err) {
    console.error('File complaint error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/complaints — my complaints ─────────────────────────────────────
router.get('/', phoneAuth, async (req, res) => {
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
              (SELECT COUNT(*) FROM complaint_messages cm WHERE cm.complaint_id=c.id AND cm.is_internal=false) AS message_count
       FROM complaints c
       LEFT JOIN users ub ON c.filed_by=ub.id
       LEFT JOIN users ua ON c.filed_against=ua.id
       LEFT JOIN rides r  ON c.ride_id = r.id::text
       ${where}
       ORDER BY c.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    res.json({ complaints: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/complaints/:id ──────────────────────────────────────────────────
router.get('/:id', phoneAuth, async (req, res) => {
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
       LEFT JOIN rides r  ON c.ride_id = r.id::text
       WHERE c.id=$1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Complaint nahi mili' });
    const c = result.rows[0];
    if (c.filed_by !== userId && c.filed_against !== userId)
      return res.status(403).json({ error: 'Access denied' });

    const [messages, evidence, timeline] = await Promise.all([
      db.query(
        `SELECT cm.*, u.name AS sender_name FROM complaint_messages cm
         LEFT JOIN users u ON cm.sender_id=u.id
         WHERE cm.complaint_id=$1 AND cm.is_internal=false ORDER BY cm.created_at ASC`,
        [c.id]
      ),
      db.query('SELECT * FROM complaint_evidence WHERE complaint_id=$1 ORDER BY created_at ASC', [c.id]),
      db.query('SELECT * FROM complaint_timeline WHERE complaint_id=$1 ORDER BY created_at ASC', [c.id]),
    ]);
    res.json({ complaint: c, messages: messages.rows, evidence: evidence.rows, timeline: timeline.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/complaints/:id/messages ───────────────────────────────────────
router.post('/:id/messages', phoneAuth, async (req, res) => {
  const userId = req.user.id;
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message khali nahi ho sakta' });
  try {
    const cRes = await db.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
    if (!cRes.rows[0]) return res.status(404).json({ error: 'Complaint nahi mili' });
    const c = cRes.rows[0];
    if (c.filed_by !== userId && c.filed_against !== userId)
      return res.status(403).json({ error: 'Access denied' });
    if (['resolved', 'closed'].includes(c.status))
      return res.status(400).json({ error: 'Closed complaint mein message nahi bhej sakte' });

    const driver = await isDriver(req.user.phone);
    const role = driver ? 'driver' : 'customer';
    const name = req.user.name || 'Unknown';

    await db.query(
      'INSERT INTO complaint_messages(complaint_id,sender_id,sender_role,sender_name,message) VALUES($1,$2,$3,$4,$5)',
      [c.id, userId, role, name, message.trim()]
    );
    if (c.status === 'awaiting_response')
      await db.query("UPDATE complaints SET status='under_review',updated_at=NOW() WHERE id=$1", [c.id]);

    await logTimeline(c.id, 'message_added', `${name} ne reply kiya`, role, name, null);

    const otherId = userId === c.filed_by ? c.filed_against : c.filed_by;
    const { phone: otherPhone, fcmRole: otherFcmRole } = await getUserPhoneAndRole(otherId);
    if (otherPhone) sendFCM(otherPhone, 'Complaint mein naya message', message.trim().slice(0, 80), { type: 'complaint_message', complaint_id: c.id }, { role: otherFcmRole }).catch(() => {});

    res.json({ message: 'Message bheja gaya' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/complaints/:id/evidence ───────────────────────────────────────
router.post('/:id/evidence', phoneAuth, async (req, res) => {
  const userId = req.user.id;
  const { image, caption } = req.body;
  if (!image) return res.status(400).json({ error: 'Image data zaroori hai' });
  try {
    const cRes = await db.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
    if (!cRes.rows[0]) return res.status(404).json({ error: 'Complaint nahi mili' });
    const c = cRes.rows[0];
    if (c.filed_by !== userId && c.filed_against !== userId)
      return res.status(403).json({ error: 'Access denied' });
    if (['resolved', 'closed'].includes(c.status))
      return res.status(400).json({ error: 'Closed complaint mein evidence nahi de sakte' });

    const countRes = await db.query(
      'SELECT COUNT(*) FROM complaint_evidence WHERE complaint_id=$1 AND uploaded_by=$2', [c.id, userId]
    );
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

// ─── POST /api/complaints/:id/withdraw ───────────────────────────────────────
router.post('/:id/withdraw', phoneAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const cRes = await db.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
    if (!cRes.rows[0]) return res.status(404).json({ error: 'Complaint nahi mili' });
    const c = cRes.rows[0];
    if (c.filed_by !== userId) return res.status(403).json({ error: 'Sirf complainant withdraw kar sakta hai' });
    if (['resolved', 'closed'].includes(c.status))
      return res.status(400).json({ error: 'Yeh complaint already close ho chuki hai' });

    await db.query(
      "UPDATE complaints SET status='closed',resolution='withdrawn',resolved_at=NOW(),updated_at=NOW() WHERE id=$1",
      [c.id]
    );
    await logTimeline(c.id, 'withdrawn', 'Complainant ne complaint withdraw ki', null, null, null);
    res.json({ message: 'Complaint withdraw ho gayi' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/complaints/:id/appeal ─────────────────────────────────────────
router.post('/:id/appeal', phoneAuth, async (req, res) => {
  const userId = req.user.id;
  const { reason } = req.body;
  if (!reason || reason.trim().length < 20)
    return res.status(400).json({ error: 'Appeal reason kam se kam 20 characters ka hona chahiye' });
  try {
    const cRes = await db.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
    if (!cRes.rows[0]) return res.status(404).json({ error: 'Complaint nahi mili' });
    const c = cRes.rows[0];
    if (c.filed_by !== userId && c.filed_against !== userId)
      return res.status(403).json({ error: 'Access denied' });
    if (c.status !== 'resolved')
      return res.status(400).json({ error: 'Sirf resolved complaints ko appeal kar sakte hain' });

    const name = req.user.name || 'Unknown';
    await db.query("UPDATE complaints SET status='appealed',updated_at=NOW() WHERE id=$1", [c.id]);
    await db.query(
      'INSERT INTO complaint_messages(complaint_id,sender_id,sender_role,sender_name,message) VALUES($1,$2,$3,$4,$5)',
      [c.id, userId, 'customer', name, `[APPEAL] ${reason.trim()}`]
    );
    await logTimeline(c.id, 'appealed', `${name} ne appeal ki`, null, name, { reason });
    res.json({ message: 'Appeal submit ho gayi, team dobara review karegi' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/complaints/types/list ──────────────────────────────────────────
router.get('/types/list', phoneAuth, async (req, res) => {
  try {
    const driver = await isDriver(req.user.phone);
    res.json({ types: driver ? COMPLAINT_TYPES_DRIVER : COMPLAINT_TYPES_CUSTOMER });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
