'use strict';
// ── Known-good boarding spots + landmark hints ────────────────────────────────
//
// Two related but independent things live here:
//
//   1. SUGGESTED PICKUP POINTS. The single biggest cause of "driver called and
//      couldn't find me" is a pin dropped somewhere a vehicle cannot actually
//      stop — inside a building footprint, on the wrong side of a divided road,
//      or at the centroid of a huge complex. Uber solves this with curated
//      boarding points. Curating them by hand for every venue in a city is not
//      realistic for us, so we LEARN them instead: when a driver marks
//      "arrived", their real GPS position is the coordinate where a vehicle
//      genuinely can and did wait. Snap that to a ~25m grid, count how often it
//      repeats, and the popular spots surface on their own. No manual work, and
//      it gets better with every ride.
//
//   2. LANDMARK HINTS. A short human phrase for a coordinate ("Charbagh Metro
//      Station") so both sides can say "near X" instead of reading a GPS blob.
//      Landmarks do not move, so once resolved a cell is cached permanently.
//
// Everything here degrades to empty/null rather than throwing: a pickup
// suggestion is a nicety, and it must never be able to block a booking.

const db = require('../config/db');

const KEY = process.env.GOOGLE_MAPS_SERVER_KEY;
let warnedMissingKey = false;

// ── Tuning ───────────────────────────────────────────────────────────────────
// A point's `cell` is only its stable identifier — it is NOT how observations
// are matched to it. Matching by grid cell was tried first and is subtly wrong:
// when the real boarding spot happens to sit near a cell boundary, ordinary GPS
// scatter of a few metres flips successive arrivals between adjacent cells, so
// one busy gate shatters into several points that each stay below MIN_USES and
// never surface. (Measured: 3 arrivals at one gate, 8m apart, produced 2 cells.)
// Matching is therefore by DISTANCE to the nearest known point.
const POINT_CELL = 0.00025;
// Two arrivals within this distance are the same boarding spot. Comfortably
// above urban GPS scatter, comfortably below the gap between distinct gates.
const MERGE_RADIUS_M = 35;
// Landmarks are cached on a coarser grid — ~110m. A landmark 110m away is still
// a useful hint, and a coarser grid means far fewer Places calls.
const LANDMARK_CELL = 0.001;
// Only suggest a spot within this distance of the requested pin. Past ~150m it
// stops being "the same place" and starts being a different street.
const SUGGEST_RADIUS_M = 150;
// A spot has to have been used this many times before we offer it. One ride
// proves nothing (the driver may have stopped badly); repeated independent
// arrivals at the same 27m cell is real evidence.
const MIN_USES = 2;
const MAX_SUGGESTIONS = 3;

function cellKey(lat, lng, size) {
  const a = Math.round(parseFloat(lat) / size) * size;
  const b = Math.round(parseFloat(lng) / size) * size;
  return `${a.toFixed(6)}_${b.toFixed(6)}`;
}

// Metres between two lat/lng pairs. Equirectangular rather than full haversine:
// at the sub-kilometre distances this file deals in the error is centimetres,
// and it avoids the trig cost on every candidate row.
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const mLat = (lat1 + lat2) / 2 * Math.PI / 180;
  const x = dLng * Math.cos(mLat);
  return Math.round(Math.sqrt(dLat * dLat + x * x) * R);
}

// ── Schema ───────────────────────────────────────────────────────────────────
// Each statement runs independently and swallows its own error. A single
// combined block would mean one failing statement silently skipping the rest —
// exactly the failure that left parcel batching half-created in production.
const DDL = [
  `CREATE TABLE IF NOT EXISTS pickup_points (
     cell         TEXT PRIMARY KEY,
     lat          DOUBLE PRECISION NOT NULL,
     lng          DOUBLE PRECISION NOT NULL,
     label        TEXT,
     source       TEXT NOT NULL DEFAULT 'learned',
     use_count    INTEGER NOT NULL DEFAULT 1,
     last_used_at TIMESTAMPTZ DEFAULT NOW(),
     created_at   TIMESTAMPTZ DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pickup_points_latlng ON pickup_points(lat, lng)`,
  `CREATE TABLE IF NOT EXISTS landmark_cache (
     cell       TEXT PRIMARY KEY,
     name       TEXT,
     updated_at TIMESTAMPTZ DEFAULT NOW()
   )`,
  // Venue classification is cached alongside the name so deciding "is this a
  // place with gates?" costs no extra Places call. Added as ALTERs because the
  // table already exists in production from the first release.
  `ALTER TABLE landmark_cache ADD COLUMN IF NOT EXISTS types    TEXT`,
  `ALTER TABLE landmark_cache ADD COLUMN IF NOT EXISTS span_m   INTEGER`,
  `ALTER TABLE landmark_cache ADD COLUMN IF NOT EXISTS dist_m   INTEGER`,
];

