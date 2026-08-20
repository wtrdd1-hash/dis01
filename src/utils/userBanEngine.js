'use strict';

const { pool } = require('../config/database');

const BAN_CACHE_TTL_MS = 5000;
const banStatusCache = new Map();

function invalidateBanStatus(userId) {
  if (userId) banStatusCache.delete(String(userId));
}

function cacheBanStatus(userId, status) {
  banStatusCache.set(String(userId), { status, expiresAt: Date.now() + BAN_CACHE_TTL_MS });
  return status;
}

function readCachedBanStatus(userId) {
  const cached = banStatusCache.get(String(userId));
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    banStatusCache.delete(String(userId));
    return null;
  }
  return cached.status;
}

/**
 * 유저의 로그인 및 서비스 이용 차단 상태를 확인한다.
 * 보안 경계에서는 { failClosed: true }를 사용해 DB 장애 시 우회를 막는다.
 */
async function checkUserBanStatus(userId, options = {}) {
  if (!userId) return { isBanned: false };
  const targetId = String(userId);
  const cached = readCachedBanStatus(targetId);
  if (cached) return cached;

  try {
    const [rows] = await pool.query(
      'SELECT is_banned, banned_until, ban_reason, banned_at, banned_by FROM users WHERE discord_id = ? LIMIT 1',
      [targetId]
    );

    if (!rows.length || !rows[0].is_banned) {
      return cacheBanStatus(targetId, { isBanned: false });
    }

    const u = rows[0];
    const now = Date.now();
    if (u.banned_until) {
      const untilTime = new Date(u.banned_until).getTime();
      if (Number.isFinite(untilTime) && untilTime <= now) {
        await pool.query(
          `UPDATE users
           SET is_banned = 0, banned_until = NULL, ban_reason = NULL,
               banned_at = NULL, banned_by = NULL
           WHERE discord_id = ?`,
          [targetId]
        );
        console.log(`[user-ban] timed ban expired for user ${targetId}`);
        return cacheBanStatus(targetId, { isBanned: false });
      }

      const remainingMs = Math.max(0, untilTime - now);
      const remainingMinutes = Math.ceil(remainingMs / 60000);
      const hours = Math.floor(remainingMinutes / 60);
      const mins = remainingMinutes % 60;
      return cacheBanStatus(targetId, {
        isBanned: true,
        isPermanent: false,
        bannedUntil: u.banned_until,
        bannedAt: u.banned_at,
        bannedBy: u.banned_by,
        reason: u.ban_reason || '관리자 지정 로그인 차단',
        remainingMinutes,
        remainingText: hours > 0 ? `${hours}시간 ${mins}분` : `${mins}분`
      });
    }

    return cacheBanStatus(targetId, {
      isBanned: true,
      isPermanent: true,
      bannedUntil: null,
      bannedAt: u.banned_at,
      bannedBy: u.banned_by,
      reason: u.ban_reason || '관리자 지정 영구 로그인 차단',
      remainingMinutes: -1,
      remainingText: '영구 차단'
    });
  } catch (err) {
    console.error('[user-ban] status lookup failed:', err);
    if (options.failClosed) {
      const wrapped = new Error('사용자 이용 가능 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      wrapped.code = 'BAN_STATUS_UNAVAILABLE';
      wrapped.cause = err;
      throw wrapped;
    }
    return { isBanned: false, checkFailed: true };
  }
}

async function disconnectUserSessions(userId, reason) {
  const io = global.__io;
  if (!io || !userId) return;
  try {
    const sockets = await io.in(`user:${String(userId)}`).fetchSockets();
    for (const socket of sockets) {
      socket.emit('account:banned', { reason: reason || '계정 이용이 제한되었습니다.' });
      socket.disconnect(true);
    }
  } catch (err) {
    console.warn('[user-ban] socket disconnect failed:', err.message);
  }
}

/**
 * 차단 설정, 보유 주식 청산, 현금 지급, 감사 로그를 하나의 트랜잭션으로 처리한다.
 */
async function banUser(userId, adminId, adminUsername, options = {}) {
  const targetId = String(userId || '').trim();
  const hours = options.hours !== undefined && options.hours !== null ? Number(options.hours) : 0;
  const reason = String(options.reason || '관리자 직권 로그인 차단').trim().slice(0, 255);
  if (!targetId) throw new Error('유저 ID가 유효하지 않습니다.');
  if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 365 * 10) {
    throw new Error('차단 시간은 0(영구)부터 87,600시간 사이여야 합니다.');
  }

  const { safeBigInt } = require('./moneyValue');
  const { amountToUnits, mulPriceAmount } = require('./moneyScale');
  const connection = await pool.getConnection();
  let username = '';
  let bannedUntil = null;
  let liquidatedTotalAmount = 0n;
  let liquidatedStocksCount = 0;
  const liquidatedList = [];

  try {
    await connection.beginTransaction();
    const [uRows] = await connection.query(
      'SELECT username, cash FROM users WHERE discord_id = ? LIMIT 1 FOR UPDATE',
      [targetId]
    );
    if (!uRows.length) throw new Error('존재하지 않는 유저 계정입니다.');
    username = uRows[0].username || `유저_${targetId.slice(-4)}`;
    const beforeCash = safeBigInt(uRows[0].cash);

    if (hours > 0) {
      await connection.query(`
        UPDATE users
        SET is_banned = 1,
            banned_until = DATE_ADD(NOW(), INTERVAL ? HOUR),
            ban_reason = ?, banned_at = NOW(), banned_by = ?
        WHERE discord_id = ?
      `, [hours, reason, adminUsername || adminId, targetId]);
      const [after] = await connection.query('SELECT banned_until FROM users WHERE discord_id = ?', [targetId]);
      bannedUntil = after[0]?.banned_until || null;
    } else {
      await connection.query(`
        UPDATE users
        SET is_banned = 1, banned_until = NULL,
            ban_reason = ?, banned_at = NOW(), banned_by = ?
        WHERE discord_id = ?
      `, [reason, adminUsername || adminId, targetId]);
    }

    const [holdings] = await connection.query(`
      SELECT us.stock_id, us.amount, s.name AS stock_name, s.price
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.stock_id
      WHERE us.user_id = ? AND us.amount > 0
      FOR UPDATE
    `, [targetId]);

    for (const holding of holdings) {
      if (amountToUnits(holding.amount) <= 0n) continue;
      const currentPrice = safeBigInt(holding.price);
      const payout = mulPriceAmount(currentPrice, holding.amount);
      if (payout <= 0n) continue;

      liquidatedTotalAmount += payout;
      liquidatedStocksCount += 1;
      liquidatedList.push({
        stockId: holding.stock_id,
        stockName: holding.stock_name,
        amount: String(holding.amount),
        price: currentPrice.toString(),
        payout: payout.toString()
      });
      await connection.query(`
        INSERT INTO stock_transactions
          (user_id, username, stock_id, stock_name, action, amount, price, total_price)
        VALUES (?, ?, ?, ?, 'SELL', ?, ?, ?)
      `, [
        targetId,
        username,
        holding.stock_id,
        holding.stock_name,
        String(holding.amount),
        currentPrice.toString(),
        payout.toString()
      ]);
    }

    if (holdings.length) {
      await connection.query('DELETE FROM user_stocks WHERE user_id = ?', [targetId]);
    }

    if (liquidatedTotalAmount > 0n) {
      const afterCash = beforeCash + liquidatedTotalAmount;
      await connection.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [
        liquidatedTotalAmount.toString(),
        targetId
      ]);
      await connection.query(`
        INSERT INTO economy_logs
          (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'STOCK_SELL', ?, ?, ?, ?)
      `, [
        targetId,
        username,
        liquidatedTotalAmount.toString(),
        beforeCash.toString(),
        afterCash.toString(),
        `[계정 차단 자동 청산] 보유 주식 ${liquidatedStocksCount}개 종목 전량 시장가 매도 정산`
      ]);
    }

    await connection.query(`
      INSERT INTO user_ban_logs
        (user_id, username, admin_id, admin_username, action, duration_hours, banned_until, reason)
      VALUES (?, ?, ?, ?, 'BAN', ?, ?, ?)
    `, [
      targetId,
      username,
      String(adminId || 'SYSTEM'),
      String(adminUsername || 'SYSTEM'),
      hours > 0 ? hours : null,
      bannedUntil,
      reason
    ]);

    await connection.commit();
  } catch (err) {
    await connection.rollback().catch(() => {});
    throw err;
  } finally {
    connection.release();
  }

  invalidateBanStatus(targetId);
  try { require('./liveSync').invalidateUser(targetId); } catch (_) {}
  await disconnectUserSessions(targetId, reason);
  console.log(`[user-ban] ${username}(${targetId}) blocked; liquidated=${liquidatedStocksCount}`);

  return {
    userId: targetId,
    username,
    isPermanent: hours <= 0,
    durationHours: hours,
    bannedUntil,
    reason,
    liquidatedStocksCount,
    liquidatedTotalAmount: liquidatedTotalAmount.toString(),
    liquidatedList
  };
}

