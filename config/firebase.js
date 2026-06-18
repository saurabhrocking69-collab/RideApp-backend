const { initializeApp: initFirebaseApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const db = require('./db');

let firebaseMessaging = null;

try {
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (sa) {
    const serviceAccount = JSON.parse(sa);
    initFirebaseApp({ credential: cert(serviceAccount) });
    firebaseMessaging = getMessaging();
    console.log('✅ Firebase Admin initialized');
  } else {
    console.log('⚠️ FIREBASE_SERVICE_ACCOUNT not set — FCM disabled');
  }
} catch (e) {
  console.log('⚠️ Firebase Admin error:', e.message);
}

// options.channelId: 'ride_requests' for drivers, 'default' for customers
async function sendFCM(phone, title, body, data = {}, options = {}) {
  const channelId = options.channelId || 'default';
  try {
    const user = await db.query('SELECT fcm_token FROM users WHERE phone = $1', [phone]);
    const token = user.rows[0]?.fcm_token;
    if (!token) { console.log('⚠️ No FCM token for', phone); return; }

    if (token.startsWith('ExponentPushToken')) {
      const expoRes = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
        body: JSON.stringify({
          to: token,
          title,
          body,
          sound: 'default',
          priority: 'high',
          channelId,
          ttl: 300,
          data,
          // Android-specific: show heads-up alert, max visibility
          android: { priority: 'max' },
          _displayInForeground: true,
        }),
      });
      const expoData = await expoRes.json().catch(() => ({}));
      const status = expoData?.data?.status || 'ok';
      if (status === 'error') {
        console.log('❌ Expo push error for', phone, ':', expoData.data.message, '| details:', expoData.data.details);
      } else {
        console.log('✅ Expo FCM sent to', phone, 'channel:', channelId, '| status:', status);
      }
      return;
    }

    if (!firebaseMessaging) { console.log('⚠️ Firebase not initialized, skipping FCM'); return; }
    await firebaseMessaging.send({
      token,
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId,
          priority: 'max',
          visibility: 'public',
          vibrateTimingsMillis: [0, 500, 150, 500],
          defaultVibrateTimings: false,
        },
      },
    });
    console.log('✅ Firebase FCM sent to', phone, 'channel:', channelId);
  } catch (e) {
    console.log('FCM error:', e.message);
  }
}

module.exports = { sendFCM };
