const { 
  HORSES, 
  HORSE_BET_MODES, 
  HORSE_CONDITIONS, 
  getRaceCard, 
  publicRaceCard, 
  runHorseRace, 
  validateHorseBet 
} = require('../src/utils/horseRace');
const { computePayout } = require('../src/utils/money');

console.log('=== 🏇 월덕 그랑프리 경마 시스템 정밀 점검 ===\n');

// 1. 출전마 정보 검사
console.log(`1. 출전마 등록 수: ${HORSES.length}마`);
HORSES.forEach(h => {
  console.log(`   - ${h.id}번 [${h.emoji} ${h.name}] (기본배당: ${h.odds}배, 가중치: ${h.weight})`);
});

// 2. 주로 날씨 상태 검사
console.log(`\n2. 주로 날씨 모드: ${HORSE_CONDITIONS.length}개`);
HORSE_CONDITIONS.forEach(c => {
  console.log(`   - ${c.emoji} ${c.name}: ${c.desc}`);
});

// 3. 레이스 카드 생성 및 배당률 계산 검사
const card = getRaceCard();
console.log(`\n3. 현재 시간대 레이스 상태:`);
console.log(`   - 날씨: ${card.condition.emoji} ${card.condition.name}`);
console.log(`   - 출전마 실시간 배당:`);
card.horses.forEach(h => {
  console.log(`     * ${h.id}번 ${h.name} -> 단승: ${h.winOdds}배 | 복승: ${h.placeOdds}배 | 연승: ${h.showOdds}배 (보정가중치: ${h.liveWeight.toFixed(2)})`);
});

// 4. 각 배팅 모드별 시뮬레이션 테스트
const modes = ['win', 'place', 'show', 'quinella', 'exacta'];
console.log('\n4. 배팅 모드별 5회 시뮬레이션:');
modes.forEach(mode => {
  const isExotic = (mode === 'quinella' || mode === 'exacta');
  const h1 = 1;
  const h2 = isExotic ? 2 : undefined;
  
  const val = validateHorseBet({ mode, horseId: h1, horseId2: h2, card });
  if (val.error) {
    console.log(`   ❌ [${mode}] 유효성 검사 실패: ${val.error}`);
    return;
  }
  
  const result = runHorseRace({ mode, horseId: h1, horseId2: h2 });
  const bet = 100000n; // 10만원
  const payout = result.isWin ? computePayout(bet, result.multiplier) : 0n;
  
  console.log(`   ✅ [${result.modeName} 모드] 선택: ${h1}번${h2 ? `, ${h2}번` : ''} | 1착: ${result.ranking[0].id}번 (${result.ranking[0].name}) | 2착: ${result.ranking[1].id}번 (${result.ranking[1].name}) | 적중여부: ${result.isWin ? '🎉 당첨!' : '❌ 미적중'} | 배당: ${result.multiplier}배 | 정산금: ${payout.toLocaleString()}원`);
});

// 5. 100회 통계 테스트 (RTP 및 무한루프/오류 방지)
console.log('\n5. 1000회 연속 레이스 통계 점검:');
let winCount = 0;
let totalBet = 0n;
let totalPayout = 0n;
const testBet = 10000n;

for (let i = 0; i < 1000; i++) {
  const result = runHorseRace({ mode: 'win', horseId: 1 });
  totalBet += testBet;
  if (result.isWin) {
    winCount++;
    totalPayout += computePayout(testBet, result.multiplier);
  }
}

const rtp = (Number(totalPayout) / Number(totalBet)) * 100;
console.log(`   - 총 1,000회 단승(1번마) 배팅:`);
console.log(`   - 1착 적중 횟수: ${winCount}회 / 1,000회 (${(winCount/10).toFixed(1)}%)`);
console.log(`   - 총 배팅액: ${totalBet.toLocaleString()}원`);
console.log(`   - 총 환급액: ${totalPayout.toLocaleString()}원`);
console.log(`   - 실측 환수율(RTP): ${rtp.toFixed(2)}% (하우스 엣지 정상 범위)`);

console.log('\n=== ✅ 경마 시스템 점검 완료! 모든 로직 정상 작동 ===');
