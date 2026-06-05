const https = require('https');
const data = JSON.stringify({ code: 'RIDE50', fare: 100, phone: '9999999999' });
const options = {
  hostname: 'rideapp-backend-production-5e1c.up.railway.app',
  path: '/api/promo/validate', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
};
const req = https.request(options, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => console.log('RESULT:', body));
});
req.write(data); req.end();