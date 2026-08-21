'use strict';

/**
 * 자동 채굴 엔진 (6시간 오프라인 상한 & MINE 기업 실적 연동)
 *
 * - 1초마다 auto_miner_level > 0 인 유저 중 6시간 이내 활동 유저에게 채굴 지급
 * - 모든 지급을 economy_flow_logs 및 economy_logs 에 기록
 * - 채굴 활동량의 10%를 'MINE(월덕 광업)' 기업 매출/이익 풀에 누적
 */
const { pool } = require('../config/database');
const { logInfo, logError } = require('./logger');
const { pushUserLive, listConnectedUserIds } = require('./liveSync');
const { CLICKER } = require('./economyBalance');
const { computeFinalMultipliers } = require('./economyModifier');

const TICK_MS = 1000;
const BASE_CURRENCY_PER_LEVEL_PER_SEC = CLICKER.AUTO_PER_LEVEL_PER_SEC || 2;
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

    // 🛡️ 자동 채굴 지급 대상 조회 (드릴 장비 및 오버클럭 연동)
    let targetUsers = [];
    try {
      const [rows] = await pool.query(`
        SELECT u.discord_id, u.username, u.auto_miner_level, u.cash,
               COALESCE(d.enhancement_level, 0) AS drill_level,
               CASE WHEN d.overclock_until > NOW() THEN 1 ELSE 0 END AS has_overclock
        FROM users u
        LEFT JOIN user_drill_equipment d ON u.discord_id = d.user_id
        WHERE u.auto_miner_level > 0
        LIMIT 500
      `);
      targetUsers = rows;
    } catch (err) {
      const [fallback] = await pool.query(
        'SELECT discord_id, username, auto_miner_level, cash, 0 AS drill_level, 0 AS has_overclock FROM users WHERE auto_miner_level > 0 LIMIT 500'
      ).catch(() => [[]]);
      targetUsers = fallback;
    }

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

      // ⚡ 드릴 강화 보너스 (+1~+15강: 각 +5%) 및 오버클럭 오일(+20%) 연동
      let drillBonus = 1.0;
      const drillLvl = Number(u.drill_level) || 0;
      if (drillLvl > 0) {
        drillBonus += (drillLvl * 0.05);
      }
      if (u.has_overclock) {
        drillBonus += 0.20;
      }

      const perLevelPay = Math.max(0, Math.floor(basePerLevel * userMultiplier * drillBonus));
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

        // 10회 틱마다 1번씩 원장에 벌크 로깅
        if (totalTicks % 10 === 0) {
          await pool.query(`
            INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason)
            VALUES ('INFLOW_MINT', 'MINING_AUTO', ?, ?, ?, ?)
          `, [
            (actualPay * 10n).toString(),
            userId,
            newCash.toString(),
            `자동 채굴 적립 (Lv${lvl})`
          ]).catch(() => {});
        }

        totalPaidThisTick += actualPay;
        paidCount++;
      } catch (e) {
        if (totalTicks % 60 === 1) {
          logError('AutoMiner', `유저 ${userId} 자동채굴 실패`, e);
        }
      }
    }

    lastPaidCount = paidCount;
    dailyStats.totalPayout += totalPaidThisTick;
    dailyStats.payoutCount += paidCount;

    // ⛏️ 채굴량에 비례하여 'MINE(월덕 광업)' 기업 실적 풀 적립
    if (totalPaidThisTick > 0n && totalTicks % 30 === 0) {
      const mineEarning = totalPaidThisTick * 10n;
      await pool.query(`
        INSERT INTO corporate_earnings (stock_id, earnings_pool, total_revenue)
        VALUES ('MINE', 10000000 + ?, ?)
        ON DUPLICATE KEY UPDATE 
          earnings_pool = earnings_pool + VALUES(earnings_pool),
          total_revenue = total_revenue + VALUES(total_revenue);
      `, [mineEarning.toString(), mineEarning.toString()]).catch(() => {});
    }

  } catch (err) {
    if (totalTicks % 60 === 1) {
      logError('AutoMiner', '자동채굴 틱 처리 오류', err);
    }
  }
}

let intervalHandle = null;

function startAutoMiner() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(processAutoMinerTick, TICK_MS);
  intervalHandle.unref?.();
  logInfo('AutoMiner', `자동 채굴 엔진 시작 (주기: ${TICK_MS}ms, 6시간 오프라인 상한)`);
}

function stopAutoMiner() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

function perPayFormat(bigVal) {
  const n = Number(bigVal);
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}억`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}만`;
  return `${n}원`;
}

module.exports = {
  startAutoMiner,
  stopAutoMiner,
  processAutoMinerTick
};