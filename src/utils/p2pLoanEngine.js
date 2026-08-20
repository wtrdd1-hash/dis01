/**
 * 🏦 P2P 사채/대부업 및 법원 강제징수 시스템 엔진
 * - 대부업 면허세: 500,000원 (국고 귀속)
 * - 담보 기능: 주식 담보 / 예금 담보 동결
 * - 법정 최고 이자율: 최대 30%
 * - 이자 소득세: 이자의 15% 국고 세금 원천징수
 * - 법원 강제 징수: 만기 경과 시 법원 자동 심사 및 승인 -> 담보/자산 강제 압류 집행
 */
const { pool } = require('../config/database');
const { safeBigInt, applyCashDelta, applyBankTransfer, getUserFunds, withUserLock } = require('./money');
const { formatMoney } = require('./formatters');
const { addTreasury } = require('./taxEngine');

const LICENSE_FEE = 500000n; // 대부업 면허세 50만원
const MAX_INTEREST_RATE = 0.30; // 법정 최고 이자율 30%
const INTEREST_TAX_RATE = 0.15; // 이자 소득세 15% (국고 귀속)
const COURT_FEE_RATE = 0.05; // 법원 강제집행 수수료 5% (국고 귀속)

let tablesReady = false;

async function ensureP2PTables() {
  if (tablesReady) return;

  // 1. 대부업자 면허 테이블
  await pool.query(`
    CREATE TABLE IF NOT EXISTS p2p_lenders (
      user_id VARCHAR(32) PRIMARY KEY,
      business_name VARCHAR(64) NOT NULL,
      total_lent DECIMAL(65,0) NOT NULL DEFAULT 0,
      total_recovered DECIMAL(65,0) NOT NULL DEFAULT 0,
      total_tax_paid DECIMAL(65,0) NOT NULL DEFAULT 0,
      licensed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_active TINYINT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 2. P2P 대출 계약 테이블
  await pool.query(`
    CREATE TABLE IF NOT EXISTS p2p_loans (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      lender_id VARCHAR(32) NOT NULL,
      borrower_id VARCHAR(32) NOT NULL,
      principal DECIMAL(65,0) NOT NULL,
      interest_rate DECIMAL(5,2) NOT NULL,
      interest_amount DECIMAL(65,0) NOT NULL,
      total_due DECIMAL(65,0) NOT NULL,
      collateral_type VARCHAR(16) NOT NULL, -- 'stock' or 'bank' or 'none'
      collateral_stock_id VARCHAR(16) NULL,
      collateral_stock_amount DECIMAL(20,4) NOT NULL DEFAULT 0,
      collateral_bank_amount DECIMAL(65,0) NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'pending', -- 'pending', 'active', 'repaid', 'foreclosed', 'cancelled'
      due_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      repaid_at DATETIME NULL,
      foreclosed_at DATETIME NULL,
      INDEX idx_borrower (borrower_id, status),
      INDEX idx_lender (lender_id, status),
      INDEX idx_status_due (status, due_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 3. 법원 강제징수 집행 기록 테이블
  await pool.query(`
    CREATE TABLE IF NOT EXISTS court_foreclosures (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      loan_id BIGINT NOT NULL,
      applicant_id VARCHAR(32) NOT NULL,
      debtor_id VARCHAR(32) NOT NULL,
      claimed_amount DECIMAL(65,0) NOT NULL,
      recovered_amount DECIMAL(65,0) NOT NULL,
      court_fee DECIMAL(65,0) NOT NULL,
      verdict VARCHAR(32) NOT NULL, -- 'APPROVED_AND_EXECUTED', 'REJECTED'
      reason TEXT NOT NULL,
      executed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_loan (loan_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  tablesReady = true;
}

/**
 * 1. 대부업 면허 취득 (면허세 50만원 징수)
 */
async function registerLenderLicense(userId, businessName) {
  await ensureP2PTables();
  const name = String(businessName || '').trim() || '대부 파이낸셜';

  const [existing] = await pool.query('SELECT * FROM p2p_lenders WHERE user_id = ?', [userId]);
  if (existing.length > 0 && existing[0].is_active) {
    throw new Error('이미 유효한 대부업 면허를 보유하고 있습니다.');
  }

  // 50만원 현금 차감
  const afterCash = await applyCashDelta(userId, -LICENSE_FEE, {
    logType: 'TAX_LICENSE',
    description: `🏛️ [국세청] 대부업 공식 면허세 납부 (-${formatMoney(LICENSE_FEE)})`
  });

  // 국고로 50만원 납부
  await addTreasury(LICENSE_FEE);

  await pool.query(`
    INSERT INTO p2p_lenders (user_id, business_name, licensed_at, is_active)
    VALUES (?, ?, NOW(), 1)
    ON DUPLICATE KEY UPDATE business_name = VALUES(business_name), is_active = 1
  `, [userId, name]);

  return {
    success: true,
    businessName: name,
    feePaid: LICENSE_FEE.toString(),
    remainingCash: afterCash.toString()
  };
}

/**
 * 대부업 면허 소지 여부 확인
 */
async function checkLenderLicense(userId) {
  await ensureP2PTables();
  const [rows] = await pool.query('SELECT * FROM p2p_lenders WHERE user_id = ? AND is_active = 1', [userId]);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 2. P2P 대출 제안 생성 (대부업자 -> 차입자)
 */
async function createLoanOffer({ lenderId, borrowerId, principal, interestRatePercent, durationHours, collateralType, collateralStockId, collateralStockAmt, collateralBankAmt }) {
  await ensureP2PTables();

  if (lenderId === borrowerId) {
    throw new Error('본인에게는 대출을 실행할 수 없습니다.');
  }

  const lender = await checkLenderLicense(lenderId);
  if (!lender) {
    throw new Error('대부업 정식 면허가 없습니다. `/대부업 면허발급`으로 50만원 면허세를 납부하고 면허를 취득하세요.');
  }

  const pAmt = safeBigInt(principal);
  if (pAmt <= 0n) throw new Error('대출 원금은 1원 이상이어야 합니다.');

  // 대부업자 현금 잔고 확인
  const funds = await getUserFunds(lenderId);
  if (funds.cash < pAmt) {
    throw new Error(`대출 자금이 부족합니다. (보유 현금: ${formatMoney(funds.cash)})`);
  }

  // 법정 최고 이자율 30% 제한
  const rateNum = Number(interestRatePercent);
  if (isNaN(rateNum) || rateNum < 0 || rateNum > 30) {
    throw new Error('이자율은 0% 이상 법정 최고 이자율 30% 이하이어야 합니다.');
  }

  const interestAmt = (pAmt * BigInt(Math.round(rateNum * 100))) / 10000n;
  const totalDue = pAmt + interestAmt;

  const hours = Math.max(1, Math.min(720, Number(durationHours) || 24)); // 최대 30일(720시간)

  const cType = ['stock', 'bank', 'none'].includes(collateralType) ? collateralType : 'none';
  let stockId = null;
  let stockAmount = 0;
  let bankAmount = 0n;

  if (cType === 'stock') {
    if (!collateralStockId) throw new Error('담보 주식 종목을 지정하세요.');
    stockId = String(collateralStockId).toUpperCase();
    stockAmount = Math.max(1, Number(collateralStockAmt) || 1);
  } else if (cType === 'bank') {
    bankAmount = safeBigInt(collateralBankAmt);
    if (bankAmount <= 0n) throw new Error('담보 예금 금액을 1원 이상 지정하세요.');
  }

  const [res] = await pool.query(`
    INSERT INTO p2p_loans (
      lender_id, borrower_id, principal, interest_rate, interest_amount, total_due,
      collateral_type, collateral_stock_id, collateral_stock_amount, collateral_bank_amount,
      status, due_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      'pending', DATE_ADD(NOW(), INTERVAL ? HOUR)
    )
  `, [
    lenderId, borrowerId, pAmt.toString(), rateNum.toFixed(2), interestAmt.toString(), totalDue.toString(),
    cType, stockId, stockAmount, bankAmount.toString(),
    hours
  ]);

  return {
    loanId: res.insertId,
    lenderBusiness: lender.business_name,
    principal: pAmt.toString(),
    principalText: formatMoney(pAmt),
    interestRate: rateNum,
    interestAmount: interestAmt.toString(),
    interestAmountText: formatMoney(interestAmt),
    totalDue: totalDue.toString(),
    totalDueText: formatMoney(totalDue),
    durationHours: hours,
    collateralType: cType,
    collateralStockId: stockId,
    collateralStockAmount: stockAmount,
    collateralBankAmount: bankAmount.toString()
  };
}

/**
 * 3. 차입자의 대출 승인 및 계약 체결 (담보 동결 및 원금 지급)
 */
async function acceptLoanOffer(loanId, borrowerId) {
  await ensureP2PTables();

  const [rows] = await pool.query('SELECT * FROM p2p_loans WHERE id = ?', [loanId]);
  if (!rows.length) throw new Error('존재하지 않는 대출 계약입니다.');
  const loan = rows[0];

  if (loan.borrower_id !== String(borrowerId)) {
    throw new Error('본인에게 제안된 대출 계약만 승인할 수 있습니다.');
  }
  if (loan.status !== 'pending') {
    throw new Error(`이미 ${loan.status} 상태의 대출입니다.`);
  }

  const pAmt = safeBigInt(loan.principal);

  // 대부업자 현금 잔고 재확인
  const lenderFunds = await getUserFunds(loan.lender_id);
  if (lenderFunds.cash < pAmt) {
    throw new Error('대부업자의 대출 자금이 부족하여 계약을 체결할 수 없습니다.');
  }

  // 차입자 담보 확인 및 동결 처리
  if (loan.collateral_type === 'stock') {
    const [stocks] = await pool.query(
      'SELECT amount FROM user_stocks WHERE user_id = ? AND stock_id = ?',
      [borrowerId, loan.collateral_stock_id]
    );
    const haveStock = Number(stocks[0]?.amount || 0);
    if (haveStock < Number(loan.collateral_stock_amount)) {
      throw new Error(`담보 주식이 부족합니다. (필요: ${loan.collateral_stock_id} ${loan.collateral_stock_amount}주, 보유: ${haveStock}주)`);
    }
    // 주식 동결 차감
    await pool.query(
      'UPDATE user_stocks SET amount = amount - ? WHERE user_id = ? AND stock_id = ?',
      [loan.collateral_stock_amount, borrowerId, loan.collateral_stock_id]
    );
  } else if (loan.collateral_type === 'bank') {
    const bAmt = safeBigInt(loan.collateral_bank_amount);
    const bFunds = await getUserFunds(borrowerId);
    if (bFunds.bank < bAmt) {
      throw new Error(`담보 예금이 부족합니다. (필요: ${formatMoney(bAmt)}, 보유 예금: ${formatMoney(bFunds.bank)})`);
    }
    // 예금 동결 차감
    await applyBankTransfer(borrowerId, 0n, -bAmt, {
      logType: 'LOAN_COLLATERAL_LOCK',
      description: `🔒 [대부업 담보 설정] 대출 #${loan.id} 예금 담보 동결 (-${formatMoney(bAmt)})`
    });
  }

  // 대부업자 현금 -> 차입자에게 지급
  await applyCashDelta(loan.lender_id, -pAmt, {
    logType: 'P2P_LOAN_DISBURSE',
    description: `💸 [대부업 원금 대출] 대출 #${loan.id} (@유저_${loan.borrower_id.slice(-4)} 차입자에게 원금 지급)`
  });
  await applyCashDelta(borrowerId, pAmt, {
    logType: 'P2P_LOAN_RECEIVE',
    description: `💰 [대부업 대출 실행] 대출 #${loan.id} (원금 +${formatMoney(pAmt)} 수령)`
  });

  // 상태를 active로 갱신
  await pool.query(
    "UPDATE p2p_loans SET status = 'active', created_at = NOW() WHERE id = ?",
    [loanId]
  );
  await pool.query(
    'UPDATE p2p_lenders SET total_lent = total_lent + ? WHERE user_id = ?',
    [pAmt.toString(), loan.lender_id]
  );

  return {
    success: true,
    loanId: loan.id,
    principalText: formatMoney(pAmt),
    totalDueText: formatMoney(loan.total_due),
    dueAt: loan.due_at
  };
}

/**
 * 4. 대출 정상 상환 (원금 + 이자 상환, 담보 해제, 이자소득세 15% 국고 귀속)
 */
async function repayLoan(loanId, borrowerId) {
  await ensureP2PTables();

  const [rows] = await pool.query('SELECT * FROM p2p_loans WHERE id = ?', [loanId]);
  if (!rows.length) throw new Error('대출 건을 찾을 수 없습니다.');
  const loan = rows[0];

  if (loan.borrower_id !== String(borrowerId)) {
    throw new Error('본인의 대출 건만 상환할 수 있습니다.');
  }
  if (loan.status !== 'active' && loan.status !== 'overdue') {
    throw new Error(`상환 가능한 상태가 아닙니다. (현재 상태: ${loan.status})`);
  }

  const totalDue = safeBigInt(loan.total_due);
  const interestAmt = safeBigInt(loan.interest_amount);
  const principalAmt = safeBigInt(loan.principal);

  // 차입자 잔고 확인
  const bFunds = await getUserFunds(borrowerId);
  if (bFunds.cash < totalDue) {
    throw new Error(`상환할 현금이 부족합니다. (필요 상환액: ${formatMoney(totalDue)}, 보유 현금: ${formatMoney(bFunds.cash)})`);
  }

  // 1) 차입자 현금 상환 차감
  await applyCashDelta(borrowerId, -totalDue, {
    logType: 'P2P_LOAN_REPAY',
    description: `💸 [대출 원리금 상환] 대출 #${loan.id} 상환 완료 (-${formatMoney(totalDue)})`
  });

  // 2) 이자 소득세 15% 계산 및 국고 귀속
  const taxAmt = (interestAmt * 1500n) / 10000n; // 15%
  const netInterest = interestAmt - taxAmt;
  const netLenderReceive = principalAmt + netInterest;

  if (taxAmt > 0n) {
    await addTreasury(taxAmt);
    await pool.query(`
      INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
      VALUES (?, ?, 'TAX_INTEREST', ?, '0', '0', ?)
    `, [
      loan.lender_id,
      `대부업자_${loan.lender_id.slice(-4)}`,
      taxAmt.toString(),
      `🏛️ [국세청] 대부업 이자소득세(15%) 원천징수 (+${formatMoney(taxAmt)})`
    ]);
  }

  // 3) 대부업자에게 원금 + 세후 이자 지급
  await applyCashDelta(loan.lender_id, netLenderReceive, {
    logType: 'P2P_LOAN_RECOVER',
    description: `💰 [대출 원리금 회수] 대출 #${loan.id} 회수 완료 (원금 ${formatMoney(principalAmt)} + 세후이자 ${formatMoney(netInterest)})`
  });

  // 4) 담보 동결 해제
  if (loan.collateral_type === 'stock') {
    await pool.query(`
      INSERT INTO user_stocks (user_id, stock_id, amount, total_spent)
      VALUES (?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)
    `, [borrowerId, loan.collateral_stock_id, loan.collateral_stock_amount]);
  } else if (loan.collateral_type === 'bank') {
    const bAmt = safeBigInt(loan.collateral_bank_amount);
    await applyBankTransfer(borrowerId, 0n, bAmt, {
      logType: 'LOAN_COLLATERAL_UNLOCK',
      description: `🔓 [담보 반환] 대출 #${loan.id} 상환에 따른 예금 담보 동결 해제 (+${formatMoney(bAmt)})`
    });
  }

  // 5) 대출 상태 'repaid' 갱신
  await pool.query(
    "UPDATE p2p_loans SET status = 'repaid', repaid_at = NOW() WHERE id = ?",
    [loanId]
  );
  await pool.query(
    'UPDATE p2p_lenders SET total_recovered = total_recovered + ?, total_tax_paid = total_tax_paid + ? WHERE user_id = ?',
    [netLenderReceive.toString(), taxAmt.toString(), loan.lender_id]
  );

  return {
    success: true,
    loanId: loan.id,
    repaidTotalText: formatMoney(totalDue),
    taxPaidText: formatMoney(taxAmt),
    netLenderText: formatMoney(netLenderReceive)
  };
}

/**
 * 5. 법원 강제 징수(추심) 신청 및 법원 자동 승인/집행 시스템
 * - 조건:
 *   1) 만기일(`due_at`) 경과 확인 (NOW() > due_at)
 *   2) 미변제 상태 확인 (status = 'active' or 'overdue')
 *   3) 대출 계약자(대부업자) 본인의 신청 확인
 */
async function requestCourtForeclosure(loanId, applicantId) {
  await ensureP2PTables();

  const [rows] = await pool.query('SELECT * FROM p2p_loans WHERE id = ?', [loanId]);
  if (!rows.length) throw new Error('대출 계약을 찾을 수 없습니다.');
  const loan = rows[0];

  if (loan.lender_id !== String(applicantId)) {
    throw new Error('해당 대출의 채권자(대부업자)만 법원에 강제 집행을 신청할 수 있습니다.');
  }

  if (loan.status === 'repaid') {
    throw new Error('이미 정상 상환 완료된 대출입니다.');
  }
  if (loan.status === 'foreclosed') {
    throw new Error('이미 법원 강제 집행이 완료된 대출 건입니다.');
  }

  // ⚖️ 법원 자동 승인 조건 검사 (Judge AI Automation)
  const isOverdue = new Date() >= new Date(loan.due_at);
  if (!isOverdue) {
    const remainMs = new Date(loan.due_at).getTime() - Date.now();
    const remainHours = Math.ceil(remainMs / 3600000);
    throw new Error(`⚖️ [법원 판결] 기각: 아직 대출 만기일이 지나지 않았습니다. (만기까지 ${remainHours}시간 남음)`);
  }

  const totalDue = safeBigInt(loan.total_due);
  let recoveredAmount = 0n;
  const executionLog = [];

  // ⚖️ 1단계: 동결된 담보물 강제 집행
  if (loan.collateral_type === 'stock') {
    // 담보 주식을 대부업자에게 강제 소유권 이전
    await pool.query(`
      INSERT INTO user_stocks (user_id, stock_id, amount, total_spent)
      VALUES (?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)
    `, [loan.lender_id, loan.collateral_stock_id, loan.collateral_stock_amount]);

    // 주가 시세 산정
    const [stRow] = await pool.query('SELECT price, name FROM stocks WHERE stock_id = ?', [loan.collateral_stock_id]);
    const price = safeBigInt(stRow[0]?.price || 0);
    const stockVal = price * BigInt(Math.round(Number(loan.collateral_stock_amount)));
    recoveredAmount += stockVal;
    executionLog.push(`담보 주식 [${loan.collateral_stock_id} ${loan.collateral_stock_amount}주 (평가액 ${formatMoney(stockVal)})] 채권자 소유권 강제 이전`);
  } else if (loan.collateral_type === 'bank') {
    // 동결 예금을 대부업자에게 강제 지급
    const bAmt = safeBigInt(loan.collateral_bank_amount);
    recoveredAmount += bAmt;
    executionLog.push(`담보 예금 [${formatMoney(bAmt)}] 강제 몰수 및 채권자 지급`);
  }

  // ⚖️ 2단계: 담보로 원리금 부족 시 채무자 잔고 추가 강제 압류 (마이너스 잔고 허용)
  if (recoveredAmount < totalDue) {
    const shortage = totalDue - recoveredAmount;
    // 채무자 계좌에서 마이너스 잔고(채무)로 강제 차감
    await applyCashDelta(loan.borrower_id, -shortage, {
      allowNegative: true,
      logType: 'COURT_SEIZURE',
      description: `⚖️ [법원 강제집행] 대출 #${loan.id} 연체에 따른 잔여 채무 강제 압류 (-${formatMoney(shortage)})`
    });
    recoveredAmount += shortage;
    executionLog.push(`채무자 계좌 잔여 채무 [${formatMoney(shortage)}] 법원 강제 압류 집행`);
  }

  // ⚖️ 3단계: 법원 집행 수수료 5% 국고 귀속
  const courtFee = (recoveredAmount * 500n) / 10000n; // 5%
  const netLenderAmt = recoveredAmount - courtFee;

  if (courtFee > 0n) {
    await addTreasury(courtFee);
  }

  // 대부업자에게 최종 정산금 지급
  if (loan.collateral_type !== 'stock' || netLenderAmt > 0n) {
    await applyCashDelta(loan.lender_id, netLenderAmt, {
      logType: 'COURT_PAYOUT',
      description: `⚖️ [법원 강제집행 배당] 대출 #${loan.id} 집행 회수금 (+${formatMoney(netLenderAmt)})`
    });
  }

  // 대출 상태 'foreclosed' 갱신
  await pool.query(
    "UPDATE p2p_loans SET status = 'foreclosed', foreclosed_at = NOW() WHERE id = ?",
    [loanId]
  );

  // 법원 판결문 기록
  await pool.query(`
    INSERT INTO court_foreclosures (loan_id, applicant_id, debtor_id, claimed_amount, recovered_amount, court_fee, verdict, reason)
    VALUES (?, ?, ?, ?, ?, ?, 'APPROVED_AND_EXECUTED', ?)
  `, [
    loanId, applicantId, loan.borrower_id, totalDue.toString(), recoveredAmount.toString(), courtFee.toString(),
    `[법원 집행관] 채무 불이행 확인. ${executionLog.join(' / ')}. 법원 수수료 5% 공제 후 채권자 배당 완료.`
  ]);

  return {
    success: true,
    verdict: '승인 및 강제 집행 완료 (APPROVED & EXECUTED)',
    claimedAmountText: formatMoney(totalDue),
    recoveredAmountText: formatMoney(recoveredAmount),
    courtFeeText: formatMoney(courtFee),
    netLenderText: formatMoney(netLenderAmt),
    executionDetails: executionLog
  };
}

/**
 * 나의 P2P 대출/대여 목록 조회
 */
async function getMyP2PLoans(userId) {
  await ensureP2PTables();
  const [lent] = await pool.query(
    'SELECT * FROM p2p_loans WHERE lender_id = ? ORDER BY id DESC LIMIT 15',
    [userId]
  );
  const [borrowed] = await pool.query(
    'SELECT * FROM p2p_loans WHERE borrower_id = ? ORDER BY id DESC LIMIT 15',
    [userId]
  );
  const lenderLicense = await checkLenderLicense(userId);

  return {
    lenderLicense,
    lentList: lent,
    borrowedList: borrowed
  };
}

module.exports = {
  LICENSE_FEE,
  MAX_INTEREST_RATE,
  INTEREST_TAX_RATE,
  COURT_FEE_RATE,
  ensureP2PTables,
  registerLenderLicense,
  checkLenderLicense,
  createLoanOffer,
  acceptLoanOffer,
  repayLoan,
  requestCourtForeclosure,
  getMyP2PLoans
};
