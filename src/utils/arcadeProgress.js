/**
 * 아케이드 XP / 레벨 / 모드 해금 / 환생
 * 예전에 번 돈(도박 이익 + 경제 수령 + 채굴 활동)을 전부 경험치로 환산한다.
 */
const { pool } = require('../config/database');
const { ensureCasinoTables } = require('./casinoLoop');

const MAX_LEVEL = 40;
const RP_PER_REBIRTH = 10;
const VIP_HONOR_PER = 10;
const VIP_HONOR_CAP = 10;

const MODES = [
  { id: 'classic', name: '클래식 홀', blurb: '원래 카지노 그대로', level: 1, kind: 'tab', tab: 'tab-casino' },
  { id: 'neon', name: '네온 슬롯', blurb: '밤거리 오락실 슬롯', level: 2, kind: 'slot', game: '슬롯머신' },
  { id: 'crash', name: '크래시 아레나', blurb: '상승 그래프 전용 경기장', level: 3, kind: 'crash' },
  { id: 'mines', name: '마인즈 연구소', blurb: '위험 구역 타일 오픈', level: 4, kind: 'mines' },
  { id: 'plinko', name: '플링코 파티', blurb: '축제 공 떨어뜨리기', level: 5, kind: 'plinko' },
  { id: 'toto', name: '토토 스타디움', blurb: '관중석 승부예측', level: 6, kind: 'toto' },
  { id: 'horse', name: '나이트 레이스', blurb: '야간 경마 전용 UI', level: 7, kind: 'horse' },
  { id: 'high', name: '하이롤러', blurb: '최소 1만 · 블랙골드 홀', level: 8, kind: 'slot', minBet: 10000 },
  { id: 'jackpot', name: '잭팟 시어터', blurb: '팟만 노리는 무대', level: 10, kind: 'slot', jackpotFocus: true }
];

const WORLDS = [
  { id: 'origin', name: '본세계', blurb: '지금 월덕 화면 그대로', cost: 0 },
  { id: 'neon', name: '네온가', blurb: '밤거리 오락실 GUI', cost: 15 },
  { id: 'dusk', name: '황혼계', blurb: '금빛 하이롤러 GUI', cost: 25 },
  { id: 'abyss', name: '심연', blurb: '어두운 다른 판', cost: 40 }
];

const TITLES = [
  { id: 'returner', name: '회귀자', cost: 0, minRebirth: 1 },
  { id: 'wanderer', name: '이세계인', cost: 20 },
  { id: 'keeper', name: '세계여행자', cost: 40 }
];

function xpNeedAt(level) {
  let need = 140;
  for (let i = 1; i < level; i += 1) need = Math.floor(need * 1.16 + 20);
  return need;
}

function xpToReach(level) {
  const cap = Math.max(1, Math.min(MAX_LEVEL, Number(level) || 1));
  let total = 0;
  let need = 140;
  for (let lv = 1; lv < cap; lv += 1) {
    total += need;
    need = Math.floor(need * 1.16 + 20);
  }
  return total;
}

function levelFromXp(xp) {
  let level = 1;
  let need = 140;
  let left = Math.max(0, Number(xp) || 0);
  while (left >= need && level < MAX_LEVEL) {
    left -= need;
    level += 1;
    need = Math.floor(need * 1.16 + 20);
  }
  return { level, xp: Math.max(0, Number(xp) || 0), into: left, need };
}

function xpFromStats(stats) {
  const won = Number(stats.won || 0);
  const eco = Number(stats.economy || 0);
  const wagered = Number(stats.wagered || 0);
  const wins = Number(stats.wins || 0);
  const clicks = Number(stats.clicks || 0);
  return Math.floor(won / 400) + Math.floor(eco / 800) + Math.floor(wagered / 2500) + wins * 12 + Math.floor(clicks / 15);
}

function vipHonorWon(rebirth) {
  return Math.min(VIP_HONOR_CAP, Math.max(0, Number(rebirth) || 0)) * VIP_HONOR_PER;
}

