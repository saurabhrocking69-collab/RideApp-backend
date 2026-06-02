const https = require('https');

const data = JSON.stringify({ phone: '9999999999', ride_id: null });

const options = {
  hostname: 'rideapp-backend-production-5e1c.up.railway.app',
  path: '/api/scratch-card/create',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
};

const req = https.request(options, res => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log('RESULT:', body));
});
req.on('error', e => console.log('ERROR:', e.message));
req.write(data);
req.end();