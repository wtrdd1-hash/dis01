'use strict';

/**
 * 🎰 CasinoReserve - 카지노 지급 준비금 및 건전성 관리 엔진
 * 
 * 1. 모든 카지노 당첨금은 무한 발행되지 않고 준비금 풀(Casino Reserve)에서 지급
 * 2. 95% 목표 RTP 유지 및 올인 시 파산 방지 상한 캡 적용
 * 3. 베팅금의 2%는 잭팟 풀에 자동 적립
 * 4. 카지노 손익을 'CASN(황금오리 카지노)' 기업 실적에 실시간 연동
 */

const { pool } = require('../config/database');
const { safeBigInt } = require('./money');

async function getCasinoState() {
  const [rows] = await pool.query('SELECT * FROM casino_reserves WHERE id = 1 LIMIT 1');
  if (!rows.length) {
    return {
      currentReserve: 50000000n,
      totalIn: 0n,
      totalOut: 0n,
      jackpotPool: 5000000n
    };
  }
  return {
    currentReserve: safeBigInt(rows[0].current_reserve),
    totalIn: safeBigInt(rows[0].total_in),
    totalOut: safeBigInt(rows[0].total_out),
    jackpotPool: safeBigInt(rows[0].jackpot_pool)
  };
}

/**
 * 🎲 카지노 베팅 및 당첨금 원자적 정산 (준비금 연동)
 */
