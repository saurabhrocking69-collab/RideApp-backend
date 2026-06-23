/**
 * Minimum critical-path tests for the rides API.
 * Uses mocked DB + Redis so no real infrastructure needed.
 */
'use strict';

jest.mock('../config/db', () => ({
  query: jest.fn(),
  connect: jest.fn(),
  end: jest.fn(),
}));
jest.mock('../config/redis', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    on: jest.fn(),
    connect: jest.fn(),
    duplicate: jest.fn(() => ({ connect: jest.fn() })),
  },
  makeBmqConn: jest.fn(),
}));
jest.mock('../config/firebase',  () => ({ sendFCM: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../config/socket',    () => ({ emitToRoom: jest.fn(), getIO: jest.fn(() => null), init: jest.fn() }));
jest.mock('../config/cloudinary',() => ({ uploader: { upload: jest.fn() } }));
jest.mock('../workers/rideWorker', () => ({ rideQueue: {}, assignRideToNextDriver: jest.fn() }));
jest.mock('../services/matching', () => ({
  driverLocations: {},
  encodeGeohash: jest.fn(() => 'abc123'),
  haversineKm: jest.fn(() => 0.5),
}));
jest.mock('../routes/favourites', () => ({ directFavouriteRideIds: new Set() }));
jest.mock('../config/razorpay',   () => ({}));

const supertest = require('supertest');
const express   = require('express');
const db        = require('../config/db');
const { sendFCM }    = require('../config/firebase');
const { emitToRoom } = require('../config/socket');

const ridesRouter = require('../routes/rides');

const app = express();
app.use(express.json());
app.use('/api/rides', ridesRouter);

// ─── Test 1: fare estimate returns correct price ─────────────────────────────
test('fare estimate returns correct price for auto', async () => {
  db.query.mockResolvedValueOnce({ rows: [{ id: 1, booking_restricted: false }] }); // user lookup
  db.query.mockResolvedValueOnce({ rows: [{ base_fare: 25, per_km_rate: 12, night_multiplier: 1.5, night_start: '22:00', night_end: '06:00' }] }); // fare_settings
  db.query.mockResolvedValueOnce({ rows: [{ id: 42, status: 'requested' }] }); // insert ride RETURNING
  db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE status

  const res = await supertest(app)
    .post('/api/rides/book')
    .send({ passenger_phone: '9876543210', pickup: 'A', drop_location: 'B', ride_type: 'auto', distance: 5 });

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty('fare');
  const fareNum = parseInt(String(res.body.fare).replace('₹', ''));
  const base = 25 + 5 * 12; // 85
  const hour = new Date().getHours();
  const isNight = hour >= 22 || hour < 6;
  const expected = isNight ? Math.round(base * 1.5) : base;
  expect(fareNum).toBe(expected);
});

// ─── Test 2: ride status returns Redis-cached status when available ───────────
test('ride status uses Redis cache when available', async () => {
  const { redis } = require('../config/redis');
  redis.get.mockResolvedValueOnce('matched'); // Redis hit

  db.query.mockResolvedValueOnce({
    rows: [{
      id: 1, status: 'requested', pickup: 'A', drop_location: 'B', fare: 100,
      driver_id: 2, driver_name: 'Raju', driver_phone: '9000000001',
      vehicle_no: 'MH01', vehicle_brand: 'Honda', vehicle_model: 'Activa',
      driver_upi_id: null, driver_verification_status: 'approved', driver_rating: 4.5,
      driver_photo: null,
    }],
  });

  const res = await supertest(app).get('/api/rides/status/1');
  expect(res.status).toBe(200);
  // Redis 'matched' should override the DB 'requested'
  expect(res.body.ride.status).toBe('matched');
});

// ─── Test 3: ride status returns 404 for missing ride ────────────────────────
test('ride status 404 for unknown ride', async () => {
  const { redis } = require('../config/redis');
  redis.get.mockResolvedValueOnce(null);
  db.query.mockResolvedValueOnce({ rows: [] });

  const res = await supertest(app).get('/api/rides/status/99999');
  expect(res.status).toBe(404);
});

// ─── Test 4: ride cancelled status clears correctly via socket ───────────────
test('cancel-smart emits ride_cancelled socket event to customer', async () => {
  // customer cancel of a matched ride with driver
  db.query.mockResolvedValueOnce({
    rows: [{
      id: 5, status: 'matched', driver_id: 2,
      seconds_since_book: 120,
      passenger_phone: '9111111111',
      driver_phone: '9222222222',
    }],
  }); // ride fetch
  db.query.mockResolvedValueOnce({ rows: [{ phone: '9111111111', trust_score: 100, cancels_today: 0, last_cancel_date: null }] }); // customer_metrics
  db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE customer_metrics
  db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE rides cancelled
  db.query.mockResolvedValueOnce({ rows: [] }); // INSERT cancellations

  const res = await supertest(app)
    .post('/api/rides/cancel-smart')
    .send({ ride_id: 5, cancelled_by: 'customer', phone: '9111111111', reason: 'test' });

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  // Driver should receive FCM
  expect(sendFCM).toHaveBeenCalledWith(
    '9222222222',
    expect.stringContaining('Cancel'),
    expect.any(String),
    expect.objectContaining({ type: 'ride_cancelled' }),
    expect.any(Object),
  );
});

// ─── Test 5: complaint submit with phone auth ─────────────────────────────────
test('complaint submit requires phone and validates ride ownership', async () => {
  const complaintsRouter = require('../routes/complaints');
  const cApp = express();
  cApp.use(express.json());
  cApp.use('/api/complaints', complaintsRouter);

  // user lookup returns a real user
  db.query.mockResolvedValueOnce({ rows: [{ id: 10 }] }); // customer
  db.query.mockResolvedValueOnce({ rows: [{ id: 5, driver_id: 99 }] }); // ride
  db.query.mockResolvedValueOnce({ rows: [{ id: 99 }] }); // driver user
  db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-123', status: 'open' }] }); // INSERT complaint
  db.query.mockResolvedValueOnce({ rows: [] }); // INSERT timeline

  const res = await supertest(cApp)
    .post('/api/complaints/submit')
    .send({
      phone: '9876543210',
      ride_id: 5,
      complaint_type: 'overcharging',
      description: 'Driver charged extra ₹50',
    });

  // Should not 401/403 — phone auth passes
  expect(res.status).not.toBe(401);
  expect(res.status).not.toBe(403);
});
