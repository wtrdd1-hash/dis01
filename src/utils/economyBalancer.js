const { pool } = require('../config/database');
const config = require('../config/config');
const { whereNotAdmin, whereIsAdmin } = require('./economyCohort');

// ============================================================
// 🏦 자동 경제 조절 시스템 (Auto Economy Balancer)
// 10분마다 경제 지표를 분석하여 자동으로 조절하고
// 관리자 전원에게 DM으로 리포트 발송
// ============================================================

// 경제 기준선 상수
const { BANK } = require('./economyBalance');

const BASELINE = {
  avgWealth: 50000,          // 1인당 평균 자산 기준 (5만원)
  giniWarning: 0.60,         // 지니계수 경고선
  giniCritical: 0.75,        // 지니계수 위기선
  inflationRatio: 2.0,       // 기준 대비 총통화량 배율 (인플레이션)
  deflationRatio: 0.5,       // 기준 대비 총통화량 배율 (디플레이션)
  gamblingProfitRate: 0.12,  // 도박 평균 수익률 경고선 (12%)
  stockAvgChangeWarn: 0.07,  // 주가 평균 변동률 경고선 (7%)
};

// 조절 강도 레벨 (경제 상황에 따라 동적 결정)
const INTENSITY = {
  MILD:   { label: '약함', rate: 0.10 },   // ±10%
  MEDIUM: { label: '보통', rate: 0.20 },   // ±20%
  STRONG: { label: '강함', rate: 0.30 },   // ±30%
};

// 동적 경제 설정 (런타임에 조절되는 배율)
let dynamicSettings = {
  dailyRewardMultiplier:    1.0,  // 출석 보상 배율
  workRewardMultiplier:     1.0,  // 노동 보상 배율
  subsidyMultiplier:        1.0,  // 지원금 배율
  gamblingPayoutMultiplier: 1.0,  // 도박 수익 배율
  businessRevenueMultiplier: 1.0, // 🏢 사업 매출 동적 배율 (불황 시 축소, 호황 시 확장)
  clickerYieldMultiplier:   1.0,  // ⛏️ 클리커 채굴 배율
  taxRate:                  0.0,
  wealthTaxMultiplier:      1.0,  // 누진 재산세 경제 승수 (호황 1.3x, 불황 0.7x 등)
  bankInterestRate:         BANK.PER_MINUTE_RATE,
  forcedRegimeIndex:        null,
  wealthThresholdForTax:    5000000, // 부자 세금 부과 기준 (500만원)
  subsidyThresholdForBonus: 10000,   // 저소득 추가 지원 기준 (1만원)
  taxPolicyLocked:          false,   // 관리자가 세율·기준을 잠그면 자동 조절이 덮지 않음
};

const BALANCER_CYCLE_MS = 10 * 60 * 1000;
const BALANCER_FIRST_DELAY_MS = 2 * 60 * 1000;
let balancerStartedAt = 0;
let lastCycleAt = 0;

// 마지막 분석 리포트
let lastReport = null;

// stockEngine의 국면 강제 변경 함수 연결
let setRegimeFn = null;
function linkStockEngine(fn) {
  setRegimeFn = fn;
}

