/* Pehre ke inkaar ki ek line - shor ke bina.

   Ye alag file me hai kyoki do jagah (userAuth aur ownPhone) ise vaparti hain,
   aur "har raaste ki ek line har minute" wali ginti dono ke beech SAAJHI honi
   chahiye. Do copies rakhte to ek hi raasta do baar chhapta.

   Kabhi kuchh phenkta nahi: log rakhne ki wajah se koi request na ruke. */
const seen = new Map();          // "reason path" -> aakhri baar kab chhapa
const GAP_MS = 60 * 1000;

/* Har 5 minute me purani entry saaf - warna ye Map dheere-dheere har us raaste
   ka naam jama karta rehta jo kabhi ek baar inkaar hua tha. */
setInterval(() => {
  const cut = Date.now() - 10 * GAP_MS;
  for (const [k, t] of seen) if (t < cut) seen.delete(k);
}, 5 * GAP_MS).unref?.();

function authDenied(req, reason) {
  try {
    // req.route abhi tay nahi hota, isliye originalUrl - par sirf raasta,
    // query ke bina: query me phone number hota hai aur wo log me nahi jaana.
    const path = String(req.originalUrl || req.url || '').split('?')[0].slice(0, 120);
    /* App ka naam bhi - warna log ye batata hi nahi ki kaun si app toot rahi
       hai. Do baar iski wajah se raaste ke naam se ANDAAZA lagana pada
       (favourites/driver-count sirf driver app bulati hai - us ek sanyog se
       pata chala). Expo app apne User-Agent me apna naam aur version bhejti
       hai, to ek nazar me pata chal jaata hai.

       Sirf pehla hissa, aur wo bhi 60 akshar tak: usme app ka naam aur version
       aa jaate hain, aur baaki sirf shor hai. Koi nijee baat ismein hoti hi
       nahi - na naam, na number. */
    const ua = String(req.headers['user-agent'] || '').split(' ').slice(0, 3).join(' ').slice(0, 60);
    const key = reason + ' ' + req.method + ' ' + path;
    const now = Date.now();
    if ((seen.get(key) || 0) > now - GAP_MS) return;
    seen.set(key, now);
    console.warn('[auth 401] ' + reason + '  ' + req.method + ' ' + path
               + (ua ? '   [' + ua + ']' : ''));
  } catch (_e) { /* log kabhi kisi request ko na rok paye */ }
}

module.exports = { authDenied };
