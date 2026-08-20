/**
 * 공유 크래시 라운드
 */
const { getOrCreateUser } = require('../config/database');
const { pool } = require('../config/database');
const { safeBigInt, parseBetAmount, computePayout, withUserLock, applyCashDelta, getUserCash, casinoTooSmallMessage } = require('./money');
const { formatMoney } = require('./formatters');
const { afterCasinoSettle } = require('./casinoLoop');
const { getSocketSessionUser } = require('./liveSync');

const BET_MS = 8000;
const TICK_MS = 80;
const GROW = 0.000055;

function nextCrashAt() {
  const r = Math.random();
  if (r < 0.04) return 1.00;
  return Math.max(1.01, Math.floor((0.96 / (1 - r)) * 100) / 100);
}

function multAt(elapsed) {
  return Math.floor(Math.exp(GROW * elapsed) * 100) / 100;
}

const history = [];

const state = {
  id: 0,
  phase: 'betting',
  crashAt: 1,
  startedAt: 0,
  betUntil: 0,
  multiplier: 1,
  bets: new Map()
};

function publicState() {
  const players = [];
  for (const [uid, b] of state.bets) {
    players.push({
      id: uid.slice(-4),
      amount: b.amount.toString(),
      cashed: b.cashed,
      cashout: b.cashout,
      payout: b.payout.toString()
    });
  }
  return {
    id: state.id,
    phase: state.phase,
    multiplier: state.multiplier,
    crashAt: state.phase === 'crash' ? state.crashAt : null,
    betUntil: state.betUntil,
    history: history.slice(),
    players
  };
}

function emitCrash() {
  const io = global.__io;
  if (io) io.emit('crash:tick', publicState());
}

async function settleLostBets() {
  for (const [uid, b] of state.bets) {
    if (b.cashed) continue;
    b.cashed = false;
    b.payout = 0n;
    const profit = -b.amount;
    try {
      const before = await getUserCash(uid);
      await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [uid, '크래시', b.amount.toString(), '0', profit.toString(), before.toString(), before.toString(), JSON.stringify({ crashAt: state.crashAt })]);
    } catch (e) {}
    try {
      const u = await getOrCreateUser(uid);
      await afterCasinoSettle({
        userId: uid,
        username: u.username || '',
        game: '크래시',
        bet: b.amount,
        payout: 0n,
        profit,
        isWin: false,
        isTie: false,
        multiplier: 0,
        newCash: (await getUserCash(uid)).toString(),
        details: { crashAt: state.crashAt }
      });
    } catch (e) {}
  }
}

function startRound() {
  state.id += 1;
  state.phase = 'betting';
  state.crashAt = nextCrashAt();
  state.startedAt = 0;
  state.betUntil = Date.now() + BET_MS;
  state.multiplier = 1;
  state.bets = new Map();
  emitCrash();
}

function flyLoop() {
  if (state.phase !== 'flying') return;
  const elapsed = Date.now() - state.startedAt;
  const m = multAt(elapsed);
  if (m >= state.crashAt) {
    state.phase = 'crash';
    state.multiplier = state.crashAt;
    history.unshift(state.crashAt);
    if (history.length > 8) history.pop();
    emitCrash();
    settleLostBets().catch(() => {});
    setTimeout(startRound, 2200);
    return;
  }
  state.multiplier = m;
  emitCrash();
  for (const [uid, b] of state.bets) {
    if (!b.cashed && b.autoAt && m >= b.autoAt) {
      cashoutCrash({ id: uid, username: b.username }).catch(() => {});
    }
  }
  setTimeout(flyLoop, TICK_MS);
}

function beginFly() {
  if (state.phase !== 'betting') return;
  state.phase = 'flying';
  state.startedAt = Date.now();
  state.multiplier = 1;
  emitCrash();
  setTimeout(flyLoop, TICK_MS);
}

