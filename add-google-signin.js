/* Google se sign-in ke liye teen khaane.

   Abhi koi SMS provider nahi hai, isliye naya koi sign up kar hi nahi sakta -
   OTP bheja hi nahi jaata. Google se aana ek doosra darwaza hai.

   Par Google phone number NAHI deta, aur is app me phone hi pehchan hai
   (users.phone NOT NULL UNIQUE) - driver usi par call karta hai. To Google se
   aane wale ko number dena hi padega, aur wo number SAABIT nahi hoga, sirf
   likha hua hoga. Isliye phone_verified: taaki system ko hamesha pata rahe ki
   kaunsa number OTP se siddh hua aur kaunsa sirf type kiya gaya.

   Purane 114 users sab OTP se aaye hain, unka phone_verified TRUE hai. */
require('dotenv').config();
if (!process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) {
  console.error('❌ Set DATABASE_PUBLIC_URL or DATABASE_URL before running this.');
  process.exit(1);
}
const { Pool } = require('pg');
const db = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const before = await db.query('SELECT COUNT(*) n FROM users');
  console.log('  users abhi:', before.rows[0].n);

  /* google_sub - Google ka apna sthir pehchan-ank. Email par key NAHI banayi
     ja rahi: Google account ka email badla ja sakta hai, sub kabhi nahi. */
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub VARCHAR(64)');
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(160)');

  /* DEFAULT TRUE jaan-boojh kar: is line ke chalne se pehle jitne bhi account
     hain, sab OTP se bane hain - unka number siddh hai. Naye Google account ko
     route khud false likhta hai. Default false rakhne se 114 sacche number ek
     hi baar me jhoothe likhe jaate. */
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT TRUE');

  // Ek Google account, ek hi user. Partial index kyoki purane 114 me ye khaali
  // hai aur NULL par unique lagana unhe aapas me nahi todta.
  await db.query('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_uniq ON users (google_sub) WHERE google_sub IS NOT NULL');

  const cols = await db.query(
    "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns " +
    "WHERE table_name='users' AND column_name IN ('google_sub','email','phone_verified') ORDER BY column_name");
  console.log('  naye khaane:');
  cols.rows.forEach(c => console.log('   ', c.column_name, '(' + c.data_type + ')',
    'null?', c.is_nullable, 'default:', c.column_default));

  const v = await db.query('SELECT phone_verified, COUNT(*) n FROM users GROUP BY 1');
  console.log('  phone_verified ki ginti:');
  v.rows.forEach(r => console.log('   ', r.phone_verified, '->', r.n));

  await db.end();
  console.log('  ho gaya');
}

run().catch(e => { console.error('  !! ' + e.message); process.exit(1); });
