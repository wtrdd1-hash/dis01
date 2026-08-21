/**
 * 세금 엔진.
 * 관리자는 면제. 일반 유저만 걷고, 걷은 돈은 국고(시중 흡수)로 보낸다.
 */
const { pool } = require('../config/database');
const config = require('../config/config');
const { safeBigInt, applyCashDelta, parseGambleBet } = require('./money');
const { formatMoney, formatMoneyCompact } = require('./formatters');
const { whereNotAdmin } = require('./economyCohort');

const TAX_COLLECT_TYPES = ['TAX_TRADE', 'TAX_TRANSFER', 'TAX_WEALTH', 'TAX_ADMIN'];
const TAX_LOG_TYPES = TAX_COLLECT_TYPES.concat(['TAX_REFUND', 'TREASURY_SUBSIDY', 'TREASURY_WITHDRAW']);

const TREASURY_KEY = 'taxTreasury';
const WEALTH_PERIODS_PER_YEAR = 365 * 24 * 6; // 10분 주기 × 365일 = 52,560회
const MAX_LIQUID_LEVY_BPS = 20; // 회당 유동자산(현금+예금)의 0.20% 상한

// 🏛️ 기본 누진 재산세 과세 구간 (독점 방지 6단계 누진세율)
const DEFAULT_WEALTH_BRACKETS = [
  { min: 0n, max: 5000000n, rate: 0.0, name: '기본 면제 (500만 미만 0%)' },
  { min: 5000000n, max: 10000000n, rate: 0.03, name: '1구간 (500만~1,000만, 3%)' },
  { min: 10000000n, max: 50000000n, rate: 0.06, name: '2구간 (1,000만~5,000만, 6%)' },
  { min: 50000000n, max: 200000000n, rate: 0.09, name: '3구간 (5,000만~2억, 9%)' },
  { min: 200000000n, max: 1000000000n, rate: 0.12, name: '4구간 (2억~10억, 12%)' },
  { min: 1000000000n, max: 5000000000n, rate: 0.16, name: '5구간 (10억~50억 초고액, 16%)' },
  { min: 5000000000n, max: null, rate: 0.20, name: '6구간 (50억 이상 독점 억제, 20%)' }
];

// 🏢 초고액 자산가 사업 누진 소득세 (1억 이상부터 구간별 부과)
function computeBusinessIncomeTax(userNetWorth, rawIncome) {
  const net = safeBigInt(userNetWorth);
  const inc = safeBigInt(rawIncome);
  if (inc <= 0n || net < 100000000n) return { tax: 0n, rate: 0, netIncome: inc };

  let taxRate = 0;
  if (net >= 5000000000n) taxRate = 0.25;      // 50억 이상: 25%
  else if (net >= 1000000000n) taxRate = 0.18; // 10억 이상: 18%
  else if (net >= 300000000n) taxRate = 0.12;  // 3억 이상: 12%
  else if (net >= 100000000n) taxRate = 0.06;  // 1억 이상: 6%

  const tax = (inc * BigInt(Math.round(taxRate * 10000))) / 10000n;
  return {
    tax,
    rate: taxRate,
    netIncome: inc - tax
  };
}

// 🏦 고액 예금자 이자 소득세 (5,000만 이상부터 구간별 부과)
function computeBankInterestTax(bankBalance, rawInterest) {
  const bal = safeBigInt(bankBalance);
  const interest = safeBigInt(rawInterest);
  if (interest <= 0n || bal < 50000000n) return { tax: 0n, rate: 0, netInterest: interest };

  let taxRate = 0;
  if (bal >= 1000000000n) taxRate = 0.20;      // 10억 이상: 20%
  else if (bal >= 300000000n) taxRate = 0.14;  // 3억 이상: 14%
  else if (bal >= 50000000n) taxRate = 0.08;   // 5000만 이상: 8%

  const tax = (interest * BigInt(Math.round(taxRate * 10000))) / 10000n;
  return {
    tax,
    rate: taxRate,
    netInterest: interest - tax
  };
}

function clampRate(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(0.30, n);
}

function rateToBps(rate) {
  return BigInt(Math.round(clampRate(rate) * 10000));
}

function taxOnAmount(amount, rate) {
  const amt = safeBigInt(amount);
  const bps = rateToBps(rate);
  if (amt <= 0n || bps <= 0n) return 0n;
  return (amt * bps) / 10000n;
}

function getPolicy() {
  let dyn = {};
  try {
    dyn = require('./economyBalancer').getDynamicSettings() || {};
  } catch (e) {
    dyn = {};
  }
  return {
    rate: clampRate(dyn.taxRate),
    threshold: safeBigInt(dyn.wealthThresholdForTax || 5000000),
    wealthTaxMultiplier: Number(dyn.wealthTaxMultiplier || 1.0),
    locked: !!dyn.taxPolicyLocked,
    brackets: DEFAULT_WEALTH_BRACKETS
  };
}

