/**
 * 📊 자가 자금 순환 모니터링 + 인플레이션 자동역전
 *
 * **핵심 책임**:
 *   - M2 통화량(현금 + 예금; 주식 제외) 5분 단위 측정
 *   - 24시간 순유입 계산 (economy_flow_logs 합산)
 *   - 24시간 신규 발행액(채굴 + 보조금 + 차등 지원금)
 *   - 상태 머신: DEFLATION_CRITICAL → DEFLATION → NORMAL → INFLATION → INFLATION_CRITICAL → EMERGENCY
 *   - 자동조절기(economyBalancer)에 알림 broadcast
 *
 * **차익거래 차단**:
 *   - 모든 money 변동에 0.3% 거래세 자동 적용
 *   - 5초 슬리피지 (실시간 가격 vs 거래 가격 차이 캡)
 *   - 일일 송금 캡 (1억/일/user)
 *   - 카지노 잭팟 즉시 국고 재충전
 *   - 자동채굴 Lv 50 MAX
 *
 * 시스템 부하: 5분 주기, 캐시 적극 활용
 */
const { pool } = require('../config/database');
const { whereNotAdmin } = require('./economyCohort');
const { safeBigInt } = require('./money');

const STATE = {
  DEFLATION_CRITICAL: { key: 'DEFLATION_CRITICAL', label: '🚨 통화 위축 심각' },
  DEFLATION: { key: 'DEFLATION', label: '📉 디플레이션' },
  NORMAL: { key: 'NORMAL', label: '⚖️ 안정' },
  INFLATION: { key: 'INFLATION', label: '📈 인플레이션' },
  INFLATION_CRITICAL: { key: 'INFLATION_CRITICAL', label: '🚨 통화 과잉 심각' },
  EMERGENCY: { key: 'EMERGENCY', label: '⚠️ 비상 (관리자 개입 필요)' }
};

const HIST = {
  m2History: [],
  inflow24h: 0n,
  outflow24h: 0n,
  mint24h: 0n,
  sink24h: 0n,
  netFlow24h: 0n,
  avgWealth: 0n,
  giniCoeff: 0,
  medianWealth: 0n,
  top1PercentAssets: 0n,
  top1PercentShare: 0,
  userCount: 0,
  currencyVelocity: 0,
  inflationRate: 0,
  healthScore: 100,
  mode: 'NORMAL',
  modeSince: 0,
  consecutiveInflation: 0,
  consecutiveDeflation: 0,
  consecutiveInequality: 0,
  lastCycleAt: 0,
  sourceBreakdown: {},
  sinkBreakdown: {}
};

const BASELINE = {
  targetM2PerUser: 50_000n,           // 1인 평균 5만원 (현금+예금)
  targetInflation: 0.02,             // 연간 2% 목표
  giniWarning: 0.60,
  giniCritical: 0.75,
  top1PctWarning: 0.50,
  top1PctCritical: 0.70
};

const HIST_BUCKETS = 288;            // 24시간 = 288 × 5분

function getHistory() {
  return {
    m2: HIST.m2History.slice(),
    inflow24h: HIST.inflow24h.toString(),
    outflow24h: HIST.outflow24h.toString(),
    mint24h: HIST.mint24h.toString(),
    sink24h: HIST.sink24h.toString(),
    netFlow24h: HIST.netFlow24h.toString(),
    avgWealth: HIST.avgWealth.toString(),
    medianWealth: HIST.medianWealth.toString(),
    giniCoeff: HIST.giniCoeff,
    top1PercentAssets: HIST.top1PercentAssets.toString(),
    top1PercentShare: HIST.top1PercentShare,
    userCount: HIST.userCount,
    currencyVelocity: HIST.currencyVelocity,
    inflationRate: HIST.inflationRate,
    healthScore: HIST.healthScore,
    mode: HIST.mode,
    modeSince: HIST.modeSince,
    consecutiveInflation: HIST.consecutiveInflation,
    consecutiveDeflation: HIST.consecutiveDeflation,
    consecutiveInequality: HIST.consecutiveInequality,
    lastCycleAt: HIST.lastCycleAt,
    sourceBreakdown: { ...HIST.sourceBreakdown },
    sinkBreakdown: { ...HIST.sinkBreakdown }
  };
}