function parseUnlocks(raw, rebirth) {
  let o = { worlds: ['origin'], titles: [] };
  try {
    if (raw) Object.assign(o, typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch (e) {}
  if (!Array.isArray(o.worlds)) o.worlds = ['origin'];
  if (!o.worlds.includes('origin')) o.worlds.unshift('origin');
  if (!Array.isArray(o.titles)) o.titles = [];
  if ((Number(rebirth) || 0) >= 1 && !o.titles.includes('returner')) o.titles.push('returner');
  return o;
}

function catalog(unlocks, rebirth, rp, world, title, prev) {
  const rb = Number(rebirth) || 0;
  return {
    rp: Number(rp) || 0,
    rebirth: rb,
    world: world || 'origin',
    prevWorld: prev || 'origin',
    title: title || (rb >= 1 ? 'returner' : ''),
    worlds: WORLDS.map((w) => Object.assign({}, w, {
      unlocked: w.cost === 0 || unlocks.worlds.includes(w.id)
    })),
    titles: TITLES.map((t) => Object.assign({}, t, {
      unlocked: unlocks.titles.includes(t.id) || (t.minRebirth && rb >= t.minRebirth)
    }))
  };
}

async function loadLifetime(userId) {
  const id = String(userId);
  let won = 0;
  let wagered = 0;
  let wins = 0;
  let economy = 0;
  let clicks = 0;
  try {
    const [g] = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN profit > 0 THEN profit ELSE 0 END), 0) AS won,
        COALESCE(SUM(bet), 0) AS wagered,
        COALESCE(SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END), 0) AS wins
      FROM gambling_logs
      WHERE user_id = ? AND (is_rolled_back = 0 OR is_rolled_back IS NULL)
    `, [id]);
    won = Number(g[0] && g[0].won || 0);
    wagered = Number(g[0] && g[0].wagered || 0);
    wins = Number(g[0] && g[0].wins || 0);
  } catch (e) {}
  try {
    const [e] = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS earned
      FROM economy_logs
      WHERE user_id = ? AND amount > 0
    `, [id]);
    economy = Number(e[0] && e[0].earned || 0);
  } catch (e) {}
  try {
    const [u] = await pool.query('SELECT total_clicks, total_wagered FROM users u LEFT JOIN user_casino c ON c.user_id = u.discord_id WHERE u.discord_id = ?', [id]);
    if (u[0]) {
      clicks = Number(u[0].total_clicks || 0);
      const cw = Number(u[0].total_wagered || 0);
      if (cw > wagered) wagered = cw;
    }
  } catch (e) {
    try {
      const [u2] = await pool.query('SELECT total_clicks FROM users WHERE discord_id = ?', [id]);
      clicks = Number(u2[0] && u2[0].total_clicks || 0);
    } catch (e2) {}
  }
  try {
    const [c] = await pool.query('SELECT total_wagered FROM user_casino WHERE user_id = ?', [id]);
    const cw = Number(c[0] && c[0].total_wagered || 0);
    if (cw > wagered) wagered = cw;
  } catch (e) {}
  return { won, economy, wagered, wins, clicks };
}

async function ensureArcadeCol() {
  await ensureCasinoTables();
  const alters = [
    'ALTER TABLE user_casino ADD COLUMN arcade_seen_level INT NOT NULL DEFAULT 1',
    'ALTER TABLE user_casino ADD COLUMN arcade_rebirth INT NOT NULL DEFAULT 0',
    'ALTER TABLE user_casino ADD COLUMN arcade_xp_spent BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE user_casino ADD COLUMN arcade_rp INT NOT NULL DEFAULT 0',
    'ALTER TABLE user_casino ADD COLUMN arcade_world VARCHAR(32) NOT NULL DEFAULT \'origin\'',
    'ALTER TABLE user_casino ADD COLUMN arcade_world_prev VARCHAR(32) NOT NULL DEFAULT \'origin\'',
    'ALTER TABLE user_casino ADD COLUMN arcade_title VARCHAR(32) NULL',
    'ALTER TABLE user_casino ADD COLUMN arcade_unlocks JSON NULL'
  ];
  for (const sql of alters) {
    try { await pool.query(sql); } catch (e) {}
  }
}

