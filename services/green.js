'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  GREEN IDENTITY — CO₂ saved by choosing an electric vehicle
//
//  Single source of truth for every surface that shows an emissions number:
//  ride history, the post-ride screen, the lifetime impact card, admin.
//  Deliberately computed ON DEMAND from rides.distance_km + rides.ride_type
//  rather than stored per ride, so that:
//    - every ride ever taken counts retroactively, with no migration, and
//    - correcting a factor below corrects all history instead of leaving old
//      rides frozen with a number we no longer stand behind.
//
//  ── On the numbers ───────────────────────────────────────────────────────
//  These are honest ballpark figures, not lab measurements, and the API
//  labels them as estimates. Two things worth being straight about:
//
//  1. An EV is NOT zero-emission in India. Tailpipe emissions are zero, but
//     the electricity comes from a grid that is still heavily coal-fired
//     (~0.7 kg CO₂ per kWh). So the saving is a genuine reduction, not an
//     elimination — roughly two-thirds less, not 100% less. Claiming "zero"
//     would be greenwashing, and the number would not survive scrutiny.
//  2. The saving is always measured against the PETROL EQUIVALENT of the same
//     vehicle class — an e-rickshaw is compared to a petrol/CNG auto, not to
//     a car. Comparing a small EV against a big petrol car would inflate the
//     figure by pretending the rider had a different journey.
// ═══════════════════════════════════════════════════════════════════════════

const GRID_KG_PER_KWH = 0.71;   // India average grid intensity (coal-heavy)

// grams of CO₂ per km. `ev` is null for vehicles that burn fuel.
const EMISSIONS = {
  //                    petrol equivalent   this vehicle
  bike:          { petrol: 55,  ev: null },
  auto:          { petrol: 85,  ev: null },
  eriksha:       { petrol: 85,  ev: Math.round(0.050 * GRID_KG_PER_KWH * 1000) }, // ~36
  electric_auto: { petrol: 85,  ev: Math.round(0.050 * GRID_KG_PER_KWH * 1000) }, // ~36
  green_bike:    { petrol: 55,  ev: Math.round(0.025 * GRID_KG_PER_KWH * 1000) }, // ~18
  car:           { petrol: 145, ev: null },
  car_7:         { petrol: 175, ev: null },
  luxury:        { petrol: 190, ev: null },
  ultra_luxury:  { petrol: 190, ev: null },
};

const GREEN_TYPES = Object.keys(EMISSIONS).filter(k => EMISSIONS[k].ev != null);

function isGreen(rideType) {
  return GREEN_TYPES.includes(String(rideType || '').toLowerCase());
}

// Grams of CO₂ avoided versus the petrol equivalent of the same vehicle class.
// Returns 0 for petrol vehicles — nothing was saved, and inventing a number
// for them would make the lifetime total meaningless.
function co2SavedGrams(rideType, distanceKm) {
  const cfg = EMISSIONS[String(rideType || '').toLowerCase()];
  const km = parseFloat(distanceKm);
  if (!cfg || cfg.ev == null || !(km > 0)) return 0;
  return Math.round((cfg.petrol - cfg.ev) * km);
}

// A gram figure means nothing to a rider. Trees are the comparison people
// actually picture: a mature tree absorbs very roughly 21 kg CO₂ a year, so
// this is "tree-days" worth of absorption, expressed as whole trees only once
// the number is genuinely meaningful.
function co2Equivalent(grams) {
  const kg = grams / 1000;
  return {
    kg: Math.round(kg * 100) / 100,
    treeDays: Math.round((kg / 21) * 365 * 10) / 10,
  };
}

// Per-vehicle figures for the apps to render booking-time hints with.
// Shipped from here rather than duplicated in the client so the two can never
// drift apart — the client should never hold its own copy of these numbers.
function greenFactors() {
  const out = {};
  for (const type of GREEN_TYPES) {
    const { petrol, ev } = EMISSIONS[type];
    out[type] = {
      saved_g_per_km: petrol - ev,
      less_pct: Math.round(((petrol - ev) / petrol) * 100),
    };
  }
  return out;
}

module.exports = { EMISSIONS, GREEN_TYPES, isGreen, co2SavedGrams, co2Equivalent, greenFactors, GRID_KG_PER_KWH };