async function unbanUser(userId, adminId, adminUsername, reason = '관리자 직권 차단 해제') {
  const targetId = String(userId || '').trim();
  if (!targetId) throw new Error('유저 ID가 유효하지 않습니다.');

  const connection = await pool.getConnection();
  let username = '';
  try {
    await connection.beginTransaction();
    const [uRows] = await connection.query(
      'SELECT username FROM users WHERE discord_id = ? LIMIT 1 FOR UPDATE',
      [targetId]
    );
    if (!uRows.length) throw new Error('존재하지 않는 유저 계정입니다.');
    username = uRows[0].username || `유저_${targetId.slice(-4)}`;

    await connection.query(`
      UPDATE users
      SET is_banned = 0, banned_until = NULL, ban_reason = NULL,
          banned_at = NULL, banned_by = NULL
      WHERE discord_id = ?
    `, [targetId]);
    await connection.query(`
      INSERT INTO user_ban_logs
        (user_id, username, admin_id, admin_username, action, duration_hours, banned_until, reason)
      VALUES (?, ?, ?, ?, 'UNBAN', NULL, NULL, ?)
    `, [
      targetId,
      username,
      String(adminId || 'SYSTEM'),
      String(adminUsername || 'SYSTEM'),
      String(reason || '관리자 직권 차단 해제').slice(0, 255)
    ]);
    await connection.commit();
  } catch (err) {
    await connection.rollback().catch(() => {});
    throw err;
  } finally {
    connection.release();
  }

  invalidateBanStatus(targetId);
  console.log(`[user-ban] ${username}(${targetId}) restored by ${adminUsername || adminId}`);
  return { userId: targetId, username, success: true };
}

module.exports = {
  checkUserBanStatus,
  invalidateBanStatus,
  banUser,
  unbanUser
};
