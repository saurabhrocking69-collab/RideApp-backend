const express = require('express');
const router  = express.Router();
const db      = require('../config/db');
const userAuth = require('../middleware/userAuth');
const ownPhone = require('../middleware/ownPhone');

// Vehicle type → group mapping
function vehicleGroup(type) {
  if (['bike','green_bike','moto'].includes(type)) return 'two_wheeler';
  if (['auto','electric_auto','eriksha'].includes(type)) return 'three_wheeler';
  return 'four_wheeler';
}

async function ensureBonusWallet(phone, client = db) {
  await client.query(
    `INSERT INTO bonus_wallet (driver_phone) VALUES ($1) ON CONFLICT (driver_phone) DO NOTHING`,
    [phone]
  );
}

// Subscription pricing is already a discount deal for the driver — rides completed
// while a ride-pack subscription is active don't also earn bonuses on top of that.
async function hasActiveSubscription(phone, client = db) {
  const r = await client.query(
    `SELECT 1 FROM driver_subscriptions WHERE driver_phone=$1 AND status='active' AND expires_at > NOW() LIMIT 1`,
    [phone]
  );
  return r.rows.length > 0;
}
// Rides actually covered by a subscription (commission waived) are logged here at
// payment time — used to exclude them from bonus-eligible ride counts even after
// the subscription itself has since expired or been fully used up.
const EXCLUDE_SUBSCRIPTION_RIDES = `AND NOT EXISTS (SELECT 1 FROM subscription_ride_log srl WHERE srl.ride_id = r.id::text)`;

