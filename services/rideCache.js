const { redis } = require('../config/redis');

const RIDE_TTL  = 7200; // 2 h — covers full ride lifecycle
const LOC_TTL   = 300;  // 5 min — stale after driver stops sending

async function setRideStatus(rideId, status) {
  await redis.set(`ride:${rideId}:status`, status, { EX: RIDE_TTL });
}

async function getRideStatus(rideId) {
  return redis.get(`ride:${rideId}:status`);
}

async function setDriverLoc(rideId, lat, lng) {
  await redis.set(
    `ride:${rideId}:driver_loc`,
    JSON.stringify({ lat, lng, ts: Date.now() }),
    { EX: LOC_TTL }
  );
}

async function getDriverLoc(rideId) {
  const raw = await redis.get(`ride:${rideId}:driver_loc`);
  return raw ? JSON.parse(raw) : null;
}

async function setRideData(rideId, data) {
  await redis.set(`ride:${rideId}:data`, JSON.stringify(data), { EX: RIDE_TTL });
}

async function getRideData(rideId) {
  const raw = await redis.get(`ride:${rideId}:data`);
  return raw ? JSON.parse(raw) : null;
}

async function clearRide(rideId) {
  await Promise.all([
    redis.del(`ride:${rideId}:status`),
    redis.del(`ride:${rideId}:driver_loc`),
    redis.del(`ride:${rideId}:data`),
  ]);
}

module.exports = { setRideStatus, getRideStatus, setRideData, getRideData, setDriverLoc, getDriverLoc, clearRide };
