/* OTP ka SMS - ek jagah, taaki provider badle to sirf yahi file badle.

   Pehle ye seedha auth.js ke andar likha tha, Fast2SMS ke liye. Provider
   badalna matlab us raaste ko kholna jispar poora login tika hai - isliye ab
   wo baat yahan hai aur auth.js sirf itna poochhta hai: "gaya ya nahi".

   PROVIDER: 2Factor (2factor.in). Chunne ki wajah ye ki hum OTP KHUD banate
   hain aur Redis me rakhte hain, aur 2Factor ka ek raasta hamara apna OTP
   bhejne deta hai:
       GET https://2factor.in/API/V1/{key}/SMS/{phone}/{otp}
   Iska matlab verify-otp ko haath lagane ki zaroorat hi nahi padi. 2Factor ka
   apna AUTOGEN + VERIFY wala raasta bhi hai, par usme OTP unke paas banta hai
   aur verify bhi unhi se karana padta - yaani hamara pehle se chal raha aur
   jancha hua verify poora badalna padta, sirf provider ke liye. Wo khatra
   mol lene ki koi wajah nahi thi.

   JAWAB KA ROOP - andaaze se nahi, chala kar dekha gaya (galat key se):
       success : {"Status":"Success","Details":"<session id>"}   HTTP 200
       error   : {"Status":"Error","Details":"Invalid API Key"}  HTTP 400
   ...PAR har error 400 nahi deta: ek raaste ne HTTP 200 ke saath
   {"Status":"Error"} lautaya. Isliye HTTP code par bharosa nahi kiya jaata -
   body ka `Status` dekha jaata hai. Yahi galti Fast2SMS wale code me bhi
   likhi hui thi (`return: false` 200 ke saath), to wo sabak yahan bhi laga.

   Chaabi kabhi log nahi hoti, aur OTP bhi nahi - dono ek saath log me chale
   jayein to log padhne wala kisi ke bhi khaate me ghus sakta hai.
*/

const TWOFACTOR_KEY = () => (process.env.TWOFACTOR_KEY || '').trim();
const FAST2SMS_KEY  = () => (process.env.FAST2SMS_API_KEY || '').trim();
/* DLT wala apna template, agar approve ho chuka ho. Khaali chhodne par
   2Factor apna default OTP template istemal karta hai, jo pehle se approved
   aata hai - isliye ye zaroori nahi, sirf marzi ki baat hai. */
/* Har app ka apna template - kyoki har app ka app-hash alag hai.

   SMS Retriever (bina tap ke bharna) ke liye SMS ke ANT me us app ka
   11-akshar ka hash hona zaroori hai, aur wo signing cert se banta hai:
       rider  (com.sppero.rider)  -> XCAG/VOG/GQ
       driver (com.sppero.driver) -> LQuev5EzywW
   Dono alag hain, to ek hi template dono ke liye kaam nahi kar sakta - jis app
   ke liye hash galat hoga, uspar autofill chup-chaap kabhi nahi chalega.

   Isliye send-otp ab ye bhi poochhta hai ki maang kaun raha hai, aur uske
   hisaab se template chunta hai. Dono khaali hon to 2Factor apna default
   template lagata hai - wahi jo aaj chal raha hai. */
const TWOFACTOR_TEMPLATE = (app) => (
  (app === 'driver' ? process.env.TWOFACTOR_TEMPLATE_DRIVER
   : app === 'rider' ? process.env.TWOFACTOR_TEMPLATE_RIDER
   : '') || process.env.TWOFACTOR_TEMPLATE || ''
).trim();

const TIMEOUT_MS = 12000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_r, rej) => setTimeout(() => rej(new Error('SMS provider ne jawab nahi diya')), ms)),
  ]);
}

/* Kya koi provider laga hua hai? auth.js ise dekh kar tay karta hai ki
   "SMS nahi bhej sakte" kehna hai ya sach me bhejna hai. */
function smsProviderName() {
  if (TWOFACTOR_KEY()) return '2factor';
  if (FAST2SMS_KEY())  return 'fast2sms';
  return null;
}

async function via2Factor(phone, otp, app) {
  const key = TWOFACTOR_KEY();
  const tpl = TWOFACTOR_TEMPLATE(app);
  const url = `https://2factor.in/API/V1/${encodeURIComponent(key)}/SMS/`
    + `${encodeURIComponent(phone)}/${encodeURIComponent(otp)}`
    + (tpl ? `/${encodeURIComponent(tpl)}` : '');

  const res = await withTimeout(fetch(url), TIMEOUT_MS);
  const body = await res.json().catch(() => null);
  const status = body && String(body.Status || '').toLowerCase();

  if (status === 'success') return { ok: true, ref: body.Details || '' };
  // Details me wajah hoti hai ("Invalid API Key", "Insufficient Balance"...)
  return { ok: false, reason: (body && body.Details) || `HTTP ${res.status}` };
}

async function viaFast2SMS(phone, otp) {
  const res = await withTimeout(fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: { authorization: FAST2SMS_KEY() },
    body: new URLSearchParams({ route: 'otp', variables_values: otp, flash: '0', numbers: phone }),
  }), TIMEOUT_MS);
  const body = await res.json().catch(() => null);
  // Fast2SMS bhi 200 ke saath { return: false } deta hai - wahi baat.
  if (!res.ok || (body && body.return === false)) {
    return { ok: false, reason: (body && body.message) || `HTTP ${res.status}` };
  }
  return { ok: true, ref: '' };
}

/* Bhejo. Laut-ta hai { ok, reason?, provider }.

   Kabhi apne aap "chala gaya" nahi kehta. Pehle yahi galti thi: SMS bhejne ki
   koshish hoti thi, error nigal liya jaata tha, aur aadmi ko "OTP sent" dikha
   diya jaata tha - jabki kuch gaya hi nahi hota tha aur wo ek aise code ka
   intezaar karta rehta jo kabhi bana hi nahi. */
async function sendOtpSms(phone, otp, app) {
  const provider = smsProviderName();
  if (!provider) return { ok: false, reason: 'koi SMS provider nahi laga', provider: null };
  try {
    const r = provider === '2factor' ? await via2Factor(phone, otp, app) : await viaFast2SMS(phone, otp);
    return { ...r, provider };
  } catch (e) {
    return { ok: false, reason: e.message, provider };
  }
}

/* Kitne SMS bache hain. Admin panel ke liye - aur isliye bhi ki 25,000 khatm
   hone ka pata us din nahi chalna chahiye jis din koi login na kar paye. */
async function smsBalance() {
  const key = TWOFACTOR_KEY();
  if (!key) return { ok: false, reason: 'koi 2Factor chaabi nahi' };
  try {
    const res = await withTimeout(fetch(`https://2factor.in/API/V1/${encodeURIComponent(key)}/BAL/SMS`), TIMEOUT_MS);
    const body = await res.json().catch(() => null);
    if (body && String(body.Status || '').toLowerCase() === 'success')
      return { ok: true, balance: parseInt(body.Details, 10) || 0 };
    return { ok: false, reason: (body && body.Details) || `HTTP ${res.status}` };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { sendOtpSms, smsBalance, smsProviderName };
