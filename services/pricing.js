// Mutable singletons — admin updates these at runtime via API
// All route files share the same object reference (Node.js module cache)

const HOURLY_FARES = {
  auto:          { 2:{fare:180,km:20}, 4:{fare:320,km:40}, 6:{fare:460,km:60}, 8:{fare:580,km:80},  24:{fare:1500,km:200}, 48:{fare:2800,km:400}, 72:{fare:4000,km:600}, extra:8  },
  bike:          { 2:{fare:120,km:20}, 4:{fare:210,km:40}, 6:{fare:300,km:60}, 8:{fare:380,km:80},  24:{fare:1000,km:200}, 48:{fare:1800,km:400}, 72:{fare:2600,km:600}, extra:5  },
  car:           { 2:{fare:260,km:20}, 4:{fare:460,km:40}, 6:{fare:660,km:60}, 8:{fare:840,km:80},  24:{fare:2200,km:200}, 48:{fare:4000,km:400}, 72:{fare:5800,km:600}, extra:12 },
  eriksha:       { 2:{fare:150,km:20}, 4:{fare:270,km:40}, 6:{fare:390,km:60}, 8:{fare:490,km:80},  24:{fare:1200,km:200}, 48:{fare:2200,km:400}, 72:{fare:3200,km:600}, extra:7  },
  ultra_luxury:  { 2:{fare:800,km:20}, 4:{fare:1400,km:40}, 6:{fare:2000,km:60}, 8:{fare:2600,km:80}, 24:{fare:6000,km:200}, 48:{fare:10000,km:400}, 72:{fare:14000,km:600}, extra:25 },
  green_bike:    { 2:{fare:100,km:20}, 4:{fare:180,km:40}, 6:{fare:260,km:60}, 8:{fare:330,km:80},  24:{fare:850,km:200},  48:{fare:1500,km:400}, 72:{fare:2200,km:600}, extra:4  },
  electric_auto: { 2:{fare:130,km:20}, 4:{fare:240,km:40}, 6:{fare:350,km:60}, 8:{fare:440,km:80},  24:{fare:1100,km:200}, 48:{fare:2000,km:400}, 72:{fare:2900,km:600}, extra:6  },
};

let SURGE_MULTIPLIER = 1.0;

// Distance tier breakpoints (km) — fixed platform-wide
const DIST_T1 = 8;
const DIST_T2 = 20;

/**
 * Calculate fare using the full Sppero fare model:
 * base + tiered distance + time component, with night multiplier.
 * Platform fee added flat on top (not subject to night/surge).
 *
 * @param {object} f          - fare_settings row
 * @param {number} distKm     - trip distance in km
 * @param {number} durationMin - estimated or actual trip duration in minutes
 * @param {boolean} isNight   - whether night surcharge applies
 * @returns {object} fare breakdown
 */
function calculateFare(f, distKm, durationMin = 0, isNight = false) {
  const baseFare  = parseFloat(f.base_fare)     || 0;
  const r1        = parseFloat(f.per_km_rate)   || 0;
  const r2        = f.per_km_rate_t2 != null ? parseFloat(f.per_km_rate_t2) : r1;
  const r3        = f.per_km_rate_t3 != null ? parseFloat(f.per_km_rate_t3) : r2;
  const timeRate  = parseFloat(f.time_rate)     || 0;
  const platFee   = parseFloat(f.platform_fee)  >= 0 ? parseFloat(f.platform_fee) : 2;
  const minFare   = parseFloat(f.min_fare)      || 0;
  const nightMult = isNight ? (parseFloat(f.night_multiplier) || 1.0) : 1.0;

  let distFare = 0;
  if (distKm <= DIST_T1) {
    distFare = distKm * r1;
  } else if (distKm <= DIST_T2) {
    distFare = DIST_T1 * r1 + (distKm - DIST_T1) * r2;
  } else {
    distFare = DIST_T1 * r1 + (DIST_T2 - DIST_T1) * r2 + (distKm - DIST_T2) * r3;
  }

  const timeFare  = durationMin * timeRate;
  const meterFare = Math.round((baseFare + distFare + timeFare) * nightMult);
  const tripFare  = Math.max(minFare, meterFare);
  const totalFare = tripFare + platFee;

  return {
    fare:             Math.round(totalFare),
    base_fare:        baseFare,
    dist_fare:        Math.round(distFare * nightMult),
    time_fare:        Math.round(timeFare * nightMult),
    platform_fee:     platFee,
    min_fare:         minFare,
    per_km_rate:      r1,
    per_km_rate_t2:   r2,
    per_km_rate_t3:   r3,
    time_rate:        timeRate,
    is_night:         isNight,
    night_multiplier: nightMult,
    is_min_applied:   meterFare < minFare,
    distance_km:      Math.round(distKm * 10) / 10,
    duration_min:     Math.round(durationMin * 10) / 10,
  };
}

module.exports = { HOURLY_FARES, getSurge: () => SURGE_MULTIPLIER, setSurge: (v) => { SURGE_MULTIPLIER = v; }, calculateFare };
