/**
 * 잔고 안전 변환·유저 락·원자적 증감
 */
const { pool } = require('../config/database');
const { safeBigInt } = require('./moneyValue');
const { formatMoney } = require('./moneyScale');

const ALL_IN_TOKENS = new Set(['all', 'max', '전량', '올인', '최대', '전체', '전액']);
const userLocks = new Map();

function isAllInAmount(val) {
  if (val === null || val === undefined) return false;
  return ALL_IN_TOKENS.has(String(val).trim().toLowerCase());
}

function parseKoreanOrNumericAmount(rawBet, userCash) {
  const cash = safeBigInt(userCash);
  if (rawBet === null || rawBet === undefined) return null;
  if (typeof rawBet === 'bigint') return rawBet > 0n ? rawBet : null;
  if (isAllInAmount(rawBet)) return cash;
  if (typeof rawBet === 'number') {
    if (!Number.isFinite(rawBet) || rawBet <= 0) return null;
    if (rawBet > Number.MAX_SAFE_INTEGER) return null;
    return BigInt(Math.floor(rawBet));
  }
  const cleaned = String(rawBet).replace(/,/g, '').trim();
  if (!cleaned) return null;
  if (isAllInAmount(cleaned)) return cash;
  try {
    const { parseMoneyInput } = require('./formatters');
    const parsedKo = parseMoneyInput(cleaned, cash);
    if (parsedKo === 'ALL') return cash;
    if (typeof parsedKo === 'bigint' && parsedKo > 0n) return parsedKo;
  } catch (e) {
    if (e && e.code === 'MONEY_OVERFLOW') throw e;
  }
  if (/^[+-]?\d+$/.test(cleaned)) {
    try {
      const n = BigInt(cleaned);
      return n > 0n ? n : null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

function readConfigBigInt(key) {
  try {
    const config = require('../config/config');
    if (config[key] == null || config[key] === '') return 0n;
    const n = BigInt(String(config[key]));
    return n > 0n ? n : 0n;
  } catch (e) {
    return 0n;
  }
}

function getCasinoMaxBet() {
  return readConfigBigInt('casinoMaxBet');
}

function getMaxPlayerCash() {
  return readConfigBigInt('maxPlayerCash');
}

function applyCasinoBetCap(amount) {
  const { MAX_MONEY } = require('./moneyScale');
  const bet = safeBigInt(amount);
  if (bet <= 0n) return bet;
  if (bet > MAX_MONEY) return MAX_MONEY;
  const maxBet = getCasinoMaxBet();
  if (maxBet > 0n && bet > maxBet) return maxBet;
  return bet;
}

function parseBetAmount(rawBet, userCash, defaultBet = 1000n) {
  if (rawBet === null || rawBet === undefined || String(rawBet).trim() === '') {
    return applyCasinoBetCap(defaultBet);
  }
  if (isAllInAmount(rawBet)) return applyCasinoBetCap(safeBigInt(userCash));
  const parsed = parseKoreanOrNumericAmount(rawBet, userCash);
  if (parsed === null) {
    const cleaned = String(rawBet).replace(/[,원\s]/g, '');
    if (cleaned === '0' || cleaned === '-0') return 0n;
    return applyCasinoBetCap(defaultBet);
  }
  return applyCasinoBetCap(parsed);
}

function parseGambleBet(rawBet, userCash) {
  return parseKoreanOrNumericAmount(rawBet, userCash);
}

function parseCasinoGambleBet(rawBet, userCash) {
  if (isAllInAmount(rawBet)) return applyCasinoBetCap(safeBigInt(userCash));
  const parsed = parseKoreanOrNumericAmount(rawBet, userCash);
  if (parsed === null) return null;
  return applyCasinoBetCap(parsed);
}

function casinoTooSmallMessage(rawBet, userCash, betAmount) {
  const cash = safeBigInt(userCash);
  const bet = safeBigInt(betAmount);
  if (isAllInAmount(rawBet) && cash < 1000n) {
    return cash <= 0n
      ? '현금이 0원이라 올인할 수 없습니다.'
      : '올인할 현금이 최소 배팅(1,000원)보다 적습니다.';
  }
  if (bet <= 0n) return '배팅 금액이 0원입니다. 1,000원 이상 입력하세요.';
  if (bet < 1000n) return '최소 배팅금액은 1,000원입니다.';
  return null;
}

function computePayout(betAmount, multiplier) {
  const bet = safeBigInt(betAmount);
  const { mulRate, assertMoneyRange } = require('./moneyScale');
  const payout = mulRate(bet, multiplier, 6);
  return assertMoneyRange(payout);
}

async function withUserLock(userId, fn) {
  if (Array.isArray(userId)) {
    const keys = [...new Set(userId.map(String))].sort();
    let currentFn = fn;
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = keys[i];
      const nextFn = currentFn;
      currentFn = () => withUserLock(k, nextFn);
    }
    return currentFn();
  }
  const key = String(userId);
  let release;
  const lockPromise = new Promise(resolve => { release = resolve; });
  const prev = userLocks.get(key) || Promise.resolve();
  userLocks.set(key, lockPromise);

  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (userLocks.get(key) === lockPromise) {
      userLocks.delete(key);
    }
  }
}

const COOLDOWN_COLUMNS = new Set(['last_daily', 'last_subsidy', 'last_work']);
const COOLDOWN_EXTRA_COLUMNS = new Set(['daily_streak']);

async function tryClaimCooldown(userId, column, cooldownMs, extraSet) {
  if (!COOLDOWN_COLUMNS.has(column)) {
    throw new Error('invalid cooldown column');
  }
  const seconds = Math.max(1, Math.ceil(Number(cooldownMs) / 1000));
  const extraParts = [];
  const params = [];
  if (extraSet && typeof extraSet === 'object') {
    for (const [key, value] of Object.entries(extraSet)) {
      if (!COOLDOWN_EXTRA_COLUMNS.has(key)) continue;
      extraParts.push(`${key} = ?`);
      params.push(value);
    }
  }
  const extraSql = extraParts.length ? `, ${extraParts.join(', ')}` : '';
  params.push(String(userId), seconds);
  const [result] = await pool.query(
    `UPDATE users SET ${column} = NOW()${extraSql}
     WHERE discord_id = ?
       AND (${column} IS NULL OR ${column} < DATE_SUB(NOW(), INTERVAL ? SECOND))`,
    params
  );
  return result.affectedRows > 0;
}

async function getUserFunds(userId) {
  const [rows] = await pool.query(
    'SELECT cash, bank FROM users WHERE discord_id = ? LIMIT 1',
    [userId]
  );
  const cash = safeBigInt(rows[0]?.cash);
  const bank = safeBigInt(rows[0]?.bank);
  return { cash, bank, liquid: cash + bank };
}

async function getUserCash(userId) {
  const funds = await getUserFunds(userId);
  return funds.cash;
}

async function applyLiquidTake(userId, amount) {
  const need = safeBigInt(amount);
  const before = await getUserFunds(userId);
  if (need <= 0n) {
    return { took: 0n, fromCash: 0n, fromBank: 0n, before, after: before };
  }
  let locked = 0n;
  try {
    locked = await require('./loanEngine').getLockedCollateral(userId);
  } catch (e) {}
  const fromCash = before.cash < need ? before.cash : need;
  const remain = need - fromCash;
  const freeBank = before.bank > locked ? before.bank - locked : 0n;
  const fromBank = freeBank < remain ? freeBank : remain;
  const took = fromCash + fromBank;
  if (took <= 0n) {
    return { took: 0n, fromCash: 0n, fromBank: 0n, before, after: before };
  }
  if (fromCash > 0n && fromBank > 0n) {
    await applyBankTransfer(userId, -fromCash, -fromBank);
  } else if (fromCash > 0n) {
    await applyCashDelta(userId, -fromCash);
  } else {
    await applyBankTransfer(userId, 0n, -fromBank);
  }
  const after = await getUserFunds(userId);
  return { took, fromCash, fromBank, before, after };
}

function notifyLive(userId) {
  try {
    require('./liveSync').pushUserLive(userId);
  } catch (e) {}
}

/**
 * 📊 전역 자금 이동 100% 전수 자동 로깅 헬퍼
 */
async function recordEconomyLog(userId, type, amount, before, after, description) {
  try {
    const amtBig = safeBigInt(amount);
    const beforeBig = safeBigInt(before);
    const afterBig = safeBigInt(after);
    if (amtBig === 0n && beforeBig === afterBig) return;

    let username = `유저_${String(userId).slice(-4)}`;
    try {
      const [uRows] = await pool.query('SELECT username FROM users WHERE discord_id = ? LIMIT 1', [userId]);
      if (uRows.length && uRows[0].username) username = uRows[0].username;
    } catch (e) {}

    const { formatMoney } = require('./formatters');
    const desc = description || `[자금 이동] ${type} (${formatMoney(amtBig)})`;

    await pool.query(`
      INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      String(userId),
      username,
      String(type || 'CASH_DELTA'),
      amtBig.toString(),
      beforeBig.toString(),
      afterBig.toString(),
      desc
    ]);

    try {
      const { logSystemEvent } = require('./universalLogger');
      logSystemEvent({
        category: 'ECONOMY',
        level: 'INFO',
        userId: String(userId),
        username,
        action: String(type || 'CASH_DELTA'),
        message: `${amtBig >= 0n ? '+' : ''}${formatMoney(amtBig)} (잔여: ${formatMoney(afterBig)})`,
        details: { description: desc, before: beforeBig.toString(), after: afterBig.toString() }
      });
    } catch (e) {}

    // ⚡ 관리자 콘솔 실시간 자동 새로고침 브로드캐스트 (유저 돈 변경 / 경제 로그)
    if (global.__io) {
      global.__io.emit('admin:event', {
        type: 'USER_MONEY_CHANGE',
        userId: String(userId),
        username,
        actionType: type,
        amount: amtBig.toString(),
        balanceAfter: afterBig.toString(),
        timestamp: Date.now()
      });
    }
  } catch (err) {
    console.error('❌ 자동 자금 로깅 실패:', err);
  }
}

async function applyCashDelta(userId, delta, opts) {
  let d = safeBigInt(delta);
  const beforeCash = await getUserCash(userId);
  if (d === 0n) return beforeCash;
  const allowNegative = !!(opts && opts.allowNegative);
  const { MAX_MONEY } = require('./moneyScale');

  if (d > 0n) {
    const playerCap = getMaxPlayerCash();
    if (playerCap > 0n) {
      if (beforeCash >= playerCap) return beforeCash;
      if (beforeCash + d > playerCap) {
        d = playerCap - beforeCash;
        if (d <= 0n) return beforeCash;
      }
    }
    if (beforeCash + d > MAX_MONEY) {
      const err = new Error('금액이 허용 한도(65자리)를 넘습니다. 단위(양/구/간)로 나눠 입력하세요.');
      err.code = 'MONEY_OVERFLOW';
      throw err;
    }
    try {
      await pool.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [d.toString(), userId]);
    } catch (e) {
      if (e && (e.errno === 1264 || e.code === 'ER_WARN_DATA_OUT_OF_RANGE')) {
        const err = new Error('금액이 허용 한도(65자리)를 넘습니다. 단위(양/구/간)로 나눠 입력하세요.');
        err.code = 'MONEY_OVERFLOW';
        throw err;
      }
      throw e;
    }
  } else {
    // 음수 차감 (allowNegative가 true이면 잔고 부족해도 마이너스 잔고로 깎임)
    if (allowNegative) {
      await pool.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [d.toString(), userId]);
    } else {
      const [result] = await pool.query(
        'UPDATE users SET cash = cash + ? WHERE discord_id = ? AND cash >= ?',
        [d.toString(), userId, (-d).toString()]
      );
      if (!result.affectedRows) {
        const err = new Error('INSUFFICIENT_CASH');
        err.code = 'INSUFFICIENT_CASH';
        throw err;
      }
    }
  }
  const afterCash = await getUserCash(userId);
  notifyLive(userId);

  // ⚡ 실시간 전역/개인 소켓 잔액 즉시 동기화 브로드캐스트
  if (global.__io) {
    const payload = { userId: String(userId), cash: afterCash.toString() };
    global.__io.to('user:' + String(userId)).emit('user:balance_update', payload);
    global.__io.emit('user:balance_update', payload);
  }

  // 📝 100% 무조건 전수 상세 자동 로깅
  if (!opts || opts.skipLog !== true) {
    let logType = opts && opts.logType ? opts.logType : null;
    let logDesc = null;

    if (typeof opts === 'string') {
      logDesc = opts;
    } else if (opts && typeof opts === 'object') {
      logDesc = opts.description || opts.reason || opts.desc || null;
    }

    if (!logDesc || !logType) {
      const stack = new Error().stack || '';
      if (stack.includes('enhancementEngine')) {
        logType = logType || 'DRILL_ENHANCE';
        logDesc = logDesc || `🔨 드릴 대장간 강화 시도 (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)} 소각)`;
      } else if (stack.includes('businessEngine')) {
        logType = logType || (d > 0n ? 'BUSINESS_REVENUE' : 'BUSINESS_INVEST');
        logDesc = logDesc || `🏢 사업체 운영 자금 변동 (${d > 0n ? '수익금 수령' : '투자/업그레이드'}) (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;
      } else if (stack.includes('StockModel') || stack.includes('stockRoutes') || stack.includes('stockBuy') || stack.includes('stockSell')) {
        logType = logType || (d < 0n ? 'STOCK_BUY' : 'STOCK_SELL');
        logDesc = logDesc || `📈 주식 거래 (${d > 0n ? '매도 정산' : '매수 체결'}) (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;
      } else if (stack.includes('crashEngine')) {
        logType = logType || (d > 0n ? 'GAMBLE_WIN_CRASH' : 'GAMBLE_BET_CRASH');
        logDesc = logDesc || `🚀 크래시 로켓 (${d > 0n ? '탈출 성공 배당금' : '배팅금 투입'}) (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;
      } else if (stack.includes('gambling') || stack.includes('GameFacade') || stack.includes('casinoLoop')) {
        logType = logType || (d > 0n ? 'GAMBLE_WIN' : 'GAMBLE_BET');
        logDesc = logDesc || `🎰 카지노/도박 게임 (${d > 0n ? '승리 당첨금' : '배팅금'}) (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;
      } else if (stack.includes('lottoEngine') || stack.includes('lotto')) {
        logType = logType || (d > 0n ? 'LOTTO_JACKPOT' : 'LOTTO_BUY');
        logDesc = logDesc || `🎫 로또 6/45 (${d > 0n ? '당첨금 수령' : '티켓 구매 소각'}) (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;
      } else if (stack.includes('shopEngine') || stack.includes('shopRoutes')) {
        logType = logType || 'SHOP_BUY';
        logDesc = logDesc || `🛍️ 상점 아이템 구매 소각 (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;
      } else if (stack.includes('mineService') || stack.includes('mine')) {
        logType = logType || (d > 0n ? 'MINE_EARN' : 'MINE_FEE');
        logDesc = logDesc || `⛏️ 심해 광산 (${d > 0n ? '채굴 수익' : '장르 해금/이용료'}) (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;
      } else if (stack.includes('daily') || stack.includes('attendance')) {
        logType = logType || 'DAILY_REWARD';
        logDesc = logDesc || `🎁 일일 출석체크 지원금 (+${formatMoney(d < 0n ? -d : d)})`;
      } else if (stack.includes('pay.js')) {
        logType = logType || (d > 0n ? 'PAY_RECEIVE' : 'PAY_SEND');
        logDesc = logDesc || `💸 유저 간 송금 (${d > 0n ? '수령' : '송금'}) (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;
      } else if (stack.includes('loanEngine') || stack.includes('p2pLoanEngine')) {
        logType = logType || (d > 0n ? 'LOAN_DISBURSE' : 'LOAN_REPAY');
        logDesc = logDesc || `🏦 대출 관련 자금 (${d > 0n ? '지급' : '상환'}) (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;
      } else if (stack.includes('admin') || stack.includes('PageController')) {
        logType = logType || (d > 0n ? 'ADMIN_GIVE' : 'ADMIN_TAKE');
        logDesc = logDesc || `👑 관리자 수동 잔액 조정 (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;
      }
    }

    if (!logType) logType = (d > 0n ? 'CASH_INFLOW' : 'CASH_OUTFLOW');
    if (!logDesc) logDesc = `[자금 변동] ${d > 0n ? '현금 지급/입금' : '현금 지출/차감'} (${d > 0n ? '+' : ''}${formatMoney(d < 0n ? -d : d)})`;

    const moveAmt = d < 0n ? -d : d;
    recordEconomyLog(userId, logType, moveAmt, beforeCash, afterCash, logDesc).catch(() => {});
  }

  return afterCash;
}

async function applyCashGiveLocked(userId, amount, opts) {
  const amt = safeBigInt(amount);
  if (amt <= 0n) {
    const cash = await getUserCash(userId);
    return { before: cash, after: cash };
  }
  return withUserLock(userId, async () => {
    const before = await getUserCash(userId);
    const after = await applyCashDelta(userId, amt, opts);
    return { before, after };
  });
}

async function applyCashTakeClamped(userId, requested, opts) {
  const allowNegative = opts && opts.allowNegative === false ? false : true; // 기본적으로 마이너스 잔고 허용
  return withUserLock(userId, async () => {
    const before = await getUserCash(userId);
    const isAll = (requested === 'ALL' || isAllInAmount(requested));
    const reqAmt = isAll ? before : safeBigInt(requested);
    
    if (isAll) {
      const actual = before > 0n ? before : 0n;
      if (actual <= 0n) return { before, after: before, actual: 0n, requested: reqAmt };
      const after = await applyCashDelta(userId, -actual, opts);
      return { before, after, actual, requested: reqAmt };
    }

    if (allowNegative) {
      const actual = reqAmt <= 0n ? 0n : reqAmt;
      if (actual <= 0n) return { before, after: before, actual: 0n, requested: reqAmt };
      const after = await applyCashDelta(userId, -actual, { ...opts, allowNegative: true });
      return { before, after, actual, requested: reqAmt };
    }

    const actual = reqAmt <= 0n ? 0n : (before < reqAmt ? (before > 0n ? before : 0n) : reqAmt);
    if (actual <= 0n) return { before, after: before, actual: 0n, requested: reqAmt };
    const after = await applyCashDelta(userId, -actual, opts);
    return { before, after, actual, requested: reqAmt };
  });
}

async function applyBankTransfer(userId, cashDelta, bankDelta, opts) {
  const c = safeBigInt(cashDelta);
  const b = safeBigInt(bankDelta);
  const beforeFunds = await getUserFunds(userId);
  const allowLocked = !!(opts && opts.allowLockedBank);
  if (b < 0n && !allowLocked) {
    let locked = 0n;
    try {
      locked = await require('./loanEngine').getLockedCollateral(userId);
    } catch (e) {}
    if (locked > 0n) {
      if (beforeFunds.bank + b < locked) {
        const err = new Error('담보로 묶인 예금은 인출할 수 없습니다. 대출을 먼저 갚으세요.');
        err.code = 'COLLATERAL_LOCKED';
        throw err;
      }
    }
  }
  const { MAX_MONEY } = require('./moneyScale');
  if (c > 0n || b > 0n) {
    if (beforeFunds.cash + c > MAX_MONEY || beforeFunds.bank + b > MAX_MONEY) {
      const err = new Error('금액이 허용 한도(65자리)를 넘습니다. 단위(양/구/간)로 나눠 입력하세요.');
      err.code = 'MONEY_OVERFLOW';
      throw err;
    }
  }
  let result;
  try {
    [result] = await pool.query(
      `UPDATE users SET cash = cash + ?, bank = bank + ?
       WHERE discord_id = ?
         AND cash + ? >= 0
         AND bank + ? >= 0`,
      [c.toString(), b.toString(), userId, c.toString(), b.toString()]
    );
  } catch (e) {
    if (e && (e.errno === 1264 || e.code === 'ER_WARN_DATA_OUT_OF_RANGE')) {
      const err = new Error('금액이 허용 한도(65자리)를 넘습니다. 단위(양/구/간)로 나눠 입력하세요.');
      err.code = 'MONEY_OVERFLOW';
      throw err;
    }
    throw e;
  }
  if (!result.affectedRows) {
    const err = new Error('INSUFFICIENT_FUNDS');
    err.code = 'INSUFFICIENT_FUNDS';
    throw err;
  }

  const afterFunds = await getUserFunds(userId);
  notifyLive(userId);

  // ⚡ 실시간 전역/개인 소켓 은행/현금 잔액 즉시 동기화 브로드캐스트
  if (global.__io) {
    const payload = {
      userId: String(userId),
      cash: afterFunds.cash.toString(),
      bank: afterFunds.bank.toString()
    };
    global.__io.to('user:' + String(userId)).emit('user:balance_update', payload);
    global.__io.emit('user:balance_update', payload);
  }

  // 📝 은행/현금 이동 전수 자동 로깅
  if (!opts || opts.skipLog !== true) {
    const logType = opts && opts.logType ? opts.logType : (b > 0n ? 'BANK_DEPOSIT' : (b < 0n ? 'BANK_WITHDRAW' : 'BANK_TRANSFER'));
    const logDesc = opts && opts.description ? opts.description : `은행 잔고 변동 (현금 ${c > 0n ? '+' : ''}${c.toString()}, 예금 ${b > 0n ? '+' : ''}${b.toString()})`;
    const moveAmt = b !== 0n ? (b < 0n ? -b : b) : (c < 0n ? -c : c);
    recordEconomyLog(userId, logType, moveAmt, beforeFunds.bank, afterFunds.bank, logDesc).catch(() => {});
  }

  return afterFunds;
}

  const { splitMoneyChunks, mergeMoneyChunks, safeAdd, safeSub, safeMul, clampMoney } = require('./moneyScale');

module.exports = {
  safeBigInt,
  isAllInAmount,
  parseKoreanOrNumericAmount,
  getCasinoMaxBet,
  getMaxPlayerCash,
  applyCasinoBetCap,
  parseBetAmount,
  parseGambleBet,
  parseCasinoGambleBet,
  casinoTooSmallMessage,
  computePayout,
  withUserLock,
  tryClaimCooldown,
  getUserCash,
  getUserFunds,
  applyLiquidTake,
  applyCashDelta,
  applyCashGiveLocked,
  applyCashTakeClamped,
  applyBankTransfer,
  splitMoneyChunks,
  mergeMoneyChunks,
  safeAdd,
  safeSub,
  safeMul,
  clampMoney
};