// 🏛️ 누진적 초과 재산세 계산 (초과 누진 과세)
function computeProgressiveWealthTax(liquidAmount, multiplier = 1.0) {
  const liquid = safeBigInt(liquidAmount);
  if (liquid < 5000000n) return { annualTax: 0n, periodLevy: 0n, effectiveRate: 0, breakdown: [] };

  const mult = Math.max(0.2, Math.min(3.0, Number(multiplier) || 1.0));
  let totalAnnual = 0n;
  const breakdown = [];

  for (const b of DEFAULT_WEALTH_BRACKETS) {
    if (b.rate <= 0 || liquid <= b.min) continue;
    const taxableInBracket = b.max ? (liquid > b.max ? b.max - b.min : liquid - b.min) : (liquid - b.min);
    if (taxableInBracket <= 0n) continue;

    const effRate = b.rate * mult;
    const bracketBps = rateToBps(effRate);
    const bracketTax = (taxableInBracket * bracketBps) / 10000n;
    totalAnnual += bracketTax;
    breakdown.push({
      name: b.name,
      taxable: taxableInBracket.toString(),
      ratePercent: (effRate * 100).toFixed(1),
      tax: bracketTax.toString()
    });
  }

  // 10분 주기 분할 (연간 52,560회 기준)
  const periodLevy = totalAnnual / (BigInt(WEALTH_PERIODS_PER_YEAR));
  const liquidCap = (liquid * BigInt(MAX_LIQUID_LEVY_BPS)) / 10000n;
  const cappedPeriodLevy = periodLevy < liquidCap ? periodLevy : liquidCap;
  const effectiveRate = liquid > 0n ? (Number(totalAnnual * 10000n / liquid) / 100) : 0;

  return {
    annualTax: totalAnnual,
    periodLevy: cappedPeriodLevy,
    effectiveRate,
    breakdown
  };
}

// 👑 세금왕 캐시 (실시간 빠른 세금 감면 연산 지원)
let cachedTaxKingUserId = null;
let lastTaxKingCacheTime = 0;

async function refreshTaxKingCache() {
  try {
    const king = await getTaxKing();
    cachedTaxKingUserId = king ? String(king.userId) : null;
    lastTaxKingCacheTime = Date.now();
  } catch (e) {}
}

function isTaxKingCached(userId) {
  if (!userId || !cachedTaxKingUserId) return false;
  return String(userId) === String(cachedTaxKingUserId);
}

// 1분 주기로 세금왕 캐시 갱신
if (process.env.NODE_ENV !== 'test') {
  setInterval(refreshTaxKingCache, 60000).unref?.();
  setTimeout(refreshTaxKingCache, 2000).unref?.();
}

/**
 * 📈 거래 금액 규모에 따른 누진 거래세율 산출 (거래 금액이 클수록 거래세 대폭 인상)
 * - 10만 미만: 0.5%
 * - 10만 ~ 100만: 1.5%
 * - 100만 ~ 1,000만: 3.0%
 * - 1,000만 ~ 5,000만: 5.0%
 * - 5,000만 ~ 2억: 8.0%
 * - 2억 이상 초고액: 12.0%
 * 👑 세금왕 특권: 모든 거래세 50% 대폭 감면!
 */
function getTradeTaxRate(userId, tradeAmount) {
  if (config.isAdmin(userId)) return 0;
  const amt = safeBigInt(tradeAmount);
  const baseRate = getPolicy().rate || 0.01;

  let calculatedRate = baseRate;
  if (amt <= 0n) calculatedRate = baseRate;
  else if (amt < 100000n) calculatedRate = Math.max(0.005, baseRate * 0.5);
  else if (amt < 1000000n) calculatedRate = Math.max(0.015, baseRate * 1.0);
  else if (amt < 10000000n) calculatedRate = Math.max(0.030, baseRate * 2.0);
  else if (amt < 50000000n) calculatedRate = Math.max(0.050, baseRate * 3.5);
  else if (amt < 200000000n) calculatedRate = Math.max(0.080, baseRate * 5.0);
  else calculatedRate = Math.max(0.120, baseRate * 8.0);

  // 👑 세금왕 50% 세금 감면 혜택 적용
  if (isTaxKingCached(userId)) {
    calculatedRate = calculatedRate * 0.5;
  }

  return calculatedRate;
}

function quoteTradeTax(userId, tradeAmount) {
  const amount = safeBigInt(tradeAmount);
  const isKing = isTaxKingCached(userId);
  const rate = getTradeTaxRate(userId, amount);
  const tax = taxOnAmount(amount, rate);
  return {
    rate,
    tax,
    exempt: config.isAdmin(userId) || rate <= 0,
    isTaxKing: isKing,
    taxKingDiscountText: isKing ? '👑 세금왕 50% 감면 혜택 적용' : null,
    netBuy: amount + tax,
    netSell: amount > tax ? amount - tax : 0n
  };
}

function maxBuyShareUnits(cash, price, userId) {
  const userCash = safeBigInt(cash);
  const unit = safeBigInt(price);
  const estimatedAmt = userCash;
  const rate = getTradeTaxRate(userId, estimatedAmt);
  const bps = rateToBps(rate);
  if (unit <= 0n || userCash <= 0n) return 0n;
  return (userCash * 100000000n) / (unit * (10000n + bps));
}

function maxBuyAffordable(cash, price, userId) {
  const { unitsToAmountStr } = require('./moneyScale');
  const units = maxBuyShareUnits(cash, price, userId);
  const asNum = Number(units) / 10000;
  if (Number.isFinite(asNum) && asNum <= Number.MAX_SAFE_INTEGER) return asNum;
  return Number(unitsToAmountStr(units));
}

function maxBuySharesInt(cash, price, userId) {
  return maxBuyShareUnits(cash, price, userId) / 10000n;
}

async function readTreasury() {
  try {
    const [rows] = await pool.query(
      'SELECT value FROM economy_settings WHERE key_name = ? LIMIT 1',
      [TREASURY_KEY]
    );
    return safeBigInt(rows[0] && rows[0].value);
  } catch (e) {
    return 0n;
  }
}

