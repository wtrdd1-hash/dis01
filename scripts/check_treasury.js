const { pool } = require('../src/config/database');
const { readTreasury, getTaxOverview, addTreasury } = require('../src/utils/taxEngine');
const { formatMoney } = require('../src/utils/formatters');

async function check() {
  console.log('=== 🏛️ 국고 및 세금 시스템 데이터베이스 정밀 진단 ===\n');

  // 1. economy_settings의 taxTreasury 확인
  const [settings] = await pool.query('SELECT * FROM economy_settings WHERE key_name = ?', ['taxTreasury']);
  console.log('1. economy_settings 테이블 조회 결과:');
  console.log(settings);

  // 2. readTreasury() 결과
  const cur = await readTreasury();
  console.log(`\n2. readTreasury() 반환값: ${formatMoney(cur)} (${cur.toString()})`);

  // 3. 최근 24시간 세금 관련 로그 확인
  const [logs] = await pool.query('SELECT id, user_id, username, type, amount, description, created_at FROM economy_logs WHERE type LIKE "%TAX%" ORDER BY id DESC LIMIT 10');
  console.log(`\n3. 최근 세금 로그 (총 ${logs.length}건):`);
  logs.forEach(l => {
    console.log(`   - [#${l.id}] ${l.created_at} | @${l.username} | ${l.type} | ${formatMoney(l.amount)} | ${l.description}`);
  });

  // 4. 주식 거래세, 송금세, 자산세 징수 코드 검사
  console.log('\n4. 세금 징수 트리거 검사:');
  const policy = (await getTaxOverview());
  console.log(`   - 현재 정책: 거래세율 ${(policy.rate * 100).toFixed(1)}%, 승수 ×${policy.wealthTaxMultiplier || 1.0}, 국고 ${formatMoney(policy.treasury)}`);

  process.exit(0);
}

check().catch(e => {
  console.error('❌ Check failed:', e);
  process.exit(1);
});
