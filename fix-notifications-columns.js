/* notifications table me teen column the hi nahi, jinhe poora code maangta hai.

   NAAPA GAYA (prod, 29 Aug 2026):
     table me sirf: id, target, title, message, created_at, image_url
     par code maangta hai: user_phone, body, type

   Nateeja - dono raaste 500 de rahe the:
     GET /api/notifications          -> column "body" does not exist
     GET /api/notifications/latest   -> column "user_phone" does not exist

   Yaani driver ka notification centre khulta hi nahi tha, aur uska 30-second
   wala poller har baar chup-chaap gir raha tha (fetch ka catch use nigal
   jaata hai). Isi tarah admin ka kisi ek aadmi ko bheja gaya sandesh
   (admin.js) aur rideWorker ki soochnaayein kabhi save hui hi nahi - unka
   INSERT bhi inhi column par likha hai.

   Ye script sirf wo teen column jodti hai. Purani panktiyan waise ki waisi
   rehti hain: unka user_phone NULL hoga aur unka target pehle jaisa - aur
   GET dono ko sambhalta hai (target = $1 OR user_phone = $1, aur
   COALESCE(message, body)).

   Do index bhi, kyoki har poochh in do column par hi chhanti hai. Bina inke
   30 second me ek baar chalne wala poller har driver ke liye poori table
   padhta rehta.
*/
const db = require('./config/db');

(async () => {
  try {
    const before = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications'`);
    console.log('  pehle: ' + before.rows.map(r => r.column_name).join(', '));

    await db.query(`
      ALTER TABLE notifications
        ADD COLUMN IF NOT EXISTS user_phone VARCHAR(15),
        ADD COLUMN IF NOT EXISTS body       TEXT,
        ADD COLUMN IF NOT EXISTS type       VARCHAR(40)`);
    await db.query(`CREATE INDEX IF NOT EXISTS notifications_user_phone_idx ON notifications (user_phone)`);
    await db.query(`CREATE INDEX IF NOT EXISTS notifications_created_idx    ON notifications (created_at DESC)`);

    const after = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'notifications'`);
    console.log('  baad me: ' + after.rows.map(r => r.column_name).join(', '));

    // Wahi do sawal jo app poochhta hai - chala kar dekho, maan mat lo
    const c = await db.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO notifications (user_phone, title, body, type, created_at)
         VALUES ('0000000000', 'JAANCH', 'JAANCH body', 'ride_rated', NOW())`);
      const list = await c.query(
        `SELECT title, COALESCE(message, body) AS message, created_at, type, image_url
           FROM notifications
          WHERE target = 'all' OR target = $1 OR user_phone = $1
             OR (target = 'drivers' AND $2 = 'driver')
          ORDER BY created_at DESC LIMIT 1`, ['0000000000', 'driver']);
      const latest = await c.query(
        `SELECT * FROM notifications WHERE user_phone = $1 ORDER BY created_at DESC LIMIT 1`,
        ['0000000000']);
      console.log('  GET /notifications        -> ' + JSON.stringify(list.rows[0]));
      console.log('  GET /notifications/latest -> ' + (latest.rows[0] ? 'mil gayi' : 'NAHI MILI'));
    } catch (e) {
      console.log('  !! jaanch phati: ' + e.message);
      process.exitCode = 1;
    } finally {
      await c.query('ROLLBACK');   // jaanch wali pankti rakhni nahi hai
      c.release();
    }
  } catch (e) {
    console.error('  !! ' + e.message);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
})();
