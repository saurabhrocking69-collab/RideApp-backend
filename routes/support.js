const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sendFCM } = require('../config/firebase');
const cloudinary = require('../config/cloudinary');

const CATEGORY_MAP = {
  // Customer categories
  safety_concern:    { title: 'Safety Concern',              priority: 'urgent' },
  driver_behavior:   { title: 'Driver Behavior',             priority: 'urgent' },
  early_drop:        { title: 'Early Drop / Wrong Route',    priority: 'high'   },
  overcharge:        { title: 'Overcharge / Refund',         priority: 'high'   },
  driver_cancelled:  { title: 'Driver Cancelled / No-show',  priority: 'high'   },
  vehicle_condition: { title: 'Vehicle Condition',           priority: 'normal' },
  wallet_issue:      { title: 'Wallet / Payment Issue',      priority: 'normal' },
  app_issue:         { title: 'App Issue',                   priority: 'low'    },
  other:             { title: 'Other Issue',                 priority: 'low'    },
  // Driver categories
  abusive_customer:  { title: 'Abusive Customer',            priority: 'urgent' },
  customer_no_show:  { title: 'Customer No-Show',            priority: 'high'   },
  payment_refused:   { title: 'Payment Refused',             priority: 'high'   },
  false_accusation:  { title: 'False Accusation',            priority: 'high'   },
  vehicle_damage:    { title: 'Vehicle Damage',              priority: 'high'   },
  wrong_location:    { title: 'Wrong Location',              priority: 'normal' },
  earnings_issue:    { title: 'Earnings / Commission Issue', priority: 'normal' },
  app_gps_issue:     { title: 'App / GPS Issue',             priority: 'normal' },
  driver_other:      { title: 'Other Issue',                 priority: 'low'    },
};

const SLA_HOURS = { urgent: 4, high: 24, normal: 48, low: 72 };

// POST /api/support/tickets — file a new ticket
router.post('/tickets', async (req, res) => {
  const { phone, role, category, description, ride_id, image_base64 } = req.body;
  if (!phone || !role || !category || !description)
    return res.status(400).json({ error: 'phone, role, category, description required' });
  if (description.length < 10)
    return res.status(400).json({ error: 'Description must be at least 10 characters' });

  const cat = CATEGORY_MAP[category];
  if (!cat) return res.status(400).json({ error: 'Invalid category' });
  if (!['customer', 'driver'].includes(role))
    return res.status(400).json({ error: 'role must be customer or driver' });

  const priority = cat.priority;
  const slaDeadline = new Date(Date.now() + SLA_HOURS[priority] * 60 * 60 * 1000);

  try {
    const ins = await db.query(
      `INSERT INTO support_tickets (role, user_phone, ride_id, category, title, description, priority, sla_deadline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [role, phone, ride_id || null, category, cat.title, description.trim(), priority, slaDeadline]
    );
    const { id, created_at } = ins.rows[0];
    const year = new Date(created_at).getFullYear().toString().slice(-2);
    const ticketNo = `SP-${year}-${String(id).padStart(5, '0')}`;
    await db.query(`UPDATE support_tickets SET ticket_no=$1, updated_at=NOW() WHERE id=$2`, [ticketNo, id]);

    // Opening system message
    await db.query(
      `INSERT INTO ticket_messages (ticket_id, sender, sender_name, message)
       VALUES ($1,'system','System',$2)`,
      [id, `Ticket ${ticketNo} filed. We will respond within ${SLA_HOURS[priority]} hours.`]
    );

    // Optional photo attachment
    if (image_base64) {
      try {
        const upload = await cloudinary.uploader.upload(image_base64, {
          folder: 'support_tickets', resource_type: 'image',
        });
        await db.query(
          `INSERT INTO ticket_attachments (ticket_id, image_url, uploaded_by) VALUES ($1,$2,'user')`,
          [id, upload.secure_url]
        );
      } catch (_e) { /* attachment optional — don't fail the ticket */ }
    }

    res.json({ success: true, ticket_no: ticketNo, ticket_id: id, priority, sla_hours: SLA_HOURS[priority] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/support/tickets — list my tickets
router.get('/tickets', async (req, res) => {
  const { phone, role } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const params = role ? [phone, role] : [phone];
    const result = await db.query(
      `SELECT st.id, st.ticket_no, st.category, st.title, st.status, st.priority,
              st.ride_id, st.created_at, st.updated_at, st.resolved_at, st.resolution_note,
              (SELECT COUNT(*) FROM ticket_messages tm
               WHERE tm.ticket_id = st.id
                 AND tm.sender = 'admin'
                 AND tm.is_internal = false
                 AND tm.created_at > COALESCE(
                   (SELECT MAX(tm2.created_at) FROM ticket_messages tm2
                    WHERE tm2.ticket_id = st.id AND tm2.sender = 'user'),
                   st.created_at
                 )
              ) AS unread_replies
       FROM support_tickets st
       WHERE st.user_phone = $1 ${role ? 'AND st.role = $2' : ''}
       ORDER BY st.created_at DESC
       LIMIT 50`,
      params
    );
    res.json({ tickets: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/support/tickets/:id — ticket detail with messages + attachments
router.get('/tickets/:id', async (req, res) => {
  const { phone } = req.query;
  const { id } = req.params;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  try {
    const ticketRes = await db.query(
      `SELECT * FROM support_tickets WHERE id=$1 AND user_phone=$2`,
      [id, phone]
    );
    if (!ticketRes.rows[0]) return res.status(404).json({ error: 'Ticket not found' });

    const [msgRes, attachRes] = await Promise.all([
      db.query(
        `SELECT id, sender, sender_name, message, created_at
         FROM ticket_messages WHERE ticket_id=$1 AND is_internal=false ORDER BY created_at ASC`,
        [id]
      ),
      db.query(
        `SELECT id, image_url, caption, created_at FROM ticket_attachments WHERE ticket_id=$1 ORDER BY created_at ASC`,
        [id]
      ),
    ]);
    res.json({ ticket: ticketRes.rows[0], messages: msgRes.rows, attachments: attachRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/support/tickets/:id/reply — user adds a message
router.post('/tickets/:id/reply', async (req, res) => {
  const { phone, message } = req.body;
  const { id } = req.params;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });
  if (message.trim().length < 1) return res.status(400).json({ error: 'Message is empty' });
  try {
    const ticketRes = await db.query(
      `SELECT id, ticket_no, status FROM support_tickets WHERE id=$1 AND user_phone=$2`,
      [id, phone]
    );
    if (!ticketRes.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    if (ticketRes.rows[0].status === 'resolved')
      return res.status(400).json({ error: 'Ticket is already resolved' });

    await db.query(
      `INSERT INTO ticket_messages (ticket_id, sender, message) VALUES ($1,'user',$2)`,
      [id, message.trim()]
    );
    await db.query(`UPDATE support_tickets SET updated_at=NOW() WHERE id=$1`, [id]);

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
