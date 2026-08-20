const { pool } = require('../src/config/database');
const { formatMoney } = require('../src/utils/formatters');
const { safeBigInt } = require('../src/utils/money');

async function main() {
  const targetId = '1481258930909872239';

  console.log('=== 1. 대상 유저 자산 확인 ===');
  const [users] = await pool.query('SELECT * FROM users WHERE discord_id = ?', [targetId]);
  console.log(users[0]);

  console.log('\n=== 2. 대상 유저 사업 목록 (user_businesses) ===');
  const [biz] = await pool.query('SELECT * FROM user_businesses WHERE user_id = ?', [targetId]);
  console.log(biz);

  console.log('\n=== 3. 대상 유저 사업 메타 (user_business_meta) ===');
  const [meta] = await pool.query('SELECT * FROM user_business_meta WHERE user_id = ?', [targetId]);
  console.log(meta);

  console.log('\n=== 4. 최근 BUSINESS_COLLECT 자금 로그 (최근 20건) ===');
  const [ecoLogs] = await pool.query(
    'SELECT * FROM economy_logs WHERE user_id = ? AND type = "BUSINESS_COLLECT" ORDER BY id DESC LIMIT 20',
    [targetId]
  );
  for (const log of ecoLogs) {
    console.log(`[${log.created_at}] Amount: ${log.amount} | Before: ${log.balance_before} -> After: ${log.balance_after} | Desc: ${log.description}`);
  }

  console.log('\n=== 5. 웹 접속 로그 /api/business/collect (최근 20건) ===');
  const [webLogs] = await pool.query(
    'SELECT * FROM web_access_logs WHERE (user_id = ? OR username LIKE "%dlhaslflkgh%") AND url LIKE "%business/collect%" ORDER BY id DESC LIMIT 20',
    [targetId]
  );
  for (const w of webLogs) {
    console.log(`[${w.created_at}] IP: ${w.ip} | Method: ${w.method} | Status: ${w.status_code} | Duration: ${w.duration_ms}ms`);
  }

  console.log('\n=== 6. 보유 주식 현황 ===');
  const [stocks] = await pool.query(
    'SELECT us.*, s.name, s.price FROM user_stocks us JOIN stocks s ON us.stock_id = s.stock_id WHERE us.user_id = ?',
    [targetId]
  );
  console.log(stocks);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
