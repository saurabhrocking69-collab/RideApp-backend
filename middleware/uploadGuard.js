/* Tasveer chadhane wale darwaze ka pehra.
 *
 * KYA KHULA THA: /api/upload aur /api/driver/upload - dono par koi jaanch hi
 * nahi thi. Koi bhi, bina kisi pehchan ke, base64 bhej kar hamare Cloudinary
 * par file chadha sakta tha. Teen alag nuksaan:
 *   - quota aur bill dono hamare, chadhane wala koi bhi
 *   - hamare khaate par kuchh bhi host ho sakta hai, kuchh bhi - aur uski
 *     zimmedari hamari hai. Play Store par jaane se pehle ye kanooni jokhim
 *     bhi hai, sirf paise ka nahi.
 *   - ek hi request me itni badi file ki server hi baith jaye
 *
 * DO PARTEIN, jaan-boojh kar alag:
 *
 * 1. NAAP AUR ROOP ki jaanch - hamesha chalti hai. Ye kisi ka kuchh nahi
 *    todti: app pehle bhi sirf jpeg bhejti thi. Isse "kuchh bhi host kar lo"
 *    wala darwaza turant band ho jaata hai.
 *
 * 2. PEHCHAN ki jaanch - UPLOAD_AUTH_ENFORCE ke peeche. Wajah saaf hai: aaj
 *    driver app is call par token bhejti hi nahi. Pehle hi din se laga dete to
 *    har purani app par registration ruk jaata - theek wahi outage jo is repo
 *    me ek baar ho chuka hai. Isliye: pehle app token bhejna shuru kare, phir
 *    ye switch chalu ho.
 *
 *    Aur ye sirf theek hai, dhoka nahi: registration me tasveer regStep 3/4/5
 *    par chadhti hai, jabki token regStep 1 par hi ban jaata hai (verifyRegOtp
 *    use AsyncStorage me rakh deta hai). Yaani jis waqt upload hota hai, token
 *    hamesha maujood hota hai - koi asli raasta band nahi hota.
 */
/* Pehchan ki jaanch khud nahi likhi - userAuth pehle se wahi karta hai aur
   poore backend me wahi ek paribhasha hai. Yahan dobara likhte to do jagah
   ho jaati, aur ek din wo do alag ho jaatin. */
const userAuth = require('./userAuth');

// Camera ki tasveer 2-5 MB tak jaati hai; 8 MB me kaafi jagah hai.
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

const enforceAuth = () => String(process.env.UPLOAD_AUTH_ENFORCE || '').toLowerCase() === 'true';

module.exports = function uploadGuard(req, res, next) {
  const image = req.body && req.body.image;
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Image not found' });
  }

  /* Sirf tasveer ka data URI - koi PDF, koi zip, koi HTML nahi.
     Yahi wo ek jaanch hai jo "hamare khaate par kuchh bhi host kar lo" wala
     darwaza band karti hai. */
  const m = /^data:([a-z0-9.+/-]+);base64,/i.exec(image);
  if (!m || !ALLOWED.includes(m[1].toLowerCase())) {
    return res.status(400).json({ error: 'Only JPEG, PNG or WebP images can be uploaded' });
  }

  // base64 ke har 4 akshar = 3 byte. Poora decode kiye bina naap pata chal
  // jaata hai - itni badi cheez ko memory me kholna hi nahi hai.
  const b64 = image.slice(m[0].length);
  const bytes = Math.floor(b64.length * 3 / 4);
  if (bytes > MAX_BYTES) {
    return res.status(413).json({ error: 'Image is too large — please use a photo under 8 MB' });
  }

  if (!enforceAuth()) return next();
  return userAuth(req, res, next);
};
