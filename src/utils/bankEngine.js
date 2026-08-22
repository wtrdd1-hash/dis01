const { pool } = require('../config/database');
const { logInfo, logError } = require('./logger');
const { formatMoney } = require('./formatters');
const { getDynamicSettings } = require('./economyBalancer');
const { BANK } = require('./economyBalance');
const { applyBankTransfer, safeBigInt } = require('./money');

const DEFAULT_1MIN_RATE = BANK.PER_MINUTE_RATE;
const interestRemainder = new Map();
const INTEREST_REMAINDER_MAX = 50000; // 메모리 누수 방지: 최대 50,000건만 유지

function rememberRemainder(userId, remainder) {
  if (interestRemainder.size >= INTEREST_REMAINDER_MAX) {
    // 5%를 무작위로 정리
    const dropCount = Math.floor(INTEREST_REMAINDER_MAX * 0.05);
    let dropped = 0;
    for (const k of interestRemainder.keys()) {
      if (dropped >= dropCount) break;
      interestRemainder.delete(k);
      dropped++;
    }
  }
  if (remainder === 0n) interestRemainder.delete(userId);
  else interestRemainder.set(userId, remainder);
}

/**
 * 현재 적용 중인 중앙은행 기준 1분 예금 이자율 조회
 */
function getCurrentInterestRate() {
  try {
    const dyn = getDynamicSettings();
    if (dyn && (dyn.autoMode === 'manual' || dyn.taxPolicyLocked)) {
      if (typeof dyn.bankInterestRate === 'number' && dyn.bankInterestRate > 0) {
        return dyn.bankInterestRate;
      }
    }
  } catch (e) {}

  try {
    const { macroState } = require('./macroEconomics');
    if (macroState && typeof macroState.baseInterestRate === 'number' && macroState.baseInterestRate > 0) {
      // 중앙은행 기준금리 + 우대금리 20% -> 1분 분할 금리
      const annual = macroState.baseInterestRate * 1.2;
      return annual / (365 * 24 * 60);
    }
  } catch (e) {}

  try {
    const dyn = getDynamicSettings();
    if (dyn && typeof dyn.bankInterestRate === 'number' && dyn.bankInterestRate > 0) {
      return dyn.bankInterestRate;
    }
  } catch (e) {}

  return DEFAULT_1MIN_RATE;
}

/**
 * 🏦 은행 예금 이자 정기 지급 실행 (1분 주기)
 */
async function processBankInterest() {
  try {
    const rate = getCurrentInterestRate();
    const ratePercent = (rate * 100).toFixed(4);

    // 예금 잔고가 100원 이상인 유저 목록 조회
    const [users] = await pool.query('SELECT discord_id, username, bank FROM users WHERE bank >= 100');
    if (users.length > 0) {
      let totalInterestPaid = 0n;
      let paidCount = 0;

      const SCALE = 10n ** 12n;
      const rateInt = BigInt(Math.round(Number(rate) * 1e12));
      for (const u of users) {
        const currentBank = safeBigInt(u.bank);
        const prevRem = interestRemainder.get(u.discord_id) || 0n;
        const product = currentBank * rateInt + prevRem;
        const rawInterest = product / SCALE;
        rememberRemainder(u.discord_id, product % SCALE);
        if (rawInterest <= 0n) continue;

        // 🏦 고액 예금자 누진 이자소득세 계산 (5,000만 이상 구간별 8%~20%)
        let taxInfo = { tax: 0n, rate: 0, netInterest: rawInterest };
        try {
          const { computeBankInterestTax, addTreasury } = require('./taxEngine');
          taxInfo = computeBankInterestTax(currentBank, rawInterest);
          if (taxInfo.tax > 0n) {
            await addTreasury(taxInfo.tax, 'TAX_BANK_INTEREST', u.discord_id, `고액 예금 이자소득세 원천징수 (${(taxInfo.rate * 100).toFixed(0)}%)`);
          }
        } catch (e) {}

        const finalInterest = taxInfo.netInterest;
        if (finalInterest <= 0n) continue;

        let newBank = currentBank + finalInterest;
        try {
          const moved = await applyBankTransfer(u.discord_id, 0n, finalInterest);
          newBank = moved.bank;
        } catch (e) {
          if (e && e.code === 'MONEY_OVERFLOW') continue;
          throw e;
        }

        try {
          const taxNote = taxInfo.tax > 0n ? ` (이자세 -${formatMoney(taxInfo.tax)} 원천징수)` : '';
          await pool.query(`
            INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
            VALUES (?, ?, 'BANK_INTEREST', ?, ?, ?, ?)
          `, [
            u.discord_id,
            u.username || `유저_${u.discord_id.slice(-4)}`,
            finalInterest.toString(),
            currentBank.toString(),
            newBank.toString(),
            `🏦 [덕스 중앙은행] 1분 정기 예금 이자 지급 (+${ratePercent}% / +${formatMoney(finalInterest)}${taxNote})`
          ]);
        } catch (e) {}

        totalInterestPaid += finalInterest;
        paidCount++;
      }

      if (paidCount > 0) {
        logInfo('BankEngine', `🏦 [1분 예금 이자 지급] ${paidCount}명에게 총 ${formatMoney(totalInterestPaid)} 지급 완료 (기준금리: ${ratePercent}%/분)`);
      }
    }
  } catch (err) {
    logError('BankEngine', '예금 이자 지급 처리 중 오류 발생', err);
  }
  try {
    await require('./loanEngine').processLoanTick();
  } catch (err) {
    logError('BankEngine', '대출 이자·만기 처리 중 오류 발생', err);
  }
}

/**
 * 🏦 은행 예금 이자 백그라운드 엔진 시작 (기본 1분 주기 = 60,000ms)
 */
function startBankEngine(intervalMs = 60 * 1000) {
  logInfo('BankEngine', `🏦 [덕스 중앙은행 이자 엔진] 가동 시작 (지급 주기: ${intervalMs / 1000}초, ${BANK.LABEL} 분할 복리)`);
  
  // 첫 실행: 10초 후 1회 체크, 이후 매 1분마다 정기 실행
  setTimeout(() => {
    processBankInterest();
  }, 10 * 1000);

  setInterval(processBankInterest, intervalMs);
}

module.exports = {
  getCurrentInterestRate,
  processBankInterest,
  startBankEngine
};
