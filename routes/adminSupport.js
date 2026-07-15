const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { sendFCM } = require('../config/firebase');

// GET /api/admin/support/stats
router.get('/stats', async (req, res) => {
  try {
    const [total, open, inProgress, resolvedToday, breached, byCategory] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM support_tickets`),
      db.query(`SELECT COUNT(*) FROM support_tickets WHERE status='open'`),
      db.query(`SELECT COUNT(*) FROM support_tickets WHERE status='in_progress'`),
      db.query(`SELECT COUNT(*) FROM support_tickets WHERE status='resolved' AND DATE(resolved_at)=CURRENT_DATE`),
      db.query(`SELECT COUNT(*) FROM support_tickets WHERE status IN ('open','in_progress') AND sla_deadline < NOW()`),
      db.query(`SELECT category, COUNT(*) AS count FROM support_tickets GROUP BY category ORDER BY count DESC LIMIT 10`),
    ]);
    res.json({
      total:          parseInt(total.rows[0].count),
      open:           parseInt(open.rows[0].count),
      in_progress:    parseInt(inProgress.rows[0].count),
      resolved_today: parseInt(resolvedToday.rows[0].count),
      sla_breached:   parseInt(breached.rows[0].count),
      by_category:    byCategory.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/support/tickets — filterable list
router.get('/tickets', async (req, res) => {
  const { status, priority, role, category, search, page = 1, limit = 30 } = req.query;
  const conditions = [];
  const params = [];
  let pi = 1;
  if (status)   { conditions.push(`st.status=$${pi++}`);              params.push(status); }
  if (priority) { conditions.push(`st.priority=$${pi++}`);            params.push(priority); }
  if (role)     { conditions.push(`st.role=$${pi++}`);                params.push(role); }
  if (category) { conditions.push(`st.category=$${pi++}`);            params.push(category); }
  if (search) {
    conditions.push(`(st.user_phone ILIKE $${pi} OR st.ticket_no ILIKE $${pi} OR CAST(st.ride_id AS TEXT) ILIKE $${pi})`);
    params.push(`%${search}%`); pi++;
  }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
  try {
    const result = await db.query(
      `SELECT st.id, st.ticket_no, st.role, st.user_phone, st.category, st.title,
              st.status, st.priority, st.assigned_to, st.sla_deadline, st.ride_id,
              st.created_at, st.updated_at,
              CASE WHEN st.sla_deadline < NOW() AND st.status IN ('open','in_progress')
                   THEN true ELSE false END AS sla_breached
       FROM support_tickets st
       ${where}
       ORDER BY
         CASE st.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END ASC,
         st.sla_deadline ASC NULLS LAST
       LIMIT $${pi++} OFFSET $${pi++}`,
      params
    );
    res.json({ tickets: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/support/tickets/:id — full detail
router.get('/tickets/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [ticketRes, msgRes, attachRes] = await Promise.all([
      db.query(`SELECT * FROM support_tickets WHERE id=$1`, [id]),
      db.query(`SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC`, [id]),
      db.query(`SELECT * FROM ticket_attachments WHERE ticket_id=$1 ORDER BY created_at ASC`, [id]),
    ]);
    if (!ticketRes.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = ticketRes.rows[0];

    let rideContext = null;
    if (ticket.ride_id) {
      const rideRes = await db.query(
        `SELECT r.id, r.pickup, r.drop_location, r.fare, r.ride_type, r.status, r.created_at,
                p.name AS customer_name, p.phone AS customer_phone,
                d.name AS driver_name, d.phone AS driver_phone
         FROM rides r
         LEFT JOIN users p ON r.passenger_id = p.id
         LEFT JOIN users d ON r.driver_id = d.id
         WHERE r.id::text = $1`,
        [String(ticket.ride_id)]
      ).catch(() => ({ rows: [] }));
      rideContext = rideRes.rows[0] || null;
    }
    res.json({ ticket, messages: msgRes.rows, attachments: attachRes.rows, ride_context: rideContext });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/support/tickets/:id/assign
router.put('/tickets/:id/assign', async (req, res) => {
  const { id } = req.params;
  const { admin_name } = req.body;
  if (!admin_name) return res.status(400).json({ error: 'admin_name required' });
  try {
    await db.query(
      `UPDATE support_tickets
       SET assigned_to=$1,
           status = CASE WHEN status='open' THEN 'in_progress' ELSE status END,
           updated_at = NOW()
       WHERE id=$2`,
      [admin_name, id]
    );
    await db.query(
      `INSERT INTO ticket_messages (ticket_id, sender, sender_name, message, is_internal)
       VALUES ($1,'system','System',$2,true)`,
      [id, `Assigned to ${admin_name}`]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/support/tickets/:id/status
router.put('/tickets/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, note } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  if (!['open', 'in_progress', 'resolved'].includes(status))
    return res.status(400).json({ error: 'Invalid status' });
  try {
    await db.query(
      `UPDATE support_tickets
       SET status=$1, updated_at=NOW() ${status === 'resolved' ? ', resolved_at=NOW()' : ''}
       WHERE id=$2`,
      [status, id]
    );
    if (note) {
      await db.query(
        `INSERT INTO ticket_messages (ticket_id,sender,sender_name,message,is_internal)
         VALUES ($1,'system','System',$2,true)`,
        [id, note]
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/support/tickets/:id/message — reply or internal note
router.post('/tickets/:id/message', async (req, res) => {
  const { id } = req.params;
  const { message, is_internal, admin_name } = req.body;
  if (!message || !admin_name) return res.status(400).json({ error: 'message and admin_name required' });
  try {
    const ticketRes = await db.query(
      `SELECT user_phone, ticket_no, role FROM support_tickets WHERE id=$1`,
      [id]
    );
    if (!ticketRes.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = ticketRes.rows[0];

    await db.query(
      `INSERT INTO ticket_messages (ticket_id, sender, sender_name, message, is_internal)
       VALUES ($1,'admin',$2,$3,$4)`,
      [id, admin_name, message, is_internal || false]
    );
    await db.query(
      `UPDATE support_tickets
       SET updated_at=NOW(), status=CASE WHEN status='open' THEN 'in_progress' ELSE status END
       WHERE id=$1`,
      [id]
    );

    if (!is_internal) {
      sendFCM(
        ticket.user_phone,
        'Sppero Support replied',
        message.slice(0, 80),
        { type: 'support_reply', ticket_id: String(id), ticket_no: ticket.ticket_no },
        { role: ticket.role }
      ).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/support/tickets/:id/resolve
router.put('/tickets/:id/resolve', async (req, res) => {
  const { id } = req.params;
  const { resolution_note, action_taken, refund_amount, admin_name } = req.body;
  if (!resolution_note || !admin_name)
    return res.status(400).json({ error: 'resolution_note and admin_name required' });
  try {
    const ticketRes = await db.query(
      `SELECT user_phone, ticket_no, role FROM support_tickets WHERE id=$1`,
      [id]
    );
    if (!ticketRes.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = ticketRes.rows[0];

    await db.query(
      `UPDATE support_tickets
       SET status='resolved', resolution_note=$1, action_taken=$2,
           refund_amount=$3, resolved_at=NOW(), updated_at=NOW()
       WHERE id=$4`,
      [resolution_note, action_taken || 'none', refund_amount || null, id]
    );
    await db.query(
      `INSERT INTO ticket_messages (ticket_id, sender, sender_name, message)
       VALUES ($1,'admin',$2,$3)`,
      [id, admin_name, `Ticket resolved: ${resolution_note}`]
    );

    sendFCM(
      ticket.user_phone,
      'Ticket Resolved',
      resolution_note.slice(0, 80),
      { type: 'support_resolved', ticket_id: String(id), ticket_no: ticket.ticket_no },
      { role: ticket.role }
    ).catch(() => {});

    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/support/tickets/:id/action — enforcement: warn, suspend, ban, refund
router.post('/tickets/:id/action', async (req, res) => {
  const { id } = req.params;
  const { action, target_phone, amount, reason, admin_name } = req.body;
  if (!action || !target_phone || !reason || !admin_name)
    return res.status(400).json({ error: 'action, target_phone, reason, admin_name required' });
  if (!['refund', 'warn', 'suspend', 'ban'].includes(action))
    return res.status(400).json({ error: 'Invalid action. Use: refund, warn, suspend, ban' });

  try {
    const ticketRes = await db.query(`SELECT role, ticket_no FROM support_tickets WHERE id=$1`, [id]);
    if (!ticketRes.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    const { role, ticket_no } = ticketRes.rows[0];

    const actionLabel = action === 'refund' ? `Refund ₹${amount || 0} issued`
      : action === 'warn'    ? 'Warning issued'
      : action === 'suspend' ? `${role === 'driver' ? 'Driver' : 'Customer'} account suspended`
      :                        `${role === 'driver' ? 'Driver' : 'Customer'} account banned`;

    // Log action to thread (visible to user)
    await db.query(
      `INSERT INTO ticket_messages (ticket_id, sender, sender_name, message, is_internal)
       VALUES ($1,'system','System',$2,false)`,
      [id, `Action by ${admin_name}: ${actionLabel}${reason ? ` — ${reason}` : ''}`]
    );

    // Record on ticket
    if (action === 'refund' && amount) {
      await db.query(
        `UPDATE support_tickets SET action_taken=$1, refund_amount=$3, updated_at=NOW() WHERE id=$2`,
        [action, id, parseFloat(amount)]
      );
    } else {
      await db.query(`UPDATE support_tickets SET action_taken=$1, updated_at=NOW() WHERE id=$2`, [action, id]);
    }

    // Execute enforcement
    if (action === 'refund' && amount) {
      const userRes = await db.query(`SELECT id FROM users WHERE phone=$1 LIMIT 1`, [target_phone]);
      const uid = userRes.rows[0]?.id;
      if (uid) {
        const walletTable = role === 'driver' ? 'driver_wallet' : 'customer_wallet';
        const idCol       = role === 'driver' ? 'driver_id'     : 'user_id';
        await db.query(`UPDATE ${walletTable} SET balance=balance+$1, updated_at=NOW() WHERE ${idCol}=$2`, [parseFloat(amount), uid]).catch(() => {});
      }
      sendFCM(target_phone, `Refund Credited: ₹${amount}`, reason, { type: 'refund' }, { role }).catch(() => {});
    } else if (action === 'warn') {
      sendFCM(target_phone, 'Sppero Support: Warning', reason, { type: 'warning' }, { role }).catch(() => {});
    } else if (action === 'suspend' || action === 'ban') {
      if (role === 'driver') {
        await db.query(`UPDATE drivers SET approved='suspended', message=$1 WHERE phone=$2`, [reason, target_phone]).catch(() => {});
      } else {
        await db.query(`UPDATE users SET is_suspended=true, suspend_reason=$1, suspended_until=NULL WHERE phone=$2`, [reason, target_phone]).catch(() => {});
      }
      sendFCM(target_phone, 'Account Suspended', reason, { type: 'account_restricted' }, { role }).catch(() => {});
    }

    res.json({ success: true, action, label: actionLabel });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
