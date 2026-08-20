/**
 * 카지노 중독 루프: 잭팟·미션·연승·VIP·행운의시간·당첨 방송
 */
const { pool } = require('../config/database');
const { safeBigInt, applyCashDelta } = require('./money');
const { formatMoney } = require('./formatters');
const config = require('../config/config');

const RAKE_BPS = 200; // 2%
const JACKPOT_HIT_RATE = 0.0018;
const JACKPOT_MIN = 30000n;
const HAPPY_HOUR_KST = 20;
const HAPPY_BONUS_BPS = 1000; // 승리 이익의 10%
const STREAK_BONUS_BPS = 300; // 5연승 이상 이익의 3%
const CONSOLATION_BPS = 500; // 7연패 보호 토큰

const VIP_TIERS = [
  { id: 'diamond', name: '다이아', minWager: 100000000n, daily: 2000n },
  { id: 'gold', name: '골드', minWager: 10000000n, daily: 1000n },
  { id: 'silver', name: '실버', minWager: 1000000n, daily: 500n },
  { id: 'bronze', name: '브론즈', minWager: 100000n, daily: 200n },
  { id: 'none', name: '일반', minWager: 0n, daily: 0n }
];

const VIP_COOLDOWN_MS = 60 * 60 * 1000; // 1시간마다 수령

const MISSIONS = [
  { key: 'slot_5', title: '슬롯 5회', target: 5, reward: 1500n, kind: 'game', game: '슬롯머신' },
  { key: 'win_3', title: '오늘 3승', target: 3, reward: 2000n, kind: 'win' },
  { key: 'wager_30k', title: '3만원 배팅', target: 30000, reward: 1500n, kind: 'wager' },
  { key: 'variety_3', title: '게임 3종', target: 3, reward: 1500n, kind: 'variety' },
  { key: 'daily_login', title: '출석 체크', target: 1, reward: 800n, kind: 'daily' }
];

let tablesReady = false;

function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

function kstDateStr(d) {
  const k = d ? new Date(d.getTime() + 9 * 60 * 60 * 1000) : kstNow();
  return k.toISOString().slice(0, 10);
}

function kstHour() {
  return kstNow().getUTCHours();
}

function kstMinute() {
  return kstNow().getUTCMinutes();
}

function maskName(name) {
  const s = String(name || '손님').trim() || '손님';
  if (s.length <= 1) return '*';
  if (s.length === 2) return s[0] + '*';
  return s.slice(0, 2) + '***';
}

function vipForWager(wagered) {
  const w = safeBigInt(wagered);
  return VIP_TIERS.find((t) => w >= t.minWager) || VIP_TIERS[VIP_TIERS.length - 1];
}

