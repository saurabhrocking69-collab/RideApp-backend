// One-time script: zero out all test-mode money before live launch
// Run: node reset-test-money.js
const db = require('./config/db');

async function resetTestMoney() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Zero customer wallet balances
    const cw = await client.query('UPDATE customer_wallet SET balance = 0, updated_at = NOW()');
    console.log(`✅ Customer wallets zeroed: ${cw.rowCount} rows`);

    // 2. Delete all customer transactions (test credits/debits)
    const tx = await client.query('DELETE FROM transactions');
    console.log(`✅ Customer transactions cleared: ${tx.rowCount} rows`);

    // 3. Zero driver wallet balances and earnings
    const dw = await client.query('UPDATE driver_wallet SET balance = 0, total_earned = 0, updated_at = NOW()');
    console.log(`✅ Driver wallets zeroed: ${dw.rowCount} rows`);

    // 4. Zero driver pending commission
    const dc = await client.query('UPDATE driver_wallet SET pending_commission = 0 WHERE pending_commission IS NOT NULL').catch(() => ({ rowCount: 0 }));
    console.log(`✅ Driver commissions zeroed: ${dc.rowCount} rows`);

    // 5. Zero bonus wallet (driver bonus earnings)
    const bw = await client.query('UPDATE bonus_wallet SET balance = 0, total_earned = 0, total_redeemed = 0, updated_at = NOW()').catch(() => ({ rowCount: 0 }));
    console.log(`✅ Bonus wallets zeroed: ${bw.rowCount} rows`);

    // 6. Delete bonus ledger entries
    const bl = await client.query('DELETE FROM bonus_ledger').catch(() => ({ rowCount: 0 }));
    console.log(`✅ Bonus ledger cleared: ${bl.rowCount} rows`);

    // 7. Delete cashback events (will regenerate on real rides)
    const cb = await client.query('DELETE FROM cashback_events').catch(() => ({ rowCount: 0 }));
    console.log(`✅ Cashback events cleared: ${cb.rowCount} rows`);

    // 8. Delete customer loyalty points
    const lp = await client.query('UPDATE customer_loyalty SET total_points = 0, updated_at = NOW()').catch(() => ({ rowCount: 0 }));
    console.log(`✅ Loyalty points zeroed: ${lp.rowCount} rows`);

    // 9. Clear referral reward records (test referrals)
    const rr = await client.query('DELETE FROM referral_rewards').catch(() => ({ rowCount: 0 }));
    console.log(`✅ Referral rewards cleared: ${rr.rowCount} rows`);

    // 10. Clear razorpay_topups (test payment records)
    const rt = await client.query('DELETE FROM razorpay_topups').catch(() => ({ rowCount: 0 }));
    console.log(`✅ Razorpay topups cleared: ${rt.rowCount} rows`);

    // 11. Clear driver_commission_payments (test records)
    const dcp = await client.query('DELETE FROM driver_commission_payments').catch(() => ({ rowCount: 0 }));
    console.log(`✅ Driver commission payments cleared: ${dcp.rowCount} rows`);

    // 12. Clear scratch cards
    const sc = await client.query('DELETE FROM scratch_cards').catch(() => ({ rowCount: 0 }));
    console.log(`✅ Scratch cards cleared: ${sc.rowCount} rows`);

    // 13. Reset driver commission debt (cash rides during test)
    const dm = await client.query(
      `UPDATE driver_commissions SET status = 'settled' WHERE status != 'settled'`
    ).catch(() => ({ rowCount: 0 }));
    console.log(`✅ Driver commissions settled: ${dm.rowCount} rows`);

    await client.query('COMMIT');
    console.log('\n🎉 All test money reset to zero. Ready for live launch!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Reset failed:', err.message);
    console.error(err);
  } finally {
    client.release();
    process.exit(0);
  }
}

resetTestMoney();
