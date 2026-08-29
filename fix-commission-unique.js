/* driver_commissions par ride_id ka unique constraint - jo kabhi tha hi nahi.

   NAAPA GAYA (prod par, 29 Aug 2026):
     * chah jagah code `ON CONFLICT (ride_id)` likhta hai - rides.js me chaar,
       parcel.js me do
     * par table par ride_id ka koi unique index ya constraint hai hi nahi
       (add-payment-flow.js me wo likha hi nahi gaya tha)
     * Postgres aise INSERT ko chalne se pehle hi thukra deta hai:
         "there is no unique or exclusion constraint matching the ON CONFLICT
          specification"
       Chala kar dekha - wahi error aaya.

   Nateeja jo grahak ki screen par dikha: driver ne cash confirm kiya,
   /cash-confirm ne pehle ride ko 'completed' likh diya, aur uske TURANT baad
   wala INSERT phat gaya. Koi transaction nahi tha, to pehla likha hua reh
   gaya aur doosra kabhi hua hi nahi. Ride paid, commission ki pankti nadaarad,
   driver ke "due" me kuch nahi juda.

   77 paid rides aisi hain - 11 June se 29 Aug tak - aur unme likha hua
   commission Rs 2156 hai, jo kabhi darj hi nahi hua.

   Ye script sirf DO kaam karti hai:
     1. duplicate pankti hatati hai (constraint unhi par atkega)
     2. UNIQUE (ride_id) lagati hai

   Chhooti hui 77 panktiyon ko bharna ALAG faisla hai - wo driver ke sar par
   achanak Rs 2156 ka karz daal dega, aur wo maalik ka faisla hai, script ka
   nahi. Isliye yahan sirf ginti chhapti hai.

   Duplicate ka niyam: har ride ki SABSE PEHLI pankti rakhi jaati hai. Dekha
   gaya: saare duplicate June ke hain, saare 'settled', aur sabki rakam ek hi
   hai - yaani ek hi ghatna do-chaar baar ginli gayi thi. Pehli asli hai. */
const db = require('./config/db');

(async () => {
  const client = await db.connect();
  try {
    // ── Pehle sirf dekho ──────────────────────────────────────────────────
    const dup = await client.query(`
      SELECT ride_id, COUNT(*)::int n FROM driver_commissions
      WHERE ride_id IS NOT NULL GROUP BY ride_id HAVING COUNT(*) > 1`);
    const miss = await client.query(`
      SELECT COUNT(*)::int n, COALESCE(SUM(r.commission_amount), 0)::numeric total
        FROM rides r
       WHERE r.payment_status = 'completed' AND r.driver_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM driver_commissions c WHERE c.ride_id = r.id)`);
    const nulls = await client.query(
      `SELECT COUNT(*)::int n FROM driver_commissions WHERE ride_id IS NULL`);

    console.log('  duplicate ride_id       : ' + dup.rows.length);
    console.log('  ride_id NULL wali pankti: ' + nulls.rows[0].n + '   (unique inhe rokta nahi)');
    console.log('  chhooti hui pankti      : ' + miss.rows[0].n +
                '   commission Rs ' + miss.rows[0].total + '  <- ye script NAHI bharti');

    // ── Ab badlo ──────────────────────────────────────────────────────────
    await client.query('BEGIN');

    const del = await client.query(`
      DELETE FROM driver_commissions c
       USING driver_commissions k
       WHERE c.ride_id = k.ride_id
         AND c.ride_id IS NOT NULL
         AND c.id > k.id`);
    console.log('  hatai gayi duplicate pankti: ' + del.rowCount);

    /* SADA unique index, partial nahi.

       Pehle `WHERE ride_id IS NOT NULL` likha tha - ye soch kar ki NULL wali
       purani pankti bach jayengi. Chala kar dekha to ON CONFLICT (ride_id)
       PHIR BHI phat gaya: Postgres kisi PARTIAL index se ON CONFLICT ka
       andaza nahi lagata jab tak statement ki apni shart index ki shart se na
       mile. Yaani wo "safai" theek wahi cheez tod deti jiske liye ye script
       likhi gayi thi.

       Sada index se koi nuksaan bhi nahi: Postgres me NULL ek doosre se
       takraate nahi, to NULL wali panktiyan waise bhi bach jaati hain (aur
       yahan wo hain bhi zero). */
    await client.query(`DROP INDEX IF EXISTS driver_commissions_ride_id_uniq`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS driver_commissions_ride_id_uniq
        ON driver_commissions (ride_id)`);

    await client.query('COMMIT');
    console.log('  UNIQUE (ride_id) lag gaya');

    // ── Sach me chala? ────────────────────────────────────────────────────
    const t = await db.connect();
    try {
      await t.query('BEGIN');
      await t.query(`
        INSERT INTO driver_commissions (driver_phone, ride_id, fare, commission, payment_method, status)
        VALUES ('0000000000','00000000-0000-0000-0000-000000000001',1,1,'cash','cash_owed')
        ON CONFLICT (ride_id) DO UPDATE SET status = 'cash_owed'`);
      console.log('  jaanch: ON CONFLICT (ride_id) ab CHALTA HAI');
    } catch (e) {
      console.log('  jaanch: ABHI BHI PHAT-TA HAI -> ' + e.message);
    } finally {
      await t.query('ROLLBACK');
      t.release();
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('  !! ' + e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    process.exit(process.exitCode || 0);
  }
})();
