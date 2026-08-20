/**
 * 덕스 중앙은행 대출.
 * 일반 유저만. 예금 담보, 국고 우선, 부족분은 소액만 신규 발행.
 * 이자는 국고로 흡수. 연체 시 카지노·주식 매수 차단.
 */
const { pool } = require('../config/database');
const config = require('../config/config');
const { LOAN } = require('./economyBalance');
const { formatMoney } = require('./formatters');
const {
  safeBigInt,
  parseGambleBet,
  withUserLock,
  applyCashDelta,
  applyBankTransfer,
  getUserFunds
} = require('./money');

const SCALE = 10n ** 12n;
const OPEN_STATUSES = ['active', 'overdue'];

function loanError(code, message, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status || 400;
  return err;
}

function creditFactor(defaults) {
  const n = Math.max(0, Math.min(LOAN.CREDIT.length - 1, Number(defaults) || 0));
  return LOAN.CREDIT[n];
}

function rateInt() {
  return BigInt(Math.round(Number(LOAN.PER_MINUTE_RATE) * 1e12));
}

function collateralFor(principal) {
  const p = safeBigInt(principal);
  if (p <= 0n) return 0n;
  return (p * 10000n) / BigInt(Math.round(LOAN.LTV * 10000));
}

function mintCapFor(principal) {
  const p = safeBigInt(principal);
  return (p * BigInt(Math.round(LOAN.MINT_SHARE * 10000))) / 10000n;
}

function interestCap(original) {
  return safeBigInt(original) * BigInt(LOAN.INTEREST_CAP);
}

