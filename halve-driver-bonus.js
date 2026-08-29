/* Driver bonus ki rakam aadhi - partner programme aa jaane ke baad.

   Ye rakam code me nahi, bonus_rules table ke `config` me hai (admin panel se
   badli ja sakti hai), isliye badlaav yahan hota hai, kisi .js me nahi.

   Paanch niyam chal rahe hain, paanchon is_active:
     id=1 daily_rides    4/8/12 rides par 20/50/90
     id=2 daily_rides    4/8/12 rides par 25/60/110
     id=3 daily_rides    3/6/10 rides par 40/100/180
     id=4 peak_hour      per_ride 8
     id=5 weekly_streak  250 (5 din x 4+ rides)

   Teen daily_rides isliye hain ki har vehicle_type ka apna niyam hai - teeno
   badalne hain, ek chhod dena kuch vehicle par purani rakam chhod dega.

   Rakam aadhi, aur poore rupaye me NEECHE ki taraf: 25 ka 12 (12.5 nahi),
   180 ka 90, 8 ka 4. Neeche isliye ki "aadha" se zyada kabhi na de baithe,
   aur poore rupaye isliye ki ye sankhya driver ko dikhti bhi hai.

   Rides/din ki shart NAHI chhedi ja rahi - sirf rakam. Shart badalna alag
   faisla hai aur wo maanga nahi gaya.

   Dobara chalane par kuch nahi bigadta? BIGADTA HAI - ye har baar aadha kar
   dega. Isliye script pehle purani rakam chhapti hai aur ek nishaan
   (bonus_halved_2026_08_29) dekhti hai, jise wo khud lagati hai. Ek hi baar
   chalti hai; doosri baar apne aap ruk jaati hai.
*/
const db = require('./config/db');

const MARK = 'bonus_halved_2026_08_29';
const half = (n) => Math.floor(Number(n) / 2);

(async () => {
  const client = await db.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS migration_marks (
      name TEXT PRIMARY KEY, done_at TIMESTAMPTZ DEFAULT NOW())`);
    const seen = await client.query('SELECT 1 FROM migration_marks WHERE name = $1', [MARK]);
    if (seen.rows[0]) {
      console.log('  pehle hi chal chuki hai (' + MARK + ') - kuch nahi kiya');
      return;
    }

    const rules = await client.query(
      `SELECT id, bonus_type, vehicle_type, config FROM bonus_rules ORDER BY id`);

    await client.query('BEGIN');
    for (const r of rules.rows) {
      const c = typeof r.config === 'string' ? JSON.parse(r.config) : { ...r.config };
      let before = '', after = '';

      if (Array.isArray(c.tiers)) {
        before = c.tiers.map(t => t.amount).join('/');
        c.tiers = c.tiers.map(t => ({ ...t, amount: half(t.amount) }));
        after = c.tiers.map(t => t.amount).join('/');
      } else if (c.per_ride != null) {
        before = String(c.per_ride);
        c.per_ride = half(c.per_ride);
        after = String(c.per_ride);
      } else if (c.amount != null) {
        before = String(c.amount);
        c.amount = half(c.amount);
        after = String(c.amount);
      } else {
        console.log('  id=' + r.id + '  ' + r.bonus_type + '  -> isme koi rakam nahi mili, chhoda');
        continue;
      }

      await client.query('UPDATE bonus_rules SET config = $1, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(c), r.id]);
      console.log('  id=' + r.id + '  ' + String(r.bonus_type).padEnd(14) +
                  String(r.vehicle_type || 'all').padEnd(8) + before + '  ->  ' + after);
    }
    await client.query('INSERT INTO migration_marks (name) VALUES ($1)', [MARK]);
    await client.query('COMMIT');
    console.log('  ho gaya, aur nishaan lag gaya - dobara chalane par ye ruk jayegi');

    const after = await client.query('SELECT id, config FROM bonus_rules ORDER BY id');
    console.log('  ab:');
    after.rows.forEach(x => console.log('   id=' + x.id + '  ' + JSON.stringify(x.config)));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('  !! ' + e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    process.exit(process.exitCode || 0);
  }
})();