async function settleBetWithReserve({ userId, username = '유저', gameType, betAmount, calculatedWin, connection = null }) {
  const bet = safeBigInt(betAmount);
  const winTarget = safeBigInt(calculatedWin);

  const runner = async (conn) => {
    // 1. 카지노 준비금 Row Lock
    const [resRows] = await conn.query('SELECT * FROM casino_reserves WHERE id = 1 FOR UPDATE');
    let reserve = resRows.length ? safeBigInt(resRows[0].current_reserve) : 50000000n;
    let totalIn = resRows.length ? safeBigInt(resRows[0].total_in) : 0n;
    let totalOut = resRows.length ? safeBigInt(resRows[0].total_out) : 0n;
    let jackpot = resRows.length ? safeBigInt(resRows[0].jackpot_pool) : 5000000n;

    // 2. 유저 잔고 검증 및 Row Lock
    const [uRows] = await conn.query('SELECT cash FROM users WHERE discord_id = ? FOR UPDATE', [String(userId)]);
    if (!uRows.length) throw new Error('유저를 찾을 수 없습니다.');
    const userCash = safeBigInt(uRows[0].cash);
    if (userCash < bet) throw new Error('INSUFFICIENT_CASH');

    let actualWin = 0n;
    let isCapped = false;

    totalIn += bet;

    if (winTarget > 0n) {
      // 당첨금 상한: 카지노 준비금의 50% + 현재 베팅금 (단일 베팅으로 카지노가 거덜나는 것 방지)
      const maxPayout = (reserve / 2n) + bet;
      if (winTarget > maxPayout && maxPayout > 0n) {
        actualWin = maxPayout;
        isCapped = true;
      } else {
        actualWin = winTarget;
      }

      totalOut += actualWin;
      const netCasinoLoss = actualWin > bet ? actualWin - bet : 0n;
      const netCasinoWin = bet > actualWin ? bet - actualWin : 0n;

      reserve = reserve >= netCasinoLoss ? reserve - netCasinoLoss : 0n;
      reserve += netCasinoWin;

      // 유저 잔고 변동
      const userDelta = actualWin - bet;
      await conn.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [userDelta.toString(), String(userId)]);
    } else {
      // 꽝 (유저 패배) -> 2% 잭팟 적립, 98% 준비금 누적
      const jackpotAdd = (bet * 2n) / 100n;
      const reserveAdd = bet - jackpotAdd;

      jackpot += jackpotAdd;
      reserve += reserveAdd;

      // 🛡️ 카지노 안심 보험 카드 발동 체크 (30% 페이백)
      let refundAmount = 0n;
      try {
        const [invRows] = await conn.query(
          'SELECT id, quantity FROM user_inventory WHERE user_id = ? AND item_key = "card_casino_insurance" AND is_active = 1 AND quantity > 0 LIMIT 1',
          [String(userId)]
        );
        if (invRows.length > 0) {
          refundAmount = (bet * 30n) / 100n;
        }
      } catch (e) {}

      const finalDeduct = bet - refundAmount;
      await conn.query('UPDATE users SET cash = cash - ? WHERE discord_id = ?', [finalDeduct.toString(), String(userId)]);

      if (refundAmount > 0n) {
        await conn.query(`
          INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason)
          VALUES ('INFLOW_MINT', 'INSURANCE_PAYBACK', ?, ?, ?, ?)
        `, [
          refundAmount.toString(),
          String(userId),
          (userCash - finalDeduct).toString(),
          `🛡️ 카지노 안심 보험 30% 환급 (${gameType})`
        ]).catch(() => {});
      }

      // 카지노 실적 호조 -> CASN 기업 이익 풀에 30% 영업이익 적립
      const casnProfit = (bet * 30n) / 100n;
      await conn.query(`
        INSERT INTO corporate_earnings (stock_id, earnings_pool, total_revenue)
        VALUES ('CASN', 10000000 + ?, ?)
        ON DUPLICATE KEY UPDATE 
          earnings_pool = earnings_pool + VALUES(earnings_pool),
          total_revenue = total_revenue + VALUES(total_revenue);
      `, [casnProfit.toString(), bet.toString()]).catch(() => {});
    }

    // 준비금 갱신
    await conn.query(`
      INSERT INTO casino_reserves (id, current_reserve, total_in, total_out, jackpot_pool)
      VALUES (1, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        current_reserve = VALUES(current_reserve),
        total_in = VALUES(total_in),
        total_out = VALUES(total_out),
        jackpot_pool = VALUES(jackpot_pool),
        updated_at = NOW()
    `, [reserve.toString(), totalIn.toString(), totalOut.toString(), jackpot.toString()]);

    const finalCash = userCash - bet + actualWin;

    // 통합 흐름 원장 (economy_flow_logs) 기록
    if (actualWin > bet) {
      await conn.query(`
        INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason, metadata)
        VALUES ('INFLOW_MINT', 'CASINO_WIN', ?, ?, ?, ?, ?)
      `, [
        (actualWin - bet).toString(),
        String(userId),
        finalCash.toString(),
        `카지노 ${gameType} 승리`,
        JSON.stringify({ gameType, bet: bet.toString(), win: actualWin.toString(), isCapped })
      ]);
    } else if (bet > actualWin) {
      await conn.query(`
        INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason, metadata)
        VALUES ('OUTFLOW_SINK', 'CASINO_LOSS', ?, ?, ?, ?, ?)
      `, [
        (bet - actualWin).toString(),
        String(userId),
        finalCash.toString(),
        `카지노 ${gameType} 손실`,
        JSON.stringify({ gameType, bet: bet.toString(), win: actualWin.toString() })
      ]);
    }

    // 도박 로그 기록
    await conn.query(`
      INSERT INTO gambling_logs (user_id, game_type, bet, payout, net_profit, balance_after, result)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      String(userId),
      gameType,
      bet.toString(),
      actualWin.toString(),
      (actualWin - bet).toString(),
      finalCash.toString(),
      actualWin > bet ? 'WIN' : (actualWin === bet ? 'DRAW' : 'LOSE')
    ]);

    return {
      success: true,
      bet,
      win: actualWin,
      netProfit: actualWin - bet,
      userCashAfter: finalCash,
      casinoReserveAfter: reserve,
      isCapped
    };
  };

  if (connection) {
    return runner(connection);
  }

  const { pool: dbPool } = require('../config/database');
  const conn = await dbPool.getConnection();
  await conn.beginTransaction();
  try {
    const res = await runner(conn);
    await conn.commit();
    return res;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  getCasinoState,
  settleBetWithReserve
};
