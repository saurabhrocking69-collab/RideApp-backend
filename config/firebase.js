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
    console.log('✅ Firebase Admin initialized (direct FCM path active)');
  } else {
    console.log('⚠️ FIREBASE_SERVICE_ACCOUNT not set — native FCM tokens will be dropped; only Expo relay tokens will work');
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

    // ── Expo relay path (ExponentPushToken[xxx]) ────────────────────────────
    // Note: Expo relay requires FCM V1 credentials uploaded to expo.dev/accounts/
    //       project → Credentials → Android. Without this, killed-app notifications
    //       will silently fail.
    if (token.startsWith('ExponentPushToken')) {
      const payload = {
        to: token,
        title,
        body,
        sound: 'default',
        priority: 'high',
        channelId,
        ttl: 300,
        data,
      };
      const expoRes = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' },
        body: JSON.stringify(payload),
      });
      const expoData = await expoRes.json().catch(() => ({}));
      // Expo response wraps status in expoData.data for single sends
      const result = expoData?.data || expoData;
      if (result?.status === 'error') {
        console.log('❌ Expo push error for', phone, ':', result.message, '| details:', JSON.stringify(result.details));
        console.log('   → If this is DeviceNotRegistered, driver needs to re-login to refresh token');
        console.log('   → If this is a FCM error, upload FCM V1 credentials to expo.dev project credentials');
      } else {
        console.log('✅ Expo FCM sent to', phone, 'channel:', channelId, '| ticket:', result?.id || 'ok');
      }
      return;
    }

    // ── Direct Firebase Admin path (native FCM token) ───────────────────────
    // Used when driver app sends getDevicePushTokenAsync() token.
    // This bypasses Expo relay entirely — most reliable for killed-app delivery.
    if (!firebaseMessaging) {
      console.log('⚠️ Firebase Admin not initialized — native FCM token for', phone, 'dropped. Set FIREBASE_SERVICE_ACCOUNT env var in Railway.');
      return;
    }
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
          notificationCount: 1,
        },
      },
    });
    console.log('✅ Firebase (direct) FCM sent to', phone, 'channel:', channelId);
  } catch (e) {
    console.log('FCM error for', phone, ':', e.message);
    if (e.code === 'messaging/registration-token-not-registered') {
      console.log('   → Token expired/invalid for', phone, '— driver needs to re-login');
      // Clear the stale token so future attempts don't waste time
      db.query('UPDATE users SET fcm_token = NULL WHERE phone = $1', [phone]).catch(() => {});
    }
  }
}

module.exports = { sendFCM };