// ──────────────────────────────────────────
// 📊 경제 지표 수집 함수
// ──────────────────────────────────────────
async function collectCohortSnapshot(filter) {
  const [users] = await pool.query(`
    SELECT u.discord_id, u.username,
           (CAST(u.cash AS DECIMAL(65,0)) + CAST(u.bank AS DECIMAL(65,0)) + CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0))) AS net_worth
    FROM users u
    LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
    LEFT JOIN stocks s ON us.stock_id = s.stock_id
    WHERE ${filter.sql}
    GROUP BY u.discord_id, u.username, u.cash, u.bank
    HAVING net_worth > 0
    ORDER BY net_worth ASC
  `, filter.params);

  if (users.length === 0) {
    return {
      userCount: 0,
      totalMoney: 0,
      avgWealth: 0,
      wealthRatio: '0.00',
      giniCoeff: '0.0000',
      top10Ratio: '0.0'
    };
  }

  const worthsBig = users.map((u) => {
    try { return BigInt(String(u.net_worth || 0).split('.')[0]); } catch (e) { return 0n; }
  });
  const totalMoneyBig = worthsBig.reduce((a, b) => a + b, 0n);
  const avgWealthBig = users.length ? totalMoneyBig / BigInt(users.length) : 0n;
  const worths = worthsBig.map((w) => {
    const n = Number(w);
    return Number.isFinite(n) ? n : 0;
  });
  const totalMoney = Number(totalMoneyBig);
  const avgWealth = Number(avgWealthBig);
  let gini = 0;
  const n = worths.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      gini += Math.abs(worths[i] - worths[j]);
    }
  }
  const giniCoeff = n > 1 && avgWealth > 0 ? gini / (2 * n * n * avgWealth) : 0;
  const top10Count = Math.max(1, Math.floor(n * 0.1));
  const top10Sum = worths.slice(-top10Count).reduce((a, b) => a + b, 0);
  const top10Ratio = totalMoney > 0 ? top10Sum / totalMoney : 0;
  return {
    userCount: users.length,
    totalMoney: totalMoneyBig.toString(),
    avgWealth,
    wealthRatio: (avgWealth / BASELINE.avgWealth).toFixed(2),
    giniCoeff: giniCoeff.toFixed(4),
    top10Ratio: (top10Ratio * 100).toFixed(1)
  };
}

async function analyzeEconomyHealth() {
  const userSnap = await collectCohortSnapshot(whereNotAdmin('u.discord_id'));
  const adminSnap = await collectCohortSnapshot(whereIsAdmin('u.discord_id'));

  if (userSnap.userCount === 0) {
    return {
      healthy: true,
      status: 'NO_USERS',
      score: 100,
      indicators: Object.assign({ gamblingProfitRate: '0.00', avgStockChange: '0.00' }, userSnap),
      adminIndicators: adminSnap,
      issues: []
    };
  }

  const totalMoney = userSnap.totalMoney;
  const avgWealth = userSnap.avgWealth;
  const giniCoeff = Number(userSnap.giniCoeff);

  // 최근 1시간 도박 수익률 (일반 유저만)
  let gamblingProfitRate = 0;
  try {
    const gambleFilter = whereNotAdmin('user_id');
    const [gambleLogs] = await pool.query(`
      SELECT SUM(profit) as total_profit, SUM(bet) as total_bet
      FROM gambling_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
        AND is_rolled_back = 0
        AND ${gambleFilter.sql}
    `, gambleFilter.params);
    const gRow = gambleLogs[0];
    if (gRow && gRow.total_bet && Number(gRow.total_bet) > 0) {
      gamblingProfitRate = Number(gRow.total_profit) / Number(gRow.total_bet);
    }
  } catch (e) {}

  // 최근 10회 주가 평균 변동률
  let avgStockChange = 0;
  try {
    const [stockLogs] = await pool.query(`
      SELECT AVG(ABS(change_rate)) as avg_change
      FROM stock_price_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
    `);
    avgStockChange = Number(stockLogs[0]?.avg_change || 0);
  } catch (e) {}

  // ──── 건강 점수 계산 (100점 만점) ────
  let score = 100;
  const warnings = [];
  const issues = [];

  const wealthRatio = avgWealth / BASELINE.avgWealth;

  if (wealthRatio > BASELINE.inflationRatio) {
    const severity = wealthRatio > 3.0 ? 'CRITICAL' : 'WARNING';
    const pts = severity === 'CRITICAL' ? 35 : 20;
    score -= pts;
    issues.push({ type: 'INFLATION', severity, wealthRatio: wealthRatio.toFixed(2) });
  } else if (wealthRatio < BASELINE.deflationRatio) {
    const severity = wealthRatio < 0.25 ? 'CRITICAL' : 'WARNING';
    const pts = severity === 'CRITICAL' ? 30 : 15;
    score -= pts;
    issues.push({ type: 'DEFLATION', severity, wealthRatio: wealthRatio.toFixed(2) });
  }

  if (giniCoeff > BASELINE.giniCritical) {
    score -= 25;
    issues.push({ type: 'INEQUALITY', severity: 'CRITICAL', gini: giniCoeff.toFixed(4) });
  } else if (giniCoeff > BASELINE.giniWarning) {
    score -= 12;
    issues.push({ type: 'INEQUALITY', severity: 'WARNING', gini: giniCoeff.toFixed(4) });
  }

  if (gamblingProfitRate > BASELINE.gamblingProfitRate) {
    score -= 15;
    issues.push({ type: 'GAMBLING_OVERPAY', severity: 'WARNING', rate: (gamblingProfitRate * 100).toFixed(2) });
  }

  if (avgStockChange > BASELINE.stockAvgChangeWarn * 100) {
    score -= 10;
    issues.push({ type: 'STOCK_VOLATILE', severity: 'WARNING', avgChange: avgStockChange.toFixed(2) });
  }

  score = Math.max(0, Math.min(100, score));

  let status;
  if (score >= 80) status = 'HEALTHY';
  else if (score >= 60) status = 'STABLE';
  else if (score >= 40) status = 'CAUTION';
  else if (score >= 20) status = 'DANGER';
  else status = 'CRITICAL';

  return {
    status,
    score,
    healthy: score >= 60,
    indicators: {
      totalMoney,
      avgWealth,
      wealthRatio: wealthRatio.toFixed(2),
      giniCoeff: giniCoeff.toFixed(4),
      top10Ratio: userSnap.top10Ratio,
      gamblingProfitRate: (gamblingProfitRate * 100).toFixed(2),
      avgStockChange: avgStockChange.toFixed(2),
      userCount: userSnap.userCount
    },
    adminIndicators: adminSnap,
    issues
  };
}

