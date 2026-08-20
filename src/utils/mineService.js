/**
 * 채굴 장르 해금·통계·순위·속보
 */
const { pool } = require('../config/database');
const { applyCashDelta, safeBigInt } = require('./money');
const { formatMoney } = require('./formatters');
const {
  DEFAULT_GENRE,
  normalizeGenre,
  getGenre,
  publicGenreList,
  currentWeather,
  badgeForClicks,
  depthForClicks,
  MEGA_CRIT_MIN,
  ANNOUNCE_USER_COOLDOWN_MS,
  ANNOUNCE_GLOBAL_COOLDOWN_MS
} = require('./mineGenres');

const announceUserAt = new Map();
let announceGlobalAt = 0;
let tableReady = false;

async function ensureMineTables() {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mine_genre_stats (
      user_id VARCHAR(32) NOT NULL,
      genre_id VARCHAR(16) NOT NULL,
      unlocked TINYINT(1) NOT NULL DEFAULT 0,
      clicks BIGINT NOT NULL DEFAULT 0,
      max_combo INT NOT NULL DEFAULT 0,
      max_depth INT NOT NULL DEFAULT 0,
      unlocked_at DATETIME NULL,
      PRIMARY KEY (user_id, genre_id),
      INDEX idx_genre_clicks (genre_id, clicks)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const [cols] = await pool.query("SHOW COLUMNS FROM users LIKE 'mine_genre'");
  if (!cols.length) {
    await pool.query("ALTER TABLE users ADD COLUMN mine_genre VARCHAR(16) NOT NULL DEFAULT 'classic'");
  }
  tableReady = true;
}

async function ensureClassic(userId) {
  await ensureMineTables();
  await pool.query(
    `INSERT INTO mine_genre_stats (user_id, genre_id, unlocked, unlocked_at)
     VALUES (?, 'classic', 1, NOW())
     ON DUPLICATE KEY UPDATE unlocked = 1`,
    [String(userId)]
  );
}

async function isUnlocked(userId, genreId) {
  const id = normalizeGenre(genreId);
  if (id === DEFAULT_GENRE) return true;
  await ensureClassic(userId);
  const [rows] = await pool.query(
    'SELECT unlocked FROM mine_genre_stats WHERE user_id = ? AND genre_id = ? LIMIT 1',
    [String(userId), id]
  );
  return Boolean(rows[0] && Number(rows[0].unlocked) === 1);
}

async function getSelectedGenre(userId) {
  await ensureMineTables();
  const [rows] = await pool.query(
    'SELECT mine_genre FROM users WHERE discord_id = ? LIMIT 1',
    [String(userId)]
  );
  const selected = normalizeGenre(rows[0] && rows[0].mine_genre);
  if (!(await isUnlocked(userId, selected))) return DEFAULT_GENRE;
  return selected;
}

async function setSelectedGenre(userId, genreId) {
  const id = normalizeGenre(genreId);
  if (!(await isUnlocked(userId, id))) {
    const err = new Error('아직 해금하지 않은 장르입니다.');
    err.status = 400;
    throw err;
  }
  await pool.query('UPDATE users SET mine_genre = ? WHERE discord_id = ?', [id, String(userId)]);
  return id;
}

async function getState(userId) {
  await ensureClassic(userId);
  const uid = String(userId);
  const [statRows] = await pool.query(
    'SELECT genre_id, unlocked, clicks, max_combo, max_depth FROM mine_genre_stats WHERE user_id = ?',
    [uid]
  );
  const byId = {};
  for (const row of statRows) {
    byId[row.genre_id] = row;
  }
  const selected = await getSelectedGenre(uid);
  const genres = publicGenreList().map((g) => {
    const row = byId[g.id] || {};
    const clicks = Number(row.clicks || 0);
    const unlocked = g.id === DEFAULT_GENRE || Number(row.unlocked) === 1;
    return {
      ...g,
      unlocked,
      clicks,
      maxCombo: Number(row.max_combo || 0),
      maxDepth: Number(row.max_depth || 0),
      depth: depthForClicks(clicks),
      badge: badgeForClicks(clicks)
    };
  });
  const current = genres.find((g) => g.id === selected) || genres[0];
  return {
    selected,
    weather: currentWeather(),
    genres,
    current,
    leaderboard: await getLeaderboard(selected, 8)
  };
}

async function unlockGenre(userId, genreId) {
  const genre = getGenre(genreId);
  if (genre.id === DEFAULT_GENRE || genre.unlockCost <= 0) {
    await ensureClassic(userId);
    await setSelectedGenre(userId, genre.id);
    return { already: true, genre, newCash: null };
  }
  await ensureClassic(userId);
  if (await isUnlocked(userId, genre.id)) {
    await setSelectedGenre(userId, genre.id);
    return { already: true, genre, newCash: null };
  }

  const cost = safeBigInt(genre.unlockCost);
  const newCash = await applyCashDelta(userId, -cost);
  await pool.query(
    `INSERT INTO mine_genre_stats (user_id, genre_id, unlocked, unlocked_at)
     VALUES (?, ?, 1, NOW())
     ON DUPLICATE KEY UPDATE unlocked = 1, unlocked_at = COALESCE(unlocked_at, NOW())`,
    [String(userId), genre.id]
  );
  await setSelectedGenre(userId, genre.id);
  return { already: false, genre, newCash: newCash.toString() };
}

async function recordClicks(userId, genreId, clicks, combo, depth) {
  const id = normalizeGenre(genreId);
  const n = Math.max(0, parseInt(clicks, 10) || 0);
  if (n <= 0) return id;
  await ensureClassic(userId);
  const unlocked = await isUnlocked(userId, id);
  const useId = unlocked ? id : DEFAULT_GENRE;
  const comboN = Math.max(0, parseInt(combo, 10) || 0);
  const depthN = Math.max(0, parseInt(depth, 10) || 0);
  await pool.query(
    `INSERT INTO mine_genre_stats (user_id, genre_id, unlocked, clicks, max_combo, max_depth, unlocked_at)
     VALUES (?, ?, ?, ?, ?, ?, IF(?=1, NOW(), NULL))
     ON DUPLICATE KEY UPDATE
       clicks = clicks + VALUES(clicks),
       max_combo = GREATEST(max_combo, VALUES(max_combo)),
       max_depth = GREATEST(max_depth, VALUES(max_depth))`,
    [String(userId), useId, useId === DEFAULT_GENRE ? 1 : (unlocked ? 1 : 0), n, comboN, depthN, useId === DEFAULT_GENRE ? 1 : 0]
  );
  return useId;
}

async function getLeaderboard(genreId, limit) {
  await ensureMineTables();
  const id = normalizeGenre(genreId);
  const cap = Math.min(20, Math.max(3, parseInt(limit, 10) || 8));
  const [rows] = await pool.query(
    `SELECT s.user_id, s.clicks, COALESCE(u.username, CONCAT('유저_', RIGHT(s.user_id, 4))) AS username
     FROM mine_genre_stats s
     LEFT JOIN users u ON u.discord_id = s.user_id
     WHERE s.genre_id = ? AND s.clicks > 0
     ORDER BY s.clicks DESC
     LIMIT ?`,
    [id, cap]
  );
  return rows.map((row, idx) => ({
    rank: idx + 1,
    userId: String(row.user_id),
    username: row.username,
    clicks: Number(row.clicks || 0)
  }));
}

async function maybeAnnounceMega({ userId, username, avatar, genreId, critCount, earned }) {
  const crits = Number(critCount || 0);
  if (crits < MEGA_CRIT_MIN) return false;
  const now = Date.now();
  if (now - announceGlobalAt < ANNOUNCE_GLOBAL_COOLDOWN_MS) return false;
  const prev = announceUserAt.get(String(userId)) || 0;
  if (now - prev < ANNOUNCE_USER_COOLDOWN_MS) return false;
  announceGlobalAt = now;
  announceUserAt.set(String(userId), now);

  const genre = getGenre(genreId);
  const name = username || '광부';
  const text = `🔥 ${name} 님이 ${genre.emoji} ${genre.name}에서 초대형 크리티컬 ${crits}회! +${formatMoney(earned)}`;

  try {
    const chat = require('../web/chatService');
    await chat.postSystemNotice(text, { userId, username: name, avatar: avatar || '' });
  } catch (e) {}

  try {
    await sendDiscordAnnounce(text);
  } catch (e) {}

  return true;
}

async function sendDiscordAnnounce(text) {
  const webhook = process.env.DISCORD_MINE_WEBHOOK_URL || '';
  const channelId = process.env.DISCORD_ANNOUNCE_CHANNEL_ID || '';
  if (webhook) {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: String(text).slice(0, 1800) })
    });
  }
  const client = global.__discordClient;
  if (channelId && client && typeof client.channels?.fetch === 'function') {
    const ch = await client.channels.fetch(channelId);
    if (ch && typeof ch.send === 'function') {
      await ch.send({ content: String(text).slice(0, 1800) });
    }
  }
}

module.exports = {
  ensureMineTables,
  ensureClassic,
  isUnlocked,
  getSelectedGenre,
  setSelectedGenre,
  getState,
  unlockGenre,
  recordClicks,
  getLeaderboard,
  maybeAnnounceMega
};