async function loadRow(userId) {
  await ensureArcadeCol();
  const [rows] = await pool.query(
    'SELECT arcade_seen_level, arcade_rebirth, arcade_xp_spent, arcade_rp, arcade_world, arcade_world_prev, arcade_title, arcade_unlocks FROM user_casino WHERE user_id = ?',
    [userId]
  );
  if (!rows[0]) {
    await pool.query(
      'INSERT INTO user_casino (user_id, arcade_seen_level) VALUES (?, 1) ON DUPLICATE KEY UPDATE arcade_seen_level = arcade_seen_level',
      [userId]
    );
    return {
      arcade_seen_level: 1,
      arcade_rebirth: 0,
      arcade_xp_spent: 0,
      arcade_rp: 0,
      arcade_world: 'origin',
      arcade_world_prev: 'origin',
      arcade_title: null,
      arcade_unlocks: null
    };
  }
  return rows[0];
}

async function saveUnlocks(userId, unlocks) {
  await pool.query('UPDATE user_casino SET arcade_unlocks = ? WHERE user_id = ?', [JSON.stringify(unlocks), userId]);
}

function guestState() {
  const unlocks = parseUnlocks(null, 0);
  return {
    guest: true,
    level: 1,
    xp: 0,
    into: 0,
    need: 140,
    maxed: false,
    canRebirth: false,
    rebirth: 0,
    overflow: 0,
    leftoverAfter: 0,
    rebirthCost: xpToReach(MAX_LEVEL),
    rp: 0,
    shop: catalog(unlocks, 0, 0, 'origin', '', 'origin'),
    ranks: [],
    modes: MODES.map((m) => Object.assign({}, m, { unlocked: m.level <= 1 })),
    lifetime: { won: '0', economy: '0', wagered: '0', wins: 0 },
    leveledUp: false
  };
}

async function listRebirthRanks(limit) {
  await ensureArcadeCol();
  const n = Math.min(30, Math.max(5, parseInt(limit, 10) || 10));
  try {
    const [rows] = await pool.query(`
      SELECT c.user_id, c.arcade_rebirth, c.arcade_rp, c.arcade_title, c.arcade_world, u.username
      FROM user_casino c
      LEFT JOIN users u ON u.discord_id = c.user_id
      WHERE c.arcade_rebirth > 0
      ORDER BY c.arcade_rebirth DESC, c.arcade_rp DESC
      LIMIT ?
    `, [n]);
    return rows.map((r, i) => ({
      rank: i + 1,
      name: r.username || ('유저_' + String(r.user_id || '').slice(-4)),
      rebirth: Number(r.arcade_rebirth) || 0,
      rp: Number(r.arcade_rp) || 0,
      title: r.arcade_title || '회귀자',
      world: r.arcade_world || 'origin'
    }));
  } catch (e) {
    return [];
  }
}

