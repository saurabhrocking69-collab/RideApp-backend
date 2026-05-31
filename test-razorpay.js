// Razorpay test — backend pe order banane ki koshish
const API = 'https://rideapp-backend-production-5e1c.up.railway.app';

async function test() {
  try {
    const res = await fetch(`${API}/api/payment/create-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 85, ride_id: 'test123' })
    });
    const data = await res.json();
    console.log('RESPONSE:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}
test();