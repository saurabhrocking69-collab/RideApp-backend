'use strict';
const express = require('express');
const router  = express.Router();
const { advanceForFare, requiresAdvance, razorpay } = require('../services/advance');

// POST /api/advance/order — create a Razorpay order for the 1/3 advance on a
// high-value booking. Called by the customer app BEFORE it books, when the fare
// estimate exceeds the threshold. The booking endpoints then verify the payment.
router.post('/order', async (req, res) => {
  const { phone, fare } = req.body;
  const fareNum = parseFloat(fare) || 0;
  if (!requiresAdvance(fareNum)) return res.status(400).json({ error: 'Advance not required for this fare' });
  if (!razorpay) return res.status(500).json({ error: 'Payment gateway not configured' });
  try {
    const advance = advanceForFare(fareNum);
    const order = await razorpay.orders.create({
      amount: advance * 100, currency: 'INR',
      receipt: `adv_${phone}_${Date.now()}`,
      notes: { phone, purpose: 'ride_advance', fare: String(fareNum) },
    });
    res.json({
      success: true,
      order_id: order.id, amount: order.amount, currency: 'INR',
      advance, remaining: Math.max(0, Math.round(fareNum) - advance),
      key_id: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