async function getArcadeState(userId) {
  await ensureArcadeCol();
  if (!userId) return guestState();
  const life = await loadLifetime(userId);
  const rawXp = xpFromStats(life);
  const row = await loadRow(userId);
  const rebirth = Number(row.arcade_rebirth) || 0;
  const spent = Number(row.arcade_xp_spent) || 0;
  const rp = Number(row.arcade_rp) || 0;
  const effective = Math.max(0, rawXp - spent);
  const prog = levelFromXp(effective);
  const cost = xpToReach(MAX_LEVEL);
  const maxed = prog.level >= MAX_LEVEL;
  const canRebirth = maxed && effective >= cost;
  const overflow = maxed ? Math.max(0, effective - cost) : 0;
  const unlocks = parseUnlocks(row.arcade_unlocks, rebirth);
  let seen = Number(row.arcade_seen_level) || 1;
  if (!row.arcade_seen_level) {
    await pool.query('UPDATE user_casino SET arcade_seen_level = ? WHERE user_id = ?', [prog.level, userId]);
    seen = prog.level;
  }
  const leveledUp = prog.level > seen;
  const modes = MODES.map((m) => Object.assign({}, m, { unlocked: prog.level >= m.level || rebirth >= 1 }));
  const ranks = await listRebirthRanks(8);
  const title = row.arcade_title || (rebirth >= 1 ? 'returner' : '');
  return {
    guest: false,
    level: prog.level,
    xp: effective,
    rawXp,
    into: maxed ? Math.min(prog.into, prog.need) : prog.into,
    need: prog.need,
    maxed,
    canRebirth,
    overflow,
    leftoverAfter: 0,
    rebirthCost: cost,
    rebirth,
    rp,
    seenLevel: seen,
    leveledUp,
    newUnlocks: leveledUp ? modes.filter((m) => m.level > seen && m.level <= prog.level) : [],
    modes,
    shop: catalog(unlocks, rebirth, rp, row.arcade_world, title, row.arcade_world_prev),
    ranks,
    vipHonor: vipHonorWon(rebirth),
    lifetime: {
      won: String(Math.floor(life.won)),
      economy: String(Math.floor(life.economy)),
      wagered: String(Math.floor(life.wagered)),
      wins: life.wins,
      clicks: life.clicks
    }
  };
}