async function addTreasury(amount) {
  const add = safeBigInt(amount);
  if (add <= 0n) return readTreasury();
  // 원자적 UPDATE 처리 (race condition 방지)
  await pool.query(
    `INSERT INTO economy_settings (key_name, value) VALUES (?, '0')
     ON DUPLICATE KEY UPDATE value = value`,
    [TREASURY_KEY]
  );
  await pool.query(
    `UPDATE economy_settings SET value = CAST(CAST(value AS DECIMAL(65,0)) + ? AS CHAR) WHERE key_name = ?`,
    [add.toString(), TREASURY_KEY]
  );
  return readTreasury();
}

// 🏛️ 국고 자금 지출/인출 (마이너스 재정 적자 전액 허용)
async function takeTreasury(amount, allowNegative = true) {
  const want = safeBigInt(amount);
  if (want <= 0n) return { took: 0n, treasury: await readTreasury() };

  // 원자적 UPDATE 처리 (race condition 방지)
  await pool.query(
    `INSERT INTO economy_settings (key_name, value) VALUES (?, '0')
     ON DUPLICATE KEY UPDATE value = value`,
    [TREASURY_KEY]
  );

  let took = want;
  if (!allowNegative) {
    // 국고 잔액만큼만 가져감 (마이너스 방지)
    const [checkRows] = await pool.query(
      `SELECT CAST(value AS DECIMAL(65,0)) AS cur FROM economy_settings WHERE key_name = ?`,
      [TREASURY_KEY]
    );
    const curBal = safeBigInt(checkRows[0]?.cur);
    took = curBal > want ? want : (curBal > 0n ? curBal : 0n);
  }

  await pool.query(
    `UPDATE economy_settings SET value = CAST(CAST(value AS DECIMAL(65,0)) - ? AS CHAR) WHERE key_name = ?`,
    [took.toString(), TREASURY_KEY]
  );
  
  const treasury = await readTreasury();
  return { took, treasury };
}

// 🏛️ 국고 지원금 지급 헬퍼 (국고에서 차감하여 유저에게 현금 지급)
async function grantTreasurySubsidy(userId, username, amount, reason = '정부 긴급 지원금') {
  const amt = safeBigInt(amount);
  if (amt <= 0n) return { success: false, error: '금액 오류' };

  // 1. 국고에서 지원금 차감 (마이너스 국고 허용)
  const { treasury: newTreasury } = await takeTreasury(amt, true);

  // 2. 유저에게 현금 지급
  const { getUserCash, applyCashDelta } = require('./money');
  const before = await getUserCash(userId);
  const after = await applyCashDelta(userId, amt);

  // 3. 로그 기록
  await logTax(
    userId,
    username,
    'TAX_REFUND',
    amt,
    before,
    after,
    `🏛️ [국고 지원금 지급] +${formatMoney(amt)} (국고 잔액: ${formatMoney(newTreasury)}, 사유: ${reason})`
  );

  return { success: true, amount: amt, newCash: after, newTreasury };
}

