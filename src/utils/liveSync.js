/**
 * 웹 실시간 자산 동기화 (개선판)
 *
 * - 로그인 소켓을 user:{discordId} 룸에 넣고, 잔고·레벨 스냅샷을 푸시한다.
 * - 180ms 디바운스로 짧은 시간 다중 변경을 묶어 푸시한다.
 * - 5초 메모리 캐시로 동일 유저에 대한 반복 푸시 부하를 막는다.
 * - 글로벌 강제 새로고침 함수도 제공한다 (데이터 리셋/관리 이벤트 직후 등).
 *
 * 성능 주의:
 *  - pushUserLive 는 매번 users + user_stocks (JOIN) + economy_settings 등 4~6회 쿼리.
 *  - 짧은 시간에 같은 유저에 대해 N번 호출되어도 1회만 DB로 내려간다.
 *  - 강제 새로고침은 캐시를 무효화한 뒤 즉시 푸시한다 (관리자 이벤트·관리자 페이지 갱신용).
 */
const { pool } = require('../config/database');
const session = require('../web/session');
const { getPublicTaxView } = require('./taxEngine');
const { getPublicLoanView } = require('./loanEngine');
const { sumHoldingValue, computeNetWorth } = require('./economyBalance');

const pending = new Map();
const DEBOUNCE_MS = 180;

const SNAPSHOT_TTL_MS = 5000;
const TAX_VIEW_TTL_MS = 30000;
const LOAN_VIEW_TTL_MS = 30000;
const STOCK_PRICE_TTL_MS = 10000;

const snapshotCache = new Map();
const taxViewCache = new Map();
const loanViewCache = new Map();
const stockPriceCache = { data: null, ts: 0 };

let cacheHits = 0;
let cacheMisses = 0;

function userRoom(userId) {
  return 'user:' + String(userId);
}

function getSocketSessionUser(socket) {
  return session.parseSessionFromCookieHeader(socket?.handshake?.headers?.cookie || '');
}

function toBigIntMoney(val) {
  try {
    return BigInt(String(val || 0).split('.')[0] || '0');
  } catch (e) {
    return 0n;
  }
}

async function getStockPricesFast() {
  const now = Date.now();
  if (stockPriceCache.data && (now - stockPriceCache.ts) < STOCK_PRICE_TTL_MS) {
    return stockPriceCache.data;
  }
  const [rows] = await pool.query('SELECT stock_id, price FROM stocks');
  const map = {};
  for (const r of rows) {
    try { map[r.stock_id] = BigInt(String(r.price || 0).split('.')[0] || '0'); }
    catch (e) { map[r.stock_id] = 0n; }
  }
  stockPriceCache.data = map;
  stockPriceCache.ts = now;
  return map;
}

async function getUserLiveSnapshot(userId) {
  const id = String(userId);
  const now = Date.now();

  const cached = snapshotCache.get(id);
  if (cached && (now - cached.ts) < SNAPSHOT_TTL_MS) {
    cacheHits++;
    return cached.data;
  }
  cacheMisses++;

  const [users] = await pool.query(
    `SELECT cash, bank, clicker_level, auto_miner_level, total_clicks, daily_streak
     FROM users WHERE discord_id = ? LIMIT 1`,
    [id]
  );
  if (!users.length) return null;

  const u = users[0];

  const [stockRows] = await pool.query(
    `SELECT us.stock_id, us.amount
     FROM user_stocks us
     WHERE us.user_id = ? AND us.amount > 0`,
    [id]
  );

  let stockVal = 0n;
  const holdings = {};
  const stockPriceMap = await getStockPricesFast();
  for (const sr of stockRows) {
    const amount = BigInt(String(sr.amount || 0).split('.')[0] || '0');
    if (amount <= 0n) continue;
    holdings[sr.stock_id] = Number(sr.amount) || 0;
    const price = stockPriceMap[sr.stock_id] || 0n;
    try {
      const { amountToUnits, mulPriceAmount } = require('./moneyScale');
      const units = amountToUnits(sr.amount);
      const val = mulPriceAmount(price, sr.amount);
      stockVal += val;
    } catch (e) {
      stockVal += price * amount;
    }
  }

  const cash = toBigIntMoney(u.cash);
  const bank = toBigIntMoney(u.bank);
  const netWorth = computeNetWorth(cash, bank, stockVal);

  let tax;
  const taxCached = taxViewCache.get(id);
  if (taxCached && (now - taxCached.ts) < TAX_VIEW_TTL_MS) {
    tax = taxCached.data;
  } else {
    try { tax = await getPublicTaxView(id); }
    catch (e) { tax = { rate: 0, rateText: '0.0%', threshold: '0', locked: false, exempt: true }; }
    taxViewCache.set(id, { data: tax, ts: now });
  }

  let loan;
  const loanCached = loanViewCache.get(id);
  if (loanCached && (now - loanCached.ts) < LOAN_VIEW_TTL_MS) {
    loan = loanCached.data;
  } else {
    try { loan = await getPublicLoanView(id); }
    catch (e) { loan = { hasLoan: false, eligible: false, maxBorrow: '0' }; }
    loanViewCache.set(id, { data: loan, ts: now });
  }

  const data = {
    cash: cash.toString(),
    bank: bank.toString(),
    stockVal: stockVal.toString(),
    netWorth: netWorth.toString(),
    clicker_level: Number(u.clicker_level || 1),
    auto_miner_level: Number(u.auto_miner_level || 0),
    total_clicks: Number(u.total_clicks || 0),
    daily_streak: Number(u.daily_streak || 0),
    holdings,
    tax,
    loan,
    timestamp: now
  };

  snapshotCache.set(id, { data, ts: now });
  if (snapshotCache.size > 2000) {
    const cutoff = now - SNAPSHOT_TTL_MS;
    for (const [k, v] of snapshotCache) {
      if (v.ts < cutoff) snapshotCache.delete(k);
    }
  }
  return data;
}