async function ensureCasinoTables() {
  if (tablesReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS casino_pot (
      id TINYINT PRIMARY KEY,
      jackpot DECIMAL(65,0) NOT NULL DEFAULT 0,
      reserve DECIMAL(65,0) NOT NULL DEFAULT 0,
      happy_override VARCHAR(16) NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query('INSERT IGNORE INTO casino_pot (id, jackpot, reserve) VALUES (1, 0, 0)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_casino (
      user_id VARCHAR(32) PRIMARY KEY,
      win_streak INT NOT NULL DEFAULT 0,
      lose_streak INT NOT NULL DEFAULT 0,
      consolation TINYINT NOT NULL DEFAULT 0,
      total_wagered DECIMAL(65,0) NOT NULL DEFAULT 0,
      total_profit DECIMAL(65,0) NOT NULL DEFAULT 0,
      vip_claim_date DATE NULL,
      vip_claim_at DATETIME NULL,
      mission_date DATE NULL,
      mission_json JSON NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM user_casino LIKE 'vip_claim_at'");
    if (!cols.length) {
      await pool.query("ALTER TABLE user_casino ADD COLUMN vip_claim_at DATETIME NULL AFTER vip_claim_date");
    }
  } catch (e) {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS toto_matches (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      sport VARCHAR(32) NOT NULL,
      home_name VARCHAR(64) NOT NULL,
      away_name VARCHAR(64) NOT NULL,
      odds_home DECIMAL(6,2) NOT NULL,
      odds_draw DECIMAL(6,2) NOT NULL,
      odds_away DECIMAL(6,2) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      result VARCHAR(8) NULL,
      settle_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_status_settle (status, settle_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS toto_tickets (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(32) NOT NULL,
      match_id BIGINT NOT NULL,
      pick VARCHAR(8) NOT NULL,
      amount DECIMAL(65,0) NOT NULL,
      payout DECIMAL(65,0) NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_match (match_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const conn = await pool.getConnection();
  try {
    const { ensureDecimal65 } = require('../config/database');
    await ensureDecimal65(conn, 'casino_pot', 'jackpot', 'DEFAULT 0');
    await ensureDecimal65(conn, 'casino_pot', 'reserve', 'DEFAULT 0');
    await ensureDecimal65(conn, 'user_casino', 'total_wagered', 'DEFAULT 0');
    await ensureDecimal65(conn, 'user_casino', 'total_profit', 'DEFAULT 0');
    await ensureDecimal65(conn, 'toto_tickets', 'amount', '');
    await ensureDecimal65(conn, 'toto_tickets', 'payout', 'DEFAULT 0');
  } finally {
    conn.release();
  }
  tablesReady = true;
}

function emptyMissions() {
  const o = {};
  for (const m of MISSIONS) {
    o[m.key] = { progress: 0, claimed: false };
  }
  return o;
}

async function loadUserCasino(userId) {
  await ensureCasinoTables();
  const today = kstDateStr();
  const [rows] = await pool.query('SELECT * FROM user_casino WHERE user_id = ?', [userId]);
  if (!rows.length) {
    const missions = emptyMissions();
    await pool.query(
      'INSERT INTO user_casino (user_id, mission_date, mission_json) VALUES (?, ?, ?)',
      [userId, today, JSON.stringify(missions)]
    );
    return {
      user_id: userId,
      win_streak: 0,
      lose_streak: 0,
      consolation: 0,
      total_wagered: 0n,
      total_profit: 0n,
      vip_claim_date: null,
      vip_claim_at: null,
      mission_date: today,
      missions
    };
  }
  const row = rows[0];
  let missions = emptyMissions();
  try {
    if (row.mission_json) {
      const parsed = typeof row.mission_json === 'string' ? JSON.parse(row.mission_json) : row.mission_json;
      missions = Object.assign(emptyMissions(), parsed);
    }
  } catch (e) {}
  const missionDate = row.mission_date ? String(row.mission_date).slice(0, 10) : '';
  if (missionDate !== today) {
    missions = emptyMissions();
    await pool.query('UPDATE user_casino SET mission_date = ?, mission_json = ? WHERE user_id = ?', [
      today, JSON.stringify(missions), userId
    ]);
  }
  return {
    user_id: userId,
    win_streak: Number(row.win_streak || 0),
    lose_streak: Number(row.lose_streak || 0),
    consolation: Number(row.consolation || 0),
    total_wagered: safeBigInt(row.total_wagered),
    total_profit: safeBigInt(row.total_profit),
    vip_claim_date: row.vip_claim_date ? String(row.vip_claim_date).slice(0, 10) : null,
    vip_claim_at: row.vip_claim_at ? new Date(row.vip_claim_at).getTime() : null,
    mission_date: today,
    missions
  };
}

function isHappyHourActive(override) {
  if (override === 'on') return true;
  if (override === 'off') return false;
  // 🕒 1시간마다 매시 00분~15분 동안 정기 발동!
  return kstMinute() < 15;
}

async function getPot() {
  await ensureCasinoTables();
  const [rows] = await pool.query('SELECT * FROM casino_pot WHERE id = 1');
  return rows[0] || { jackpot: 0, reserve: 0, happy_override: null };
}

function decorateNearMiss(game, isWin, details) {
  // 실제 서버 판정 릴 심볼과 화면 릴 심볼의 100% 정합성을 위해 인위적 displayReels 변조 비활성화
  return { nearMiss: false };
}

function emitAll(event, payload) {
  const io = global.__io;
  if (io) io.emit(event, payload);
}

async function addRake(betAmount) {
  const rake = safeBigInt(betAmount) * BigInt(RAKE_BPS) / 10000n;
  if (rake <= 0n) return 0n;
  await pool.query('UPDATE casino_pot SET jackpot = jackpot + ? WHERE id = 1', [rake.toString()]);
  return rake;
}

async function maybeHitJackpot(ctx) {
  const potRow = await getPot();
  const pot = safeBigInt(potRow.jackpot);
  if (pot < JACKPOT_MIN) return 0n;
  let chance = JACKPOT_HIT_RATE;
  if (ctx.game === '슬롯머신' && Number(ctx.multiplier || 0) >= 50) chance = 0.12;
  if ((ctx.game === '포커' || ctx.game === '세븐포커') && ctx.details && ctx.details.handRank === 'royal_flush') chance = 0.12;
  if (Math.random() > chance) return 0n;
  const seed = pot / 20n;
  const win = pot - seed;
  if (win <= 0n) return 0n;
  await pool.query('UPDATE casino_pot SET jackpot = ? WHERE id = 1', [seed.toString()]);
  return win;
}

function bumpMissionState(missions, ctx) {
  const next = Object.assign({}, missions);
  const add = (key, n) => {
    if (!next[key]) next[key] = { progress: 0, claimed: false };
    if (next[key].claimed) return;
    next[key] = {
      progress: Number(next[key].progress || 0) + n,
      claimed: false
    };
  };
  if (ctx.game === '슬롯머신') add('slot_5', 1);
  if (ctx.isWin) add('win_3', 1);
  add('wager_30k', Number(ctx.bet > 10n ** 12n ? 10n ** 12n : ctx.bet));
  if (ctx.game) {
    if (!next.variety_3) next.variety_3 = { progress: 0, claimed: false, games: [] };
    const games = Array.isArray(next.variety_3.games) ? next.variety_3.games.slice() : [];
    if (!games.includes(ctx.game)) games.push(ctx.game);
    next.variety_3 = {
      progress: games.length,
      claimed: !!next.variety_3.claimed,
      games
    };
  }
  return next;
}

async function markDailyMission(userId) {
  const row = await loadUserCasino(userId);
  if (!row.missions.daily_login) row.missions.daily_login = { progress: 0, claimed: false };
  if (row.missions.daily_login.claimed) return;
  row.missions.daily_login.progress = 1;
  await pool.query('UPDATE user_casino SET mission_json = ? WHERE user_id = ?', [
    JSON.stringify(row.missions), userId
  ]);
}

async function afterCasinoSettle(ctx) {
  await ensureCasinoTables();
  const userId = String(ctx.userId);
  const bet = safeBigInt(ctx.bet);
  const profit = safeBigInt(ctx.profit);
  const payout = safeBigInt(ctx.payout);
  const isWin = !!ctx.isWin;
  const isTie = !!ctx.isTie;

  const potRow = await getPot();
  const happy = isHappyHourActive(potRow.happy_override);
  const stats = await loadUserCasino(userId);

  let winStreak = stats.win_streak;
  let loseStreak = stats.lose_streak;
  let consolation = stats.consolation;
  if (!isTie) {
    if (isWin) {
      winStreak += 1;
      loseStreak = 0;
    } else {
      loseStreak += 1;
      winStreak = 0;
      if (loseStreak >= 7) consolation = 1;
    }
  }

  let extra = 0n;
  if (isWin && profit > 0n && happy) extra += profit * BigInt(HAPPY_BONUS_BPS) / 10000n;
  if (isWin && profit > 0n && winStreak >= 5) extra += profit * BigInt(STREAK_BONUS_BPS) / 10000n;
  if (isWin && profit > 0n && consolation) {
    extra += profit * BigInt(CONSOLATION_BPS) / 10000n;
    consolation = 0;
  }

  const adminPlay = config.isAdmin(userId);
  let jackpotHit = 0n;
  if (!adminPlay) {
    await addRake(bet);
    jackpotHit = await maybeHitJackpot({
      game: ctx.game,
      multiplier: ctx.multiplier,
      details: ctx.details || {}
    });
  }

  let newCash = ctx.newCash != null ? String(ctx.newCash) : null;
  if (extra + jackpotHit > 0n) {
    const cash = await applyCashDelta(userId, extra + jackpotHit);
    newCash = cash.toString();
  }

  const missions = bumpMissionState(stats.missions, {
    game: ctx.game,
    isWin,
    bet
  });

  await pool.query(`
    UPDATE user_casino
    SET win_streak = ?, lose_streak = ?, consolation = ?,
        total_wagered = total_wagered + ?, total_profit = total_profit + ?,
        mission_json = ?
    WHERE user_id = ?
  `, [
    winStreak,
    loseStreak,
    consolation,
    bet.toString(),
    profit.toString(),
    JSON.stringify(missions),
    userId
  ]);

  const near = decorateNearMiss(ctx.game, isWin, ctx.details);
  const displayName = maskName(ctx.username);
  if (isWin && profit >= 10000n) {
    emitAll('casino:win', {
      name: displayName,
      game: ctx.game,
      profit: profit.toString(),
      text: `${displayName}님 ${ctx.game} ${formatMoney(profit)} 당첨!`
    });
  }
  if (jackpotHit > 0n) {
    emitAll('casino:jackpot', {
      name: displayName,
      amount: jackpotHit.toString(),
      text: `JACKPOT! ${displayName}님 ${formatMoney(jackpotHit)}`
    });
  }

  const freshPot = await getPot();
  return {
    extraPayout: extra.toString(),
    jackpotHit: jackpotHit.toString(),
    happyHour: happy,
    winStreak,
    loseStreak,
    consolation,
    nearMiss: near.nearMiss,
    displayReels: near.displayReels || null,
    newCash,
    loop: {
      jackpot: String(freshPot.jackpot || 0),
      happyHour: happy
    }
  };
}

function publicMissions(missions) {
  return MISSIONS.map((m) => {
    const st = missions[m.key] || { progress: 0, claimed: false };
    const target = m.kind === 'wager' ? m.target : m.target;
    return {
      key: m.key,
      title: m.title,
      progress: Math.min(Number(st.progress || 0), target),
      target,
      reward: m.reward.toString(),
      claimed: !!st.claimed,
      done: Number(st.progress || 0) >= target
    };
  });
}

async function getLoopState(userId, username) {
  await ensureCasinoTables();
  const pot = await getPot();
  const happy = isHappyHourActive(pot.happy_override);
  const [wins] = await pool.query(`
    SELECT user_id, game, profit, created_at
    FROM gambling_logs
    WHERE profit >= 10000 AND (is_rolled_back = 0 OR is_rolled_back IS NULL)
    ORDER BY id DESC
    LIMIT 12
  `);
  const names = {};
  if (wins.length) {
    const ids = [...new Set(wins.map((w) => w.user_id))];
    const [users] = await pool.query(
      `SELECT discord_id, username FROM users WHERE discord_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    for (const u of users) names[u.discord_id] = u.username;
  }
  const winners = wins.map((w) => ({
    name: maskName(names[w.user_id] || '손님'),
    game: w.game,
    profit: String(w.profit),
    text: `${maskName(names[w.user_id] || '손님')}님 ${w.game} ${formatMoney(w.profit)} 당첨!`
  }));

  let me = null;
  if (userId) {
    const stats = await loadUserCasino(userId);
    const vip = vipForWager(stats.total_wagered);
    const now = Date.now();
    const lastClaim = stats.vip_claim_at || 0;
    const isClaimed = lastClaim > 0 && (now - lastClaim < VIP_COOLDOWN_MS);
    const remainSec = isClaimed ? Math.max(0, Math.ceil((VIP_COOLDOWN_MS - (now - lastClaim)) / 1000)) : 0;

    me = {
      username: username || '',
      winStreak: stats.win_streak,
      loseStreak: stats.lose_streak,
      consolation: !!stats.consolation,
      totalWagered: stats.total_wagered.toString(),
      vip: vip.id,
      vipName: vip.name,
      vipDaily: vip.daily.toString(),
      vipClaimed: isClaimed,
      vipRemainSec: remainSec,
      missions: publicMissions(stats.missions)
    };
  }

  return {
    jackpot: String(pot.jackpot || 0),
    happyHour: happy,
    happyHourLabel: '1시간마다 (매시 00~15분) 승리 +10%',
    winners,
    me
  };
}

async function claimMission(userId, key) {
  const def = MISSIONS.find((m) => m.key === key);
  if (!def) {
    const err = new Error('없는 미션입니다.');
    err.status = 400;
    throw err;
  }
  const stats = await loadUserCasino(userId);
  const st = stats.missions[key] || { progress: 0, claimed: false };
  if (st.claimed) {
    const err = new Error('이미 받은 미션입니다.');
    err.status = 400;
    throw err;
  }
  if (Number(st.progress || 0) < def.target) {
    const err = new Error('아직 미션을 완료하지 않았습니다.');
    err.status = 400;
    throw err;
  }
  stats.missions[key] = { progress: st.progress, claimed: true, games: st.games };
  await pool.query('UPDATE user_casino SET mission_json = ? WHERE user_id = ?', [
    JSON.stringify(stats.missions), userId
  ]);
  const newCash = await applyCashDelta(userId, def.reward);

  // 🏛️ 국고 지원금에서 차감
  try {
    const { takeTreasury } = require('./taxEngine');
    await takeTreasury(def.reward, true);
    await pool.query(`
      INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
      VALUES (?, ?, 'TREASURY_SUBSIDY', ?, ?, ?, ?)
    `, [
      userId,
      `유저_${userId.slice(-4)}`,
      def.reward.toString(),
      (newCash - def.reward).toString(),
      newCash.toString(),
      `🏛️ [국고 카지노 미션 지원금] ${def.title} 완료 (+${formatMoney(def.reward)})`
    ]);
  } catch (e) {}

  return { reward: def.reward.toString(), newCash: newCash.toString(), missions: publicMissions(stats.missions) };
}

async function claimVipDaily(userId) {
  const stats = await loadUserCasino(userId);
  const vip = vipForWager(stats.total_wagered);
  if (vip.daily <= 0n) {
    const err = new Error('VIP 등급이 아닙니다. 누적 배팅 10만원부터 브론즈입니다.');
    err.status = 400;
    throw err;
  }
  const now = Date.now();
  const lastClaim = stats.vip_claim_at || 0;
  if (lastClaim > 0 && (now - lastClaim < VIP_COOLDOWN_MS)) {
    const remainMin = Math.ceil((VIP_COOLDOWN_MS - (now - lastClaim)) / 60000);
    const err = new Error(`1시간마다 수령 가능합니다. (${remainMin}분 후 수령 가능)`);
    err.status = 400;
    throw err;
  }
  await pool.query('UPDATE user_casino SET vip_claim_at = NOW(), vip_claim_date = CURDATE() WHERE user_id = ?', [userId]);
  const newCash = await applyCashDelta(userId, vip.daily);

  // 🏛️ 국고 지원금에서 차감
  try {
    const { takeTreasury } = require('./taxEngine');
    await takeTreasury(vip.daily, true);
    await pool.query(`
      INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
      VALUES (?, ?, 'TREASURY_SUBSIDY', ?, ?, ?, ?)
    `, [
      userId,
      `유저_${userId.slice(-4)}`,
      vip.daily.toString(),
      (newCash - vip.daily).toString(),
      newCash.toString(),
      `🏛️ [국고 VIP 일일 보조금] VIP ${vip.name} 등급 일일 지원 (+${formatMoney(vip.daily)})`
    ]);
  } catch (e) {}

  return { reward: vip.daily.toString(), vip: vip.name, newCash: newCash.toString() };
}

async function adminSetJackpot(amount) {
  await ensureCasinoTables();
  let v = 0n;
  try {
    const { parseMoneyInput } = require('./moneyScale');
    const parsed = parseMoneyInput(amount);
    v = typeof parsed === 'bigint' ? parsed : safeBigInt(amount);
  } catch (e) {
    if (e && e.code === 'MONEY_OVERFLOW') throw e;
    v = safeBigInt(amount);
  }
  if (v < 0n) {
    const err = new Error('잭팟은 0 이상이어야 합니다.');
    err.status = 400;
    throw err;
  }
  await pool.query('UPDATE casino_pot SET jackpot = ? WHERE id = 1', [v.toString()]);
  return (await getPot()).jackpot;
}

async function adminSetHappyOverride(mode) {
  await ensureCasinoTables();
  const v = mode === 'on' || mode === 'off' ? mode : null;
  await pool.query('UPDATE casino_pot SET happy_override = ? WHERE id = 1', [v]);
  return v;
}

module.exports = {
  ensureCasinoTables,
  afterCasinoSettle,
  getLoopState,
  claimMission,
  claimVipDaily,
  markDailyMission,
  adminSetJackpot,
  adminSetHappyOverride,
  getPot,
  isHappyHourActive,
  maskName,
  kstDateStr,
  vipForWager,
  MISSIONS,
  VIP_TIERS
};
