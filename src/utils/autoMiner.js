/**
 * 자동 채굴 엔진 (너프 & 돈 흐름 로그 적용 버전)
 *
 * - 1초마다 auto_miner_level > 0 인 유저에게
 *   cash += auto_miner_level * BASE * (globalNerf * userMod) 적용
 * - 모든 지급을 economy_logs (type='MINING_AUTO')에 기록
 * - 유저별 너프 (user_economy_modifier 테이블) 적용
 */
const { pool } = require('../config/database');
const { logInfo, logError } = require('./logger');
const { pushUserLive, listConnectedUserIds } = require('./liveSync');
const { CLICKER } = require('./economyBalance');
const { computeFinalMultipliers } = require('./economyModifier');

const TICK_MS = 1000;
const BASE_CURRENCY_PER_LEVEL_PER_SEC = CLICKER.AUTO_PER_LEVEL_PER_SEC;
const AUTO_MINER_MAX_LEVEL = 50;
const MIN_PAYOUT_THRESHOLD = 1n;

let lastTickAt = null;
let lastPaidCount = 0;
let totalTicks = 0;
let dailyStats = { date: null, totalPayout: 0n, payoutCount: 0 };

function resetDailyStatsIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyStats.date !== today) {
    dailyStats = { date: today, totalPayout: 0n, payoutCount: 0 };
  }
}

async function processAutoMinerTick() {
  lastTickAt = new Date();
  totalTicks++;
  resetDailyStatsIfNeeded();

  try {
    let multiplier = 1.0;
    try {
      const { getDynamicSettings } = require('./economyBalancer');
      const dyn = getDynamicSettings();
      if (dyn && Number.isFinite(Number(dyn.autoMinerMultiplier))) {
        multiplier = Number(dyn.autoMinerMultiplier);
      }
    } catch (e) {}

    const basePerLevel = Math.max(1, Math.round(BASE_CURRENCY_PER_LEVEL_PER_SEC * multiplier));

    const [targetUsers] = await pool.query(
      `SELECT discord_id, username, auto_miner_level, cash
       FROM users
       WHERE auto_miner_level > 0
         AND discord_id != '886478189520637992'
       LIMIT 1000`
    );

    if (!targetUsers.length) return;

    let totalPaidThisTick = 0n;
    let paidCount = 0;

    for (const u of targetUsers) {
      const userId = String(u.discord_id);
      const lvl = Math.min(AUTO_MINER_MAX_LEVEL, Number(u.auto_miner_level) || 0);
      if (lvl <= 0) continue;

      const finalMult = await computeFinalMultipliers(userId);
      if (finalMult.emergencyLock) continue;

      const userMultiplier = finalMult.auto;
      if (userMultiplier <= 0) continue;

      const perLevelPay = Math.max(0, Math.floor(basePerLevel * userMultiplier));
      const rawPay = BigInt(perLevelPay) * BigInt(lvl);
      if (rawPay < MIN_PAYOUT_THRESHOLD) continue;

      const currentCash = BigInt(u.cash || 0);
      let newCash = currentCash + rawPay;

      if (finalMult.cashCap !== null && finalMult.cashCap !== undefined && newCash > BigInt(finalMult.cashCap)) {
        newCash = BigInt(finalMult.cashCap);
      }
      const actualPay = newCash - currentCash;
      if (actualPay <= 0n) continue;

      try {
        await pool.query(
          'UPDATE users SET cash = ? WHERE discord_id = ? AND cash = ?',
          [newCash.toString(), userId, currentCash.toString()]
        );

        await pool.query(
          `INSERT INTO economy_logs
           (user_id, username, type, amount, balance_before, balance_after, description)
           VALUES (?, ?, 'MINING_AUTO', ?, ?, ?, ?)`,
          [
            userId,
            u.username || `유저_${userId.slice(-4)}`,
            actualPay.toString(),
            currentCash.toString(),
            newCash.toString(),
            `자동채굴 Lv${lvl} (+${perPayFormat(actualPay)})`.slice(0, 250)
          ]
        ).catch((le) => { /* 테이블 없으면 무시 */ });

        totalPaidThisTick += actualPay;
        paidCount++;
      } catch (e) {
        if (totalTicks % 60 === 1) {
          logError('AutoMiner', `유저 ${userId} 자동채굴 실패`, e);
        }
      }
    }

    dailyStats.totalPayout += totalPaidThisTick;
    dailyStats.payoutCount += paidCount;

    lastPaidCount = paidCount;

    if (paidCount > 0) {
      try {
        const ids = listConnectedUserIds();
        if (ids.length > 0) {
          for (const id of ids) {
            try { pushUserLive(id); } catch (e) {}
          }
        }
      } catch (e) {}
    }

    if (totalTicks % 60 === 0) {
      console.log(`⛏️ [AutoMiner] 틱 ${totalTicks} - ${paidCount}명에게 총 ${perPayFormat(totalPaidThisTick)} 지급 (오늘 누적: ${perPayFormat(dailyStats.totalPayout)})`);
    }
  } catch (err) {
    if (totalTicks % 30 === 1) {
      logError('AutoMiner', '자동채굴 1초 틱 오류', err);
    }
  }
}

function perPayFormat(amount) {
  try {
    const n = BigInt(amount);
    if (n >= 1000000000000n) return (Number(n / 100000000n) / 10).toFixed(1) + '억';
    if (n >= 100000000n) return (Number(n / 10000n) / 10000).toFixed(2) + '억';
    if (n >= 10000n) return (Number(n / 10000n) / 10).toFixed(1) + '만';
    return Number(n).toLocaleString() + '원';
  } catch (e) {
    return String(amount);
  }
}

function startAutoMiner() {
  logInfo(
    'AutoMiner',
    `자동 채굴 엔진 가동 (주기: ${TICK_MS / 1000}초, Lv당 +${BASE_CURRENCY_PER_LEVEL_PER_SEC}원/초 × 유저별 너프 적용)`
  );
  setTimeout(processAutoMinerTick, 3000);
  setInterval(processAutoMinerTick, TICK_MS);
}

function getAutoMinerStats() {
  return {
    lastTickAt,
    lastPaidCount,
    totalTicks,
    dailyPayout: dailyStats.totalPayout.toString(),
    dailyPayoutText: perPayFormat(dailyStats.totalPayout),
    dailyPayoutCount: dailyStats.payoutCount,
    date: dailyStats.date
  };
}

module.exports = {
  startAutoMiner,
  processAutoMinerTick,
  getAutoMinerStats
};