// ──────────────────────────────────────────
// ⚙️ 자동 조절 적용 함수
// ──────────────────────────────────────────
function getIntensity(issueSeverity, wealthRatio) {
  if (issueSeverity === 'CRITICAL') {
    return Math.abs(wealthRatio - 1) > 2.0 ? INTENSITY.STRONG : INTENSITY.MEDIUM;
  }
  return INTENSITY.MILD;
}

async function applyAutoBalancing(report) {
  if (!report) {
    report = await analyzeEconomyHealth();
  }
  const actions = [];
  const { issues, indicators } = report;

  // 🔌 관리자 수동 컨트롤: autoMode='manual' 또는 'paused'면 자동 결정 무효화
  let __manualState = null;
  try {
    const ec = require('./economyControls');
    await ec.loadManualState();
    __manualState = ec.getManualState();
  } catch (e) {}
  const adminManualMode = __manualState && (__manualState.autoMode === 'manual' || __manualState.autoMode === 'paused');
  if (adminManualMode) {
    actions.push(`🛑 관리자 수동모드(${__manualState.autoMode}) 유지 — 자동 결정 무효화, 현재 설정값 지속`);
    if (__manualState.autoMode === 'paused') {
      // paused: 현재 dyn 그대로 두고 종료
      return actions;
    }
    // manual: 다음 사이클에서도 자동 적용하지 않음을 알리고 일단 기본값만 리턴
    return actions;
  }

  // 설정 초기화 (매 사이클마다 누적 방지)
  let newSettings = {
    dailyRewardMultiplier:    1.0,
    workRewardMultiplier:     1.0,
    subsidyMultiplier:        1.0,
    gamblingPayoutMultiplier: 1.0,
    businessRevenueMultiplier: 1.0,
    clickerYieldMultiplier:   1.0,
    taxRate:                  0.0,
    wealthTaxMultiplier:      1.0,
    bankInterestRate:         BANK.PER_MINUTE_RATE,
    forcedRegimeIndex:        null,
    wealthThresholdForTax:    5000000,
    subsidyThresholdForBonus: 10000,
  };

  for (const issue of issues) {
    const intensity = issue.severity === 'CRITICAL' ? INTENSITY.STRONG :
                      issue.severity === 'WARNING'  ? INTENSITY.MEDIUM : INTENSITY.MILD;
    const r = intensity.rate;

    if (issue.type === 'INFLATION') {
      // 인플레이션: 보상 및 사업 매출 긴축, 부유세 강화, 시중 유동성 흡수 고금리
      newSettings.dailyRewardMultiplier    = Math.max(0.5, 1.0 - r);
      newSettings.workRewardMultiplier     = Math.max(0.5, 1.0 - r);
      newSettings.subsidyMultiplier        = Math.max(0.5, 1.0 - r * 0.5);
      newSettings.gamblingPayoutMultiplier = Math.max(0.6, 1.0 - r);
      newSettings.businessRevenueMultiplier = Math.max(0.65, 1.0 - r * 1.2); // 🏢 과열기 사업 매출 긴축
      newSettings.clickerYieldMultiplier   = Math.max(0.7, 1.0 - r);
      newSettings.taxRate                  = Math.min(0.15, r * 0.5);
      newSettings.wealthTaxMultiplier      = Math.min(2.5, 1.0 + r * 1.5); // 🏛️ 과열기 누진 부유세 강화
      newSettings.bankInterestRate         = Math.min(BANK.PER_MINUTE_RATE * 2, BANK.PER_MINUTE_RATE * (1 + r));
      newSettings.forcedRegimeIndex        = 1; // 📉 가상 시장 조정기
      actions.push(`📉 **인플레이션** (${intensity.label}) → 사업매출 -${Math.round(r*120)}%, 부유세율 ×${newSettings.wealthTaxMultiplier.toFixed(1)}, 예금금리 인상, 시장: 📉 조정기`);

    } else if (issue.type === 'DEFLATION') {
      // 디플레이션: 보상 및 사업 매출 부양, 저소득 생계지원 대폭 확대, 세금 감면
      newSettings.dailyRewardMultiplier    = Math.min(2.0, 1.0 + r);
      newSettings.workRewardMultiplier     = Math.min(2.0, 1.0 + r);
      newSettings.subsidyMultiplier        = Math.min(2.5, 1.0 + r * 1.5);
      newSettings.gamblingPayoutMultiplier = Math.min(1.5, 1.0 + r * 0.5);
      newSettings.businessRevenueMultiplier = Math.min(1.4, 1.0 + r * 1.0); // 🏢 침체기 사업 매출 부양
      newSettings.clickerYieldMultiplier   = Math.min(1.5, 1.0 + r * 0.8);
      newSettings.taxRate                  = 0.0;
      newSettings.wealthTaxMultiplier      = Math.max(0.5, 1.0 - r); // 🏛️ 불황기 부유세 감면
      newSettings.bankInterestRate         = Math.min(BANK.PER_MINUTE_RATE * 2.5, BANK.PER_MINUTE_RATE * (1 + r * 1.5));
      newSettings.forcedRegimeIndex        = 7; // 🏦 중앙은행 유동성 완화 (LIQUIDITY)
      newSettings.subsidyThresholdForBonus = 50000;
      actions.push(`🚀 **디플레이션** (${intensity.label}) → 사업매출 +${Math.round(r*100)}%, 서민지원금 +${Math.round(r*150)}%, 시장: 🏦 부양기`);

    } else if (issue.type === 'INEQUALITY') {
      // 빈부격차: 초고자산가 부유세 및 사업 소득세 대폭 강화, 저소득층 복지 지원
      newSettings.taxRate                  = Math.min(0.12, r * 0.5);
      newSettings.wealthTaxMultiplier      = Math.min(3.0, 1.0 + r * 2.0); // 🏛️ 양극화 심화 시 부유세 최대 3배까지 강화
      newSettings.wealthThresholdForTax    = issue.severity === 'CRITICAL' ? 3000000 : 5000000;
      newSettings.subsidyThresholdForBonus = 30000;
      newSettings.subsidyMultiplier        = Math.min(2.0, 1.0 + r * 1.2);
      actions.push(`⚖️ **빈부격차 심화** (${intensity.label}) → 초고자산가 누진세율 ×${newSettings.wealthTaxMultiplier.toFixed(1)} 대폭 상향, 저소득층 기본소득 지원 강화`);

    } else if (issue.type === 'GAMBLING_OVERPAY') {
      // 도박 수익 과다
      const decrease = Math.min(0.25, r);
      newSettings.gamblingPayoutMultiplier = Math.max(0.7, 1.0 - decrease);
      actions.push(`🎰 **도박 수익 과다** (${intensity.label}) → 도박 배율 -${Math.round(decrease*100)}%`);

    } else if (issue.type === 'STOCK_VOLATILE') {
      // 주식 시장 과열
      if (!newSettings.forcedRegimeIndex) {
        newSettings.forcedRegimeIndex = 2; // ⚖️ 안정적 박스권 횡보
      }
      actions.push(`📊 **주식 과열** (${intensity.label}) → 시장: ⚖️ 박스권 횡보 전환`);
    }
  }

  if (dynamicSettings.taxPolicyLocked) {
    newSettings.taxRate = dynamicSettings.taxRate;
    newSettings.wealthThresholdForTax = dynamicSettings.wealthThresholdForTax;
    newSettings.taxPolicyLocked = true;
    actions.push('🔒 세금 정책 잠금 유지 — 세율·기준은 관리자 설정');
  } else {
    newSettings.taxPolicyLocked = false;
  }

  // 설정 적용
  dynamicSettings = newSettings;

  // DB에 현재 설정 저장
  try {
    await pool.query(`
      INSERT INTO economy_settings (key_name, value) VALUES
        ('dailyRewardMultiplier',    ?),
        ('workRewardMultiplier',     ?),
        ('subsidyMultiplier',        ?),
        ('gamblingPayoutMultiplier', ?),
        ('taxRate',                  ?),
        ('bankInterestRate',         ?),
        ('forcedRegimeIndex',        ?),
        ('wealthThresholdForTax',    ?),
        ('subsidyThresholdForBonus', ?),
        ('taxPolicyLocked',          ?)
      ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()
    `, [
      String(newSettings.dailyRewardMultiplier),
      String(newSettings.workRewardMultiplier),
      String(newSettings.subsidyMultiplier),
      String(newSettings.gamblingPayoutMultiplier),
      String(newSettings.taxRate),
      String(newSettings.bankInterestRate),
      newSettings.forcedRegimeIndex !== null ? String(newSettings.forcedRegimeIndex) : 'null',
      String(newSettings.wealthThresholdForTax),
      String(newSettings.subsidyThresholdForBonus),
      newSettings.taxPolicyLocked ? '1' : '0',
    ]);
  } catch (e) {}

  // 주식 국면 강제 변경
  if (setRegimeFn && newSettings.forcedRegimeIndex !== null) {
    setRegimeFn(newSettings.forcedRegimeIndex);
  }

  // economy_health_log 저장
  try {
    await pool.query(`
      INSERT INTO economy_health_log
        (total_money, avg_wealth, gini_coefficient, top10_ratio, avg_gamble_profit_rate, health_score, status, actions_taken)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      String(indicators.totalMoney),
      String(indicators.avgWealth),
      indicators.giniCoeff,
      (Number(indicators.top10Ratio) / 100).toFixed(4),
      (Number(indicators.gamblingProfitRate) / 100).toFixed(4),
      report.score,
      report.status,
      actions.length > 0 ? actions.join(' | ') : '없음 (정상)',
    ]);
  } catch (e) {}

  return actions;
}

// ──────────────────────────────────────────
// 📩 관리자 DM 발송 함수
// ──────────────────────────────────────────
async function sendAdminReport(client, report, actions) {
  const { indicators: ind, score, status, issues } = report;

  const statusEmoji = {
    HEALTHY:  '✅',
    STABLE:   '🟢',
    CAUTION:  '🟡',
    DANGER:   '🔴',
    CRITICAL: '🚨',
  }[status] || '❓';

  const scoreBar = '█'.repeat(Math.round(score / 10)) + '░'.repeat(10 - Math.round(score / 10));

  let issueText = issues.length > 0
    ? issues.map(i => {
        const sev = i.severity === 'CRITICAL' ? '🚨' : '⚠️';
        if (i.type === 'INFLATION')      return `${sev} 인플레이션 (자산비율 ${i.wealthRatio}x)`;
        if (i.type === 'DEFLATION')      return `${sev} 디플레이션 (자산비율 ${i.wealthRatio}x)`;
        if (i.type === 'INEQUALITY')     return `${sev} 빈부격차 (지니계수 ${i.gini})`;
        if (i.type === 'GAMBLING_OVERPAY') return `${sev} 도박 수익 과다 (${i.rate}%)`;
        if (i.type === 'STOCK_VOLATILE') return `${sev} 주식 시장 과열 (평균변동 ${i.avgChange}%)`;
        return `${sev} ${i.type}`;
      }).join('\n')
    : '✅ 이상 없음';

  let actionText = actions.length > 0
    ? actions.join('\n')
    : '⏸ 조치 없음 (경제 정상)';

  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  const embed = {
    color: score >= 80 ? 0x00cc66 : score >= 60 ? 0xffcc00 : score >= 40 ? 0xff6600 : 0xff0000,
    title: `${statusEmoji} 자동 경제 조절 리포트`,
    description: `**${now}** 기준 경제 현황 분석 결과입니다.`,
    fields: [
      {
        name: '📊 경제 건강 점수',
        value: `\`[${scoreBar}]\` **${score}점** / 100점\n상태: **${status}**`,
        inline: false,
      },
      {
        name: '💰 일반 유저 경제 (조절 기준)',
        value: [
          `총 통화량: **${Number(ind.totalMoney).toLocaleString()}원**`,
          `1인 평균 자산: **${Number(ind.avgWealth).toLocaleString()}원** (기준 대비 **${ind.wealthRatio}x**)`,
          `지니계수: **${ind.giniCoeff}** (0=완전평등, 1=완전불평등)`,
          `상위 10% 자산 점유율: **${ind.top10Ratio}%**`,
          `도박 평균 수익률: **${ind.gamblingProfitRate}%**`,
          `주가 평균 변동률: **${ind.avgStockChange}%**`,
          `분석 유저 수: **${ind.userCount}명**`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '👑 관리자 계정 (참고, 조절 미반영)',
        value: (() => {
          const adm = report.adminIndicators || {};
          return [
            `총 자산: **${Number(adm.totalMoney || 0).toLocaleString()}원**`,
            `1인 평균: **${Number(adm.avgWealth || 0).toLocaleString()}원**`,
            `계정 수: **${adm.userCount || 0}명**`,
          ].join('\n');
        })(),
        inline: false,
      },
      {
        name: '⚠️ 감지된 이슈',
        value: issueText,
        inline: false,
      },
      {
        name: '🔧 자동 조치 완료',
        value: actionText,
        inline: false,
      },
      {
        name: '⚙️ 현재 적용 중인 배율',
        value: [
          `출석 보상: **×${dynamicSettings.dailyRewardMultiplier.toFixed(2)}**`,
          `노동 보상: **×${dynamicSettings.workRewardMultiplier.toFixed(2)}**`,
          `지원금: **×${dynamicSettings.subsidyMultiplier.toFixed(2)}**`,
          `도박 배율: **×${dynamicSettings.gamblingPayoutMultiplier.toFixed(2)}**`,
          `거래세율: **${(dynamicSettings.taxRate * 100).toFixed(1)}%**`,
          `자산세 기준(현금+예금): **${Number(dynamicSettings.wealthThresholdForTax).toLocaleString()}원**`,
        ].join('\n'),
        inline: false,
      },
    ],
    footer: { text: '자동 경제 조절 • 일반 유저 지표만 반영 • 10분마다 분석' },
    timestamp: new Date().toISOString(),
  };

  for (const adminId of config.adminIds) {
    try {
      const adminUser = await client.users.fetch(adminId);
      await adminUser.send({ embeds: [embed] });
    } catch (e) {
      console.warn(`⚠️ [경제조절] 관리자 DM 발송 실패 (${adminId}):`, e.message);
    }
  }
}