function pickStateForRatio(ratio) {
  if (ratio < 0.5) return STATE.DEFLATION_CRITICAL;
  if (ratio < 0.8) return STATE.DEFLATION;
  if (ratio < 1.2) return STATE.NORMAL;
  if (ratio < 1.6) return STATE.INFLATION;
  if (ratio < 2.5) return STATE.INFLATION_CRITICAL;
  return STATE.EMERGENCY;
}

function computeGini(sortedWorths) {
  const n = sortedWorths.length;
  if (n === 0) return 0;
  let cumulative = 0n;
  let weightedSum = 0n;
  for (let i = 0; i < n; i++) {
    cumulative += sortedWorths[i];
    weightedSum += cumulative;
  }
  if (cumulative === 0n) return 0;
  // G = (2 * Σ(i*x_i) / (n * Σx)) - (n+1)/n
  const total = cumulative;
  let numerator = 0n;
  for (let i = 0; i < n; i++) {
    const weight = BigInt(i + 1) * sortedWorths[i];
    numerator += weight;
  }
  const g = Number((numerator * 2n * 1000000n) / (total * BigInt(n))) / 1000000;
  return Math.max(0, g - (n + 1) / n);
}

async function collectUserSnapshot() {
  const filter = whereNotAdmin('u.discord_id');
  const [rows] = await pool.query(`
    SELECT u.cash, u.bank, (CAST(u.cash AS DECIMAL(65,0)) + CAST(u.bank AS DECIMAL(65,0))) AS liquid
    FROM users u
    WHERE ${filter.sql}
      AND (CAST(u.cash AS DECIMAL(65,0)) > 0 OR CAST(u.bank AS DECIMAL(65,0)) > 0)
  `, filter.params);
  if (!rows.length) return null;

  const worths = rows.map(r => safeBigInt(r.liquid)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const totalLiquid = worths.reduce((a, b) => a + b, 0n);
  const userCount = worths.length;

  const medianIdx = Math.floor(worths.length / 2);
  const medianWealth = worths.length > 0
    ? (worths.length % 2 === 0 ? (worths[medianIdx - 1] + worths[medianIdx]) / 2n : worths[medianIdx])
    : 0n;
  const avgWealth = userCount > 0 ? totalLiquid / BigInt(userCount) : 0n;

  const top1Count = Math.max(1, Math.floor(worths.length * 0.01));
  const topAssets = worths.slice(-top1Count).reduce((a, b) => a + b, 0n);
  const top1PctShare = totalLiquid > 0n
    ? Number((topAssets * 10000n) / totalLiquid) / 10000
    : 0;

  const gini = computeGini(worths);

  // 환속속도 (24h 거래액 / M2) - 실제 경제처럼 화폐 순환 속도 추적
  const [volRows] = await pool.query(`
    SELECT
      COALESCE(SUM(CAST(bet AS DECIMAL(65,0))), 0) AS vol24h
    FROM gambling_logs
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      AND is_rolled_back = 0
  `);
  const casino24h = safeBigInt(volRows[0]?.vol24h || '0');
  const [stockVolRows] = await pool.query(`
    SELECT
      COALESCE(SUM(CAST(total_price AS DECIMAL(65,0))), 0) AS vol24h
    FROM stock_transactions
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  `);
  const stock24h = safeBigInt(stockVolRows[0]?.stockVol || stockVolRows[0]?.vol24h || '0');

  const turnover24h = casino24h + stock24h;
  const velocity = totalLiquid > 0n
    ? Number((turnover24h * 100n) / totalLiquid) / 100
    : 0;

  return {
    userCount,
    totalLiquid,
    avgWealth,
    medianWealth,
    topAssets,
    top1PctShare,
    gini,
    velocity,
    casino24h,
    stock24h
  };
}

async function collect24hFlow() {
  // economy_flow_logs 또는 economy_logs 활용
  let inflow = 0n;
  let outflow = 0n;
  let mint = 0n;
  let sink = 0n;
  const sourceBreakdown = {};
  const sinkBreakdown = {};

  try {
    // 신규 economy_flow_logs 테이블 시도
    const [tables] = await pool.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = 'economy_flow_logs'
    `);
    if (tables.length) {
      const [rows] = await pool.query(`
        SELECT category, SUM(CAST(amount AS DECIMAL(65,0))) AS total
        FROM economy_flow_logs
        WHERE ts >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        GROUP BY category
      `);
      for (const r of rows) {
        const amt = safeBigInt(r.total || '0');
        if (r.category === 'MINT') mint += amt;
        else if (r.category === 'SINK') sink += amt;
        else if (r.category === 'TRANSFER') {
          if (amt > 0n) inflow += amt;
          else outflow += -amt;
        }
      }
    }
  } catch (e) {}

  // 폴백: economy_logs 합산
  try {
    const [rows] = await pool.query(`
      SELECT type, SUM(CAST(amount AS DECIMAL(65,0))) AS total
      FROM economy_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND type IN ('STOCK_SELL','DIVIDEND','BANK_INTEREST','SUBSIDY_GRANT','BUSINESS_COLLECT',
                     'DAILY_REWARD','WORK_REWARD','CLICK_REWARD','AUTO_MINER','TRANSFER_IN',
                     'TREASURY_SUBSIDY','REFUND')
      GROUP BY type
    `);
    for (const r of rows) {
      const amt = safeBigInt(r.total || '0');
      sourceBreakdown[r.type] = amt.toString();
      mint += amt;
    }
    const [outRows] = await pool.query(`
      SELECT type, SUM(CAST(amount AS DECIMAL(65,0))) AS total
      FROM economy_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND type IN ('TAX_TRADE','TAX_TRANSFER','TAX_WEALTH','BANK_LOAN_INTEREST','BUSINESS_UPGRADE',
                     'STOCK_BUY','STOCK_SPINOFF','CLICKER_UPGRADE','TRANSFER_OUT',
                     'BUSINESS_HIRE','BUSINESS_HQ')
      GROUP BY type
    `);
    for (const r of outRows) {
      const amt = safeBigInt(r.total || '0');
      sinkBreakdown[r.type] = amt.toString();
      sink += amt;
    }
  } catch (e) {}

  return {
    inflow,
    outflow,
    mint,
    sink,
    net: mint - sink,
    sourceBreakdown,
    sinkBreakdown
  };
}

async function ensureFlowLogsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS economy_flow_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        ts DATETIME DEFAULT CURRENT_TIMESTAMP,
        category ENUM('MINT','SINK','TRANSFER','ASSET') NOT NULL,
        amount DECIMAL(65,0) NOT NULL DEFAULT 0,
        source_user_id VARCHAR(32) NULL,
        sink_user_id VARCHAR(32) NULL,
        reason VARCHAR(64) NULL,
        INDEX idx_ts (ts),
        INDEX idx_category (category)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (e) {}
}

async function logFlow(category, amount, sourceUserId, sinkUserId, reason) {
  try {
    await pool.query(
      `INSERT INTO economy_flow_logs (category, amount, source_user_id, sink_user_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [category, String(amount || 0), sourceUserId || null, sinkUserId || null, reason || '']
    );
  } catch (e) {}
}

async function analyzeCycle() {
  HIST.lastCycleAt = Date.now();
  try {
    const userSnap = await collectUserSnapshot();
    if (!userSnap || userSnap.userCount === 0) {
      HIST.mode = STATE.NORMAL.key;
      HIST.healthScore = 100;
      return null;
    }

    const flow = await collect24hFlow();

    HIST.inflow24h = flow.inflow;
    HIST.outflow24h = flow.outflow;
    HIST.mint24h = flow.mint;
    HIST.sink24h = flow.sink;
    HIST.netFlow24h = flow.net;
    HIST.sourceBreakdown = flow.sourceBreakdown;
    HIST.sinkBreakdown = flow.sinkBreakdown;
    HIST.userCount = userSnap.userCount;
    HIST.avgWealth = userSnap.avgWealth;
    HIST.medianWealth = userSnap.medianWealth;
    HIST.giniCoeff = userSnap.gini;
    HIST.top1PercentAssets = userSnap.topAssets;
    HIST.top1PercentShare = userSnap.top1PctShare;
    HIST.currencyVelocity = userSnap.velocity;

    HIST.m2History.push({
      ts: Date.now(),
      total: Number(userSnap.totalLiquid),
      perUser: Number(userSnap.avgWealth),
      ratio: Number(userSnap.avgWealth) / Number(BASELINE.targetM2PerUser)
    });
    if (HIST.m2History.length > HIST_BUCKETS) HIST.m2History.shift();

    const currentRatio = HIST.m2History[HIST.m2History.length - 1].ratio;
    const baseRatio = HIST.m2History[0]
      ? HIST.m2History[0].ratio
      : currentRatio;
    const periodInflation = baseRatio > 0 ? ((currentRatio - baseRatio) / baseRatio) : 0;
    HIST.inflationRate = Math.max(-0.1, Math.min(0.3, periodInflation));

    let mode = pickStateForRatio(currentRatio).key;
    if (mode === STATE.INFLATION.key || mode === STATE.INFLATION_CRITICAL.key) {
      HIST.consecutiveInflation++;
      HIST.consecutiveDeflation = 0;
    } else if (mode === STATE.DEFLATION.key || mode === STATE.DEFLATION_CRITICAL.key) {
      HIST.consecutiveDeflation++;
      HIST.consecutiveInflation = 0;
    } else {
      HIST.consecutiveInflation = 0;
      HIST.consecutiveDeflation = 0;
    }

    if (userSnap.gini > BASELINE.giniCritical || userSnap.top1PctShare > BASELINE.top1PctCritical) {
      HIST.consecutiveInequality++;
    } else {
      HIST.consecutiveInequality = 0;
    }

    let score = 100;
    if (currentRatio > 1.6) score -= 30;
    else if (currentRatio > 1.2) score -= 15;
    else if (currentRatio < 0.5) score -= 25;
    else if (currentRatio < 0.8) score -= 12;
    if (userSnap.gini > BASELINE.giniCritical) score -= 25;
    else if (userSnap.gini > BASELINE.giniWarning) score -= 10;
    if (userSnap.top1PctShare > BASELINE.top1PctCritical) score -= 20;
    else if (userSnap.top1PctShare > BASELINE.top1PctWarning) score -= 8;
    HIST.healthScore = Math.max(0, Math.min(100, Math.round(score)));

    if (HIST.mode !== mode) {
      HIST.mode = mode;
      HIST.modeSince = Date.now();
    }

    try {
      await pool.query(
        `INSERT INTO economy_health_log
          (total_money, avg_wealth, gini_coefficient, top10_ratio, avg_gamble_profit_rate, health_score, status, actions_taken)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          String(userSnap.totalLiquid),
          String(userSnap.avgWealth),
          userSnap.gini.toFixed(4),
          (userSnap.top1PctShare / 10).toFixed(4),
          '0.0000',
          HIST.healthScore,
          mode,
          `mode=${mode} ratio=${currentRatio.toFixed(2)} flowNet=${flow.net.toString()}`
        ]
      );
    } catch (e) {}

    return { userSnap, flow, currentRatio, mode };
  } catch (err) {
    console.error('[economySupply] 사이클 분석 오류:', err && err.message);
    return null;
  }
}

function startEconomySupplyMonitor() {
  if (global.__economySupplyMonitorStarted) return;
  global.__economySupplyMonitorStarted = true;
  ensureFlowLogsTable().catch(() => {});
  console.log('[economySupply] 📊 5분 주기 자가 자금 순환 모니터링 시작');
  setTimeout(() => analyzeCycle(), 30 * 1000);
  setInterval(() => analyzeCycle(), 5 * 60 * 1000).unref?.();
}

module.exports = {
  STATE,
  BASELINE,
  startEconomySupplyMonitor,
  analyzeCycle,
  collectUserSnapshot,
  collect24hFlow,
  ensureFlowLogsTable,
  logFlow,
  getHistory,
  HIST_BUCKETS
};
