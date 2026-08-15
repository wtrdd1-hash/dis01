const { pool } = require('../config/database');
const config = require('../config/config');

// ============================================================
// 🏦 자동 경제 조절 시스템 (Auto Economy Balancer)
// 10분마다 경제 지표를 분석하여 자동으로 조절하고
// 관리자 전원에게 DM으로 리포트 발송
// ============================================================

// 경제 기준선 상수
const BASELINE = {
  avgWealth: 100000,         // 1인당 평균 자산 기준 (10만원)
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
  dailyRewardMultiplier:   1.0,  // 출석 보상 배율
  workRewardMultiplier:    1.0,  // 노동 보상 배율
  subsidyMultiplier:       1.0,  // 지원금 배율
  gamblingPayoutMultiplier: 1.0, // 도박 수익 배율
  taxRate:                 0.0,  // 거래세율
  forcedRegimeIndex:       null, // 강제 시장 국면 (null이면 자동)
  wealthThresholdForTax: 5000000, // 부자 세금 부과 기준 (500만원)
  subsidyThresholdForBonus: 10000, // 저소득 추가 지원 기준 (1만원)
};

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
async function analyzeEconomyHealth() {
  const [users] = await pool.query(`
    SELECT u.discord_id, u.username,
           (u.cash + u.bank + COALESCE(SUM(us.amount * s.price), 0)) AS net_worth
    FROM users u
    LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
    LEFT JOIN stocks s ON us.stock_id = s.stock_id
    GROUP BY u.discord_id, u.username, u.cash, u.bank
    HAVING net_worth > 0
    ORDER BY net_worth ASC
  `);

  if (users.length === 0) {
    return { healthy: true, status: 'NO_USERS', score: 100, indicators: {} };
  }

  const worths = users.map(u => Number(BigInt(Math.round(Number(u.net_worth)))));
  const totalMoney = worths.reduce((a, b) => a + b, 0);
  const avgWealth = Math.round(totalMoney / users.length);

  // 지니계수 계산
  let gini = 0;
  const n = worths.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      gini += Math.abs(worths[i] - worths[j]);
    }
  }
  const giniCoeff = n > 1 ? gini / (2 * n * n * avgWealth) : 0;

  // 상위 10% 자산 비율
  const top10Count = Math.max(1, Math.floor(n * 0.1));
  const top10Sum = worths.slice(-top10Count).reduce((a, b) => a + b, 0);
  const top10Ratio = totalMoney > 0 ? top10Sum / totalMoney : 0;

  // 최근 1시간 도박 수익률
  let gamblingProfitRate = 0;
  try {
    const [gambleLogs] = await pool.query(`
      SELECT SUM(profit) as total_profit, SUM(bet) as total_bet
      FROM gambling_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
        AND is_rolled_back = 0
    `);
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
      top10Ratio: (top10Ratio * 100).toFixed(1),
      gamblingProfitRate: (gamblingProfitRate * 100).toFixed(2),
      avgStockChange: avgStockChange.toFixed(2),
      userCount: users.length,
    },
    issues,
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
  const actions = [];
  const { issues, indicators } = report;

  // 설정 초기화 (매 사이클마다 누적 방지)
  let newSettings = {
    dailyRewardMultiplier:    1.0,
    workRewardMultiplier:     1.0,
    subsidyMultiplier:        1.0,
    gamblingPayoutMultiplier: 1.0,
    taxRate:                  0.0,
    bankInterestRate:         0.0001, // 기본 1분당 0.01% (시간당 0.6% 복리 수준)
    forcedRegimeIndex:        null,
    wealthThresholdForTax:    5000000,
    subsidyThresholdForBonus: 10000,
  };

  for (const issue of issues) {
    const intensity = issue.severity === 'CRITICAL' ? INTENSITY.STRONG :
                      issue.severity === 'WARNING'  ? INTENSITY.MEDIUM : INTENSITY.MILD;
    const r = intensity.rate;

    if (issue.type === 'INFLATION') {
      // 인플레이션: 보상 감소, 세금 증가, 시장 조정기 전환, 시중 유동성 흡수를 위한 고금리 예금 유도
      newSettings.dailyRewardMultiplier    = Math.max(0.5, 1.0 - r);
      newSettings.workRewardMultiplier     = Math.max(0.5, 1.0 - r);
      newSettings.subsidyMultiplier        = Math.max(0.5, 1.0 - r * 0.5);
      newSettings.gamblingPayoutMultiplier = Math.max(0.6, 1.0 - r);
      newSettings.taxRate                  = Math.min(0.15, r * 0.5);
      newSettings.bankInterestRate         = Math.min(0.0003, 0.0001 * (1 + r)); // 긴축 금리 인상
      newSettings.forcedRegimeIndex        = 1; // 📉 가상 시장 조정기
      actions.push(`📉 **인플레이션** (${intensity.label}) → 보상 -${Math.round(r*100)}%, 세금 +${Math.round(r*50)}%, 예금금리 인상, 시장: 📉 조정기 전환`);

    } else if (issue.type === 'DEFLATION') {
      // 디플레이션: 보상 증가, 부양기 전환, 예금 특별 우대금리
      newSettings.dailyRewardMultiplier    = Math.min(2.0, 1.0 + r);
      newSettings.workRewardMultiplier     = Math.min(2.0, 1.0 + r);
      newSettings.subsidyMultiplier        = Math.min(2.5, 1.0 + r * 1.5);
      newSettings.gamblingPayoutMultiplier = Math.min(1.5, 1.0 + r * 0.5);
      newSettings.taxRate                  = 0.0;
      newSettings.bankInterestRate         = Math.min(0.0004, 0.0001 * (1 + r * 1.5)); // 부양 우대금리
      newSettings.forcedRegimeIndex        = 5; // 🏦 중앙은행 유동성 무제한 살포
      newSettings.subsidyThresholdForBonus = 50000;
      actions.push(`🚀 **디플레이션** (${intensity.label}) → 보상 +${Math.round(r*100)}%, 지원금 +${Math.round(r*150)}%, 우대금리 적용, 시장: 🏦 부양기 전환`);

    } else if (issue.type === 'INEQUALITY') {
      // 빈부격차: 고자산 세금 증가, 저소득 지원 강화
      newSettings.taxRate               = Math.min(0.10, r * 0.4);
      newSettings.wealthThresholdForTax = issue.severity === 'CRITICAL' ? 1000000 : 3000000;
      newSettings.subsidyThresholdForBonus = 30000;
      actions.push(`⚖️ **빈부격차** (${intensity.label}) → 고자산 세금 ${Math.round(r*40)}%, 저소득 지원 강화`);

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
        ('forcedRegimeIndex',        ?),
        ('wealthThresholdForTax',    ?),
        ('subsidyThresholdForBonus', ?)
      ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = NOW()
    `, [
      String(newSettings.dailyRewardMultiplier),
      String(newSettings.workRewardMultiplier),
      String(newSettings.subsidyMultiplier),
      String(newSettings.gamblingPayoutMultiplier),
      String(newSettings.taxRate),
      newSettings.forcedRegimeIndex !== null ? String(newSettings.forcedRegimeIndex) : 'null',
      String(newSettings.wealthThresholdForTax),
      String(newSettings.subsidyThresholdForBonus),
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
        name: '💰 경제 지표',
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
        ].join('\n'),
        inline: false,
      },
    ],
    footer: { text: '자동 경제 조절 시스템 • 10분마다 자동 분석' },
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
    console.log('📊 [자동 경제 조절] 경제 지표 분석 시작...');
    const report = await analyzeEconomyHealth();
    lastReport = report;

    const actions = await applyAutoBalancing(report);

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
function startAutoBalancer(client, stockEngineFn) {
  if (stockEngineFn) setRegimeFn = stockEngineFn;
  console.log('🏦 [자동 경제 조절 시스템] 가동 시작 (10분 주기 분석)');

  // 봇 시작 2분 후 첫 실행
  setTimeout(() => runBalancerCycle(client), 2 * 60 * 1000);

  // 10분마다 반복 실행
  setInterval(() => runBalancerCycle(client), 10 * 60 * 1000);
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
};
