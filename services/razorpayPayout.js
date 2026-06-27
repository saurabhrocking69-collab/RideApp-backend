const axios = require('axios');

const BASE = 'https://api.razorpay.com/v1';

function auth() {
  return { username: process.env.RAZORPAY_KEY_ID, password: process.env.RAZORPAY_KEY_SECRET };
}

// Create contact or return existing one (idempotent via reference_id)
async function ensureContact(phone, name) {
  try {
    const res = await axios.post(`${BASE}/contacts`, {
      name: name || phone,
      contact: phone,
      type: 'vendor',
      reference_id: `drv_${phone}`,
    }, { auth: auth() });
    return res.data.id;
  } catch (err) {
    const desc = err.response?.data?.error?.description || '';
    // Razorpay rejects duplicate reference_id — fetch the existing contact
    if (desc.includes('reference_id')) {
      const list = await axios.get(`${BASE}/contacts?reference_id=drv_${phone}`, { auth: auth() });
      const contact = list.data.items?.[0];
      if (contact) return contact.id;
    }
    const msg = err.response?.data?.error?.description || err.message;
    throw new Error(`Razorpay contact error: ${msg}`);
  }
}

// Register bank account or UPI as a fund account under this contact
async function createFundAccount(contactId, payout) {
  try {
    if (payout.method === 'upi') {
      const res = await axios.post(`${BASE}/fund_accounts`, {
        contact_id: contactId,
        account_type: 'vpa',
        vpa: { address: payout.upi_id },
      }, { auth: auth() });
      return res.data.id;
    }
    const res = await axios.post(`${BASE}/fund_accounts`, {
      contact_id: contactId,
      account_type: 'bank_account',
      bank_account: {
        name: payout.bank_holder,
        ifsc: payout.bank_ifsc,
        account_number: payout.bank_account,
      },
    }, { auth: auth() });
    return res.data.id;
  } catch (err) {
    const msg = err.response?.data?.error?.description || err.message;
    throw new Error(`Razorpay fund account error: ${msg}`);
  }
}

// Initiate payout — returns Razorpay payout object { id, status, utr? }
async function initiatePayout(fundAccountId, amountRupees, dbPayoutId, method) {
  try {
    const res = await axios.post(`${BASE}/payouts`, {
      account_number: process.env.RAZORPAY_ACCOUNT_NUMBER,
      fund_account_id: fundAccountId,
      amount: Math.round(amountRupees * 100), // paise
      currency: 'INR',
      mode: method === 'upi' ? 'UPI' : 'IMPS',
      purpose: 'payout',
      queue_if_low_balance: false,
      reference_id: `sp_po_${dbPayoutId}`,
      narration: 'Sppero Driver Payout',
    }, { auth: auth() });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.error?.description || err.message;
    throw new Error(`Razorpay payout error: ${msg}`);
  }
}

module.exports = { ensureContact, createFundAccount, initiatePayout };
