'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DAILY, WORK, SUBSIDY, BANK, BUSINESS, CLICKER, TAX } = require('../src/utils/economyBalance');

test('30일 가상 경제 시뮬레이션 및 인플레이션 억제 검증 (100 유저)', async (t) => {
  // 100명의 가상 유저 생성 (다양한 행동 패턴)
  // 30명: 일반 직장인 (출석 + 1일 3회 일하기)
  // 20명: 광부 (출석 + 자동 채굴 Lv 1~10)
  // 20명: 자영업자 (출석 + 사업체 Lv 1~5)
  // 15명: 투자자 (출석 + 은행 예금 위주)
  // 15명: 겜블러 (카지노 베팅, 95% RTP)
  
  const users = [];
  for (let i = 0; i < 100; i++) {
    let role = 'WORKER';
    if (i >= 30 && i < 50) role = 'MINER';
    else if (i >= 50 && i < 70) role = 'BUSINESS';
    else if (i >= 70 && i < 85) role = 'INVESTOR';
    else if (i >= 85) role = 'GAMBLER';

    users.push({
      id: `sim_user_${i}`,
      role,
      cash: 10000n, // 초기 정착금 10,000원
      bank: 0n,
      minerLevel: role === 'MINER' ? (i % 5) + 1 : 0,
      businessIncomePerDay: role === 'BUSINESS' ? 10000n : 0n,
      consecutiveWorkCount: 0
    });
  }

  let casinoReserve = 50000000n;
  let treasury = 20000000n;

  // 30일 시뮬레이션 실행 (Day 1 -> Day 30)
  for (let day = 1; day <= 30; day++) {
    for (const u of users) {
      // 1. 매일 출석체크 (3,000 ~ 5,000원)
      const dailyEarn = BigInt(DAILY.MIN_REWARD + ((day % 10) * 200));
      u.cash += dailyEarn;

      // 2. 저소득 지원금 (순자산 20,000원 이하 시 2,000원)
      const netWorth = u.cash + u.bank;
      if (netWorth <= BigInt(SUBSIDY.MAX_NET_WORTH)) {
        u.cash += BigInt(SUBSIDY.AMOUNT);
      }

      // 3. 역할별 일상 경제 활동
      if (u.role === 'WORKER') {
        // 일하기 3회 (500~1500원)
        for (let w = 0; w < 3; w++) {
          u.cash += 1000n;
        }
      } else if (u.role === 'MINER') {
        // 6시간 채굴 상한 (Lv * 2원/초 * 3600초 * 6시간 = Lv * 43,200원)
        const mined = BigInt(u.minerLevel * 2 * 3600 * 6);
        u.cash += mined / 10n; // 시뮬레이션 스케일
      } else if (u.role === 'BUSINESS') {
        // 사업체 6시간 상한 수금 및 15% 유지보수 비용 적용
        const gross = u.businessIncomePerDay;
        const maintenance = (gross * 15n) / 100n;
        const netBusiness = gross - maintenance;
        u.cash += netBusiness;
        treasury += maintenance; // 국고 귀속
      } else if (u.role === 'INVESTOR') {
        // 현금의 80%를 은행에 예금
        if (u.cash > 20000n) {
          const toDeposit = (u.cash * 8n) / 10n;
          u.cash -= toDeposit;
          u.bank += toDeposit;
        }
      } else if (u.role === 'GAMBLER') {
        // 95% RTP 카지노 베팅
        const bet = u.cash > 5000n ? 3000n : 500n;
        if (u.cash >= bet) {
          u.cash -= bet;
          casinoReserve += bet;
          // 95% 확률적 기대 회수
          const win = (bet * 95n) / 100n;
          if (casinoReserve >= win) {
            u.cash += win;
            casinoReserve -= win;
          }
        }
      }

      // 4. 일일 은행 복리 이자 (하루 0.1%)
      if (u.bank > 0n) {
        const interest = (u.bank * 1n) / 1000n; // 0.1%
        u.bank += interest;
      }

      // 5. 1일 1회 부유세 (1,000만원 초과분에 대해 0.2%)
      const totalWealth = u.cash + u.bank;
      if (totalWealth > TAX.WEALTH_TAX_THRESHOLD) {
        const taxable = totalWealth - TAX.WEALTH_TAX_THRESHOLD;
        const taxAmount = (taxable * 2n) / 1000n;
        if (u.cash >= taxAmount) {
          u.cash -= taxAmount;
        } else {
          u.bank = u.bank >= taxAmount ? u.bank - taxAmount : 0n;
        }
        treasury += taxAmount;
      }
    }
  }

  // 30일 후 거시경제 지표 분석
  const totalM2 = users.reduce((acc, u) => acc + u.cash + u.bank, 0n);
  const avgM2 = totalM2 / BigInt(users.length);

  // 정렬 후 중위 자산 및 상위 1% 분석
  const sortedNetWorths = users.map(u => u.cash + u.bank).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const medianWealth = sortedNetWorths[Math.floor(sortedNetWorths.length / 2)];
  const top1Wealth = sortedNetWorths[sortedNetWorths.length - 1];
  const top1Share = Number((top1Wealth * 100n) / totalM2);

  // 지니계수 계산
  let sumDiff = 0n;
  for (let i = 0; i < sortedNetWorths.length; i++) {
    for (let j = 0; j < sortedNetWorths.length; j++) {
      const diff = sortedNetWorths[i] > sortedNetWorths[j] 
        ? sortedNetWorths[i] - sortedNetWorths[j] 
        : sortedNetWorths[j] - sortedNetWorths[i];
      sumDiff += diff;
    }
  }
  const gini = Number(sumDiff) / (2 * sortedNetWorths.length * Number(totalM2));

  // 검증:
  // 1. M2 총통화량이 30일 후 유저당 평균 500만원 이하로 안정적으로 억제되어야 함 (하이퍼인플레이션 방지)
  assert.ok(avgM2 < 5000000n, `평균 자산(${avgM2}원)이 건전 상한(500만원) 이하로 억제되어야 함`);

  // 2. 카지노 지급 준비금이 건전하게 유지되어야 함 (> 2천만원)
  assert.ok(casinoReserve > 20000000n, `카지노 준비금(${casinoReserve}원)이 건전하게 유지되어야 함`);

  // 3. 상위 1% 독점율이 50% 미만이어야 함
  assert.ok(top1Share < 50, `상위 1% 자산 점유율(${top1Share.toFixed(1)}%)이 50% 미만이어야 함`);

  // 4. 지니계수가 0.65 미만의 건전한 경제를 유지해야 함
  assert.ok(gini < 0.65, `지니계수(${gini.toFixed(3)})가 건전 수준(0.65 미만)이어야 함`);
});
