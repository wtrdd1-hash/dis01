'use strict';

const { pool } = require('../config/database');

class LedgerModel {
  /**
   * 경제 흐름(인플레 유입/소각) 원장 기록
   */
  static async logEconomyFlow(userId, flowType, category, amount, reason = '', details = {}) {
    try {
      await pool.query(`
        INSERT INTO economy_flow_logs (user_id, flow_type, category, amount, reason, details)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        userId ? String(userId) : null,
        flowType,
        category,
        amount.toString(),
        reason,
        JSON.stringify(details || {})
      ]);
    } catch (e) {
      console.error('[LedgerModel] economy_flow_logs 기록 실패:', e.message);
    }
  }

  /**
   * 카지노 & 게임 플레이 감사 로그 기록
   */
  static async logGambling(userId, game, bet, payout, profit, balanceBefore, balanceAfter, details = {}) {
    try {
      await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        String(userId),
        game,
        bet.toString(),
        payout.toString(),
        profit.toString(),
        balanceBefore.toString(),
        balanceAfter.toString(),
        JSON.stringify(details || {})
      ]);
    } catch (e) {
      console.error('[LedgerModel] gambling_logs 기록 실패:', e.message);
    }
  }

  /**
   * 관리자 활동 감사 로그 기록
   */
  static async logAdminAction(adminId, adminUsername, action, targetUserId, details = {}, ip = null, country = null) {
    try {
      await pool.query(`
        INSERT INTO admin_logs (admin_id, admin_username, action, target_user_id, details, ip, country)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        String(adminId),
        adminUsername || String(adminId) || '관리자',
        action,
        targetUserId ? String(targetUserId) : null,
        JSON.stringify(details || {}),
        ip || null,
        country || null
      ]);
    } catch (e) {
      console.error('[LedgerModel] admin_logs 기록 실패:', e.message);
    }
  }
}

module.exports = LedgerModel;
