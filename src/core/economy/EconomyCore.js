'use strict';

/**
 * 🏛️ EconomyCore - 월덕 가상 경제 단일 통합 코어 (Single Source of Truth)
 * 
 * 모든 자산 변동(현금/예금/주식), 세금/국고, 이자/대출, 카지노/채굴, 거시경제 밸런싱을
 * 단 하나의 통합 코어를 거쳐 원자적(Atomic) ACID 트랜잭션 및 통합 원장(economy_flow_logs)에 기록합니다.
 */

const { pool } = require('../../config/database');
const config = require('../../config/config');
const money = require('../../utils/money');
const moneyScale = require('../../utils/moneyScale');
const moneyValue = require('../../utils/moneyValue');
const formatters = require('../../utils/formatters');
const economyBalance = require('../../utils/economyBalance');
const economyBalancer = require('../../utils/economyBalancer');
const taxEngine = require('../../utils/taxEngine');
const bankEngine = require('../../utils/bankEngine');
const loanEngine = require('../../utils/loanEngine');
const economyControls = require('../../utils/economyControls');
const casinoReserve = require('../../utils/casinoReserve');

class EconomyCore {
  constructor() {
    this.constants = economyBalance;
    this.scale = moneyScale;
    this.value = moneyValue;
    this.formatters = formatters;
  }

  /**
   * 🔒 ACID 트랜잭션 래퍼 (자동 롤백 및 커넥션 안전 반환)
   */
  async withTransaction(fn) {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    try {
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }

  // ----------------------------------------------------
  // 1. 💰 Vault: 자산 연산, 원자적 잔고 변경 & 통합 원장
  // ----------------------------------------------------
  get vault() {
    return {
      safeBigInt: moneyValue.safeBigInt,
      parseGambleBet: money.parseGambleBet,
      parseBetAmount: money.parseBetAmount,
      parseKoreanOrNumericAmount: money.parseKoreanOrNumericAmount,
      withUserLock: money.withUserLock,
      applyCashDelta: money.applyCashDelta,
      applyBankTransfer: money.applyBankTransfer,
      
      transfer: async (fromUserId, toUserId, amount, reason = '') => {
        const amt = moneyValue.safeBigInt(amount);
        if (amt <= 0n) throw new Error('송금액은 0보다 커야 합니다.');
        const u1 = String(fromUserId);
        const u2 = String(toUserId);

        return money.withUserLock([u1, u2], async () => {
          const [sender] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [u1]);
          if (!sender.length || moneyValue.safeBigInt(sender[0].cash) < amt) {
            throw new Error('잔액이 부족합니다.');
          }
          await pool.query('UPDATE users SET cash = cash - ? WHERE discord_id = ?', [amt.toString(), u1]);
          await pool.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [amt.toString(), u2]);
          return { success: true, amount: amt };
        });
      },
      
      getUserBalance: async (userId) => {
        const [rows] = await pool.query(
          'SELECT cash, bank, clicker_level, total_clicks FROM users WHERE discord_id = ? LIMIT 1',
          [String(userId)]
        );
        if (!rows.length) return null;
        const cash = moneyValue.safeBigInt(rows[0].cash);
        const bank = moneyValue.safeBigInt(rows[0].bank);
        return {
          cash,
          bank,
          liquidNetWorth: cash + bank,
          raw: rows[0]
        };
      },

      /**
       * 🟢 신규 통화 발행 (MINT) -> 잔고 증가 + 통합 원장 기록
       */
      applyInflow: async ({ userId, category, amount, reason = '', metadata = {} }) => {
        const amt = moneyValue.safeBigInt(amount);
        if (amt <= 0n) return { success: true, amount: 0n };

        return this.withTransaction(async (conn) => {
          const [uRows] = await conn.query('SELECT cash FROM users WHERE discord_id = ? FOR UPDATE', [String(userId)]);
          if (!uRows.length) throw new Error('유저를 찾을 수 없습니다.');
          const cashBefore = moneyValue.safeBigInt(uRows[0].cash);
          const cashAfter = cashBefore + amt;

          await conn.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [amt.toString(), String(userId)]);

          await conn.query(`
            INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason, metadata)
            VALUES ('INFLOW_MINT', ?, ?, ?, ?, ?, ?)
          `, [
            category,
            amt.toString(),
            String(userId),
            cashAfter.toString(),
            reason || `통화 신규 유입 (${category})`,
            JSON.stringify(metadata)
          ]);

          return {
            success: true,
            amount: amt,
            cashBefore,
            cashAfter
          };
        });
      },

      /**
       * 🔴 통화 소각 / 수수료 (SINK) -> 잔고 차감 + 통합 원장 기록
       */
      applyOutflow: async ({ userId, category, amount, reason = '', metadata = {} }) => {
        const amt = moneyValue.safeBigInt(amount);
        if (amt <= 0n) return { success: true, amount: 0n };

        return this.withTransaction(async (conn) => {
          const [uRows] = await conn.query('SELECT cash FROM users WHERE discord_id = ? FOR UPDATE', [String(userId)]);
          if (!uRows.length) throw new Error('유저를 찾을 수 없습니다.');
          const cashBefore = moneyValue.safeBigInt(uRows[0].cash);
          if (cashBefore < amt) throw new Error('INSUFFICIENT_CASH');
          const cashAfter = cashBefore - amt;

          await conn.query('UPDATE users SET cash = cash - ? WHERE discord_id = ?', [amt.toString(), String(userId)]);

          await conn.query(`
            INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason, metadata)
            VALUES ('OUTFLOW_SINK', ?, ?, ?, ?, ?, ?)
          `, [
            category,
            amt.toString(),
            String(userId),
            cashAfter.toString(),
            reason || `통화 소각/비용 지출 (${category})`,
            JSON.stringify(metadata)
          ]);

          return {
            success: true,
            amount: amt,
            cashBefore,
            cashAfter
          };
        });
      },