let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      for (const sql of DDL) {
        await db.query(sql).catch(e => console.warn('[pickupPoints] DDL skipped:', e.message));
      }
    })();
  }
  return ready;
}
ensureSchema();

// ── Landmark lookup ──────────────────────────────────────────────────────────
// Places types that are not landmarks — administrative areas and address
// fragments. Without this filter the nearest "result" to any city pin is
// usually the locality itself ("Lucknow"), which tells nobody anything. This is
// the same wrong-category noise already seen in nearby-category search.
const NOT_A_LANDMARK = new Set([
  'route', 'street_address', 'political', 'locality', 'sublocality',
  'sublocality_level_1', 'postal_code', 'plus_code', 'premise', 'subpremise',
  'administrative_area_level_1', 'administrative_area_level_2', 'country',
  'neighborhood', 'geocode',
]);

// ── What makes a place worth offering an entry-point choice for ──────────────
// Showing "Pickup near <some shop>" on every booking is noise: outside your own
// house the nearest named place is a random storefront, it is not actionable,
// and there is no second entrance to choose between. The choice only earns its
// place where a venue genuinely HAS multiple entrances a driver could go to the
// wrong one of — stations, airports, malls, hospitals, campuses, big temples.
const MAJOR_VENUE_TYPES = new Set([
  'airport', 'train_station', 'subway_station', 'transit_station',
  'light_rail_station', 'bus_station', 'shopping_mall', 'hospital',
  'university', 'stadium', 'amusement_park', 'zoo', 'museum',
  'tourist_attraction', 'convention_center', 'campground',
]);

// Size is the second, type-independent signal. Places returns a viewport per
// result, and a viewport spanning a couple of hundred metres means a compound
// with a perimeter — which is exactly when "which gate?" becomes a real
// question. This catches the heritage sites, big temples and government
// campuses that no type list would ever fully enumerate.
const VENUE_MIN_SPAN_M = 180;
// The customer has to plausibly be AT the venue, not merely near it. Past this
// the "you're at X" framing is simply wrong.
const VENUE_MAX_DIST_M = 250;

function placeSpanM(geometry) {
  const vp = geometry?.viewport;
  if (!vp?.northeast || !vp?.southwest) return 0;
  return distanceM(vp.southwest.lat, vp.southwest.lng, vp.northeast.lat, vp.northeast.lng);
}

