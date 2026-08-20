'use strict';

/**
 * 🏛️ EconomyCore - 월덕 가상 경제 단일 통합 코어 (Single Source of Truth)
 * 
 * 모든 자산 변동(현금/예금/주식), 세금/국고, 이자/대출, 거시경제 밸런싱을
 * 단 하나의 통합 코어를 거쳐 원자적(Atomic)으로 안전하게 처리합니다.
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

class EconomyCore {
  constructor() {
    this.constants = economyBalance;
    this.scale = moneyScale;
    this.value = moneyValue;
    this.formatters = formatters;
  }

  // ----------------------------------------------------
  // 1. 💰 Vault: 자산 연산, 원자적 잔고 변경 & 유저 락
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
      }
    };
  }

  // ----------------------------------------------------
  // 2. 🏛️ Tax: 세금, 국고 및 누진 재산세 엔진
  // ----------------------------------------------------
  get tax() {
    return {
      getTreasuryBalance: taxEngine.readTreasury,
      calculateTradeTax: taxEngine.taxOnAmount,
      computeWealthTaxForUser: taxEngine.computeProgressiveWealthTax,
      getPublicTaxView: taxEngine.getPublicTaxView || taxEngine.publicTaxState,
      processTenMinWealthTax: taxEngine.collectWealthTax,
      refundTax: taxEngine.refundFromTreasury
    };
  }

  // ----------------------------------------------------
  // 3. 🏦 Bank: 이자, 담보대출 및 금융 서비스
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
  // 4. 🎛️ Governor: 거시경제 밸런서 & 동적 정책 컨트롤
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
    return {
      status: 'HEALTHY',
      version: '2.0.0-CORE',
      treasury: treasury.toString(),
      autoMode: manual ? manual.autoMode : 'auto',
      taxRatePercent: ((settings.taxRate || 0) * 100).toFixed(2) + '%',
      bankInterestHourly: ((bankEngine.getCurrentInterestRate() * 60 * 100) || 0.05).toFixed(4) + '%'
    };
  }
}

const coreInstance = new EconomyCore();
module.exports = coreInstance;
