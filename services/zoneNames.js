'use strict';
// Resolves demand-zone grid cells (lat/lng) to a short, human-readable area
// name (e.g. "Gomti Nagar") via Google reverse geocoding, cached in Postgres
// so we only ever geocode each ~2km grid cell once (neighbourhoods don't move).
const db = require('../config/db');

db.query(`
  CREATE TABLE IF NOT EXISTS zone_names (
    zone_lat NUMERIC NOT NULL,
    zone_lng NUMERIC NOT NULL,
    area_name TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (zone_lat, zone_lng)
  )
`).catch(() => {});

const KEY = process.env.GOOGLE_MAPS_SERVER_KEY;
let warnedMissingKey = false;

// Prefer the smallest named area (sublocality/neighborhood) over the whole city
const PREFERRED_TYPES = ['sublocality_level_1', 'sublocality', 'neighborhood', 'locality'];

function pickAreaName(components) {
  for (const type of PREFERRED_TYPES) {
    const comp = components.find(c => c.types.includes(type));
    if (comp) return comp.long_name;
  }
  return null;
}

async function geocodeOne(lat, lng) {
  if (!KEY) {
    if (!warnedMissingKey) { console.warn('[zoneNames] GOOGLE_MAPS_SERVER_KEY not set — hot zones will show without area names'); warnedMissingKey = true; }
    return null;
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    const result = data.results?.[0];
    if (!result) return null;
    return pickAreaName(result.address_components || []) || null;
  } catch (_e) {
    return null;
  }
}

// zones: array of { lat, lng, ... } already rounded to the grid.
// Returns the same array with an `area_name` field added to each.
async function attachAreaNames(zones) {
  if (zones.length === 0) return zones;

  const cached = await db.query(
    `SELECT zone_lat, zone_lng, area_name FROM zone_names
     WHERE (zone_lat, zone_lng) IN (${zones.map((_, i) => `($${i * 2 + 1}::numeric, $${i * 2 + 2}::numeric)`).join(',')})`,
    zones.flatMap(z => [z.lat, z.lng])
  ).catch(() => ({ rows: [] }));

  const cacheMap = new Map(cached.rows.map(r => [`${r.zone_lat},${r.zone_lng}`, r.area_name]));

  await Promise.all(zones.map(async (z) => {
    const key = `${z.lat},${z.lng}`;
    if (cacheMap.has(key)) { z.area_name = cacheMap.get(key); return; }
    const name = await geocodeOne(z.lat, z.lng);
    z.area_name = name;
    db.query(
      `INSERT INTO zone_names (zone_lat, zone_lng, area_name) VALUES ($1, $2, $3)
       ON CONFLICT (zone_lat, zone_lng) DO UPDATE SET area_name = $3, updated_at = NOW()`,
      [z.lat, z.lng, name]
    ).catch(() => {});
  }));

  return zones;
}

module.exports = { attachAreaNames };