// ──────────────────────────────────────────
// 🔄 메인 실행 루프
// ──────────────────────────────────────────
async function runBalancerCycle(client) {
  try {
    lastCycleAt = Date.now();
    console.log('📊 [자동 경제 조절] 경제 지표 분석 시작...');
    const report = await analyzeEconomyHealth();
    lastReport = report;

    const actions = await applyAutoBalancing(report);
    try {
      const tax = require('./taxEngine');
      const levy = await tax.collectWealthTax();
      if (levy && levy.count > 0) {
        actions.push(`🏛️ **고자산 회수** → ${levy.count}명, ${levy.collected.toLocaleString('ko-KR')}원 국고 흡수`);
      }
    } catch (e) {}

    // 이상 감지 시 또는 1시간마다 관리자 DM 발송
    const now = Date.now();
    const shouldNotify = actions.length > 0 || (now % (60 * 60 * 1000) < 10 * 60 * 1000);
    if (shouldNotify && client) {
      await sendAdminReport(client, report, actions);
    }

    const logMsg = actions.length > 0
      ? `⚠️ [자동 경제 조절] 점수: ${report.score} (${report.status}) → 조치: ${actions.join(' | ')}`
      : `✅ [자동 경제 조절] 점수: ${report.score} (${report.status}) → 정상`;
    console.log(logMsg);
  } catch (err) {
    console.error('❌ [자동 경제 조절] 사이클 오류:', err);
  }
}

