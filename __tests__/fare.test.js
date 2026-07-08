/**
 * Critical path tests: fare estimation + admin fare settings validation.
 * These catch the class of bugs where NULL/NaN DB values silently break booking.
 */
'use strict';

jest.mock('../config/db', () => ({ query: jest.fn() }));
// admin.js runs db.query at module load — return a safe default
jest.mock('../config/socket', () => ({ emitToRoom: jest.fn(), getIO: jest.fn(() => null), init: jest.fn() }));
jest.mock('../config/firebase', () => ({ sendFCM: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../config/redis', () => ({ redis: { get: jest.fn(), set: jest.fn(), del: jest.fn(), on: jest.fn(), connect: jest.fn(), duplicate: jest.fn(() => ({ connect: jest.fn() })) }, makeBmqConn: jest.fn() }));
jest.mock('../config/cloudinary', () => ({ uploader: { upload: jest.fn() } }));
jest.mock('../config/razorpay', () => ({}));
jest.mock('../workers/rideWorker', () => ({ rideQueue: {}, assignRideToNextDriver: jest.fn() }));
jest.mock('../services/matching', () => ({ driverLocations: {}, encodeGeohash: jest.fn(() => 'abc'), haversineKm: jest.fn(() => 0.5) }));
jest.mock('../routes/favourites', () => ({ directFavouriteRideIds: new Set() }));

const supertest = require('supertest');
const express   = require('express');
const db        = require('../config/db');

// admin.js has top-level db.query().then() — mock must return a Promise
db.query.mockResolvedValue({ rows: [] });

const miscRouter  = require('../routes/misc');
const adminRouter = require('../routes/admin');

const app = express();
app.use(express.json());
app.use('/api',       miscRouter);
app.use('/api/admin', adminRouter);

// ─── Fare estimate: normal case ───────────────────────────────────────────────
test('fare-estimate returns correct fare for bike (5 km, day)', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ base_fare: 15, per_km_rate: 8, night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' }] });

  const res = await supertest(app)
    .post('/api/fare-estimate')
    .send({ ride_type: 'bike', distance: 5 });

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('fare');
  expect(typeof res.body.fare).toBe('number');
  expect(isNaN(res.body.fare)).toBe(false);
  const hour = new Date().getHours();
  const isNight = hour >= 22 || hour < 6;
  const expected = Math.round((15 + 5 * 8) * (isNight ? 1.3 : 1));
  expect(res.body.fare).toBe(expected);
});

// ─── Fare estimate: NULL per_km_rate in DB must NOT return NaN ────────────────
test('fare-estimate returns 500 when per_km_rate is NULL (not NaN/null fare)', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ base_fare: 1, per_km_rate: null, night_multiplier: 1.2, night_start: '22:00', night_end: '06:00' }] });

  const res = await supertest(app)
    .post('/api/fare-estimate')
    .send({ ride_type: 'bike', distance: 3 });

  // Must not silently return {fare: null} — that breaks hasFare check in frontend
  if (res.status === 200) {
    expect(res.body.fare).not.toBeNull();
    expect(typeof res.body.fare).toBe('number');
    expect(isNaN(res.body.fare)).toBe(false);
    expect(res.body.fare).toBeGreaterThanOrEqual(0);
  } else {
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  }
});

// ─── Fare estimate: NULL base_fare must NOT return NaN ────────────────────────
test('fare-estimate handles NULL base_fare gracefully', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ base_fare: null, per_km_rate: 8, night_multiplier: 1.2, night_start: '22:00', night_end: '06:00' }] });

  const res = await supertest(app)
    .post('/api/fare-estimate')
    .send({ ride_type: 'auto', distance: 2 });

  if (res.status === 200) {
    expect(isNaN(res.body.fare)).toBe(false);
    expect(res.body.fare).not.toBeNull();
  } else {
    expect(res.status).toBe(500);
  }
});

// ─── Fare estimate: unknown ride_type returns 400/error ───────────────────────
test('fare-estimate returns error for unknown ride_type', async () => {
  db.query.mockResolvedValueOnce({ rows: [] }); // no row in fare_settings

  const res = await supertest(app)
    .post('/api/fare-estimate')
    .send({ ride_type: 'spaceship', distance: 5 });

  expect(res.body).toHaveProperty('error');
});

// ─── Admin fare settings: rejects NULL per_km_rate ───────────────────────────
test('admin fare-settings rejects missing per_km_rate', async () => {
  const res = await supertest(app)
    .post('/api/admin/fare-settings')
    .send({ vehicle_type: 'bike', base_fare: 15, per_km_rate: '', night_multiplier: 1.3 });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/per_km_rate/);
});

// ─── Admin fare settings: rejects negative values ────────────────────────────
test('admin fare-settings rejects negative base_fare', async () => {
  const res = await supertest(app)
    .post('/api/admin/fare-settings')
    .send({ vehicle_type: 'auto', base_fare: -5, per_km_rate: 12, night_multiplier: 1.5 });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/base_fare/);
});

// ─── Admin fare settings: rejects night_multiplier < 1 ───────────────────────
test('admin fare-settings rejects night_multiplier below 1', async () => {
  const res = await supertest(app)
    .post('/api/admin/fare-settings')
    .send({ vehicle_type: 'car', base_fare: 40, per_km_rate: 15, night_multiplier: 0.5 });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/night_multiplier/);
});

// ─── Admin fare settings: valid update succeeds ───────────────────────────────
test('admin fare-settings accepts valid numeric inputs', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // upsert returns

  const res = await supertest(app)
    .post('/api/admin/fare-settings')
    .send({ vehicle_type: 'bike', base_fare: 15, per_km_rate: 8, night_multiplier: 1.3, night_start: '22:00', night_end: '06:00' });

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
});
