const { pool } = require('../src/config/database');
const { formatMoney } = require('../src/utils/formatters');
const { safeBigInt, applyCashGiveLocked } = require('../src/utils/money');
const { parseAdminMoney } = require('../src/utils/moneyScale');

async function testGive() {
  const userId = '1481258930909872239';
  const amount = '750000000';
  const reason = '테스트 지급';

  console.log('1. parseAdminMoney 테스트:');
  const parsed = parseAdminMoney(amount, '원');
  console.log('Parsed:', parsed, typeof parsed);

  console.log('2. 유저 조회 테스트:');
  const [rows] = await pool.query('SELECT * FROM users WHERE discord_id = ? LIMIT 1', [userId]);
  console.log('User in DB:', rows[0]);

  console.log('3. applyCashGiveLocked 테스트:');
  const { before, after } = await applyCashGiveLocked(userId, parsed);
  console.log('Before:', before, 'After:', after);

  console.log('4. economy_logs INSERT 테스트:');
  await pool.query(`
    INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
    VALUES (?, ?, 'ADMIN_GIVE', ?, ?, ?, ?)
  `, [
    userId,
    rows[0] ? rows[0].username : 'dlhaslflkgh',
    parsed.toString(),
    before.toString(),
    after.toString(),
    `👑 [웹 관리자 지급 테스트] +${formatMoney(parsed)}`
  ]);
  console.log('✅ economy_logs INSERT 성공');

  process.exit(0);
}

testGive().catch(err => {
  console.error('Error in testGive:', err);
  process.exit(1);
});