// Returns the best nearby place as {name, types, span_m, dist_m} or null.
async function fetchPlace(lat, lng) {
  if (!KEY) {
    if (!warnedMissingKey) {
      console.warn('[pickupPoints] GOOGLE_MAPS_SERVER_KEY not set — landmark hints disabled');
      warnedMissingKey = true;
    }
    return null;
  }
  try {
    // Default (prominence) ranking, not rankby=distance: we want the landmark a
    // human would name, which is the well-known station rather than whichever
    // unnamed shopfront happens to be three metres closer.
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=250&key=${KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (!Array.isArray(data.results)) return null;

    let best = null;
    for (const r of data.results) {
      if (!r.name) continue;
      const types = r.types || [];
      if (types.some(t => NOT_A_LANDMARK.has(t))) continue;
      // A name that is just a plus-code or a bare number helps nobody.
      if (!/[a-zA-Z]{3}/.test(r.name)) continue;
      const loc = r.geometry?.location;
      const cand = {
        name: String(r.name).slice(0, 80),
        types,
        span_m: placeSpanM(r.geometry),
        dist_m: loc ? distanceM(lat, lng, loc.lat, loc.lng) : 9999,
      };
      // Prefer a real venue even if a smaller shop ranked above it — a station
      // 90m away is far more useful than the tea stall at its gate.
      const candIsVenue = isVenue(cand);
      if (!best) { best = cand; if (candIsVenue) break; }
      else if (candIsVenue) { best = cand; break; }
    }
    return best;
  } catch (_e) {
    return null;
  }
}

function isVenue(p) {
  if (!p) return false;
  if (p.dist_m > VENUE_MAX_DIST_M) return false;
  if (p.types.some(t => MAJOR_VENUE_TYPES.has(t))) return true;
  return p.span_m >= VENUE_MIN_SPAN_M;
}

// The cached place for a coordinate — {name, types, span_m, dist_m} or null.
// One Places call per ~110m cell, ever.
async function placeFor(lat, lng) {
  if (lat == null || lng == null) return null;
  try {
    await ensureSchema();
    const cell = cellKey(lat, lng, LANDMARK_CELL);
    const hit = await db.query(
      `SELECT name, types, span_m, dist_m FROM landmark_cache WHERE cell=$1`, [cell]
    );
    if (hit.rows[0]) {
      const r = hit.rows[0];
      if (!r.name) return null;   // cached negative
      return {
        name: r.name,
        types: r.types ? String(r.types).split(',').filter(Boolean) : [],
        span_m: r.span_m || 0,
        dist_m: r.dist_m == null ? 0 : r.dist_m,
      };
    }

    const p = await fetchPlace(lat, lng);
    // Cache negatives too — a cell with no landmark will still have none
    // tomorrow, and re-asking Google on every booking there costs real money.
    await db.query(
      `INSERT INTO landmark_cache (cell, name, types, span_m, dist_m) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (cell) DO UPDATE SET name=$2, types=$3, span_m=$4, dist_m=$5, updated_at=NOW()`,
      [cell, p?.name || null, p ? p.types.join(',') : null, p?.span_m || null, p?.dist_m || null]
    ).catch(() => {});
    return p;
  } catch (_e) {
    return null;
  }
}

// Short landmark name. Still used for the DRIVER's card — "near <local shop>"
// is genuinely how addresses work on the ground here, even when it would be
// useless as a customer-facing prompt.
async function landmarkFor(lat, lng) {
  try {
    const p = await placeFor(lat, lng);
    return p?.name || null;
  } catch (_e) {
    return null;
  }
}

// ── Learning ─────────────────────────────────────────────────────────────────
// Called when a driver marks "arrived" — their GPS is a spot a vehicle actually
// reached and waited at. Fire-and-forget: never block the arrival response.
async function recordSuccessfulPickup(lat, lng) {
  if (lat == null || lng == null) return;
  const la = parseFloat(lat), ln = parseFloat(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
  // (0,0) is the classic "GPS not ready" reading and would otherwise create a
  // phantom boarding point in the Gulf of Guinea.
  if (Math.abs(la) < 0.01 && Math.abs(ln) < 0.01) return;
  try {
    await ensureSchema();

    // Is this arrival at a spot we already know about? Bounding box first so
    // the index does the work, then an exact circular test.
    const dLat = MERGE_RADIUS_M / 111320;
    const dLng = MERGE_RADIUS_M / (111320 * Math.max(0.2, Math.cos(la * Math.PI / 180)));
    const near = await db.query(
      `SELECT cell, lat, lng FROM pickup_points
        WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4 LIMIT 40`,
      [la - dLat, la + dLat, ln - dLng, ln + dLng]
    );
    let best = null, bestD = Infinity;
    for (const r of near.rows) {
      const d = distanceM(la, ln, parseFloat(r.lat), parseFloat(r.lng));
      if (d <= MERGE_RADIUS_M && d < bestD) { best = r; bestD = d; }
    }

    if (best) {
      // Nudge the stored coordinate toward the new observation by an
      // incremental mean. use_count on the right-hand side is the pre-update
      // value, which is what makes this a correct running average.
      await db.query(
        `UPDATE pickup_points SET
           lat = (lat * use_count + $2) / (use_count + 1),
           lng = (lng * use_count + $3) / (use_count + 1),
           use_count = use_count + 1,
           last_used_at = NOW()
         WHERE cell = $1`,
        [best.cell, la, ln]
      );
      return;
    }

    // New spot. ON CONFLICT covers the narrow race where two arrivals in the
    // same cell both find nothing and insert together.
    await db.query(
      `INSERT INTO pickup_points (cell, lat, lng, use_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (cell) DO UPDATE SET
         use_count = pickup_points.use_count + 1,
         last_used_at = NOW()`,
      [cellKey(la, ln, POINT_CELL), la, ln]
    );
  } catch (e) {
    console.warn('[pickupPoints] record failed:', e.message);
  }
}

// ── Suggestion ───────────────────────────────────────────────────────────────
// Boarding spots near a requested pin, best first. Always returns an array.
async function suggestPickupPoints(lat, lng) {
  if (lat == null || lng == null) return [];
  const la = parseFloat(lat), ln = parseFloat(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return [];
  try {
    await ensureSchema();
    // Bounding box first so the index does the heavy lifting, then an exact
    // circular filter in JS. A degree of longitude shrinks with latitude, hence
    // the cos() term — without it the box is too narrow away from the equator.
    const dLat = SUGGEST_RADIUS_M / 111320;
    const dLng = SUGGEST_RADIUS_M / (111320 * Math.max(0.2, Math.cos(la * Math.PI / 180)));
    const rows = await db.query(
      `SELECT cell, lat, lng, label, source, use_count
         FROM pickup_points
        WHERE lat BETWEEN $1 AND $2
          AND lng BETWEEN $3 AND $4
          AND (use_count >= $5 OR source = 'admin')
        LIMIT 60`,
      [la - dLat, la + dLat, ln - dLng, ln + dLng, MIN_USES]
    );

    const near = rows.rows
      .map(r => ({
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lng),
        label: r.label,
        source: r.source,
        uses: r.use_count,
        distance_m: distanceM(la, ln, parseFloat(r.lat), parseFloat(r.lng)),
      }))
      .filter(p => p.distance_m <= SUGGEST_RADIUS_M)
      // An admin-pinned point outranks anything learned; then popularity, then
      // proximity. Popularity before proximity on purpose: a proven gate 80m
      // away beats a barely-used spot 20m away.
      .sort((a, b) =>
        (a.source === 'admin' ? 0 : 1) - (b.source === 'admin' ? 0 : 1) ||
        b.uses - a.uses ||
        a.distance_m - b.distance_m
      )
      .slice(0, MAX_SUGGESTIONS);

    // Label any point that doesn't have one yet, so the customer sees "Charbagh
    // Metro Station" rather than a bare distance. Done lazily here (and cached
    // back onto the row) instead of at learn time, so we only ever pay for
    // points that are actually shown to someone.
    await Promise.all(near.map(async (p) => {
      if (p.label) return;
      const name = await landmarkFor(p.lat, p.lng);
      if (name) {
        p.label = name;
        db.query(`UPDATE pickup_points SET label=$1 WHERE cell=$2`,
          [name, cellKey(p.lat, p.lng, POINT_CELL)]).catch(() => {});
      }
    }));

    return near;
  } catch (e) {
    console.warn('[pickupPoints] suggest failed:', e.message);
    return [];
  }
}

// The venue a coordinate sits AT, when there is one worth choosing an entrance
// for — {name, kind} — else null. This is what gates the customer-facing entry
// point picker, so it never appears on an ordinary residential road.
async function venueFor(lat, lng) {
  try {
    const p = await placeFor(lat, lng);
    if (!isVenue(p)) return null;
    // A coarse kind, so the app can word the prompt correctly: you pick a
    // "gate" at a station and a "terminal" at an airport.
    const t = p.types;
    const kind =
      t.includes('airport') ? 'terminal'
      : t.some(x => ['train_station', 'subway_station', 'transit_station', 'light_rail_station', 'bus_station'].includes(x)) ? 'gate'
      : t.includes('shopping_mall') ? 'entrance'
      : t.includes('hospital') ? 'entrance'
      : 'entry point';
    return { name: p.name, kind };
  } catch (_e) {
    return null;
  }
}

module.exports = {
  suggestPickupPoints,
  recordSuccessfulPickup,
  landmarkFor,
  venueFor,
  // exported for tests / admin tooling
  _internals: { cellKey, distanceM, POINT_CELL, SUGGEST_RADIUS_M, MIN_USES },
};
