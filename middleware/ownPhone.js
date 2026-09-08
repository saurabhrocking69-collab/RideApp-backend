/* "Ye data sirf uska hai jiska hai" - ek jagah likha hua.
 *
 * KYA KHULA PADA THA (2026-09-08 ko naapa gaya, live):
 * 60 raaste bilkul bina pehre ke the. Unme se sabse bure wo the jo NIJI
 * jaankari sirf phone number par de dete the - koi token nahi, koi jaanch
 * nahi. Apne hi number par jaanch kar dekha:
 *     GET /api/places/saved?phone=...        -> 200, ghar/office ka pata
 *     GET /api/emergency-contacts?phone=...  -> 200, parivaar ke naam-number
 *     GET /api/support/tickets?phone=...     -> 200, saari shikayatein
 *
 * Ye ride app me aur bhi bura hai: kisi ka number har us driver ko dikhta hai
 * jisne kabhi uski ride li ho. Yaani ek ride ke baad kisi ka ghar ka pata
 * nikalna bas ek request ki baat thi.
 *
 * DO PARTEIN, wahi jo uploadGuard me hain aur wahi wajah:
 *
 * 1. Pehchan aur maalikana - PDATA_AUTH_ENFORCE ke peeche, abhi BAND. Kyoki
 *    aaj dono apps in calls par token bhejti hi nahi (jaancha: places aur
 *    support par `fetch`, emergency-contacts par `apiGet` - koi token nahi).
 *    Abhi chalu kar dete to har lage hue app par ye sab kaam karna band kar
 *    deta - theek wahi outage jo is repo me 2026-07-29 ko ho chuka hai.
 *
 * 2. Isliye kram yahi hai aur isme koi shortcut nahi: pehle backend inert jaaye
 *    -> phir apps token bhejna shuru karein -> phir switch chalu ho.
 *
 * Maalikana ki jaanch `req.user.phone` se hoti hai, body/query ke `phone` se
 * nahi - warna pehra hota hi nahi: koi bhi kisi ka bhi number likh deta.
 */
const userAuth = require('./userAuth');

const enforce = () => String(process.env.PDATA_AUTH_ENFORCE || '').toLowerCase() === 'true';

// Number kai roop me aata hai (+91, spaces, 0 se shuru) - aakhri 10 ank hi
// asli pehchan hain. Isse "91xxxx" aur "xxxx" ko alag maan kar pehra galti se
// kisi ko uske apne data se rok na de.
const norm = (p) => String(p || '').replace(/\D/g, '').slice(-10);

module.exports = function ownPhone(req, res, next) {
  if (!enforce()) return next();
  userAuth(req, res, () => {
    const asked = norm(req.body?.phone ?? req.query?.phone);
    // Koi phone maanga hi nahi (jaise soochi apne aap token se nikalti ho) -
    // to token hi kaafi hai, aage jaane do.
    if (!asked) return next();
    if (norm(req.user?.phone) !== asked) {
      return res.status(403).json({ error: 'This is not your account' });
    }
    next();
  });
};
