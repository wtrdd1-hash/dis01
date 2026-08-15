const { pool } = require('../config/database');
const { logInfo, logError } = require('./logger');
const { formatMoney } = require('./formatters');
const config = require('../config/config');
const { getDynamicSettings } = require('./economyBalancer');

// 기본 1시간당 이자율 (0.5% = 0.005)
let baseInterestRate = config.bankInterestRate || 0.005;

/**
 * 현재 적용 중인 중앙은행 기준 예금 이자율 조회
 */
function getCurrentInterestRate() {
  let rate = baseInterestRate;
  try {
    const dyn = getDynamicSettings();
    if (dyn && dyn.subsidyMultiplier) {
      // 경제 부양 시에는 예금 금리도 소폭 우대
      if (dyn.subsidyMultiplier > 1.2) rate *= 1.2;
      else if (dyn.subsidyMultiplier < 0.8) rate *= 0.8;
    }
  } catch (e) {}
  return rate;
}

/**
 * 🏦 은행 예금 이자 정기 지급 실행
 */
async function processBankInterest() {
  try {
    const rate = getCurrentInterestRate();
    const ratePercent = (rate * 100).toFixed(2);

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
          `🏦 [덕스 중앙은행] 정기 예금 이자 지급 (+${ratePercent}% / +${formatMoney(interest)})`
        ]);
      } catch (e) {}

      totalInterestPaid += interest;
      paidCount++;
    }

    if (paidCount > 0) {
      logInfo('BankEngine', `🏦 [정기 예금 이자 지급] 총 ${paidCount}명에게 ${formatMoney(totalInterestPaid)} 지급 완료 (기준금리: ${ratePercent}%)`);
    }
  } catch (err) {
    logError('BankEngine', '예금 이자 지급 처리 중 오류 발생', err);
  }
}

/**
 * 🏦 은행 예금 이자 백그라운드 엔진 시작 (기본 1시간 주기 = 3,600,000ms)
 */
function startBankEngine(intervalMs = 60 * 60 * 1000) {
  logInfo('BankEngine', `🏦 [덕스 중앙은행 이자 엔진] 가동 시작 (지급 주기: ${intervalMs / 1000 / 60}분, 기본이율: ${(baseInterestRate * 100).toFixed(2)}%)`);
  
  // 첫 실행: 5분 후 1회 체크, 이후 매 시간 정기 실행
  setTimeout(() => {
    processBankInterest();
  }, 5 * 60 * 1000);

  setInterval(processBankInterest, intervalMs);
}

module.exports = {
  getCurrentInterestRate,
  processBankInterest,
  startBankEngine
};