async function ackArcadeLevel(userId, level) {
  await ensureArcadeCol();
  const n = Math.max(1, Math.min(MAX_LEVEL, parseInt(level, 10) || 1));
  await pool.query(
    'INSERT INTO user_casino (user_id, arcade_seen_level) VALUES (?, ?) ON DUPLICATE KEY UPDATE arcade_seen_level = GREATEST(arcade_seen_level, ?)',
    [userId, n, n]
  );
  return getArcadeState(userId);
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

async function doRebirth(userId) {
  if (!userId) fail(401, '로그인이 필요합니다.');
  const state = await getArcadeState(userId);
  if (!state.canRebirth) fail(400, '만렙(Lv.40)에 도달해야 환생할 수 있습니다.');
  const row = await loadRow(userId);
  const rebirth = (Number(row.arcade_rebirth) || 0) + 1;
  const spent = (Number(row.arcade_xp_spent) || 0) + Math.max(0, Number(state.xp) || 0);
  const rp = (Number(row.arcade_rp) || 0) + RP_PER_REBIRTH;
  const unlocks = parseUnlocks(row.arcade_unlocks, rebirth);
  if (!unlocks.titles.includes('returner')) unlocks.titles.push('returner');
  const title = row.arcade_title || 'returner';
  await pool.query(`
    UPDATE user_casino
    SET arcade_rebirth = ?, arcade_xp_spent = ?, arcade_rp = ?, arcade_seen_level = 1,
        arcade_unlocks = ?, arcade_title = COALESCE(arcade_title, 'returner')
    WHERE user_id = ?
  `, [rebirth, spent, rp, JSON.stringify(unlocks), userId]);
  const next = await getArcadeState(userId);
  next.justRebirth = true;
  next.gainedRp = RP_PER_REBIRTH;
  next.title = title;
  return next;
}

async function buyArcadeItem(userId, kind, id) {
  if (!userId) fail(401, '로그인이 필요합니다.');
  const row = await loadRow(userId);
  const rebirth = Number(row.arcade_rebirth) || 0;
  let rp = Number(row.arcade_rp) || 0;
  const unlocks = parseUnlocks(row.arcade_unlocks, rebirth);
  if (kind === 'world') {
    const item = WORLDS.find((w) => w.id === id);
    if (!item) fail(404, '없는 세계입니다.');
    if (item.cost === 0 || unlocks.worlds.includes(item.id)) fail(400, '이미 열린 세계입니다.');
    if (rp < item.cost) fail(400, '환생 포인트가 부족합니다.');
    rp -= item.cost;
    unlocks.worlds.push(item.id);
    await pool.query('UPDATE user_casino SET arcade_rp = ?, arcade_unlocks = ? WHERE user_id = ?', [rp, JSON.stringify(unlocks), userId]);
    return getArcadeState(userId);
  }
  if (kind === 'title') {
    const item = TITLES.find((t) => t.id === id);
    if (!item) fail(404, '없는 칭호입니다.');
    const owned = unlocks.titles.includes(item.id) || (item.minRebirth && rebirth >= item.minRebirth);
    if (owned && item.cost === 0) {
      await pool.query('UPDATE user_casino SET arcade_title = ? WHERE user_id = ?', [item.id, userId]);
      return getArcadeState(userId);
    }
    if (owned) {
      await pool.query('UPDATE user_casino SET arcade_title = ? WHERE user_id = ?', [item.id, userId]);
      return getArcadeState(userId);
    }
    if (rp < item.cost) fail(400, '환생 포인트가 부족합니다.');
    rp -= item.cost;
    unlocks.titles.push(item.id);
    await pool.query('UPDATE user_casino SET arcade_rp = ?, arcade_unlocks = ?, arcade_title = ? WHERE user_id = ?', [rp, JSON.stringify(unlocks), item.id, userId]);
    return getArcadeState(userId);
  }
  fail(400, '상점 종류가 올바르지 않습니다.');
}

async function switchArcadeWorld(userId, worldId, back) {
  if (!userId) fail(401, '로그인이 필요합니다.');
  const row = await loadRow(userId);
  const rebirth = Number(row.arcade_rebirth) || 0;
  const unlocks = parseUnlocks(row.arcade_unlocks, rebirth);
  const target = back ? (row.arcade_world_prev || 'origin') : String(worldId || 'origin');
  const def = WORLDS.find((w) => w.id === target) || WORLDS[0];
  if (def.cost > 0 && !unlocks.worlds.includes(def.id)) fail(403, '아직 열리지 않은 세계입니다. 환생 상점에서 해금하세요.');
  const prev = row.arcade_world || 'origin';
  if (!back && prev === def.id) return getArcadeState(userId);
  await pool.query(
    'UPDATE user_casino SET arcade_world_prev = ?, arcade_world = ? WHERE user_id = ?',
    [prev, def.id, userId]
  );
  return getArcadeState(userId);
}

async function adminSetRebirth(userId, patch) {
  await ensureArcadeCol();
  await loadRow(userId);
  const fields = [];
  const args = [];
  if (patch.rebirth != null && patch.rebirth !== '') {
    fields.push('arcade_rebirth = ?');
    args.push(Math.max(0, Math.min(9999, parseInt(patch.rebirth, 10) || 0)));
  }
  if (patch.rp != null && patch.rp !== '') {
    fields.push('arcade_rp = ?');
    args.push(Math.max(0, Math.min(999999, parseInt(patch.rp, 10) || 0)));
  }
  if (!fields.length) fail(400, '환생 횟수 또는 RP를 입력하세요.');
  args.push(userId);
  await pool.query(`UPDATE user_casino SET ${fields.join(', ')} WHERE user_id = ?`, args);
  return getArcadeState(userId);
}

function assertModeUnlocked(state, modeId) {
  const mode = (state.modes || []).find((m) => m.id === modeId);
  if (!mode) fail(404, '없는 모드입니다.');
  if (!mode.unlocked) fail(403, 'Lv.' + mode.level + '에 해금됩니다.');
  return mode;
}

module.exports = {
  MODES,
  WORLDS,
  TITLES,
  MAX_LEVEL,
  RP_PER_REBIRTH,
  levelFromXp,
  xpFromStats,
  xpToReach,
  vipHonorWon,
  getArcadeState,
  ackArcadeLevel,
  doRebirth,
  buyArcadeItem,
  switchArcadeWorld,
  listRebirthRanks,
  adminSetRebirth,
  assertModeUnlocked
};