      /**
       * 💸 원자적 안전 송금 (ACID 트랜잭션 + Row Lock + 원장 기록)
       */
      transfer: async (fromUserId, toUserId, amount, opts = {}) => {
        const amt = moneyValue.safeBigInt(amount);
        if (amt <= 0n) throw new Error('송금 금액은 1원 이상이어야 합니다.');
        if (String(fromUserId) === String(toUserId)) throw new Error('자신에게는 송금할 수 없습니다.');

        return this.withTransaction(async (conn) => {
          const [firstId, secondId] = [String(fromUserId), String(toUserId)].sort();
          await conn.query('SELECT discord_id, cash FROM users WHERE discord_id IN (?, ?) FOR UPDATE', [firstId, secondId]);

          const [fromRows] = await conn.query('SELECT cash FROM users WHERE discord_id = ? LIMIT 1', [String(fromUserId)]);
          if (!fromRows.length) throw new Error('보내는 유저 정보를 찾을 수 없습니다.');
          const fromCash = moneyValue.safeBigInt(fromRows[0].cash);
          if (fromCash < amt) throw new Error('INSUFFICIENT_CASH');

          const [toRows] = await conn.query('SELECT cash FROM users WHERE discord_id = ? LIMIT 1', [String(toUserId)]);
          if (!toRows.length) throw new Error('받는 유저 정보를 찾을 수 없습니다.');

          await conn.query('UPDATE users SET cash = cash - ? WHERE discord_id = ?', [amt.toString(), String(fromUserId)]);
          await conn.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [amt.toString(), String(toUserId)]);

          const desc = opts.description || `유저 간 송금 (${amt.toString()}원)`;
          
          await conn.query(`
            INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, target_user_id, balance_after, reason)
            VALUES ('TRANSFER', 'USER_TRANSFER', ?, ?, ?, ?, ?)
          `, [
            amt.toString(),
            String(fromUserId),
            String(toUserId),
            (fromCash - amt).toString(),
            desc
          ]).catch(() => {});

          return {
            success: true,
            amount: amt,
            fromCashAfter: fromCash - amt,
            toCashAfter: moneyValue.safeBigInt(toRows[0].cash) + amt
          };
        });
      }
    };
  }

  // ----------------------------------------------------
  // 2. 🎰 Casino: 지급 준비금 기반 베팅 & 95% RTP
  // ----------------------------------------------------
  get casino() {
    return {
      getState: casinoReserve.getCasinoState,
      settleBet: casinoReserve.settleBetWithReserve
    };
  }

  // ----------------------------------------------------
  // 3. 🏛️ Tax: 세금, 국고 및 1일 1회 부유세
  // ----------------------------------------------------
  get tax() {
    return {
      getTreasuryBalance: taxEngine.readTreasury,
      calculateTradeTax: taxEngine.taxOnAmount,
      computeWealthTaxForUser: taxEngine.computeProgressiveWealthTax,
      getPublicTaxView: taxEngine.getPublicTaxView || taxEngine.publicTaxState,
      processDailyWealthTax: taxEngine.collectWealthTax,
      refundTax: taxEngine.refundFromTreasury
    };
  }

  // ----------------------------------------------------
  // 4. 🏦 Bank: 1일 0.1% 이자, 담보대출 및 금융
  // ----------------------------------------------------
  get bank() {
    return {
      getCurrentInterestRate: bankEngine.getCurrentInterestRate,
      processBankInterest: bankEngine.processBankInterest,
      getPublicLoanView: loanEngine.getPublicLoanView,
      requestLoan: loanEngine.requestLoan,
      repayLoan: loanEngine.repayLoan,
      checkDueLoans: loanEngine.checkDueLoans
    };
  }

  // ----------------------------------------------------
  // 5. 🎛️ Governor: 거시경제 밸런서 & 동적 정책 컨트롤
  // ----------------------------------------------------
  get governor() {
    return {
      getDynamicSettings: economyBalancer.getDynamicSettings,
      getBaseline: () => economyBalancer.BASELINE,
      getLastReport: () => economyBalancer.lastReport,
      setAutoMode: economyControls.setAutoMode,
      lockTaxPolicy: economyControls.lockTaxPolicy,
      bulkUpdate: economyControls.bulkUpdate,
      getManualState: economyControls.getManualState,
      summarizeCurrentSettings: economyControls.summarizeCurrentSettings,
      triggerAutoBalancing: economyBalancer.applyAutoBalancing
    };
  }

  /**
   * 📊 통합 시스템 가동 상태 및 헬스 체크
   */
  async getStatusSummary() {
    const treasury = await this.tax.getTreasuryBalance();
    const settings = economyBalancer.getDynamicSettings();
    const manual = economyControls.getManualState();
    const casinoState = await this.casino.getState();
    return {
      status: 'HEALTHY',
      version: '2.1.0-REBALANCE',
      treasury: treasury.toString(),
      casinoReserve: casinoState.currentReserve.toString(),
      jackpotPool: casinoState.jackpotPool.toString(),
      autoMode: manual ? manual.autoMode : 'auto',
      taxRatePercent: ((settings.taxRate || 0) * 100).toFixed(2) + '%',
      bankInterestDaily: '0.10%'
    };
  }
}

const coreInstance = new EconomyCore();
module.exports = coreInstance;