// ──────────────────────────────────────────
// 🚀 시작 함수 (ready.js에서 호출)
// ──────────────────────────────────────────
async function loadDynamicSettingsFromDb() {
  try {
    const [rows] = await pool.query('SELECT key_name, value FROM economy_settings');
    if (!rows.length) return dynamicSettings;
    const map = {};
    for (const row of rows) map[row.key_name] = row.value;
    const num = (key, fallback) => {
      const n = Number(map[key]);
      return Number.isFinite(n) ? n : fallback;
    };
    dynamicSettings.dailyRewardMultiplier = num('dailyRewardMultiplier', dynamicSettings.dailyRewardMultiplier);
    dynamicSettings.workRewardMultiplier = num('workRewardMultiplier', dynamicSettings.workRewardMultiplier);
    dynamicSettings.subsidyMultiplier = num('subsidyMultiplier', dynamicSettings.subsidyMultiplier);
    dynamicSettings.gamblingPayoutMultiplier = num('gamblingPayoutMultiplier', dynamicSettings.gamblingPayoutMultiplier);
    dynamicSettings.taxRate = Math.max(0, Math.min(0.15, num('taxRate', dynamicSettings.taxRate)));
    dynamicSettings.bankInterestRate = num('bankInterestRate', dynamicSettings.bankInterestRate);
    if (map.wealthThresholdForTax != null && String(map.wealthThresholdForTax).trim() !== '') {
      const raw = String(map.wealthThresholdForTax).trim();
      if (/^\d+$/.test(raw.replace(/,/g, ''))) {
        dynamicSettings.wealthThresholdForTax = raw.replace(/,/g, '');
      } else {
        try {
          const { parseMoneyInput } = require('./moneyScale');
          const parsed = parseMoneyInput(raw);
          dynamicSettings.wealthThresholdForTax = typeof parsed === 'bigint' ? parsed.toString() : raw;
        } catch (e) {
          dynamicSettings.wealthThresholdForTax = raw;
        }
      }
    }
    dynamicSettings.subsidyThresholdForBonus = num('subsidyThresholdForBonus', dynamicSettings.subsidyThresholdForBonus);
    dynamicSettings.taxPolicyLocked = map.taxPolicyLocked === '1' || map.taxPolicyLocked === 'true';
    if (map.forcedRegimeIndex && map.forcedRegimeIndex !== 'null') {
      const idx = parseInt(map.forcedRegimeIndex, 10);
      dynamicSettings.forcedRegimeIndex = Number.isInteger(idx) ? idx : null;
    }
  } catch (e) {}
  return dynamicSettings;
}

