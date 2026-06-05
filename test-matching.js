const https = require('https');

function apiCall(path, method, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'rideapp-backend-production-5e1c.up.railway.app',
      path, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve(b));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function test() {
  // Driver location update (Hazratganj, Lucknow)
  console.log('1. Driver location update...');
  let r = await apiCall('/api/driver/update-location', 'POST', { phone: '7854236984', lat: 26.8467, lng: 80.9462 });
  console.log('   ', r);

  // Check suspension
  console.log('2. Suspension check...');
  r = await apiCall('/api/driver/check-suspension?phone=7854236984', 'GET');
  console.log('   ', r);

  // Customer cancel status
  console.log('3. Customer cancel status...');
  r = await apiCall('/api/customer/cancel-status?phone=9999999999', 'GET');
  console.log('   ', r);
}
test();