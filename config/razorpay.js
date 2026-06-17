const Razorpay = require('razorpay');

console.log('🔑 RZP KEY:', process.env.RAZORPAY_KEY_ID ? 'MILA' : 'NAHI MILA');

let razorpay = null;
if (process.env.RAZORPAY_KEY_ID) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

module.exports = razorpay;
