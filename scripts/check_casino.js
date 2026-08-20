const { pool } = require('../src/config/database');

async function main() {
  try {
    const [rows] = await pool.query('SELECT user_id, total_wagered, vip_claim_date, vip_claim_at, updated_at FROM user_casino ORDER BY updated_at DESC LIMIT 10');
    console.log('USER CASINO ROWS:', rows);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

main();
