const { pool } = require('../src/config/database');
const { formatMoney } = require('../src/utils/formatters');

async function testLogsApi() {
  console.log('=== 📊 전체 자금 흐름 & 영역별 로그 탐색기 정밀 검증 ===\n');

  // 1. 최근 30일치 로그 카운트 및 총액
  const [totalRow] = await pool.query(`
    SELECT COUNT(*) as count, COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) as total_volume
    FROM economy_logs
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
  `);
  console.log(`1. 최근 30일 전체 자금 이동 로그: ${totalRow[0].count}건 (총 이동 금액: ${formatMoney(totalRow[0].total_volume)})`);

  // 2. 영역별(카테고리별) 로그 집계
  const categories = {
    '🏛️ 세금·국고': ['TAX_WEALTH', 'TAX_TRADE', 'TAX_ADMIN', 'TAX_REFUND', 'TREASURY_SUBSIDY', 'TREASURY_WITHDRAW', 'TREASURY_CASINO_VIP'],
    '💸 송금·이체': ['TRANSFER', 'TRANSFER_SEND', 'TRANSFER_RECEIVE'],
    '🎰 도박·카지노': ['GAMBLING', 'SLOT', 'DICE', 'COIN', 'ROULETTE', 'HORSE', 'LOTTERY', 'CASINO_VIP', 'CASINO_MISSION', 'CASINO_VIP_DAILY'],
    '📈 주식·배당': ['STOCK_BUY', 'STOCK_SELL', 'DIVIDEND'],
    '🏦 은행·대출': ['BANK_DEPOSIT', 'BANK_WITHDRAW', 'BANK_INTEREST', 'INTEREST', 'LOAN_BORROW', 'LOAN_REPAY', 'LOAN'],
    '⛏️ 활동·지원금': ['CLICKER', 'MINE', 'WORK', 'DAILY', 'ATTENDANCE', 'SUBSIDY', 'BUSINESS'],
    '👑 관리자': ['ADMIN_GIVE', 'ADMIN_TAKE', 'ADMIN_RESET', 'ADMIN_SET', 'WEB_TAX_WITHDRAW', 'DISCORD_TAX_WITHDRAW', 'WEB_TAX_REFUND']
  };

  console.log('\n2. 영역별 30일치 로그 현황:');
  for (const [catName, types] of Object.entries(categories)) {
    const [catRow] = await pool.query(`
      SELECT COUNT(*) as count, COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) as vol
      FROM economy_logs
      WHERE type IN (${types.map(() => '?').join(',')}) AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `, types);
    console.log(`   - ${catName}: ${catRow[0].count}건 (합계: ${formatMoney(catRow[0].vol)})`);
  }

  // 3. 최근 5건 샘플 출력
  const [samples] = await pool.query(`
    SELECT id, user_id, username, type, amount, balance_before, balance_after, description, created_at
    FROM economy_logs
    ORDER BY id DESC
    LIMIT 5
  `);
  console.log('\n3. 최근 실시간 자금 이동 로그 샘플 5건:');
  samples.forEach(s => {
    console.log(`   [#${s.id}] ${s.created_at.toLocaleString()} | @${s.username} | ${s.type} | ${formatMoney(s.amount)} | ${s.description}`);
  });

  console.log('\n=== ✅ 30일치 전수 로그 보존 및 영역별 탐색 검증 완료! ===');
  process.exit(0);
}

testLogsApi().catch(e => {
  console.error('❌ Error in testLogsApi:', e);
  process.exit(1);
});
