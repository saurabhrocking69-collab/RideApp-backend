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

// ── Intercity (>80km, cars only) ─────────────────────────────────────────────
// One-way per-km is higher than round-trip per-km because the driver returns empty.
// Round trips bill 2x route distance at the lower rate + per-day driver allowance
// + night-halt for each overnight. Tolls/state tax/parking are NOT included —
// customer pays those to the driver directly (shown as a note in both apps).
const INTERCITY_FARES = {
  car: {
    label: 'Intercity Economy', vehicle_desc: 'Wagon R, Dzire or similar',
    base_fare: 200, per_km_oneway: 14, per_km_round: 11,
    driver_allowance_per_day: 400, night_halt: 300,
    min_km: 80, seats: 4,
  },
  luxury: {
    label: 'Intercity Premium', vehicle_desc: 'Innova, Ertiga or similar',
    base_fare: 350, per_km_oneway: 20, per_km_round: 16,
    driver_allowance_per_day: 600, night_halt: 400,
    min_km: 80, seats: 6,
  },
};

/**
 * Intercity fare — flat per-km model, no city slabs / night multiplier.
 * @param {object} cfg      - INTERCITY_FARES entry
 * @param {number} distKm   - one-way route distance in km
 * @param {string} tripKind - 'oneway' | 'round'
 * @param {number} tripDays - calendar days the trip spans (round trips; min 1)
 */
function calculateIntercityFare(cfg, distKm, tripKind = 'oneway', tripDays = 1) {
  const isRound  = tripKind === 'round';
  const days     = Math.max(1, Math.round(tripDays) || 1);
  const perKm    = isRound ? cfg.per_km_round : cfg.per_km_oneway;
  const billedKm = Math.ceil(Math.max(isRound ? distKm * 2 : distKm, cfg.min_km * (isRound ? 2 : 1)));
  const distFare  = Math.round(billedKm * perKm);
  const allowance = isRound ? days * cfg.driver_allowance_per_day : cfg.driver_allowance_per_day;
  const nightHalt = isRound ? (days - 1) * cfg.night_halt : 0;
  const fare = Math.round(cfg.base_fare + distFare + allowance + nightHalt);
  return {
    fare,
    base_fare:        cfg.base_fare,
    dist_fare:        distFare,
    per_km_rate:      perKm,
    billed_km:        billedKm,
    driver_allowance: allowance,
    night_halt:       nightHalt,
    trip_days:        days,
    trip_kind:        isRound ? 'round' : 'oneway',
    distance_km:      Math.round(distKm * 10) / 10,
    label:            cfg.label,
    vehicle_desc:     cfg.vehicle_desc,
    seats:            cfg.seats,
  };
}

// ── Parcel delivery — flat per-km model, no night/city slabs ──────────────────
// Package size only adds a small handling surcharge; the vehicle itself is
// already gated by size on the client (small→any, medium→auto+, large→car
// only), so the fare table doesn't need a separate rate per size.
const PARCEL_FARES = {
  bike:          { base_fare: 20, per_km_rate: 5,  min_fare: 30 },
  green_bike:    { base_fare: 18, per_km_rate: 4,  min_fare: 28 },
  auto:          { base_fare: 25, per_km_rate: 7,  min_fare: 40 },
  eriksha:       { base_fare: 22, per_km_rate: 6,  min_fare: 35 },
  electric_auto: { base_fare: 22, per_km_rate: 6,  min_fare: 35 },
  car:           { base_fare: 40, per_km_rate: 11, min_fare: 65 },
};
const PARCEL_SIZE_SURCHARGE = { small: 0, medium: 10, large: 25 };

/**
 * Parcel fare — flat per-km + a small handling surcharge by package size.
 * @param {object} cfg         - PARCEL_FARES entry
 * @param {number} distKm      - route distance in km
 * @param {string} packageSize - 'small' | 'medium' | 'large'
 */
function calculateParcelFare(cfg, distKm, packageSize = 'small') {
  const surcharge = PARCEL_SIZE_SURCHARGE[packageSize] ?? 0;
  const distFare   = Math.round(distKm * cfg.per_km_rate);
  const rawFare    = cfg.base_fare + distFare + surcharge;
  const fare       = Math.max(Math.round(rawFare), cfg.min_fare);
  return {
    fare,
    base_fare:    cfg.base_fare,
    dist_fare:    distFare,
    per_km_rate:  cfg.per_km_rate,
    surcharge,
    package_size: packageSize,
    distance_km:  Math.round(distKm * 10) / 10,
  };
}

let SURGE_MULTIPLIER = 1.0;

// Server runs in UTC (Railway default); night_start/night_end are configured as IST values by admins.
// Always compare against IST hour to avoid 5.5-hour drift.
function getISTHour() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCHours();
}

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
  const meterFare = Math.round((distFare + timeFare) * nightMult);
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

module.exports = { HOURLY_FARES, INTERCITY_FARES, PARCEL_FARES, getSurge: () => SURGE_MULTIPLIER, setSurge: (v) => { SURGE_MULTIPLIER = v; }, calculateFare, calculateIntercityFare, calculateParcelFare, getISTHour };
