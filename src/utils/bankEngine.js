const { pool } = require('../config/database');
const { logInfo, logError } = require('./logger');
const { formatMoney } = require('./formatters');
const config = require('../config/config');
const { getDynamicSettings } = require('./economyBalancer');

// 기본 1분당 이자율 (0.01% = 0.0001)
const DEFAULT_1MIN_RATE = 0.0001;

/**
 * 현재 적용 중인 중앙은행 기준 1분 예금 이자율 조회
 */
function getCurrentInterestRate() {
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
    if (users.length === 0) return;

    let totalInterestPaid = 0n;
    let paidCount = 0;

    for (const u of users) {
      const currentBank = BigInt(u.bank || 0);
      const interest = BigInt(Math.floor(Number(currentBank) * rate));
      if (interest <= 0n) continue;

      const newBank = currentBank + interest;

      await pool.query('UPDATE users SET bank = ? WHERE discord_id = ?', [newBank.toString(), u.discord_id]);

      // 경제 변동 로그 기록
      try {
        await pool.query(`
          INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
          VALUES (?, ?, 'BANK_INTEREST', ?, ?, ?, ?)
        `, [
          u.discord_id,
          u.username || `유저_${u.discord_id.slice(-4)}`,
          interest.toString(),
          currentBank.toString(),
          newBank.toString(),
          `🏦 [덕스 중앙은행] 1분 정기 예금 이자 지급 (+${ratePercent}% / +${formatMoney(interest)})`
        ]);
      } catch (e) {}

      totalInterestPaid += interest;
      paidCount++;
    }

    if (paidCount > 0) {
      logInfo('BankEngine', `🏦 [1분 예금 이자 지급] ${paidCount}명에게 총 ${formatMoney(totalInterestPaid)} 지급 완료 (기준금리: ${ratePercent}%/분)`);
    }
  } catch (err) {
    logError('BankEngine', '예금 이자 지급 처리 중 오류 발생', err);
  }
}

/**
 * 🏦 은행 예금 이자 백그라운드 엔진 시작 (기본 1분 주기 = 60,000ms)
 */
function startBankEngine(intervalMs = 60 * 1000) {
  logInfo('BankEngine', `🏦 [덕스 중앙은행 이자 엔진] 가동 시작 (지급 주기: ${intervalMs / 1000}초, 1분 복리 적용)`);
  
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
