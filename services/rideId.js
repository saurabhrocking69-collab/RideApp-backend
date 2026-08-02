'use strict';
// Rides use a UUID primary key (rides.id) — a 36-character string that must
// never be shown to a user. This produces the short masked code used
// everywhere instead, e.g. "#SP48B9DFF7".
//
// MUST stay byte-identical to shortRideId() in the two apps
// (rideapp-mobile3/src/rideId.ts and rideapp-driver/rideId.ts). A rider
// reading a code off a push notification has to be able to match it against
// the one in their trip history, and support has to be able to match both.
//
// This file exists because the apps had that helper and the backend did not,
// so server-generated pushes and wallet descriptions were leaking raw UUIDs
// while every in-app screen showed the short form.
//
// Use it for anything a person reads. Do NOT use it in console.log — logs
// want the full id for debugging.
function shortRideId(id) {
  return '#SP' + String(id || '').slice(-8).toUpperCase();
}

module.exports = { shortRideId };
