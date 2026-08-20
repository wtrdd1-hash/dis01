/**
 * 🌐 거시경제 종합 엔진 (Macroeconomic Engine)
 * - 테일러 준칙(Taylor Rule) 기반 중앙은행 기준금리 결정
 * - 소비자 물가지수 (CPI) & 인플레이션율
 * - 4계절 경기 사이클 (회복기 -> 호황기 -> 긴축기 -> 침체기)
 * - 통화량(M2), 외환보유고, 국고 건전성
 */
const { pool } = require('../config/database');
const { safeBigInt } = require('./money');
const { formatMoney } = require('./formatters');

// 거시경제 상수
const MACRO = {
  TARGET_INFLATION: 0.02,     // 연간 목표 인플레이션율 (2.0%)
  NEUTRAL_BASE_RATE: 0.035,    // 중립 기준금리 (연 3.5%)
  BASE_CPI: 100.0,             // 기준 소비자물가지수
  CYCLE_NAMES: [
    { key: 'RECOVERY', name: '🌱 경기 회복기 (Recovery)', desc: '저금리 기조와 유동성 확장을 바탕으로 경제활동이 기지개를 켜고 있습니다.', stockBias: 0.015, bondRate: 0.025 },
    { key: 'BOOM', name: '☀️ 호황 및 성장기 (Expansion/Boom)', desc: '소비와 기업 투자가 활발하며 증시 랠리가 펼쳐지고 있습니다. 물가 상승 압력이 커집니다.', stockBias: 0.030, bondRate: 0.045 },
    { key: 'TIGHTENING', name: '🍂 긴축 및 조정기 (Tightening)', desc: '중앙은행의 고금리 정책으로 시중 유동성이 흡수되며 자산 시장이 숨고르기에 들어갔습니다.', stockBias: -0.020, bondRate: 0.060 },
    { key: 'RECESSION', name: '❄️ 침체 및 불황기 (Recession)', desc: '투자 심리가 위축되고 경기 둔화가 나타나며 중앙은행의 긴급 부양책이 기대되는 구간입니다.', stockBias: -0.025, bondRate: 0.020 }
  ]
};

// 런타임 거시경제 상태 메모리
let macroState = {
  cpi: 102.4,                  // 현재 소비자물가지수
  inflationRate: 0.024,        // 인플레이션율 (2.4%)
  baseInterestRate: 0.035,     // 중앙은행 연간 기준금리 (3.5%)
  cycleIndex: 0,               // 0: 회복, 1: 호황, 2: 긴축, 3: 침체
  moneySupplyM2: '0',          // 시중 총 통화량
  gdpGrowthRate: 0.032,        // 경제 성장률 (3.2%)
  updatedAt: Date.now()
};

/**
 * 📊 실시간 거시경제 지표 계산 및 업데이트
 */