let tablesReady = false;
async function ensureLoanTables() {
  if (tablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bank_loans (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      user_id VARCHAR(32) NOT NULL,
      principal DECIMAL(65,0) NOT NULL DEFAULT 0,
      interest_accrued DECIMAL(65,0) NOT NULL DEFAULT 0,
      collateral DECIMAL(65,0) NOT NULL DEFAULT 0,
      original_principal DECIMAL(65,0) NOT NULL DEFAULT 0,
      from_treasury DECIMAL(65,0) NOT NULL DEFAULT 0,
      from_mint DECIMAL(65,0) NOT NULL DEFAULT 0,
      opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      due_at DATETIME NOT NULL,
      last_accrue_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      defaulted TINYINT NOT NULL DEFAULT 0,
      INDEX idx_loan_user_status (user_id, status),
      INDEX idx_loan_due (status, due_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_loan_credit (
      user_id VARCHAR(32) PRIMARY KEY,
      defaults INT NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  tablesReady = true;
}

async function getCreditDefaults(userId) {
  await ensureLoanTables();
  const [rows] = await pool.query(
    'SELECT defaults FROM user_loan_credit WHERE user_id = ? LIMIT 1',
    [String(userId)]
  );
  return Math.max(0, Number(rows[0] && rows[0].defaults) || 0);
}

async function setCreditDefaults(userId, value) {
  const n = Math.max(0, Math.min(99, Number(value) || 0));
  await pool.query(
    `INSERT INTO user_loan_credit (user_id, defaults) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE defaults = VALUES(defaults)`,
    [String(userId), n]
  );
}

async function getOpenLoan(userId) {
  await ensureLoanTables();
  const [rows] = await pool.query(
    `SELECT * FROM bank_loans
     WHERE user_id = ? AND status IN ('active', 'overdue')
     ORDER BY id DESC LIMIT 1`,
    [String(userId)]
  );
  return rows[0] || null;
}

async function getLockedCollateral(userId) {
  const loan = await getOpenLoan(userId);
  return loan ? safeBigInt(loan.collateral) : 0n;
}

function debtOf(loan) {
  if (!loan) return 0n;
  return safeBigInt(loan.principal) + safeBigInt(loan.interest_accrued);
}

async function logLoan(userId, username, type, amount, before, after, description) {
  const amt = safeBigInt(amount);
  if (amt <= 0n) return;
  try {
    await pool.query(
      `INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(userId),
        username || ('유저_' + String(userId).slice(-4)),
        type,
        amt.toString(),
        safeBigInt(before).toString(),
        safeBigInt(after).toString(),
        String(description || '대출').slice(0, 255)
      ]
    );
  } catch (e) {}
}

async function accrueLoanRow(row) {
  const principal = safeBigInt(row.principal);
  if (principal <= 0n) return row;
  const last = row.last_accrue_at ? new Date(row.last_accrue_at).getTime() : Date.now();
  const minutes = Math.max(0, Math.floor((Date.now() - last) / 60000));
  if (minutes <= 0) return row;
  const add = (principal * rateInt() * BigInt(minutes)) / SCALE;
  let interest = safeBigInt(row.interest_accrued) + add;
  const cap = interestCap(row.original_principal || principal);
  if (interest > cap) interest = cap;
  const nextAt = new Date(last + minutes * 60000);
  await pool.query(
    'UPDATE bank_loans SET interest_accrued = ?, last_accrue_at = ? WHERE id = ?',
    [interest.toString(), nextAt, row.id]
  );
  row.interest_accrued = interest.toString();
  row.last_accrue_at = nextAt;
  return row;
}

async function allocateFunds(want) {
  const { readTreasury, takeTreasury } = require('./taxEngine');
  const need = safeBigInt(want);
  if (need <= 0n) return { funded: 0n, fromTreasury: 0n, fromMint: 0n };
  const treasury = await readTreasury();
  const cap = mintCapFor(need);
  const fromTreasury = treasury < need ? treasury : need;
  let fromMint = 0n;
  if (fromTreasury < need) {
    const gap = need - fromTreasury;
    fromMint = gap < cap ? gap : cap;
  }
  const funded = fromTreasury + fromMint;
  if (funded <= 0n) {
    throw loanError('NO_FUNDS', '지금은 국고가 비어 있어 대출할 수 없습니다.');
  }
  if (fromTreasury > 0n) {
    const pulled = await takeTreasury(fromTreasury);
    if (pulled.took < fromTreasury) {
      const got = pulled.took;
      const mint = ((need - got) < cap ? (need - got) : cap);
      return { funded: got + mint, fromTreasury: got, fromMint: mint };
    }
  }
  return { funded, fromTreasury, fromMint };
}

function publicLoan(loan, extra) {
  const dueAt = loan && loan.due_at ? new Date(loan.due_at).getTime() : 0;
  const overdue = !!(loan && loan.status === 'overdue');
  const principal = loan ? safeBigInt(loan.principal) : 0n;
  const interest = loan ? safeBigInt(loan.interest_accrued) : 0n;
  return Object.assign({
    hasLoan: !!loan,
    overdue,
    blocked: overdue,
    principal: principal.toString(),
    interest: interest.toString(),
    debt: (principal + interest).toString(),
    collateral: loan ? safeBigInt(loan.collateral).toString() : '0',
    dueAt,
    dueInSec: loan ? Math.max(0, Math.floor((dueAt - Date.now()) / 1000)) : 0,
    rateText: LOAN.LABEL,
    termHours: LOAN.TERM_HOURS
  }, extra || {});
}

async function quoteLoan(userId, rawAmount) {
  await ensureLoanTables();
  if (config.isAdmin(userId)) {
    throw loanError('ADMIN_EXEMPT', '관리자 계정은 대출할 수 없습니다.');
  }
  const funds = await getUserFunds(userId);
  const open = await getOpenLoan(userId);
  if (open) await accrueLoanRow(open);
  const defaults = await getCreditDefaults(userId);
  const factor = creditFactor(defaults);
  const locked = open ? safeBigInt(open.collateral) : 0n;
  const availableBank = funds.bank > locked ? funds.bank - locked : 0n;
  const maxByBank = (funds.bank * BigInt(Math.round(LOAN.LTV * 10000 * factor))) / 10000n;
  const { readTreasury } = require('./taxEngine');
  const treasury = await readTreasury();
  const mintCap = mintCapFor(maxByBank);
  let maxBorrow = maxByBank;
  const fundable = treasury + mintCap;
  if (fundable < maxBorrow) maxBorrow = fundable;
  if (open) maxBorrow = 0n;

  let amount = 0n;
  if (rawAmount != null && String(rawAmount).trim() !== '') {
    const parsed = parseGambleBet(rawAmount, maxBorrow);
    amount = parsed && parsed > 0n ? parsed : 0n;
    if (amount > maxBorrow) amount = maxBorrow;
  }

  return {
    eligible: !open && maxBorrow > 0n && !config.isAdmin(userId),
    maxBorrow: maxBorrow.toString(),
    amount: amount.toString(),
    bank: funds.bank.toString(),
    cash: funds.cash.toString(),
    locked: locked.toString(),
    availableBank: availableBank.toString(),
    collateralIf: collateralFor(amount || maxBorrow).toString(),
    creditDefaults: defaults,
    creditFactor: factor,
    treasury: treasury.toString(),
    mintCap: mintCap.toString(),
    rateText: LOAN.LABEL,
    termHours: LOAN.TERM_HOURS,
    active: open ? publicLoan(open) : null
  };
}

async function getPublicLoanView(userId) {
  if (!userId) {
    return publicLoan(null, { eligible: false, maxBorrow: '0', availableBank: '0', locked: '0' });
  }
  try {
    const q = await quoteLoan(userId, null);
    const base = q.active || publicLoan(null);
    return Object.assign({}, base, {
      eligible: q.eligible,
      maxBorrow: q.maxBorrow,
      availableBank: q.availableBank,
      locked: q.locked,
      creditDefaults: q.creditDefaults,
      creditFactor: q.creditFactor,
      cash: q.cash,
      bank: q.bank,
      exempt: false
    });
  } catch (e) {
    if (e.code === 'ADMIN_EXEMPT') {
      return publicLoan(null, { eligible: false, exempt: true, maxBorrow: '0' });
    }
    return publicLoan(null, { eligible: false, maxBorrow: '0' });
  }
}

async function assertLoanPlayAllowed(userId) {
  if (!userId || config.isAdmin(userId)) return;
  const loan = await getOpenLoan(userId);
  if (loan && loan.status === 'overdue') {
    throw loanError(
      'LOAN_BLOCK',
      '대출이 연체되어 카지노와 주식 매수를 쓸 수 없습니다. 은행에서 먼저 갚으세요.',
      403
    );
  }
}

async function borrowLoan(userId, username, rawAmount) {
  if (config.isAdmin(userId)) throw loanError('ADMIN_EXEMPT', '관리자 계정은 대출할 수 없습니다.');
  return withUserLock(userId, async () => {
    const quote = await quoteLoan(userId, rawAmount);
    if (quote.active) throw loanError('EXISTS', '이미 대출이 있습니다. 갚은 뒤에 다시 받으세요.');
    if (!quote.eligible) {
      throw loanError('NO_LIMIT', '지금은 대출 한도가 없습니다. 예금을 늘리거나 연체를 정리하세요.');
    }
    const want = safeBigInt(quote.amount);
    if (want <= 0n) throw loanError('BAD_AMOUNT', '대출 금액은 1원 이상이어야 합니다.');
    const funds = await getUserFunds(userId);
    let allocated;
    try {
      allocated = await allocateFunds(want);
    } catch (e) {
      throw e;
    }
    const principal = allocated.funded < want ? allocated.funded : want;
    if (principal <= 0n) throw loanError('NO_FUNDS', '지금은 국고가 비어 있어 대출할 수 없습니다.');
    const collateral = collateralFor(principal);
    if (funds.bank < collateral) {
      const { addTreasury } = require('./taxEngine');
      if (allocated.fromTreasury > 0n) await addTreasury(allocated.fromTreasury);
      throw loanError('NEED_COLLATERAL', `담보 예금이 부족합니다. ${formatMoney(collateral)} 이상이 필요합니다.`);
    }
    const before = funds.cash;
    const { addTreasury } = require('./taxEngine');
    let after;
    let granted = false;
    try {
      after = await applyCashDelta(userId, principal);
      granted = true;
      const due = new Date(Date.now() + LOAN.TERM_HOURS * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO bank_loans
          (user_id, principal, interest_accrued, collateral, original_principal, from_treasury, from_mint, due_at, last_accrue_at, status)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, NOW(), 'active')`,
        [
          String(userId),
          principal.toString(),
          collateral.toString(),
          principal.toString(),
          allocated.fromTreasury.toString(),
          allocated.fromMint.toString(),
          due
        ]
      );
    } catch (e) {
      if (granted) {
        try { await applyCashDelta(userId, -principal); } catch (e2) {}
      }
      if (allocated.fromTreasury > 0n) {
        try { await addTreasury(allocated.fromTreasury); } catch (e2) {}
      }
      throw e;
    }
    await logLoan(
      userId,
      username,
      'BANK_LOAN',
      principal,
      before,
      after,
      `대출 ${formatMoney(principal)} · 담보 ${formatMoney(collateral)} · 만기 ${LOAN.TERM_HOURS}시간`
    );
    const view = await getPublicLoanView(userId);
    try { require('./liveSync').pushUserLive(userId); } catch (e) {}
    return view;
  });
}

async function takeForRepay(userId, need) {
  const funds = await getUserFunds(userId);
  const loan = await getOpenLoan(userId);
  const locked = loan ? safeBigInt(loan.collateral) : 0n;
  let remain = safeBigInt(need);
  let fromCash = 0n;
  let fromBank = 0n;
  if (remain > 0n && funds.cash > 0n) {
    fromCash = funds.cash < remain ? funds.cash : remain;
    remain -= fromCash;
  }
  const unlocked = funds.bank > locked ? funds.bank - locked : 0n;
  if (remain > 0n && unlocked > 0n) {
    const take = unlocked < remain ? unlocked : remain;
    fromBank += take;
    remain -= take;
  }
  if (fromCash > 0n || fromBank > 0n) {
    await applyBankTransfer(userId, fromCash > 0n ? -fromCash : 0n, fromBank > 0n ? -fromBank : 0n);
  }
  return { took: fromCash + fromBank, fromCash, fromBank, remain };
}

async function seizeForDue(userId, need) {
  const funds = await getUserFunds(userId);
  let remain = safeBigInt(need);
  let fromCash = 0n;
  let fromBank = 0n;
  if (remain > 0n && funds.bank > 0n) {
    const take = funds.bank < remain ? funds.bank : remain;
    fromBank = take;
    remain -= take;
  }
  if (remain > 0n && funds.cash > 0n) {
    fromCash = funds.cash < remain ? funds.cash : remain;
    remain -= fromCash;
  }
  if (fromCash > 0n || fromBank > 0n) {
    await applyBankTransfer(
      userId,
      fromCash > 0n ? -fromCash : 0n,
      fromBank > 0n ? -fromBank : 0n,
      { allowLockedBank: true }
    );
  }
  return { took: fromCash + fromBank, fromCash, fromBank, remain };
}

async function applyRepayment(userId, username, loan, paid, seized) {
  let interest = safeBigInt(loan.interest_accrued);
  let principal = safeBigInt(loan.principal);
  let left = safeBigInt(paid);
  let interestPaid = 0n;
  let principalPaid = 0n;
  if (left > 0n && interest > 0n) {
    interestPaid = left < interest ? left : interest;
    interest -= interestPaid;
    left -= interestPaid;
  }
  if (left > 0n && principal > 0n) {
    principalPaid = left < principal ? left : principal;
    principal -= principalPaid;
    left -= principalPaid;
  }
  const origT = safeBigInt(loan.from_treasury);
  const origM = safeBigInt(loan.from_mint);
  const origP = origT + origM;
  const treasuryShare = origP > 0n ? (principalPaid * origT) / origP : 0n;
  const { addTreasury } = require('./taxEngine');
  const toTreasury = treasuryShare + interestPaid;
  if (toTreasury > 0n) await addTreasury(toTreasury);

  const done = principal <= 0n && interest <= 0n;
  if (done) {
    await pool.query(
      `UPDATE bank_loans SET principal = 0, interest_accrued = 0, collateral = 0, status = 'repaid' WHERE id = ?`,
      [loan.id]
    );
    if (loan.defaulted || loan.status === 'overdue') {
      const cur = await getCreditDefaults(userId);
      await setCreditDefaults(userId, Math.max(0, cur - 1));
    }
  } else {
    const nextCol = collateralFor(principal);
    const funds = await getUserFunds(userId);
    const col = nextCol < funds.bank ? nextCol : funds.bank;
    const status = seized && (loan.status === 'overdue' || loan.status === 'active')
      ? (loan.status === 'overdue' || Date.now() >= new Date(loan.due_at).getTime() ? 'overdue' : 'active')
      : loan.status;
    await pool.query(
      `UPDATE bank_loans SET principal = ?, interest_accrued = ?, collateral = ?, status = ? WHERE id = ?`,
      [principal.toString(), interest.toString(), col.toString(), status, loan.id]
    );
  }
  const after = await getUserFunds(userId);
  await logLoan(
    userId,
    username,
    seized ? 'BANK_LOAN_SEIZE' : 'BANK_REPAY',
    paid,
    after.cash + safeBigInt(paid),
    after.cash,
    seized
      ? `만기 회수 ${formatMoney(paid)} · 남은 채무 ${formatMoney(principal + interest)}`
      : `상환 ${formatMoney(paid)} · 남은 채무 ${formatMoney(principal + interest)}`
  );
  return getPublicLoanView(userId);
}

async function repayLoan(userId, username, rawAmount) {
  return withUserLock(userId, async () => {
    let loan = await getOpenLoan(userId);
    if (!loan) throw loanError('NONE', '갚을 대출이 없습니다.');
    loan = await accrueLoanRow(loan);
    const owe = debtOf(loan);
    const parsed = rawAmount == null || String(rawAmount).trim() === '' || String(rawAmount).trim() === '전액' || String(rawAmount).trim() === 'all'
      ? owe
      : (parseGambleBet(rawAmount, owe) || 0n);
    const want = parsed < owe ? parsed : owe;
    if (want <= 0n) throw loanError('BAD_AMOUNT', '상환 금액은 1원 이상이어야 합니다.');
    const taken = await takeForRepay(userId, want);
    if (taken.took <= 0n) throw loanError('NO_CASH', '현금(또는 잠기지 않은 예금)이 부족합니다.');
    const view = await applyRepayment(userId, username, loan, taken.took, false);
    try { require('./liveSync').pushUserLive(userId); } catch (e) {}
    return view;
  });
}

async function settleDueLoan(row, force) {
  return withUserLock(row.user_id, async () => {
    let loan = await getOpenLoan(row.user_id);
    if (!loan || Number(loan.id) !== Number(row.id)) return;
    loan = await accrueLoanRow(loan);
    if (loan.status === 'repaid') return;
    const dueAt = new Date(loan.due_at).getTime();
    if (!force && Date.now() < dueAt && loan.status !== 'overdue') return;
    const owe = debtOf(loan);
    const [users] = await pool.query('SELECT username FROM users WHERE discord_id = ? LIMIT 1', [loan.user_id]);
    const username = users[0] && users[0].username;
    const taken = await seizeForDue(loan.user_id, owe);
    if (taken.remain > 0n && !loan.defaulted) {
      await pool.query('UPDATE bank_loans SET defaulted = 1, status = ? WHERE id = ?', ['overdue', loan.id]);
      const cur = await getCreditDefaults(loan.user_id);
      await setCreditDefaults(loan.user_id, cur + 1);
      loan.defaulted = 1;
      loan.status = 'overdue';
    }
    if (taken.took > 0n) {
      await applyRepayment(loan.user_id, username, loan, taken.took, true);
    } else if (taken.remain > 0n) {
      await pool.query('UPDATE bank_loans SET status = ? WHERE id = ?', ['overdue', loan.id]);
    }
  });
}

async function processLoanTick() {
  try {
    await ensureLoanTables();
    const [open] = await pool.query(
      `SELECT id, user_id FROM bank_loans WHERE status IN ('active', 'overdue')`
    );
    for (const row of open) {
      try {
        const [full] = await pool.query('SELECT * FROM bank_loans WHERE id = ? LIMIT 1', [row.id]);
        if (full[0]) await accrueLoanRow(full[0]);
      } catch (e) {}
    }
    const [due] = await pool.query(
      `SELECT * FROM bank_loans
       WHERE status = 'active' AND due_at <= NOW()`
    );
    for (const row of due) {
      try { await settleDueLoan(row); } catch (e) {
        console.error('[loanEngine] 만기 회수 실패', row.user_id, e && e.message);
      }
    }
  } catch (e) {
    console.error('[loanEngine] tick', e && e.message);
  }
}

async function listLoansAdmin(limit) {
  await ensureLoanTables();
  const cap = Math.max(1, Math.min(100, Number(limit) || 40));
  const [rows] = await pool.query(
    `SELECT l.*, u.username
     FROM bank_loans l
     LEFT JOIN users u ON u.discord_id = l.user_id
     WHERE l.status IN ('active', 'overdue')
     ORDER BY l.status DESC, l.due_at ASC
     LIMIT ${cap}`
  );
  const [sum] = await pool.query(
    `SELECT
       COALESCE(SUM(principal + interest_accrued), 0) AS debt,
       COALESCE(SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END), 0) AS overdue_count,
       COUNT(*) AS open_count
     FROM bank_loans WHERE status IN ('active', 'overdue')`
  );
  return {
    debt: safeBigInt(sum[0] && sum[0].debt).toString(),
    overdueCount: Number(sum[0] && sum[0].overdue_count) || 0,
    openCount: Number(sum[0] && sum[0].open_count) || 0,
    loans: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username || '알수없음',
      principal: safeBigInt(r.principal).toString(),
      interest: safeBigInt(r.interest_accrued).toString(),
      debt: debtOf(r).toString(),
      collateral: safeBigInt(r.collateral).toString(),
      dueAt: r.due_at,
      status: r.status,
      defaulted: !!r.defaulted
    }))
  };
}

async function adminForceLoan(userId) {
  const loan = await getOpenLoan(userId);
  if (!loan) throw loanError('NONE', '해당 유저의 대출이 없습니다.', 404);
  await settleDueLoan(loan, true);
  return getPublicLoanView(userId);
}

async function closeLoansOnReset(userId) {
  await ensureLoanTables();
  await pool.query(
    `UPDATE bank_loans SET principal = 0, interest_accrued = 0, collateral = 0, status = 'repaid'
     WHERE user_id = ? AND status IN ('active', 'overdue')`,
    [String(userId)]
  );
}

module.exports = {
  LOAN,
  ensureLoanTables,
  getLockedCollateral,
  getOpenLoan,
  getPublicLoanView,
  quoteLoan,
  borrowLoan,
  repayLoan,
  assertLoanPlayAllowed,
  processLoanTick,
  listLoansAdmin,
  adminForceLoan,
  closeLoansOnReset
};