async function logTax(userId, username, type, amount, before, after, description) {
  const amt = safeBigInt(amount);
  if (amt <= 0n) return;
  try {
    await pool.query(
      `INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(userId),
        username || ('유저_' + String(userId).slice(-4)),
        type,
        amt.toString(),
        safeBigInt(before).toString(),
        safeBigInt(after).toString(),
        String(description || '세금').slice(0, 255)
      ]
    );
  } catch (e) {}
}

async function applyDebitWithTax(userId, username, principal, tax, type, description) {
  const p = safeBigInt(principal);
  const t = safeBigInt(tax);
  const total = p + t;
  const { getUserCash } = require('./money');
  const before = await getUserCash(userId);
  const after = await applyCashDelta(userId, -total);
  if (t > 0n) {
    await addTreasury(t);
    await logTax(userId, username, type, t, before, after, description);
  }
  return { after, tax: t, principal: p };
}

async function applyCreditMinusTax(userId, username, proceeds, tax, type, description) {
  const p = safeBigInt(proceeds);
  const t = safeBigInt(tax);
  const net = p > t ? p - t : 0n;
  const { getUserCash } = require('./money');
  const before = await getUserCash(userId);
  const after = net > 0n ? await applyCashDelta(userId, net) : before;
  if (t > 0n) {
    await addTreasury(t);
    await logTax(userId, username, type, t, before, after, description);
  }
  return { after, tax: t, principal: p, net };
}

const TRANSFER_FEE_RATE = 0.01; // 💸 송금 기본 수수료율 1%

function quoteTransferTax(senderId, recipientId, amount) {
  if (config.isAdmin(senderId) || config.isAdmin(recipientId)) {
    return { rate: 0, tax: 0n, exempt: true, rateText: '0.0%', isTaxKing: false };
  }
  const amt = safeBigInt(amount);
  const isKing = isTaxKingCached(senderId);
  const effectiveRate = isKing ? (TRANSFER_FEE_RATE * 0.5) : TRANSFER_FEE_RATE;
  const rateText = isKing ? '0.5% (👑세금왕 50% 감면)' : '1.0%';

  if (amt <= 0n) {
    return { rate: effectiveRate, tax: 0n, exempt: false, rateText, isTaxKing: isKing };
  }
  
  // 송금 수수료 계산 (세금왕 0.5%, 일반 1.0%)
  const rateBps = BigInt(Math.round(effectiveRate * 10000));
  let tax = (amt * rateBps) / 10000n;
  if (tax < 10n && amt >= 1000n) tax = 10n;

  return {
    rate: effectiveRate,
    tax,
    exempt: false,
    rateText,
    isTaxKing: isKing
  };
}

async function loadWealthSnapshot(userId) {
  const [rows] = await pool.query(
    `
    SELECT u.cash, u.bank,
           CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0)) AS stock_val
    FROM users u
    LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
    LEFT JOIN stocks s ON us.stock_id = s.stock_id
    WHERE u.discord_id = ?
    GROUP BY u.discord_id, u.cash, u.bank
    `,
    [userId]
  );
  const cash = safeBigInt(rows[0] && rows[0].cash);
  const bank = safeBigInt(rows[0] && rows[0].bank);
  const stock = safeBigInt(rows[0] && rows[0].stock_val);
  return {
    cash,
    bank,
    stock,
    liquid: cash + bank,
    net: cash + bank + stock
  };
}

function minBigInt(values) {
  return values.reduce((a, b) => (a < b ? a : b));
}

async function collectWealthTax() {
  const policy = getPolicy();
  const filter = whereNotAdmin('u.discord_id');
  const threshold = safeBigInt(policy.threshold || 5000000n);
  const [rows] = await pool.query(
    `
    SELECT u.discord_id, u.username
    FROM users u
    LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
    LEFT JOIN stocks s ON us.stock_id = s.stock_id
    WHERE ${filter.sql}
    GROUP BY u.discord_id, u.username, u.cash, u.bank
    HAVING (CAST(u.cash AS DECIMAL(65,0)) + CAST(u.bank AS DECIMAL(65,0)) + CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0) / 2) AS DECIMAL(65,0))) > ?
    `,
    filter.params.concat([threshold.toString()])
  );

  const { withUserLock, applyLiquidTake } = require('./money');
  let collected = 0n;
  let count = 0;
  const rateBps = rateToBps(policy.rate);

    for (const row of rows) {
      if (config.isAdmin(row.discord_id)) continue;
      try {
        const took = await withUserLock(row.discord_id, async () => {
          const snap = await loadWealthSnapshot(row.discord_id);
          // 🏛️ 과세 대상: 유동자산(현금+예금) + 주식평가액의 50% (부동산과세 방지)
          const taxableWealth = snap.liquid + snap.stock / 2n;
          if (taxableWealth < 5000000n) return 0n;

          // 🏛️ 유동자산 기준 누진 과세 (현금+예금+주식50%)
          const prog = computeProgressiveWealthTax(taxableWealth, policy.wealthTaxMultiplier);
          const periodLevy = prog.periodLevy;
          const levy = minBigInt([periodLevy, snap.liquid]);
          if (levy <= 0n) return 0n;

          const taken = await applyLiquidTake(row.discord_id, levy);
          if (taken.took <= 0n) return 0n;
          await addTreasury(taken.took);
          await logTax(
            row.discord_id,
            row.username,
            'TAX_WEALTH',
            taken.took,
            snap.liquid,
            taken.after.liquid,
            `🏛️ 누진재산세(주식50% 포함·실효 ${prog.effectiveRate}%) | 유동 ${formatMoneyCompact(snap.liquid)} + 주식50% ${formatMoneyCompact(snap.stock / 2n)} | 징수 ${formatMoneyCompact(taken.took)}`
          );
          return taken.took;
      });
      if (took > 0n) {
        collected += took;
        count += 1;
      }
    } catch (e) {
      console.error('[taxEngine] 누진 자산세 징수 실패:', row.discord_id, e && e.message);
    }
  }

  return { collected, count };
}

async function getTaxOverview() {
  const policy = getPolicy();
  const treasury = await readTreasury();
  let recent = [];
  let last24h = 0n;
  try {
    const [logs] = await pool.query(
      `SELECT user_id, username, type, amount, description, created_at
       FROM economy_logs
       WHERE type IN (${TAX_LOG_TYPES.map(() => '?').join(',')})
       ORDER BY id DESC
       LIMIT 20`,
      TAX_LOG_TYPES
    );
    recent = logs;
    const [sumRows] = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM economy_logs
       WHERE type IN (${TAX_COLLECT_TYPES.map(() => '?').join(',')})
         AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      TAX_COLLECT_TYPES
    );
    last24h = safeBigInt(sumRows[0] && sumRows[0].total);
  } catch (e) {}
  let schedule = { nextCycleAt: Date.now(), intervalMs: 10 * 60 * 1000, locked: policy.locked };
  try {
    schedule = require('./economyBalancer').getBalancerSchedule();
  } catch (e) {}

  let topPayers = [];
  try {
    topPayers = await getTopTaxPayers(15);
  } catch (e) {}

  return {
    rate: policy.rate,
    threshold: safeBigInt(policy.threshold).toString(),
    locked: policy.locked,
    treasury: treasury.toString(),
    last24h: last24h.toString(),
    nextCycleAt: schedule.nextCycleAt,
    intervalMs: schedule.intervalMs,
    recent,
    topPayers
  };
}

function publicTaxState(userId) {
  const policy = getPolicy();
  const exempt = config.isAdmin(userId);
  return {
    rate: exempt ? 0 : policy.rate,
    rateText: ((exempt ? 0 : policy.rate) * 100).toFixed(1) + '%',
    threshold: safeBigInt(policy.threshold).toString(),
    locked: policy.locked,
    exempt
  };
}

function estimateWealthLevy(snapOrNet, policy, liquidLimit = null) {
  let netVal = 0n;
  let liquidVal = null;
  if (typeof snapOrNet === 'object' && snapOrNet !== null) {
    netVal = safeBigInt(snapOrNet.net || snapOrNet.liquid);
    liquidVal = safeBigInt(snapOrNet.liquid);
  } else {
    netVal = safeBigInt(snapOrNet);
    liquidVal = liquidLimit !== null ? safeBigInt(liquidLimit) : null;
  }
  const prog = computeProgressiveWealthTax(netVal, policy.wealthTaxMultiplier || 1.0);
  return liquidVal !== null ? minBigInt([prog.periodLevy, liquidVal]) : prog.periodLevy;
}

async function getPublicTaxView(userId) {
  const base = publicTaxState(userId);
  let schedule = { nextCycleAt: Date.now() + 10 * 60 * 1000, intervalMs: 10 * 60 * 1000 };
  try {
    schedule = require('./economyBalancer').getBalancerSchedule();
  } catch (e) {}
  let estimatedLevy = 0n;
  let liquid = 0n;
  if (userId && !base.exempt && base.rate > 0) {
    try {
      const snap = await loadWealthSnapshot(userId);
      liquid = snap.liquid;
      estimatedLevy = estimateWealthLevy(snap, getPolicy());
    } catch (e) {}
  }
  const nextInSec = Math.max(0, Math.floor((Number(schedule.nextCycleAt) - Date.now()) / 1000));
  return {
    ...base,
    nextWealthTaxAt: schedule.nextCycleAt,
    nextWealthTaxInSec: nextInSec,
    estimatedLevy: estimatedLevy.toString(),
    liquid: liquid.toString(),
    collecting: !base.exempt && base.rate > 0
  };
}

function taxError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function computeCashLevy(cash, mode, value) {
  const have = safeBigInt(cash);
  if (have <= 0n) return 0n;
  if (mode === 'amount') {
    const parsed = parseGambleBet(value, have);
    if (!parsed || parsed <= 0n) return 0n;
    return parsed < have ? parsed : have;
  }
  if (mode === 'cash_percent') {
    const pct = Number(value);
    if (!Number.isFinite(pct) || pct <= 0) return 0n;
    const bps = BigInt(Math.round(Math.min(100, pct) * 100));
    return (have * bps) / 10000n;
  }
  if (mode === 'policy_rate') {
    return taxOnAmount(have, getPolicy().rate);
  }
  if (mode === 'custom_rate') {
    const pct = Number(value);
    if (!Number.isFinite(pct) || pct <= 0) return 0n;
    return taxOnAmount(have, clampRate(pct / 100));
  }
  return 0n;
}

async function previewCollectFromUser(userId, mode, value) {
  if (config.isAdmin(userId)) throw taxError('ADMIN_EXEMPT', '관리자 계정은 징수 대상이 아닙니다.');
  const [rows] = await pool.query('SELECT discord_id, username, cash FROM users WHERE discord_id = ? LIMIT 1', [userId]);
  if (!rows[0]) throw taxError('NOT_FOUND', '유저를 찾을 수 없습니다.');
  const cash = safeBigInt(rows[0].cash);
  const levy = computeCashLevy(cash, mode, value);
  return {
    userId: String(userId),
    username: rows[0].username || ('유저_' + String(userId).slice(-4)),
    cash: cash.toString(),
    levy: levy.toString(),
    levyText: formatMoney(levy),
    count: levy > 0n ? 1 : 0,
    total: levy.toString(),
    totalText: formatMoney(levy)
  };
}

async function collectFromUser(userId, mode, value, reason) {
  if (config.isAdmin(userId)) throw taxError('ADMIN_EXEMPT', '관리자 계정은 징수 대상이 아닙니다.');
  const preview = await previewCollectFromUser(userId, mode, value);
  const levy = safeBigInt(preview.levy);
  if (levy <= 0n) throw taxError('NOTHING', '걷을 현금이 없습니다.');
  const { applyCashTakeClamped } = require('./money');
  const result = await applyCashTakeClamped(userId, levy);
  if (result.actual > 0n) {
    await addTreasury(result.actual);
    await logTax(
      userId,
      preview.username,
      'TAX_ADMIN',
      result.actual,
      result.before,
      result.after,
      String(reason || `관리자 세금 징수 (${mode})`).slice(0, 255)
    );
  }
  return {
    userId: String(userId),
    username: preview.username,
    took: result.actual.toString(),
    tookText: formatMoney(result.actual),
    before: result.before.toString(),
    after: result.after.toString(),
    treasury: (await readTreasury()).toString()
  };
}

async function previewWealthTax() {
  const policy = getPolicy();
  const filter = whereNotAdmin('u.discord_id');
  const threshold = safeBigInt(policy.threshold || 5000000n);
  const [rows] = await pool.query(
    `SELECT u.discord_id, u.username, u.cash, u.bank
     FROM users u
     WHERE ${filter.sql}
     GROUP BY u.discord_id, u.username, u.cash, u.bank
     HAVING (CAST(u.cash AS DECIMAL(65,0)) + CAST(u.bank AS DECIMAL(65,0))) > ?`,
    filter.params.concat([threshold.toString()])
  );
  const samples = [];
  let total = 0n;
  let count = 0;
  for (const row of rows) {
    if (config.isAdmin(row.discord_id)) continue;
    const cash = safeBigInt(row.cash);
    const bank = safeBigInt(row.bank);
    const liquid = cash + bank;
    if (liquid < 5000000n) continue;

    const prog = computeProgressiveWealthTax(liquid, policy.wealthTaxMultiplier || 1.0);
    const levy = minBigInt([prog.periodLevy, liquid]);
    if (levy <= 0n) continue;
    count += 1;
    total += levy;
    if (samples.length < 15) {
      samples.push({
        userId: String(row.discord_id),
        username: row.username || '알수없음',
        levy: levy.toString(),
        levyText: formatMoneyCompact(levy)
      });
    }
  }
  return { count, total: total.toString(), totalText: formatMoney(total), samples };
}

async function previewFlatCollect(mode, value) {
  const filter = whereNotAdmin('discord_id');
  const [rows] = await pool.query(
    `SELECT discord_id, username, cash FROM users WHERE ${filter.sql} AND CAST(cash AS DECIMAL(65,0)) > 0`,
    filter.params
  );
  const samples = [];
  let total = 0n;
  let count = 0;
  for (const row of rows) {
    if (config.isAdmin(row.discord_id)) continue;
    const levy = computeCashLevy(row.cash, mode, value);
    if (levy <= 0n) continue;
    count += 1;
    total += levy;
    if (samples.length < 15) {
      samples.push({
        userId: String(row.discord_id),
        username: row.username || '알수없음',
        levy: levy.toString(),
        levyText: formatMoneyCompact(levy)
      });
    }
  }
  return { count, total: total.toString(), totalText: formatMoney(total), samples };
}

async function collectFlatFromAll(mode, value, reason) {
  const filter = whereNotAdmin('discord_id');
  const [rows] = await pool.query(
    `SELECT discord_id, username, cash FROM users WHERE ${filter.sql} AND CAST(cash AS DECIMAL(65,0)) > 0`,
    filter.params
  );
  let collected = 0n;
  let count = 0;
  for (const row of rows) {
    if (config.isAdmin(row.discord_id)) continue;
    try {
      const result = await collectFromUser(
        row.discord_id,
        mode,
        value,
        reason || `관리자 전원 징수 (${mode})`
      );
      const took = safeBigInt(result.took);
      if (took > 0n) {
        collected += took;
        count += 1;
      }
    } catch (e) {
      if (e.code === 'NOTHING' || e.code === 'ADMIN_EXEMPT') continue;
    }
  }
  return {
    count,
    collected: collected.toString(),
    collectedText: formatMoney(collected),
    treasury: (await readTreasury()).toString()
  };
}

async function refundFromTreasury(userId, amount, reason) {
  if (config.isAdmin(userId)) throw taxError('ADMIN_EXEMPT', '관리자 계정에는 환급하지 않습니다.');
  const treasuryNow = await readTreasury();
  const want = parseGambleBet(amount, treasuryNow) || safeBigInt(amount);
  if (!want || want <= 0n) throw taxError('BAD_AMOUNT', '환급 금액은 1원 이상이어야 합니다.');
  const pulled = await takeTreasury(want, true);
  try {
    const { applyCashGiveLocked } = require('./money');
    const [users] = await pool.query('SELECT username FROM users WHERE discord_id = ? LIMIT 1', [userId]);
    if (!users[0]) throw taxError('NOT_FOUND', '유저를 찾을 수 없습니다.');
    const result = await applyCashGiveLocked(userId, pulled.took);
    await logTax(
      userId,
      users[0].username,
      'TAX_REFUND',
      pulled.took,
      result.before,
      result.after,
      String(reason || '국고 연말정산 환급').slice(0, 255)
    );
    return {
      userId: String(userId),
      username: users[0].username,
      gave: pulled.took.toString(),
      gaveText: formatMoney(pulled.took),
      requested: want.toString(),
      before: result.before.toString(),
      after: result.after.toString(),
      treasury: pulled.treasury.toString()
    };
  } catch (e) {
    if (pulled.took > 0n) await addTreasury(pulled.took);
    throw e;
  }
}

// 🏛️ 관리자 전용 국고 자금 출금/인출 (관리자 지갑 또는 특정 유저에게 지급)
async function withdrawTreasuryByAdmin(adminId, amount, targetUserId, reason) {
  const treasuryNow = await readTreasury();
  const want = parseGambleBet(amount, treasuryNow) || safeBigInt(amount);
  if (!want || want <= 0n) throw taxError('BAD_AMOUNT', '출금 금액은 1원 이상이어야 합니다.');

  const recipientId = targetUserId ? String(targetUserId) : String(adminId);
  const [users] = await pool.query('SELECT username FROM users WHERE discord_id = ? LIMIT 1', [recipientId]);
  if (!users[0]) throw taxError('NOT_FOUND', '수령 대상 유저를 찾을 수 없습니다.');

  // 국고에서 전액 차감 (마이너스 적자 허용)
  const pulled = await takeTreasury(want, true);
  try {
    const { applyCashGiveLocked } = require('./money');
    const result = await applyCashGiveLocked(recipientId, pulled.took);
    const whyText = String(reason || '관리자 국고 인출/출금').slice(0, 255);
    await logTax(
      recipientId,
      users[0].username,
      'TREASURY_WITHDRAW',
      pulled.took,
      result.before,
      result.after,
      `🏛️ [관리자 국고 인출] ${formatMoney(pulled.took)} (실행 관리자: <@${adminId}> / 사유: ${whyText})`
    );
    return {
      adminId: String(adminId),
      recipientId,
      recipientName: users[0].username,
      withdrawn: pulled.took.toString(),
      withdrawnText: formatMoney(pulled.took),
      before: result.before.toString(),
      after: result.after.toString(),
      treasury: pulled.treasury.toString(),
      treasuryText: formatMoney(pulled.treasury)
    };
  } catch (e) {
    if (pulled.took > 0n) await addTreasury(pulled.took);
    throw e;
  }
}

async function previewSettleRefund(percent, hours) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const hrs = Math.max(1, Math.min(24 * 400, Math.floor(Number(hours) || 24 * 365)));
  const treasury = await readTreasury();
  const [rows] = await pool.query(
    `SELECT user_id, username, COALESCE(SUM(amount), 0) AS paid
     FROM economy_logs
     WHERE type IN (${TAX_COLLECT_TYPES.map(() => '?').join(',')})
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     GROUP BY user_id, username`,
    TAX_COLLECT_TYPES.concat([hrs])
  );
  const payers = [];
  let totalPaid = 0n;
  for (const row of rows) {
    if (config.isAdmin(row.user_id)) continue;
    const paid = safeBigInt(row.paid);
    if (paid <= 0n) continue;
    totalPaid += paid;
    payers.push({ userId: String(row.user_id), username: row.username || '알수없음', paid });
  }
  const wanted = (totalPaid * BigInt(Math.round(pct * 100))) / 10000n;
  const poolAmt = wanted < treasury ? wanted : treasury;
  const samples = payers.slice(0, 15).map((p) => {
    const share = totalPaid > 0n ? (p.paid * poolAmt) / totalPaid : 0n;
    return {
      userId: p.userId,
      username: p.username,
      paid: p.paid.toString(),
      refund: share.toString(),
      refundText: formatMoneyCompact(share)
    };
  });
  return {
    hours: hrs,
    percent: pct,
    payerCount: payers.length,
    periodCollected: totalPaid.toString(),
    periodCollectedText: formatMoney(totalPaid),
    refundPool: poolAmt.toString(),
    refundPoolText: formatMoney(poolAmt),
    remainTreasury: (treasury - poolAmt).toString(),
    remainTreasuryText: formatMoney(treasury - poolAmt),
    samples
  };
}

async function settleTaxRefund(percent, hours, reason) {
  const preview = await previewSettleRefund(percent, hours);
  const poolAmt = safeBigInt(preview.refundPool);
  if (poolAmt <= 0n) throw taxError('NOTHING', '환급할 국고 또는 납세 이력이 없습니다.');
  const [rows] = await pool.query(
    `SELECT user_id, username, COALESCE(SUM(amount), 0) AS paid
     FROM economy_logs
     WHERE type IN (${TAX_COLLECT_TYPES.map(() => '?').join(',')})
       AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
     GROUP BY user_id, username`,
    TAX_COLLECT_TYPES.concat([preview.hours])
  );
  const totalPaid = safeBigInt(preview.periodCollected);
  let given = 0n;
  let count = 0;
  for (const row of rows) {
    if (config.isAdmin(row.user_id)) continue;
    const paid = safeBigInt(row.paid);
    if (paid <= 0n || totalPaid <= 0n) continue;
    const share = (paid * poolAmt) / totalPaid;
    if (share <= 0n) continue;
    try {
      const result = await refundFromTreasury(
        row.user_id,
        share.toString(),
        reason || `연말정산 환급 ${preview.percent}% (${preview.hours}시간)`
      );
      given += safeBigInt(result.gave);
      count += 1;
    } catch (e) {
      if (e.code === 'EMPTY_TREASURY') break;
    }
  }
  return {
    count,
    given: given.toString(),
    givenText: formatMoney(given),
    leftover: (await readTreasury()).toString(),
    leftoverText: formatMoney(await readTreasury())
  };
}

/**
 * 🏆 유저별 누적 납세액 통계 및 성실 납세자 랭킹 조회
 */
async function getTopTaxPayers(limit = 30) {
  try {
    const [rows] = await pool.query(
      `SELECT 
         user_id, 
         username, 
         COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) AS total_tax_paid,
         COUNT(*) AS tax_count,
         MAX(created_at) AS last_tax_at,
         COALESCE(SUM(CASE WHEN type = 'TAX_WEALTH' THEN CAST(amount AS DECIMAL(65,0)) ELSE 0 END), 0) AS wealth_tax_paid,
         COALESCE(SUM(CASE WHEN type = 'TAX_TRADE' THEN CAST(amount AS DECIMAL(65,0)) ELSE 0 END), 0) AS trade_tax_paid,
         COALESCE(SUM(CASE WHEN type = 'TAX_ADMIN' THEN CAST(amount AS DECIMAL(65,0)) ELSE 0 END), 0) AS admin_tax_paid
       FROM economy_logs
       WHERE type IN (${TAX_COLLECT_TYPES.map(() => '?').join(',')})
       GROUP BY user_id, username
       ORDER BY total_tax_paid DESC
       LIMIT ?`,
      TAX_COLLECT_TYPES.concat([Math.min(100, Math.max(1, limit))])
    );

    return rows.map((r, idx) => {
      const total = safeBigInt(r.total_tax_paid);
      const wealth = safeBigInt(r.wealth_tax_paid);
      const trade = safeBigInt(r.trade_tax_paid);
      const admin = safeBigInt(r.admin_tax_paid);
      const { formatKstDateTime } = require('./formatters');
      return {
        rank: idx + 1,
        userId: r.user_id,
        username: r.username || '알수없음',
        totalTaxPaid: total.toString(),
        totalTaxPaidText: formatMoney(total),
        wealthTaxPaid: wealth.toString(),
        wealthTaxPaidText: formatMoney(wealth),
        tradeTaxPaid: trade.toString(),
        tradeTaxPaidText: formatMoney(trade),
        adminTaxPaid: admin.toString(),
        adminTaxPaidText: formatMoney(admin),
        taxCount: r.tax_count,
        lastTaxAt: r.last_tax_at,
        lastTaxAtText: r.last_tax_at ? formatKstDateTime(r.last_tax_at) : '-'
      };
    });
  } catch (err) {
    console.error('납세자 랭킹 집계 오류:', err);
    return [];
  }
}

/**
 * 👑 세금왕 (세금 납부 1위) 유저 정보 조회
 */
async function getTaxKing() {
  try {
    const top = await getTopTaxPayers(1);
    if (top.length > 0 && BigInt(top[0].totalTaxPaid) > 0n) {
      return top[0];
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 👑 특정 유저가 세금왕(1위)인지 확인
 */
async function isTaxKing(userId) {
  if (!userId) return false;
  const king = await getTaxKing();
  return !!(king && String(king.userId) === String(userId));
}

/**
 * 👤 특정 유저의 누적 세금 납부 상세 통계
 */
async function getUserTaxStats(userId) {
  try {
    const [rows] = await pool.query(
      `SELECT 
         COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) AS total_tax_paid,
         COUNT(*) AS tax_count,
         COALESCE(SUM(CASE WHEN type = 'TAX_WEALTH' THEN CAST(amount AS DECIMAL(65,0)) ELSE 0 END), 0) AS wealth_tax_paid,
         COALESCE(SUM(CASE WHEN type = 'TAX_TRADE' THEN CAST(amount AS DECIMAL(65,0)) ELSE 0 END), 0) AS trade_tax_paid,
         COALESCE(SUM(CASE WHEN type = 'TAX_ADMIN' THEN CAST(amount AS DECIMAL(65,0)) ELSE 0 END), 0) AS admin_tax_paid
       FROM economy_logs
       WHERE user_id = ? AND type IN (${TAX_COLLECT_TYPES.map(() => '?').join(',')})`,
      [userId].concat(TAX_COLLECT_TYPES)
    );

    const total = safeBigInt(rows[0]?.total_tax_paid);
    const wealth = safeBigInt(rows[0]?.wealth_tax_paid);
    const trade = safeBigInt(rows[0]?.trade_tax_paid);
    const admin = safeBigInt(rows[0]?.admin_tax_paid);

    // 납세 순위 산출
    const [rankRows] = await pool.query(
      `SELECT COUNT(*) + 1 AS tax_rank
       FROM (
         SELECT user_id, SUM(CAST(amount AS DECIMAL(65,0))) AS sum_paid
         FROM economy_logs
         WHERE type IN (${TAX_COLLECT_TYPES.map(() => '?').join(',')})
         GROUP BY user_id
         HAVING sum_paid > ?
       ) t`,
      TAX_COLLECT_TYPES.concat([total.toString()])
    );
    const taxRank = rankRows[0]?.tax_rank || 1;

    return {
      userId,
      totalTaxPaid: total.toString(),
      totalTaxPaidText: formatMoney(total),
      wealthTaxPaid: wealth.toString(),
      wealthTaxPaidText: formatMoney(wealth),
      tradeTaxPaid: trade.toString(),
      tradeTaxPaidText: formatMoney(trade),
      adminTaxPaid: admin.toString(),
      adminTaxPaidText: formatMoney(admin),
      taxCount: rows[0]?.tax_count || 0,
      taxRank
    };
  } catch (err) {
    console.error('유저 납세 통계 오류:', err);
    return {
      userId,
      totalTaxPaid: '0',
      totalTaxPaidText: '0원',
      wealthTaxPaid: '0',
      wealthTaxPaidText: '0원',
      tradeTaxPaid: '0',
      tradeTaxPaidText: '0원',
      adminTaxPaid: '0',
      adminTaxPaidText: '0원',
      taxCount: 0,
      taxRank: 1
    };
  }
}

module.exports = {
  getPolicy,
  getTradeTaxRate,
  quoteTradeTax,
  quoteTransferTax,
  taxOnAmount,
  maxBuyAffordable,
  maxBuySharesInt,
  maxBuyShareUnits,
  applyDebitWithTax,
  applyCreditMinusTax,
  collectWealthTax,
  computeProgressiveWealthTax,
  loadWealthSnapshot,
  getTaxOverview,
  publicTaxState,
  getPublicTaxView,
  readTreasury,
  addTreasury,
  takeTreasury,
  grantTreasurySubsidy,
  previewCollectFromUser,
  collectFromUser,
  previewWealthTax,
  previewFlatCollect,
  collectFlatFromAll,
  refundFromTreasury,
  withdrawTreasuryByAdmin,
  previewSettleRefund,
  settleTaxRefund,
  getTopTaxPayers,
  getTaxKing,
  isTaxKing,
  getUserTaxStats,
  computeBusinessIncomeTax,
  computeBankInterestTax
};
