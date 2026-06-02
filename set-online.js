const { Pool } = require('pg');
const db = new Pool({
  connectionString: 'postgresql://postgres:FfxsUaHWYRSbaNfIrUiRrcUtwEweYHhR@zephyr.proxy.rlwy.net:20998/railway',
  ssl: { rejectUnauthorized: false }
});

db.query(`UPDATE drivers SET is_online = true`)
  .then(r => { console.log('✅ Saare drivers online:', r.rowCount, 'rows'); db.end(); })
  .catch(e => { console.log('❌ Error:', e.message); db.end(); });