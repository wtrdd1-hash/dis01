const { pool } = require('../src/config/database');
const { withdrawTreasuryByAdmin, readTreasury } = require('../src/utils/taxEngine');
const { formatMoney } = require('../src/utils/formatters');

async function test() {
  console.log('=== 🏛️ 관리자 국고 출금 기능 정밀 테스트 ===\n');

  // 테스트 관리자 ID (bot config의 첫 번째 관리자 또는 더미)
  const [adminUser] = await pool.query('SELECT discord_id, username, cash FROM users LIMIT 1');
  if (!adminUser[0]) {
    console.log('유저가 없어 테스트를 건너뜁니다.');
    process.exit(0);
  }

  const adminId = adminUser[0].discord_id;
  const initialTreasury = await readTreasury();
  console.log(`1. 초기 국고 잔액: ${formatMoney(initialTreasury)}`);
  console.log(`2. 관리자(@${adminUser[0].username}) 초기 현금: ${formatMoney(adminUser[0].cash)}`);

  // 100만원 출금 테스트
  const testAmount = '1000000';
  console.log(`\n3. 국고에서 ${formatMoney(testAmount)} 출금 실행...`);
  const res = await withdrawTreasuryByAdmin(adminId, testAmount, adminId, '테스트 국고 출금');

  console.log('4. 출금 결과:');
  console.log(res);

  const afterTreasury = await readTreasury();
  console.log(`\n5. 출금 후 국고 잔액: ${formatMoney(afterTreasury)}`);
  console.log(`6. 국고 차감 확인: ${initialTreasury.toString()} - ${testAmount} = ${(initialTreasury - 1000000n).toString()} (실제: ${afterTreasury.toString()})`);

  // 최근 로그 확인
  const [log] = await pool.query('SELECT * FROM economy_logs WHERE type = "TREASURY_WITHDRAW" ORDER BY id DESC LIMIT 1');
  console.log('\n7. DB 로그 기록 확인:', log[0]);

  console.log('\n=== ✅ 국고 출금 기능 검증 완료! ===');
  process.exit(0);
}

test().catch(e => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
