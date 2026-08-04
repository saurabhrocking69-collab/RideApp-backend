const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function encodeGeohash(lat, lng, precision = 6) {
  let idx = 0, bit = 0, evenBit = true, geohash = '';
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
  while (geohash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) { idx = idx * 2 + 1; lngMin = mid; } else { idx = idx * 2; lngMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { idx = idx * 2 + 1; latMin = mid; } else { idx = idx * 2; latMax = mid; }
    }
    evenBit = !evenBit;
    if (++bit === 5) { geohash += GEOHASH_BASE32[idx]; bit = 0; idx = 0; }
  }
  return geohash;
}

function getNearbyCells(lat, lng) {
  const cells = new Set();
  const delta = 0.011;
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      cells.add(encodeGeohash(lat + dLat * delta, lng + dLng * delta, 6));
    }
  }
  return Array.from(cells);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreDriver(driver, distKm, now) {
  const idleMs  = driver.idle_since ? now - new Date(driver.idle_since).getTime() : 0;
  const idleMin = Math.min(idleMs / 60000, 120);
  const distScore = (distKm !== null && distKm !== undefined) ? Math.max(0, (10 - distKm) / 10) * 40 : 0;
  const idleScore = (idleMin / 120) * 40;
  const accScore  = (parseFloat(driver.acceptance_rate || 100) / 100) * 15;
  const ratScore  = ((parseFloat(driver.rating || 5)) - 1) / 4 * 5;
  return distScore + idleScore + accScore + ratScore;
}

// ── Vehicle upgrades: bigger vehicle serves the smaller request ──────────────
// A driver whose vehicle strictly covers what the customer asked for may take
// the smaller job too (their choice — they see the smaller fare on the offer):
//   ultra_luxury → luxury   (pre-existing rule)
//   car_7        → car      (a 7-seater can obviously do a 5-seater trip)
// NOT the reverse: a 5-seater must never be offered a 7-seater request, because
// the customer booked those extra seats.
//
// This lives in ONE place on purpose. The same filter appears in the broadcast
// query, the pre-assignment query, the hourly-booking queries and the debug
// endpoint — a rule applied to only some of them leaves paths where 7-seater
// drivers are silently invisible.
const VEHICLE_UPGRADES = { ultra_luxury: 'luxury', car_7: 'car' };

// SQL predicate: "<col> can serve the ride type in <param>".
// Both arguments are caller-supplied literals (a column name and a $n
// placeholder) and the vehicle names are hardcoded constants above — no
// user input reaches the generated string.
function vehicleServesSql(col, param) {
  const upgrades = Object.entries(VEHICLE_UPGRADES)
    .map(([bigger, smaller]) => `(${col} = '${bigger}' AND ${param} = '${smaller}')`)
    .join(' OR ');
  return `(${col} = ${param} OR ${upgrades})`;
}

// JS equivalent of the predicate above, for in-memory checks.
function vehicleServes(driverType, requestedType) {
  if (driverType === requestedType) return true;
  return VEHICLE_UPGRADES[driverType] === requestedType;
}

// In-memory driver locations (supplemental to DB)
const driverLocations = {};

module.exports = {
  encodeGeohash, getNearbyCells, haversineKm, scoreDriver, driverLocations,
  VEHICLE_UPGRADES, vehicleServesSql, vehicleServes,
};