function emitSnapshot(userId, snapshot) {
  const io = global.__io;
  if (!io || !snapshot) return;
  io.to(userRoom(userId)).emit('user:balance', snapshot);
}

async function pushUserLiveNow(userId, opts = {}) {
  try {
    const id = String(userId);
    if (opts.force !== true) {
      const cached = snapshotCache.get(id);
      if (cached && (Date.now() - cached.ts) < SNAPSHOT_TTL_MS) {
        const ageMs = Date.now() - cached.ts;
        if (ageMs >= 80) {
          emitSnapshot(id, cached.data);
          return cached.data;
        }
      }
    } else {
      snapshotCache.delete(id);
    }
    const snapshot = await getUserLiveSnapshot(id);
    if (snapshot) emitSnapshot(id, snapshot);
    return snapshot;
  } catch (e) {
    return null;
  }
}

function pushUserLive(userId) {
  if (!userId) return Promise.resolve(null);
  const key = String(userId);
  const existing = pending.get(key);
  if (existing) return existing;

  const job = new Promise((resolve) => {
    setTimeout(async () => {
      pending.delete(key);
      const snap = await pushUserLiveNow(key);
      resolve(snap);
    }, DEBOUNCE_MS);
  });

  pending.set(key, job);
  return job;
}

function invalidateUser(userId) {
  if (!userId) return;
  const id = String(userId);
  snapshotCache.delete(id);
  taxViewCache.delete(id);
  loanViewCache.delete(id);
}

function broadcastUserRefresh(userId) {
  if (!userId) return;
  invalidateUser(userId);
  return pushUserLiveNow(userId, { force: true });
}

function attachLiveSyncSocket(io) {
  if (!io || io.__liveSyncAttached) return;
  io.__liveSyncAttached = true;

  io.on('connection', async (socket) => {
    const session = getSocketSessionUser(socket);
    if (session && session.id) {
      socket.join(userRoom(session.id));
      try {
        const snap = await getUserLiveSnapshot(session.id);
        if (snap) socket.emit('user:balance', snap);
      } catch (e) {}
    }

    socket.on('user:sync', async (_payload, callback) => {
      const sess = getSocketSessionUser(socket);
      if (!sess || !sess.id) {
        if (typeof callback === 'function') callback({ success: false, error: 'unauthorized' });
        return;
      }
      try {
        invalidateUser(sess.id);
        const snap = await getUserLiveSnapshot(sess.id);
        if (snap) socket.emit('user:balance', snap);
        if (typeof callback === 'function') callback({ success: true, data: snap });
      } catch (e) {
        if (typeof callback === 'function') callback({ success: false, error: e.message });
      }
    });
  });
}

function listConnectedUserIds() {
  const io = global.__io;
  if (!io) return [];
  const ids = [];
  for (const [name] of io.sockets.adapter.rooms) {
    if (typeof name === 'string' && name.startsWith('user:')) {
      ids.push(name.slice(5));
    }
  }
  return ids;
}

function startLiveSyncGc() {
  if (global.__liveSyncGcStarted) return;
  global.__liveSyncGcStarted = true;
  const gcIntervalMs = 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - SNAPSHOT_TTL_MS;
    let dropped = 0;
    for (const [k, v] of snapshotCache) {
      if (v.ts < cutoff) { snapshotCache.delete(k); dropped++; }
    }
    const taxCutoff = Date.now() - TAX_VIEW_TTL_MS;
    for (const [k, v] of taxViewCache) {
      if (v.ts < taxCutoff) { taxViewCache.delete(k); dropped++; }
    }
    const loanCutoff = Date.now() - LOAN_VIEW_TTL_MS;
    for (const [k, v] of loanViewCache) {
      if (v.ts < loanCutoff) { loanViewCache.delete(k); dropped++; }
    }
    if (dropped > 0) {
      const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
      console.log(`[LiveSync GC] dropped=${dropped} heap=${mem}MB cacheHits=${cacheHits} cacheMisses=${cacheMisses}`);
    }
    if (global.gc && Math.random() < 0.1) {
      try { global.gc(); } catch (e) {}
    }
  }, gcIntervalMs);
  console.log(`[LiveSync] 메모리 캐시 GC 시작 (주기 ${gcIntervalMs / 1000}초)`);
}

function getCacheStats() {
  return {
    snapshots: snapshotCache.size,
    taxViews: taxViewCache.size,
    loanViews: loanViewCache.size,
    stockPriceAge: stockPriceCache.data ? Date.now() - stockPriceCache.ts : null,
    hits: cacheHits,
    misses: cacheMisses
  };
}

module.exports = {
  getSocketSessionUser,
  getUserLiveSnapshot,
  pushUserLive,
  pushUserLiveNow,
  broadcastUserRefresh,
  invalidateUser,
  attachLiveSyncSocket,
  listConnectedUserIds,
  startLiveSyncGc,
  getCacheStats,
  userRoom
};
