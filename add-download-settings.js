/* App download ki setting - website aur admin dono ke liye ek hi jagah.

   sppero.com ek static site hai (apna koi server nahi), aur admin panel yahan
   backend me hai. Dono ko ek hi sach chahiye: aaj log app kahan se lein.
   Isliye setting yahin rehti hai aur website use chalte waqt maang leti hai -
   badalne par website dobara deploy nahi karni padti.

   Teen haalat, kyoki asli zindagi me teeno aati hain:
     direct  - APK seedha website se (Play Store se pehle wala daur)
     play    - Play Store ke button (jaise hi app pass ho jaye)
     off     - kuch mat dikhao (koi dikkat ho, ya beech ka waqt)

   sha256 bhi rakha jaata hai. Seedhe APK ka sabse bada sawal yahi hota hai ki
   "jo utra wo wahi hai jo Sppero ne banaya?" - fingerprint dikha dena uska
   ek matra seedha jawab hai, aur banane me kuch nahi lagta.
*/
const db = require('./config/db');

const DEFAULTS = [
  ['mode', 'off', 'direct | play | off'],
  ['rider_apk', '', 'Rider app ki APK ka poora URL'],
  ['rider_play', '', 'Rider app ka Play Store link'],
  ['rider_version', '', 'Jaise 1.4.2'],
  ['rider_size', '', 'MB me, jaise 48'],
  ['rider_sha256', '', 'APK ka SHA-256 (apksigner/certutil se)'],
  ['driver_apk', '', 'Captain app ki APK ka poora URL'],
  ['driver_play', '', 'Captain app ka Play Store link'],
  ['driver_version', '', 'Jaise 1.4.2'],
  ['driver_size', '', 'MB me'],
  ['driver_sha256', '', 'APK ka SHA-256'],
  ['note', '', 'Buttons ke neeche ek line (khaali chhod sakte hain)'],
];

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS download_settings (
        key        VARCHAR(40) PRIMARY KEY,
        value      TEXT NOT NULL DEFAULT '',
        label      TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    for (const [k, v, label] of DEFAULTS) {
      await db.query(
        `INSERT INTO download_settings (key, value, label) VALUES ($1,$2,$3)
         ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label`,
        [k, v, label]);
    }
    const r = await db.query('SELECT key, value FROM download_settings ORDER BY key');
    console.log('  download_settings taiyar:');
    r.rows.forEach(x => console.log('   ' + x.key.padEnd(16) + (x.value || '(khaali)')));
    console.log('\n  mode abhi "off" hai - jab tak admin se link na bhare, website par');
    console.log('  download ka hissa dikhega hi nahi. Aadha bhara hua section');
    console.log('  dikhane se accha hai na dikhana.');
  } catch (e) {
    console.error('  !! ' + e.message);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
})();