// GET /api/bonus/dashboard?phone=X
router.get('/dashboard', userAuth, ownPhone(), async (req, res) => {
  const { phone } = req.query;
  try {
    const drRes = await db.query(
      `SELECT d.vehicle_type FROM drivers d JOIN users u ON d.id=u.id WHERE u.phone=$1`, [phone]
    );
    if (!drRes.rows[0]) return res.status(404).json({ error: 'Driver not found' });
    const vType = drRes.rows[0].vehicle_type;
    const group = vehicleGroup(vType);

    await ensureBonusWallet(phone);

    const [wallet, rulesRes, todayRides, todayClaimed, weekData, weekClaimedRes] = await Promise.all([
      db.query(`SELECT * FROM bonus_wallet WHERE driver_phone=$1`, [phone]),
      db.query(
        `SELECT * FROM bonus_rules WHERE is_active=true AND (vehicle_type='all' OR vehicle_type=$1) ORDER BY bonus_type, id`,
        [group]
      ),
      db.query(
        `SELECT COUNT(*) FROM rides r WHERE r.driver_id=(SELECT id FROM users WHERE phone=$1) AND r.status='completed' AND DATE(r.created_at AT TIME ZONE 'Asia/Kolkata')=CURRENT_DATE ${EXCLUDE_SUBSCRIPTION_RIDES}`,
        [phone]
      ),
      db.query(
        `SELECT rule_id, ref_key FROM bonus_claims_guard WHERE driver_phone=$1 AND ref_key LIKE $2`,
        [phone, `daily_${new Date().toISOString().slice(0,10)}_%`]
      ),
      (() => {
        const now = new Date();
        const dow = now.getDay() === 0 ? 7 : now.getDay();
        const ws = new Date(now); ws.setDate(now.getDate() - dow + 1); ws.setHours(0,0,0,0);
        return db.query(
          `SELECT DATE(r.created_at AT TIME ZONE 'Asia/Kolkata') AS ride_date, COUNT(*) AS cnt
           FROM rides r WHERE r.driver_id=(SELECT id FROM users WHERE phone=$1) AND r.status='completed' AND r.created_at >= $2 ${EXCLUDE_SUBSCRIPTION_RIDES}
           GROUP BY DATE(r.created_at AT TIME ZONE 'Asia/Kolkata')`,
          [phone, ws.toISOString().slice(0,10)]
        ).then(r => ({ rows: r.rows, weekStart: ws.toISOString().slice(0,10) }));
      })(),
      (() => {
        const now = new Date();
        const dow = now.getDay() === 0 ? 7 : now.getDay();
        const ws = new Date(now); ws.setDate(now.getDate() - dow + 1); ws.setHours(0,0,0,0);
        const weekKey = `week_${ws.toISOString().slice(0,10)}`;
        return db.query(
          `SELECT 1 FROM bonus_claims_guard WHERE driver_phone=$1 AND ref_key=$2`,
          [phone, weekKey]
        );
      })(),
    ]);

    // Peak hour bonus earned today
    const peakRule = rulesRes.rows.find(r => r.bonus_type === 'peak_hour');
    let peakToday = 0;
    if (peakRule) {
      const pt = await db.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM bonus_ledger WHERE driver_phone=$1 AND bonus_type='peak_hour' AND ref_date=CURRENT_DATE`,
        [phone]
      );
      peakToday = parseFloat(pt.rows[0].total);
    }

    const now = new Date();
    const hour = now.getHours();
    const isPeak = peakRule ? peakRule.config.slots.some((s) => hour >= s.start && hour < s.end) : false;

    res.json({
      vehicle_type: vType,
      vehicle_group: group,
      wallet: wallet.rows[0] || { balance: 0, total_earned: 0, total_redeemed: 0 },
      rules: rulesRes.rows,
      rides_today: parseInt(todayRides.rows[0].count),
      today_claimed: todayClaimed.rows,
      week_rides_by_day: weekData.rows,
      week_start: weekData.weekStart,
      week_bonus_claimed: weekClaimedRes.rows.length > 0,
      peak_today: peakToday,
      is_peak_hour: isPeak,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/bonus/claim-daily { phone, rule_id, tier_index }
router.post('/claim-daily', userAuth, ownPhone(), async (req, res) => {
  const { phone, rule_id, tier_index } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ruleRes = await client.query(
      `SELECT * FROM bonus_rules WHERE id=$1 AND is_active=true AND bonus_type='daily_rides'`, [rule_id]
    );
    if (!ruleRes.rows[0]) { await client.query('ROLLBACK'); return res.json({ success: false, error: 'Rule not found' }); }
    const tier = ruleRes.rows[0].config.tiers?.[tier_index];
    if (!tier) { await client.query('ROLLBACK'); return res.json({ success: false, error: 'Invalid tier' }); }

    const ridesRes = await client.query(
      `SELECT COUNT(*) FROM rides r WHERE r.driver_id=(SELECT id FROM users WHERE phone=$1) AND r.status='completed' AND DATE(r.created_at AT TIME ZONE 'Asia/Kolkata')=CURRENT_DATE ${EXCLUDE_SUBSCRIPTION_RIDES}`,
      [phone]
    );
    if (parseInt(ridesRes.rows[0].count) < tier.rides) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: `${tier.rides} rides required — currently at ${ridesRes.rows[0].count}` });
    }

    const refKey = `daily_${new Date().toISOString().slice(0,10)}_r${rule_id}_t${tier_index}`;
    await client.query(
      `INSERT INTO bonus_claims_guard (driver_phone, rule_id, ref_key) VALUES ($1,$2,$3)`,
      [phone, rule_id, refKey]
    );

    await ensureBonusWallet(phone, client);
    await client.query(
      `UPDATE bonus_wallet SET balance=balance+$1, total_earned=total_earned+$1, updated_at=NOW() WHERE driver_phone=$2`,
      [tier.amount, phone]
    );
    await client.query(
      `INSERT INTO bonus_ledger (driver_phone, rule_id, bonus_type, amount, description) VALUES ($1,$2,'daily_rides',$3,$4)`,
      [phone, rule_id, tier.amount, `${tier.rides} rides bonus — ${ruleRes.rows[0].label}`]
    );
    await client.query('COMMIT');
    res.json({ success: true, amount: tier.amount, message: `₹${tier.amount} bonus added to your wallet! 🎉` });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.json({ success: false, error: 'This tier bonus has already been claimed today' });
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/bonus/claim-streak { phone }
router.post('/claim-streak', userAuth, ownPhone(), async (req, res) => {
  const { phone } = req.body;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ruleRes = await client.query(
      `SELECT * FROM bonus_rules WHERE is_active=true AND bonus_type='weekly_streak' LIMIT 1`
    );
    if (!ruleRes.rows[0]) { await client.query('ROLLBACK'); return res.json({ success: false, error: 'No streak rule active' }); }
    const rule = ruleRes.rows[0];
    const { target_days, rides_per_day, amount } = rule.config;

    const now = new Date();
    const dow = now.getDay() === 0 ? 7 : now.getDay();
    const ws = new Date(now); ws.setDate(now.getDate() - dow + 1); ws.setHours(0,0,0,0);
    const weekKey = `week_${ws.toISOString().slice(0,10)}`;

    const weekData = await client.query(
      `SELECT DATE(r.created_at AT TIME ZONE 'Asia/Kolkata') AS ride_date, COUNT(*) AS cnt
       FROM rides r WHERE r.driver_id=(SELECT id FROM users WHERE phone=$1) AND r.status='completed' AND r.created_at >= $2 ${EXCLUDE_SUBSCRIPTION_RIDES}
       GROUP BY DATE(r.created_at AT TIME ZONE 'Asia/Kolkata') HAVING COUNT(*) >= $3`,
      [phone, ws.toISOString().slice(0,10), rides_per_day]
    );
    if (weekData.rows.length < target_days) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: `${target_days} qualifying days required — currently ${weekData.rows.length}/${target_days} done` });
    }

    await client.query(
      `INSERT INTO bonus_claims_guard (driver_phone, rule_id, ref_key) VALUES ($1,$2,$3)`,
      [phone, rule.id, weekKey]
    );
    await ensureBonusWallet(phone, client);
    await client.query(
      `UPDATE bonus_wallet SET balance=balance+$1, total_earned=total_earned+$1, updated_at=NOW() WHERE driver_phone=$2`,
      [amount, phone]
    );
    await client.query(
      `INSERT INTO bonus_ledger (driver_phone, rule_id, bonus_type, amount, description) VALUES ($1,$2,'weekly_streak',$3,$4)`,
      [phone, rule.id, amount, `Weekly Warrior — ${target_days} days × ${rides_per_day}+ rides`]
    );
    await client.query('COMMIT');
    res.json({ success: true, amount, message: `₹${amount} Weekly Warrior bonus earned! 🏆` });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.json({ success: false, error: 'This week\'s streak bonus has already been claimed' });
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// POST /api/bonus/redeem { phone, amount }
router.post('/redeem', userAuth, ownPhone(), async (req, res) => {
  const { phone, amount } = req.body;
  const redeemAmt = parseFloat(amount);
  if (isNaN(redeemAmt) || redeemAmt < 50) return res.json({ success: false, error: 'Minimum ₹50 required to redeem' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const walletRes = await client.query(
      `SELECT balance FROM bonus_wallet WHERE driver_phone=$1 FOR UPDATE`, [phone]
    );
    if (!walletRes.rows[0] || parseFloat(walletRes.rows[0].balance) < redeemAmt) {
      await client.query('ROLLBACK');
      return res.json({ success: false, error: 'Insufficient bonus balance' });
    }
    await client.query(
      `UPDATE bonus_wallet SET balance=balance-$1, total_redeemed=total_redeemed+$1, updated_at=NOW() WHERE driver_phone=$2`,
      [redeemAmt, phone]
    );
    const u = await client.query(`SELECT id FROM users WHERE phone=$1`, [phone]);
    await client.query(
      `UPDATE driver_wallet SET balance=balance+$1, total_earned=total_earned+$1 WHERE driver_id=$2`,
      [redeemAmt, u.rows[0].id]
    );
    await client.query(
      `INSERT INTO bonus_ledger (driver_phone, bonus_type, amount, description) VALUES ($1,'redeem',$2,'Bonus wallet → Main wallet redeem')`,
      [phone, -redeemAmt]
    );
    await client.query(
      `INSERT INTO transactions (user_id,type,amount,description) VALUES ($1,'credit',$2,'Bonus wallet redeem')`,
      [u.rows[0].id, redeemAmt]
    );
    await client.query('COMMIT');
    res.json({ success: true, message: `₹${redeemAmt.toFixed(0)} transferred to your main wallet! 💰` });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// GET /api/bonus/history?phone=X&page=1
router.get('/history', userAuth, ownPhone(), async (req, res) => {
  const { phone, page = '1' } = req.query;
  const offset = (parseInt(page) - 1) * 20;
  try {
    const [rows, total] = await Promise.all([
      db.query(
        `SELECT * FROM bonus_ledger WHERE driver_phone=$1 ORDER BY created_at DESC LIMIT 20 OFFSET $2`,
        [phone, offset]
      ),
      db.query(`SELECT COUNT(*) FROM bonus_ledger WHERE driver_phone=$1`, [phone]),
    ]);
    res.json({ history: rows.rows, total: parseInt(total.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Called internally when a ride completes — auto-credits peak hour bonus
async function creditPeakBonusIfApplicable(drPhone, rideId) {
  try {
    const ruleRes = await db.query(
      `SELECT * FROM bonus_rules WHERE is_active=true AND bonus_type='peak_hour' LIMIT 1`
    );
    if (!ruleRes.rows[0]) return;
    const rule = ruleRes.rows[0];
    const hour = new Date().getHours();
    const isPeak = rule.config.slots.some((s) => hour >= s.start && hour < s.end);
    if (!isPeak) return;

    // Subscription rides are already discounted — no bonus stacks on top. This
    // ride's subscription_ride_log row (if any) won't exist yet at trip-completion
    // time (it's written at payment confirmation), so check live subscription status.
    if (await hasActiveSubscription(drPhone)) return;

    // Guard — one bonus per ride
    await db.query(
      `INSERT INTO bonus_claims_guard (driver_phone, rule_id, ref_key) VALUES ($1,$2,$3)`,
      [drPhone, rule.id, `peak_${rideId}`]
    );
    const amt = rule.config.per_ride;
    await ensureBonusWallet(drPhone);
    await db.query(
      `UPDATE bonus_wallet SET balance=balance+$1, total_earned=total_earned+$1, updated_at=NOW() WHERE driver_phone=$2`,
      [amt, drPhone]
    );
    await db.query(
      `INSERT INTO bonus_ledger (driver_phone, rule_id, bonus_type, amount, description) VALUES ($1,$2,'peak_hour',$3,'Peak hour ride bonus')`,
      [drPhone, rule.id, amt]
    );
  } catch (_e) {} // silent fail — never break ride completion
}

module.exports = router;
module.exports.creditPeakBonusIfApplicable = creditPeakBonusIfApplicable;
