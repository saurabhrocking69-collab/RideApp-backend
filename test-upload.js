const API = 'https://rideapp-backend-production-5e1c.up.railway.app';

// Ek chhoti test image (1x1 pixel red dot, base64)
const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function test() {
  try {
    const res = await fetch(`${API}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: testImage })
    });
    const data = await res.json();
    console.log('RESPONSE:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('ERROR:', e.message);
  }
}
