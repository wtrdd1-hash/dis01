const { computeProgressiveWealthTax, getPolicy } = require('../src/utils/taxEngine');
const { formatMoney } = require('../src/utils/formatters');

console.log('=== 🏛️ 누진적 재산세 시스템 정밀 검증 ===\n');

const testCases = [
  { name: '서민층 (300만원)', cash: 3000000n },
  { name: '1구간 대상 (800만원)', cash: 8000000n },
  { name: '2구간 대상 (2,000만원)', cash: 20000000n },
  { name: '3구간 대상 (8,000만원)', cash: 80000000n },
  { name: '4구간 고자산가 (5억원)', cash: 500000000n },
  { name: '5구간 초고자산가 (20억원)', cash: 2000000000n }
];

console.log('1. 표준 경제 상황 (기본 승수 1.0x) 계산:');
testCases.forEach(tc => {
  const res = computeProgressiveWealthTax(tc.cash, 1.0);
  console.log(`   - [${tc.name}] 자산 ${formatMoney(tc.cash)} -> 연간 세금: ${formatMoney(res.annualTax)} (실효세율: ${res.effectiveRate}%), 10분 주기 분할세액: ${formatMoney(res.periodLevy)}`);
  if (res.breakdown.length > 0) {
    res.breakdown.forEach(b => {
      console.log(`     * ${b.name}: 과세표준 ${formatMoney(b.taxable)} × ${b.ratePercent}% = ${formatMoney(b.tax)}`);
    });
  }
});

console.log('\n2. 인플레이션 과열기 (경제 승수 1.3x 강화) 계산:');
const boomRes = computeProgressiveWealthTax(20000000n, 1.3);
console.log(`   - 2,000만원 유저: 연간 ${formatMoney(boomRes.annualTax)} (실효세율 ${boomRes.effectiveRate}%), 회당 ${formatMoney(boomRes.periodLevy)}`);

console.log('\n3. 디플레이션 불황기 (경제 승수 0.7x 감면) 계산:');
const bustRes = computeProgressiveWealthTax(20000000n, 0.7);
console.log(`   - 2,000만원 유저: 연간 ${formatMoney(bustRes.annualTax)} (실효세율 ${bustRes.effectiveRate}%), 회당 ${formatMoney(bustRes.periodLevy)}`);

console.log('\n=== ✅ 누진 재산세 및 경제 상황 연동 검증 완료! ===');
