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

// In-memory driver locations (supplemental to DB)
const driverLocations = {};

module.exports = { encodeGeohash, getNearbyCells, haversineKm, scoreDriver, driverLocations };
