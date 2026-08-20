/**
 * 블랙잭 미종료 배팅 보관.
 * 배팅 차감과 세션 INSERT를 한 트랜잭션으로 묶고,
 * 정산/환불은 status='playing' 행을 먼저 점유한 뒤에만 지급한다.
 */
const { pool } = require('../config/database');
const { safeBigInt } = require('./money');

function notifyLive(userId) {
  try {
    require('./liveSync').pushUserLive(userId);
  } catch (e) {}
}

function serializeState(state) {
  if (!state) return null;
  return JSON.stringify(state, (_, val) => (typeof val === 'bigint' ? val.toString() : val));
}

function playingError() {
  const err = new Error('이미 진행 중인 블랙잭이 있습니다.');
  err.status = 409;
  err.code = 'BJ_IN_PROGRESS';
  return err;
}

async function openAndHoldBet(userId, source, betAmount, balanceBefore, state) {
  const id = String(userId);
  const bet = safeBigInt(betAmount);
  const before = safeBigInt(balanceBefore);
  const src = source === 'discord' ? 'discord' : 'web';
  if (bet <= 0n) {
    const err = new Error('배팅 금액이 올바르지 않습니다.');
    err.status = 400;
    throw err;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query(
      'SELECT user_id FROM blackjack_sessions WHERE user_id = ? AND status = ? FOR UPDATE',
      [id, 'playing']
    );
    if (existing.length) {
      await conn.rollback();
      throw playingError();
    }

    const [deduct] = await conn.query(
      'UPDATE users SET cash = cash + ? WHERE discord_id = ? AND cash >= ?',
      [(-bet).toString(), id, bet.toString()]
    );
    if (!deduct.affectedRows) {
      await conn.rollback();
      const err = new Error('보유 현금이 부족합니다.');
      err.code = 'INSUFFICIENT_CASH';
      err.status = 400;
      throw err;
    }

    await conn.query(
      `INSERT INTO blackjack_sessions (user_id, source, bet, balance_before, status, state_json)
       VALUES (?, ?, ?, ?, 'playing', ?)`,
      [id, src, bet.toString(), before.toString(), serializeState(state)]
    );
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
      throw playingError();
    }
    throw err;
  } finally {
    conn.release();
  }
  notifyLive(id);
}

async function increaseBet(userId, extraAmount) {
  const id = String(userId);
  const extra = safeBigInt(extraAmount);
  if (extra <= 0n) {
    const err = new Error('추가 배팅 금액이 올바르지 않습니다.');
    err.status = 400;
    throw err;
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT bet FROM blackjack_sessions WHERE user_id = ? AND status = ? FOR UPDATE',
      [id, 'playing']
    );
    if (!rows.length) {
      await conn.rollback();
      const err = new Error('진행 중인 블랙잭이 없습니다.');
      err.status = 400;
      throw err;
    }
    const [deduct] = await conn.query(
      'UPDATE users SET cash = cash + ? WHERE discord_id = ? AND cash >= ?',
      [(-extra).toString(), id, extra.toString()]
    );
    if (!deduct.affectedRows) {
      await conn.rollback();
      const err = new Error('더블다운을 위한 잔액이 부족합니다.');
      err.code = 'INSUFFICIENT_CASH';
      err.status = 400;
      throw err;
    }
    await conn.query(
      'UPDATE blackjack_sessions SET bet = bet + ? WHERE user_id = ? AND status = ?',
      [extra.toString(), id, 'playing']
    );
    await conn.commit();
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    throw err;
  } finally {
    conn.release();
  }
  notifyLive(id);
}

async function updateSession(userId, { bet, state } = {}) {
  const id = String(userId);
  const fields = [];
  const params = [];
  if (bet !== undefined) {
    fields.push('bet = ?');
    params.push(safeBigInt(bet).toString());
  }
  if (state !== undefined) {
    fields.push('state_json = ?');
    params.push(serializeState(state));
  }
  if (!fields.length) return;
  params.push(id);
  await pool.query(
    `UPDATE blackjack_sessions SET ${fields.join(', ')} WHERE user_id = ? AND status = 'playing'`,
    params
  );
}

async function claimSession(userId, nextStatus) {
  const id = String(userId);
  const status = nextStatus === 'refunded' ? 'refunded' : 'settled';
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT user_id, source, bet, balance_before, status FROM blackjack_sessions WHERE user_id = ? AND status = ? FOR UPDATE',
      [id, 'playing']
    );
    if (!rows.length) {
      await conn.rollback();
      return null;
    }
    await conn.query(
      'DELETE FROM blackjack_sessions WHERE user_id = ? AND status = ?',
      [id, 'playing']
    );
    await conn.commit();
    return {
      userId: rows[0].user_id,
      source: rows[0].source,
      bet: safeBigInt(rows[0].bet),
      balanceBefore: safeBigInt(rows[0].balance_before)
    };
  } catch (err) {
    try { await conn.rollback(); } catch (e) {}
    throw err;
  } finally {
    conn.release();
  }
}

async function logRefund(userId, bet, balanceBefore, newCash, reason) {
  try {
    await pool.query(
      `INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(userId),
        '블랙잭환불',
        bet.toString(),
        bet.toString(),
        '0',
        balanceBefore.toString(),
        newCash.toString(),
        JSON.stringify({ reason: String(reason || 'refund') })
      ]
    );
  } catch (e) {}
}

async function refundClaimed(claimed, reason) {
  if (!claimed) return null;
  const { applyCashDelta } = require('./money');
  const newCash = await applyCashDelta(claimed.userId, claimed.bet);
  await logRefund(claimed.userId, claimed.bet, claimed.balanceBefore, newCash, reason);
  return newCash;
}

async function refundUser(userId, reason) {
  const claimed = await claimSession(userId, 'refunded');
  return refundClaimed(claimed, reason);
}

async function refundOpenSessions() {
  const [rows] = await pool.query(
    'SELECT user_id FROM blackjack_sessions WHERE status = ?',
    ['playing']
  );
  let count = 0;
  for (const row of rows) {
    try {
      const claimed = await claimSession(row.user_id, 'refunded');
      if (!claimed) continue;
      await refundClaimed(claimed, 'restart');
      count += 1;
    } catch (err) {
      console.error(`[blackjack] 재시작 환불 실패 (${row.user_id}):`, err.message);
    }
  }
  try {
    await pool.query(
      `DELETE FROM blackjack_sessions
       WHERE status IN ('settled', 'refunded')
         AND updated_at < DATE_SUB(NOW(), INTERVAL 1 DAY)`
    );
  } catch (e) {}
  return count;
}

async function hasOpenSession(userId) {
  const [rows] = await pool.query(
    'SELECT user_id FROM blackjack_sessions WHERE user_id = ? AND status = ? LIMIT 1',
    [String(userId), 'playing']
  );
  return rows.length > 0;
}

module.exports = {
  openAndHoldBet,
  updateSession,
  increaseBet,
  claimSession,
  refundUser,
  refundOpenSessions,
  hasOpenSession
};
