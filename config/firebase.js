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

// options.channelId : 'ride_requests' for drivers, 'default' for customers
// options.role      : 'driver' | 'customer' (default 'customer')
//   driver  → reads driver_fcm_token, falls back to fcm_token for drivers who haven't re-logged
//   customer→ reads fcm_token only
async function sendFCM(phone, title, body, data = {}, options = {}) {
  const channelId = options.channelId || 'default';
  const role      = options.role || 'customer';
  const imageUrl  = options.imageUrl  || null;
  try {
    const col  = role === 'driver'
      ? 'COALESCE(driver_fcm_token, fcm_token)'
      : 'fcm_token';
    const user = await db.query(`SELECT ${col} AS fcm_token FROM users WHERE phone = $1`, [phone]);
    const token = user.rows[0]?.fcm_token;
    if (!token) { console.log('⚠️ No FCM token for', phone, `(role: ${role})`); return; }

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
        data: { ...data, ...(imageUrl ? { image_url: imageUrl } : {}) },
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
    // Map legacy channel → v2 so any old call sites automatically get the right channel.
    const resolvedChannel = channelId === 'ride_requests' ? 'ride_requests_v2' : channelId;
    const fcmData = { ...data, ...(imageUrl ? { image_url: imageUrl } : {}) };
    await firebaseMessaging.send({
      token,
      notification: { title, body, ...(imageUrl ? { imageUrl } : {}) },
      data: Object.fromEntries(Object.entries(fcmData).map(([k, v]) => [k, String(v)])),
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: resolvedChannel,
          priority: 'max',
          visibility: 'public',
          vibrateTimingsMillis: [0, 800, 200, 800, 200, 800],
          defaultVibrateTimings: false,
          notificationCount: 1,
          ...(imageUrl ? { imageUrl } : {}),
        },
      },
    });
    console.log('✅ Firebase (direct) FCM sent to', phone, 'channel:', resolvedChannel);
  } catch (e) {
    console.log('FCM error for', phone, ':', e.message);
    if (e.code === 'messaging/registration-token-not-registered') {
      console.log('   → Token expired/invalid for', phone, `(role: ${role}) — user needs to re-login`);
      // Clear the stale token so future attempts don't waste time
      const clearCol = role === 'driver' ? 'driver_fcm_token' : 'fcm_token';
      db.query(`UPDATE users SET ${clearCol} = NULL WHERE phone = $1`, [phone]).catch(() => {});
    }
  }
}

module.exports = { sendFCM };
