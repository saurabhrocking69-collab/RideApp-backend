require('dotenv').config();
if (!process.env.DATABASE_PUBLIC_URL && !process.env.DATABASE_URL) {
  console.error('\u274c Set DATABASE_PUBLIC_URL or DATABASE_URL in your environment before running this script.');
  process.exit(1);
}
const { Pool } = require('pg');
const db = new Pool({ 
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function addDrivers() {
  const drivers = [
    { phone: '8888888888', name: 'Raju Driver',   type: 'auto',    vehicle: 'UP32AB1234', license: 'UP032023A001' },
    { phone: '7777777777', name: 'Amit Driver',   type: 'bike',    vehicle: 'UP32CD5678', license: 'UP032023B001' },
    { phone: '6666666666', name: 'Suresh Driver', type: 'taxi',    vehicle: 'UP32EF9012', license: 'UP032023T001' },
    { phone: '5555555555', name: 'Vikram Driver', type: 'economy', vehicle: 'UP32GH3456', license: 'UP032023E001' },
    { phone: '4444444444', name: 'Rahul Driver',  type: 'premium', vehicle: 'UP32IJ7890', license: 'UP032023P001' },
    { phone: '3333333333', name: 'Deepak Driver', type: 'moto',    vehicle: 'UP32KL1234', license: 'UP032023M001' },
  ];

  for (const d of drivers) {
    try {
      const u = await db.query(
        "INSERT INTO users (phone, name, role) VALUES ($1, $2, 'driver') ON CONFLICT (phone) DO NOTHING RETURNING id",
        [d.phone, d.name]
      );
      if (u.rows[0]) {
        await db.query(
          'INSERT INTO drivers (id, vehicle_type, vehicle_no, license_no) VALUES ($1, $2, $3, $4)',
          [u.rows[0].id, d.type, d.vehicle, d.license]
        );
        await db.query(
          'INSERT INTO driver_wallet (driver_id) VALUES ($1)',
          [u.rows[0].id]
        );
        console.log('✅ Added:', d.name);
      }
    } catch(e) {
      console.log('Skip:', d.name, e.message);
    }
  }
  console.log('Done!');
  db.end();
}
addDrivers();