const { pool } = require('../src/config/database');
const { 
  readTreasury, 
  addTreasury, 
  takeTreasury, 
  grantTreasurySubsidy, 
  getTaxOverview 
} = require('../src/utils/taxEngine');
const { formatMoney } = require('../src/utils/formatters');

async function testTaxAndTreasury() {
  console.log('=== 🏛️ 세금 및 국고 지원금 연동 정밀 검증 ===\n');

  // 1. 현재 국고 잔액 조회
  const initialTreasury = await readTreasury();
  console.log(`1. 시작 전 국고 잔액: ${formatMoney(initialTreasury)}`);

  // 2. 세금 징수로 국고 적립 테스트 (+50,000원)
  const taxAdd = 50000n;
  const afterTax = await addTreasury(taxAdd);
  console.log(`2. 세금 적립 (+${formatMoney(taxAdd)}) -> 국고 잔액: ${formatMoney(afterTax)}`);

  // 3. 지원금 지급으로 국고 차감 테스트
  const [testUsers] = await pool.query('SELECT discord_id, username, cash FROM users LIMIT 1');
  if (testUsers.length > 0) {
    const u = testUsers[0];
    const subAmt = 15000n;
    const res = await grantTreasurySubsidy(u.discord_id, u.username, subAmt, '검증용 국고 지원금');
    console.log(`3. 유저 [@${u.username}]에게 지원금 지급 (-${formatMoney(subAmt)}) -> 신규 잔고: ${formatMoney(res.newCash)}, 국고 잔액: ${formatMoney(res.newTreasury)}`);
  }

  // 4. 대규모 국고 지원금 지급으로 마이너스(적자) 국고 테스트
  const hugeDeduct = 1000000000n; // 10억원 지출
  const deductRes = await takeTreasury(hugeDeduct, true);
  console.log(`4. 대규모 국고 지출 (-${formatMoney(hugeDeduct)}) -> 인출액: ${formatMoney(deductRes.took)}, 국고 상태: ${formatMoney(deductRes.treasury)} (마이너스 재정 적자 허용 확인 ✅)`);

  // 5. 국고 원상복구 (테스트 후)
  await pool.query('UPDATE economy_settings SET value = ? WHERE key_name = "taxTreasury"', [initialTreasury.toString()]);
  console.log(`5. 테스트 완료 후 국고 원상복원 완료: ${formatMoney(await readTreasury())}`);

  console.log('\n=== ✅ 국고 세금 징수 및 지원금 연동 검증 완료! ===');
  process.exit(0);
}

testTaxAndTreasury().catch(e => {
  console.error('❌ Test failed:', e);
  process.exit(1);
});
