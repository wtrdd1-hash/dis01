'use strict';

const { pool, getOrCreateUser } = require('../config/database');
const { safeBigInt, applyCashDelta } = require('../utils/money');

class UserModel {
  /**
   * 유저 단건 조회 또는 생성
   */
  static async findById(discordId, username = null, avatar = null) {
    if (!discordId) return null;
    return getOrCreateUser(String(discordId), username, avatar);
  }

  static async findOrCreate(discordId, username = null, avatar = null) {
    return UserModel.findById(discordId, username, avatar);
  }

  /**
   * 유저 현금 및 은행 잔액 조회
   */
  static async getBalance(discordId) {
    const id = String(discordId);
    const [rows] = await pool.query('SELECT cash, bank, clicker_level, auto_miner_level FROM users WHERE discord_id = ?', [id]);
    if (!rows.length) return { cash: 0n, bank: 0n, clickerLevel: 1, autoLevel: 0 };
    return {
      cash: safeBigInt(rows[0].cash),
      bank: safeBigInt(rows[0].bank),
      clickerLevel: Number(rows[0].clicker_level || 1),
      autoLevel: Number(rows[0].auto_miner_level || 0)
    };
  }

  /**
   * 유저 현금 변동 (Delta 적용)
   */
  static async updateCash(discordId, deltaBigInt) {
    return applyCashDelta(String(discordId), deltaBigInt);
  }

  /**
   * 유저 은행 잔액 입금 / 출금 트랜잭션
   */
  static async transferBank(discordId, type, amount) {
    const id = String(discordId);
    const amt = safeBigInt(amount);
    if (amt <= 0n) throw new Error('이체 금액이 올바르지 않습니다.');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query('SELECT cash, bank FROM users WHERE discord_id = ? FOR UPDATE', [id]);
      if (!rows.length) throw new Error('유저를 찾을 수 없습니다.');

      const cash = safeBigInt(rows[0].cash);
      const bank = safeBigInt(rows[0].bank);

      if (type === 'DEPOSIT') {
        if (cash < amt) throw new Error('보유 현금이 부족합니다.');
        await conn.query('UPDATE users SET cash = cash - ?, bank = bank + ? WHERE discord_id = ?', [amt.toString(), amt.toString(), id]);
      } else if (type === 'WITHDRAW') {
        if (bank < amt) throw new Error('은행 잔고가 부족합니다.');
        await conn.query('UPDATE users SET cash = cash + ?, bank = bank - ? WHERE discord_id = ?', [amt.toString(), amt.toString(), id]);
      } else {
        throw new Error('올바르지 않은 이체 유형입니다.');
      }

      await conn.commit();
      const newCash = type === 'DEPOSIT' ? cash - amt : cash + amt;
      const newBank = type === 'DEPOSIT' ? bank + amt : bank - amt;
      return { success: true, cash: newCash.toString(), bank: newBank.toString() };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * 일일 출석체크 보상 수령
   */
  static async claimDaily(discordId) {
    const id = String(discordId);
    const user = await getOrCreateUser(id);
    const now = new Date();
    const lastDaily = user.last_daily ? new Date(user.last_daily) : null;

    if (lastDaily && (now.getTime() - lastDaily.getTime() < 24 * 60 * 60 * 1000)) {
      const waitMs = (24 * 60 * 60 * 1000) - (now.getTime() - lastDaily.getTime());
      const hours = Math.ceil(waitMs / (1000 * 60 * 60));
      return { success: false, error: `오늘의 일일 보상을 이미 받았습니다. (약 ${hours}시간 후 가능)` };
    }

    const streak = (user.daily_streak || 0) + 1;
    const baseReward = 50000n;
    const bonus = BigInt(Math.min(streak, 30)) * 5000n;
    const totalReward = baseReward + bonus;

    const newCash = await applyCashDelta(id, totalReward);
    await pool.query('UPDATE users SET daily_streak = ?, last_daily = NOW() WHERE discord_id = ?', [streak, id]);

    return {
      success: true,
      reward: totalReward.toString(),
      streak,
      newCash: newCash.toString()
    };
  }

  /**
   * 관리자 권한 및 IP 화이트리스트 검증
   */
  static async checkAdminAccess(discordId, clientIp, config) {
    if (!discordId || !config.isAdmin(discordId)) return { allowed: false, reason: 'ADMIN_REQUIRED' };

    try {
      const [rows] = await pool.query('SELECT ip_address, is_active FROM admin_ip_whitelist WHERE is_active = 1');
      if (rows.length === 0) return { allowed: true }; // 등록된 화이트리스트가 없으면 관리자 통과

      const ip = String(clientIp || '').trim();
      const matched = rows.some(r => r.ip_address === ip || r.ip_address === '127.0.0.1' || r.ip_address === '::1');
      if (!matched) return { allowed: false, reason: 'IP_NOT_WHITELISTED', clientIp: ip };

      return { allowed: true };
    } catch (e) {
      return { allowed: true };
    }
  }
}

module.exports = UserModel;