async function placeCrashBet(session, rawBet, autoAt) {
  if (state.phase !== 'betting') {
    const err = new Error('지금은 배팅 시간이 아닙니다. 다음 라운드를 기다리세요.');
    err.status = 400;
    throw err;
  }
  if (state.bets.has(session.id)) {
    const err = new Error('이미 이 라운드에 배팅했습니다.');
    err.status = 400;
    throw err;
  }
  return withUserLock(session.id, async () => {
    const user = await getOrCreateUser(session.id, session.username, session.avatar);
    const cash = safeBigInt(user.cash);
    const bet = parseBetAmount(rawBet, cash, 1000n);
    const tooSmall = casinoTooSmallMessage(rawBet, cash, bet);
    if (tooSmall) {
      const err = new Error(tooSmall);
      err.status = 400;
      throw err;
    }
    if (cash < bet) {
      const err = new Error(`현금이 부족합니다. (보유 ${formatMoney(cash)})`);
      err.status = 400;
      throw err;
    }
    const newCash = await applyCashDelta(session.id, -bet);
    state.bets.set(session.id, {
      amount: bet,
      cashed: false,
      cashout: 0,
      payout: 0n,
      username: session.username || '',
      autoAt: Number(autoAt) || 0
    });
    emitCrash();
    return { success: true, bet: bet.toString(), newCash: newCash.toString(), message: '크래시 배팅 완료' };
  });
}

async function cashoutCrash(session) {
  if (state.phase !== 'flying') {
    const err = new Error('비행 중에만 탈출할 수 있습니다.');
    err.status = 400;
    throw err;
  }
  const b = state.bets.get(session.id);
  if (!b || b.cashed) {
    const err = new Error('배팅이 없거나 이미 탈출했습니다.');
    err.status = 400;
    throw err;
  }
  const m = state.multiplier;
  const payout = computePayout(b.amount, m);
  const profit = payout - b.amount;
  b.cashed = true;
  b.cashout = m;
  b.payout = payout;
  const newCash = await applyCashDelta(session.id, payout);
  try {
    const before = newCash - payout;
    await pool.query(`
      INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [session.id, '크래시', b.amount.toString(), payout.toString(), profit.toString(), before.toString(), newCash.toString(), JSON.stringify({ cashout: m, crashAt: state.crashAt })]);
  } catch (e) {}
  await afterCasinoSettle({
    userId: session.id,
    username: session.username || '',
    game: '크래시',
    bet: b.amount,
    payout,
    profit,
    isWin: true,
    isTie: false,
    multiplier: m,
    newCash,
    details: { cashout: m }
  });
  emitCrash();
  return {
    success: true,
    isWin: true,
    multiplier: m,
    payout: payout.toString(),
    profit: profit.toString(),
    newCash: newCash.toString(),
    message: `${m}배 탈출! +${formatMoney(profit)}`
  };
}

function attachCrashEngine(io) {
  if (!io || io.__crashAttached) return;
  io.__crashAttached = true;
  io.on('connection', (socket) => {
    socket.emit('crash:tick', publicState());
    socket.on('crash:bet', async (payload, cb) => {
      const sess = getSocketSessionUser(socket);
      if (!sess) {
        if (typeof cb === 'function') cb({ success: false, error: '로그인이 필요합니다.' });
        return;
      }
      try {
        const data = await placeCrashBet(sess, payload && payload.bet);
        if (typeof cb === 'function') cb(data);
      } catch (e) {
        if (typeof cb === 'function') cb({ success: false, error: e.message });
      }
    });
    socket.on('crash:cashout', async (_payload, cb) => {
      const sess = getSocketSessionUser(socket);
      if (!sess) {
        if (typeof cb === 'function') cb({ success: false, error: '로그인이 필요합니다.' });
        return;
      }
      try {
        const data = await cashoutCrash(sess);
        if (typeof cb === 'function') cb(data);
      } catch (e) {
        if (typeof cb === 'function') cb({ success: false, error: e.message });
      }
    });
  });
  startRound();
  setInterval(() => {
    if (state.phase === 'betting' && Date.now() >= state.betUntil) beginFly();
  }, 200).unref();
}

module.exports = {
  attachCrashEngine,
  publicState,
  placeCrashBet,
  cashoutCrash
};