async function updateMacroEconomics() {
  try {
    // 1. 총 통화량(M2: 현금 + 예금) 집계 (주식은 자산이지 통화가 아니므로 제외)
    const [supplyRows] = await pool.query(`
      SELECT 
        COALESCE(SUM(CAST(u.cash AS DECIMAL(65,0))), 0) AS total_cash,
        COALESCE(SUM(CAST(u.bank AS DECIMAL(65,0))), 0) AS total_bank,
        COALESCE(SUM(CAST(ROUND(us.amount * s.price) AS DECIMAL(65,0))), 0) AS total_stock
      FROM users u
      LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
      LEFT JOIN stocks s ON us.stock_id = s.stock_id
    `);

    const cash = safeBigInt(supplyRows[0]?.total_cash);
    const bank = safeBigInt(supplyRows[0]?.total_bank);
    const totalM2 = cash + bank; // M2 = 유동화된 통화만 (주식 제외)
    macroState.moneySupplyM2 = totalM2.toString();

    // 2. 유저 수 및 1인당 자산에 따른 인플레이션율 산출
    const [cntRow] = await pool.query('SELECT COUNT(*) as cnt FROM users');
    const userCount = Math.max(1, cntRow[0]?.cnt || 1);
    const avgWealth = Number(totalM2 / BigInt(userCount));

    // 기준 자산(5만원) 대비 팽창률로 CPI & 인플레이션 계산
    const expansionRatio = avgWealth / 50000;
    const rawInflation = (expansionRatio - 1.0) * 0.02 + 0.02; // 기본 2% ± 팽창
    macroState.inflationRate = Math.max(-0.03, Math.min(0.15, rawInflation)); // -3% ~ 15%
    macroState.cpi = parseFloat((MACRO.BASE_CPI * (1 + macroState.inflationRate)).toFixed(2));

    // 3. 테일러 준칙(Taylor Rule)에 따른 중앙은행 기준금리 산출
    // BaseRate = NeutralRate + 1.5 * (Inflation - TargetInflation) + 0.5 * OutputGap
    const outputGap = (expansionRatio - 1.0) * 0.03;
    const taylorRate = MACRO.NEUTRAL_BASE_RATE + 1.5 * (macroState.inflationRate - MACRO.TARGET_INFLATION) + 0.5 * outputGap;
    macroState.baseInterestRate = Math.max(0.01, Math.min(0.085, taylorRate)); // 1.0% ~ 8.5%
    macroState.gdpGrowthRate = parseFloat(((0.03 + outputGap) * 100).toFixed(2));

    // 4. 거시경제 경기 사이클 판정
    if (macroState.inflationRate > 0.05 && macroState.baseInterestRate > 0.05) {
      macroState.cycleIndex = 2; // 긴축 및 조정기
    } else if (macroState.inflationRate > 0.03) {
      macroState.cycleIndex = 1; // 호황 및 성장기
    } else if (macroState.inflationRate < 0.00) {
      macroState.cycleIndex = 3; // 침체 및 불황기
    } else {
      macroState.cycleIndex = 0; // 경기 회복기
    }

    macroState.updatedAt = Date.now();

    // DB에 거시경제 상태 기록
    try {
      await pool.query(`
        INSERT INTO economy_health_log 
          (total_money, avg_wealth, gini_coefficient, top10_ratio, avg_gamble_profit_rate, health_score, status, actions_taken)
        VALUES (?, ?, '0.35', '0.65', '0.00', 85, ?, ?)
      `, [
        totalM2.toString(),
        String(avgWealth),
        MACRO.CYCLE_NAMES[macroState.cycleIndex].key,
        `[거시경제] 기준금리 ${(macroState.baseInterestRate * 100).toFixed(2)}% | CPI ${macroState.cpi} | 인플레 ${(macroState.inflationRate * 100).toFixed(2)}%`
      ]);
    } catch (e) {}

    return macroState;
  } catch (err) {
    console.error('❌ 거시경제 지표 계산 실패:', err);
    return macroState;
  }
}

/**
 * 🏦 거시경제 종합 브리핑 뷰 반환
 */
function getMacroEconomicView() {
  const curCycle = MACRO.CYCLE_NAMES[macroState.cycleIndex] || MACRO.CYCLE_NAMES[0];
  const annualBaseRatePct = (macroState.baseInterestRate * 100).toFixed(2);
  const inflationPct = (macroState.inflationRate * 100).toFixed(2);

  // 시중 은행 예금/대출 금리 연동 (기준금리 기반)
  const depositRateAnnual = (macroState.baseInterestRate * 1.2 * 100).toFixed(2); // 기준금리 + 우대
  const loanRateAnnual = (macroState.baseInterestRate * 1.8 * 100).toFixed(2);    // 기준금리 + 가산

  // 추천 투자 전략 가이드
  let investmentAdvice = '';
  if (macroState.cycleIndex === 0) {
    investmentAdvice = '🌱 **[회복기 전략]** 저금리 유동성 확장기입니다. 우량 주식 분할 매수 및 사업 투자가 유리합니다.';
  } else if (macroState.cycleIndex === 1) {
    investmentAdvice = '☀️ **[호황기 전략]** 증시 랠리가 활발합니다. 수익률 극대화 후 고점 차익실현 비중을 늘리세요.';
  } else if (macroState.cycleIndex === 2) {
    investmentAdvice = '🍂 **[긴축기 전략]** 고금리 예금 비중을 높여 안정적인 이자 수익을 확보하고 현금을 축적하세요.';
  } else {
    investmentAdvice = '❄️ **[침체기 전략]** 정부 지원금과 저평가된 우량주 저가 매수 기회를 노리세요.';
  }

  return {
    cycle: curCycle,
    cpi: macroState.cpi,
    inflationRate: inflationPct + '%',
    baseInterestRate: annualBaseRatePct + '%',
    depositRateAnnual: depositRateAnnual + '%',
    loanRateAnnual: loanRateAnnual + '%',
    gdpGrowthRate: macroState.gdpGrowthRate + '%',
    moneySupplyM2Text: formatMoney(safeBigInt(macroState.moneySupplyM2)),
    investmentAdvice,
    updatedAt: macroState.updatedAt
  };
}

module.exports = {
  MACRO,
  macroState,
  updateMacroEconomics,
  getMacroEconomicView
};
