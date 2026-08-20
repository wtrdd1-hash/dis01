/**
 * 🛡️ 경제 안정성 & 유저별 너프 시스템
 *
 * - Gini 계수 등 경제 지표에 따라 채굴/클릭/자동채굴 수익 자동 조정
 * - 특정 유저에게 개별 너프/부스트 적용 (관리자 설정)
 * - 채굴/활동 시 자동 적용되는 최종 배율 계산
 */
const { pool } = require('../config/database');

const PROTECTED_ADMIN_ID = '886478189520637992';
const PROTECTED_ADMIN_ID_2 = '889085646768078850';
const PROTECTED_ADMIN_IDS = new Set([PROTECTED_ADMIN_ID, PROTECTED_ADMIN_ID_2]);

let _modifierCache = null;
let _modifierCacheAt = 0;
const MOD_CACHE_TTL_MS = 30 * 1000;

let _systemCache = {
  globalMineNerf: 1.0,
  globalClickNerf: 1.0,
  globalAutoNerf: 1.0,
  emergencyLock: false,
  at: 0
};
const SYSTEM_CACHE_TTL_MS = 5 * 1000;

async function loadModifierCache(forceReload = false) {
  const now = Date.now();
  if (!forceReload && _modifierCache && _modifierCacheAt > now - MOD_CACHE_TTL_MS) {
    return _modifierCache;
  }
  try {
    const [rows] = await pool.query(`
      SELECT discord_id, mine_multiplier, click_multiplier, auto_multiplier,
             cash_cap, note, expires_at, is_active
      FROM user_economy_modifier
      WHERE is_active = 1
        AND (expires_at IS NULL OR expires_at > NOW())
    `);
    const map = new Map();
    for (const r of rows) {
      map.set(String(r.discord_id), {
        mineMultiplier: Number(r.mine_multiplier ?? 1.0),
        clickMultiplier: Number(r.click_multiplier ?? 1.0),
        autoMultiplier: Number(r.auto_multiplier ?? 1.0),
        cashCap: r.cash_cap ? Number(r.cash_cap) : null,
        note: r.note || '',
        expiresAt: r.expires_at
      });
    }
    _modifierCache = map;
    _modifierCacheAt = now;
    return map;
  } catch (e) {
    console.error('[economyModifier] 캐시 로드 실패:', e.message);
    return _modifierCache || new Map();
  }
}

function invalidateCache() {
  _modifierCache = null;
  _modifierCacheAt = 0;
  _systemCache = { globalMineNerf: 1.0, globalClickNerf: 1.0, globalAutoNerf: 1.0, emergencyLock: false, at: 0 };
}

async function getUserModifier(userId) {
  if (!userId) return null;
  const id = String(userId);
  if (PROTECTED_ADMIN_IDS.has(id)) return null;
  const map = await loadModifierCache();
  return map.get(id) || null;
}

function getSystemNerf() {
  const now = Date.now();
  if (_systemCache.at > now - SYSTEM_CACHE_TTL_MS) return _systemCache;
  return { globalMineNerf: 1.0, globalClickNerf: 1.0, globalAutoNerf: 1.0, emergencyLock: false, at: now };
}

async function computeFinalMultipliers(userId) {
  const sys = getSystemNerf();
  const userMod = await getUserModifier(userId);
  return {
    mine: userMod ? userMod.mineMultiplier * sys.globalMineNerf : sys.globalMineNerf,
    click: userMod ? userMod.clickMultiplier * sys.globalClickNerf : sys.globalClickNerf,
    auto: userMod ? userMod.autoMultiplier * sys.globalAutoNerf : sys.globalAutoNerf,
    cashCap: userMod ? userMod.cashCap : null,
    emergencyLock: sys.emergencyLock,
    userModified: !!userMod
  };
}

async function listActiveModifiers() {
  const [rows] = await pool.query(`
    SELECT discord_id, username, mine_multiplier, click_multiplier, auto_multiplier,
           cash_cap, note, expires_at, created_at
    FROM user_economy_modifier
    WHERE is_active = 1
    ORDER BY created_at DESC
    LIMIT 200
  `).catch(() => [[]]);
  if (!Array.isArray(rows)) return [];
  return rows;
}

async function setUserModifier({ discordId, username, mineMultiplier, clickMultiplier, autoMultiplier, cashCap, note, expiresAt, adminId, adminUsername }) {
  if (!discordId) throw new Error('Discord ID 필수');
  if (PROTECTED_ADMIN_IDS.has(String(discordId))) {
    throw new Error('🔒 시스템 절대 보호 관리자(886478189520637992 / 889085646768078850)는 너프 적용 불가');
  }
  const safeMine = clamp(mineMultiplier ?? 1.0, 0, 10);
  const safeClick = clamp(clickMultiplier ?? 1.0, 0, 10);
  const safeAuto = clamp(autoMultiplier ?? 1.0, 0, 10);
  const cap = cashCap ? BigInt(cashCap) : null;

  await pool.query(`
    INSERT INTO user_economy_modifier
      (discord_id, username, mine_multiplier, click_multiplier, auto_multiplier,
       cash_cap, note, expires_at, added_by_id, added_by_username, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())
    ON DUPLICATE KEY UPDATE
      username = VALUES(username),
      mine_multiplier = VALUES(mine_multiplier),
      click_multiplier = VALUES(click_multiplier),
      auto_multiplier = VALUES(auto_multiplier),
      cash_cap = VALUES(cash_cap),
      note = VALUES(note),
      expires_at = VALUES(expires_at),
      added_by_id = VALUES(added_by_id),
      added_by_username = VALUES(added_by_username),
      is_active = 1
  `, [
    String(discordId),
    username || null,
    safeMine,
    safeClick,
    safeAuto,
    cap ? cap.toString() : null,
    note || null,
    expiresAt || null,
    adminId || null,
    adminUsername || null
  ]);

  invalidateCache();
  return { success: true };
}

async function removeUserModifier(discordId) {
  if (!discordId) throw new Error('Discord ID 필수');
  if (PROTECTED_ADMIN_IDS.has(String(discordId))) {
    throw new Error('🔒 시스템 절대 보호 관리자(886478189520637992 / 889085646768078850)는 삭제 불가');
  }
  const [result] = await pool.query(
    'DELETE FROM user_economy_modifier WHERE discord_id = ?',
    [String(discordId)]
  );
  invalidateCache();
  return { success: true, affectedRows: result.affectedRows };
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

module.exports = {
  loadModifierCache,
  getUserModifier,
  getSystemNerf,
  computeFinalMultipliers,
  listActiveModifiers,
  setUserModifier,
  removeUserModifier,
  invalidateCache,
  PROTECTED_ADMIN_ID
};