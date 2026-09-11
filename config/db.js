const { Pool } = require('pg');

/* NIJI pata pehle, sarvajanik baad me.

   Ye ulta tha - DATABASE_PUBLIC_URL pehle dekha jaata tha - aur uski keemat
   har ek query par lagti thi. Asli ride par naapa gaya:

       [accept] ... 922ms | lookup 175  claim 220  card 180  transition 346

   Paanch padaav, har ek ~180ms. Ek DB chakkar 2-15ms hona chahiye. Wajah query
   ki ginti nahi thi - RAASTA thi: DATABASE_PUBLIC_URL Railway ka sarvajanik
   proxy hai (zephyr.proxy.rlwy.net), to har query container se nikal kar
   internet par jaati thi aur wahi raasta wapas. Jabki Postgres usi project me,
   niji network par, postgres.railway.internal:5432 par baitha hai.

   Sarvajanik pata hataya NAHI: is laptop se chalane ke liye wahi ek raasta
   hai, kyoki niji network sirf Railway ke andar dikhta hai. */
const PRIVATE_URL = process.env.DATABASE_URL;
const PUBLIC_URL  = process.env.DATABASE_PUBLIC_URL;

const opts = (url) => ({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
  max: parseInt(process.env.DB_POOL_MAX || '20'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/* Pool ka apna 'error' sunne wala.

   `pg` ka Pool tab 'error' phenkta hai jab koi BEKAAR pada client toot jaye -
   network girne par, ya DB ke restart par. Uska koi sunne wala na ho to Node
   use uncaught exception bana deta hai.

   Sarvar phir bhi gir nahi raha tha (server.js me uncaughtException ka pehra
   hai), par wo log me "UNCAUGHT EXCEPTION" banकर aata - jo asli wajah nahi
   batata, aur jisse DB ki dikkat kisi aur cheez jaisi dikhti. Ek saaf line us
   raat bahut kaam aati hai jab kuchh galat ho.

   Har naye pool par lagana padta hai, kyoki girawat me pool badal jaata hai. */
const watch = (pool) => {
  pool.on('error', e => console.error('❌ DB pool (bekaar pada client):', e.message));
  return pool;
};

let db = watch(new Pool(opts(PRIVATE_URL || PUBLIC_URL)));

/* Ek surakshit girawat.

   Niji pata tez hai, par agar wahan pehla jud-na hi na ho paye - SSL na mile,
   naam na khule, kuchh bhi - to poora sarvar DB se kat jayega. Ek tez raaste ke
   liye ye keemat bahut badi hai.

   Isliye: pehla jud-na na ho to apne aap sarvajanik par laut jao, aur log me
   SAAF likho. Warna wo chup-chaap dheema chalta rehta aur kisi ko pata bhi na
   chalta ki kyon. */
db.connect()
  .then(c => { c.release?.(); console.log('✅ PostgreSQL connected! (' + (PRIVATE_URL ? 'niji' : 'sarvajanik') + ' raasta)'); })
  .catch(err => {
    console.log('❌ PostgreSQL error:', err.message);
    if (PRIVATE_URL && PUBLIC_URL && PRIVATE_URL !== PUBLIC_URL) {
      console.warn('⚠️  niji pata nahi chala - sarvajanik par laut rahe hain (dheema, par chalu). Wajah upar likhi hai.');
      db = watch(new Pool(opts(PUBLIC_URL)));
      db.connect()
        .then(c => { c.release?.(); console.log('✅ PostgreSQL connected! (sarvajanik raasta)'); })
        .catch(e2 => console.log('❌ PostgreSQL (sarvajanik) bhi nahi:', e2.message));
    }
  });

/* Pool badal sakta hai (upar wali girawat me), isliye seedha `db` nahi -
   ek aisa mukhauta jo hamesha ABHI wale pool par jaata hai. Seedha export
   karne par purana pool pakda ja chukta hota aur girawat bekaar ho jaati. */
module.exports = {
  query:   (...a) => db.query(...a),
  connect: (...a) => db.connect(...a),
  end:     (...a) => db.end(...a),
  get pool() { return db; },
  on:      (...a) => db.on(...a),
};
