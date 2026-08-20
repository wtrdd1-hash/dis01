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
const WEALTH_PERIODS_PER_DAY = 144; // 10분 주기
const MAX_LIQUID_LEVY_BPS = 20; // 회당 유동자산(현금+예금)의 0.20% 상한

// 🏛️ 기본 누진 재산세 과세 구간 (500만 3%, 1000만 6%, 5000만 9%, 2억 12%, 10억 15%)
const DEFAULT_WEALTH_BRACKETS = [
  { min: 0n, max: 5000000n, rate: 0.0, name: '기본 면제 (500만 미만 0%)' },
  { min: 5000000n, max: 10000000n, rate: 0.03, name: '1구간 (500만~1,000만, 3%)' },
  { min: 10000000n, max: 50000000n, rate: 0.06, name: '2구간 (1,000만~5,000만, 6%)' },
  { min: 50000000n, max: 200000000n, rate: 0.09, name: '3구간 (5,000만~2억, 9%)' },
  { min: 200000000n, max: 1000000000n, rate: 0.12, name: '4구간 (2억~10억, 12%)' },
  { min: 1000000000n, max: null, rate: 0.15, name: '5구간 (10억 이상 초고액, 15%)' }
];

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

  // 10분 주기 분할 (1년 144회/일 기준)
  const periodLevy = totalAnnual / (BigInt(WEALTH_PERIODS_PER_DAY));
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

function getTradeTaxRate(userId) {
  if (config.isAdmin(userId)) return 0;
  return getPolicy().rate;
}

function quoteTradeTax(userId, tradeAmount) {
  const rate = getTradeTaxRate(userId);
  const amount = safeBigInt(tradeAmount);
  const tax = taxOnAmount(amount, rate);
  return {
    rate,
    tax,
    exempt: config.isAdmin(userId) || rate <= 0,
    netBuy: amount + tax,
    netSell: amount > tax ? amount - tax : 0n
  };
}

function maxBuyShareUnits(cash, price, userId) {
  const userCash = safeBigInt(cash);
  const unit = safeBigInt(price);
  const bps = rateToBps(getTradeTaxRate(userId));
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
  const cur = await readTreasury();
  const next = cur + add;
  await pool.query(
    `INSERT INTO economy_settings (key_name, value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value = ?`,
    [TREASURY_KEY, next.toString(), next.toString()]
  );
  return next;
}

// 🏛️ 국고 자금 지출/인출 (마이너스 재정 적자 전액 허용)
async function takeTreasury(amount, allowNegative = true) {
  const want = safeBigInt(amount);
  if (want <= 0n) return { took: 0n, treasury: await readTreasury() };

  const cur = await readTreasury();
  let took = want;
  if (!allowNegative && want > cur) {
    took = cur > 0n ? cur : 0n;
  }
  const next = cur - took;
  await pool.query(
    `INSERT INTO economy_settings (key_name, value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value = ?`,
    [TREASURY_KEY, next.toString(), next.toString()]
  );
  return { took, treasury: next };
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

function quoteTransferTax(senderId, recipientId, amount) {
  if (config.isAdmin(senderId) || config.isAdmin(recipientId)) {
    return { rate: 0, tax: 0n, exempt: true };
  }
  const rate = getPolicy().rate;
  return { rate, tax: taxOnAmount(amount, rate), exempt: rate <= 0 };
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
    HAVING (CAST(u.cash AS DECIMAL(65,0)) + CAST(u.bank AS DECIMAL(65,0)) + CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0))) > ?
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
        // 총 순자산(현금 + 예금 + 주식) 500만 이상이면 과세 대상
        if (snap.net < 5000000n || snap.liquid <= 0n) return 0n;

        // 🏛️ 총 순자산 기준 누진 과세 세액 산출 (500만 3%, 1000만 6%, 5000만 9%, 2억 12%, 10억 15% ...)
        const prog = computeProgressiveWealthTax(snap.net, policy.wealthTaxMultiplier);
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
          `🏛️ 누진재산세(실효 ${prog.effectiveRate}%) | 총순자산 ${formatMoneyCompact(snap.net)} (주식 ${formatMoneyCompact(snap.stock)}+유동 ${formatMoneyCompact(snap.liquid)}) | 징수 ${formatMoneyCompact(taken.took)}`
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
  return {
    rate: policy.rate,
    threshold: safeBigInt(policy.threshold).toString(),
    locked: policy.locked,
    treasury: treasury.toString(),
    last24h: last24h.toString(),
    nextCycleAt: schedule.nextCycleAt,
    intervalMs: schedule.intervalMs,
    recent
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
    `SELECT u.discord_id, u.username, u.cash, u.bank,
            CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0)) AS stock_val
     FROM users u
     LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
     LEFT JOIN stocks s ON us.stock_id = s.stock_id
     WHERE ${filter.sql}
     GROUP BY u.discord_id, u.username, u.cash, u.bank
     HAVING (CAST(u.cash AS DECIMAL(65,0)) + CAST(u.bank AS DECIMAL(65,0)) + CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0))) > ?`,
    filter.params.concat([threshold.toString()])
  );
  const samples = [];
  let total = 0n;
  let count = 0;
  for (const row of rows) {
    if (config.isAdmin(row.discord_id)) continue;
    const cash = safeBigInt(row.cash);
    const bank = safeBigInt(row.bank);
    const stock = safeBigInt(row.stock_val);
    const liquid = cash + bank;
    const net = cash + bank + stock;
    if (net < 5000000n || liquid <= 0n) continue;

    const prog = computeProgressiveWealthTax(net, policy.wealthTaxMultiplier || 1.0);
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
  settleTaxRefund
};