function startAutoBalancer(client, stockEngineFn) {
  if (stockEngineFn) setRegimeFn = stockEngineFn;
  console.log('🏦 [자동 경제 조절 시스템] 가동 시작 (10분 주기 분석)');
  balancerStartedAt = Date.now();
  lastCycleAt = 0;
  loadDynamicSettingsFromDb().catch(() => {});

  setTimeout(() => runBalancerCycle(client), BALANCER_FIRST_DELAY_MS);
  setInterval(() => runBalancerCycle(client), BALANCER_CYCLE_MS);
}

async function persistSetting(key, value) {
  await pool.query(
    `INSERT INTO economy_settings (key_name, value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()`,
    [key, String(value)]
  );
}

async function setTaxPolicyOverride({ rate, threshold, multiplier, locked } = {}) {
  if (rate !== undefined && rate !== null && String(rate).trim() !== '') {
    const n = Number(rate);
    if (!Number.isFinite(n) || n < 0 || n > 0.30) {
      const err = new Error('세율은 0~30% 사이여야 합니다.');
      err.code = 'BAD_RATE';
      throw err;
    }
    dynamicSettings.taxRate = Math.max(0, Math.min(0.30, n));
    await persistSetting('taxRate', dynamicSettings.taxRate);
  }
  if (multiplier !== undefined && multiplier !== null && String(multiplier).trim() !== '') {
    const m = Number(multiplier);
    if (!Number.isFinite(m) || m < 0.1 || m > 5.0) {
      const err = new Error('세금 승수는 0.1x ~ 5.0x 사이여야 합니다.');
      err.code = 'BAD_MULTIPLIER';
      throw err;
    }
    dynamicSettings.wealthTaxMultiplier = m;
    await persistSetting('wealthTaxMultiplier', dynamicSettings.wealthTaxMultiplier);
  }
  if (threshold !== undefined && threshold !== null && String(threshold).trim() !== '') {
    const { parseMoneyInput } = require('./moneyScale');
    let parsed = null;
    try {
      parsed = parseMoneyInput(String(threshold));
    } catch (e) {
      if (e && e.code === 'MONEY_OVERFLOW') throw e;
    }
    if (parsed === null || typeof parsed !== 'bigint' || parsed < 0n) {
      const err = new Error('자산세 기준은 0원 이상이어야 합니다. 예: 500만, 1양');
      err.code = 'BAD_THRESHOLD';
      throw err;
    }
    dynamicSettings.wealthThresholdForTax = parsed.toString();
    await persistSetting('wealthThresholdForTax', dynamicSettings.wealthThresholdForTax);
  }
  if (locked !== undefined) {
    dynamicSettings.taxPolicyLocked = !!locked;
    await persistSetting('taxPolicyLocked', dynamicSettings.taxPolicyLocked ? '1' : '0');
  }
  return getDynamicSettings();
}

function getBalancerSchedule() {
  const now = Date.now();
  let nextAt;
  if (!lastCycleAt) {
    nextAt = (balancerStartedAt || now) + BALANCER_FIRST_DELAY_MS;
    if (nextAt < now) nextAt = now + 5000;
  } else {
    nextAt = lastCycleAt + BALANCER_CYCLE_MS;
    if (nextAt < now) nextAt = now + BALANCER_CYCLE_MS;
  }
  return {
    lastCycleAt,
    nextCycleAt: nextAt,
    intervalMs: BALANCER_CYCLE_MS,
    locked: !!dynamicSettings.taxPolicyLocked
  };
}

// ──────────────────────────────────────────
// 📤 외부 게이터 (서버 API, 명령어에서 사용)
// ──────────────────────────────────────────
function getDynamicSettings() {
  return { ...dynamicSettings };
}

function getLastReport() {
  return lastReport;
}

module.exports = {
  startAutoBalancer,
  linkStockEngine,
  getDynamicSettings,
  getLastReport,
  analyzeEconomyHealth,
  applyAutoBalancing,
  loadDynamicSettingsFromDb,
  setTaxPolicyOverride,
  getBalancerSchedule
};
