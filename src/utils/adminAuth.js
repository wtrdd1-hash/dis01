/**
 * 👑 DB 기반 동적 관리자 권한 모듈
 *
 * - 886478189520637992는 시스템 절대 보호 관리자 (SUPER_ADMIN)
 * - admin_accounts 테이블과 env/config 기반 default 관리자를 합산하여 권한 검사
 * - config.isAdmin()이 매번 DB를 호출하지 않도록 메모리 캐시 사용 (10초 TTL)
 */
const { pool } = require('../config/database');
const config = require('../config/config');

const PROTECTED_ADMIN_ID = '886478189520637992';
const PROTECTED_ADMIN_ID_2 = '889085646768078850';
const PROTECTED_ADMIN_IDS = new Set([PROTECTED_ADMIN_ID, PROTECTED_ADMIN_ID_2]);

let cache = {
  ids: null,
  expiresAt: 0
};
const CACHE_TTL_MS = 10 * 1000;

async function loadAdminIdsFromDb() {
  try {
    const [rows] = await pool.query('SELECT discord_id, role FROM admin_accounts');
    const ids = new Set();
    for (const r of rows) {
      if (r.discord_id) ids.add(String(r.discord_id));
    }
    return ids;
  } catch (e) {
    console.error('[adminAuth] admin_accounts 조회 실패:', e.message);
    return null;
  }
}

async function getEffectiveAdminIds() {
  const now = Date.now();
  if (cache.ids && cache.expiresAt > now) {
    return cache.ids;
  }
  const dbIds = await loadAdminIdsFromDb();
  const merged = new Set(PROTECTED_ADMIN_IDS);
  if (dbIds) {
    for (const id of dbIds) merged.add(id);
  }
  for (const id of config.adminIds || []) {
    if (id) merged.add(String(id));
  }
  cache = { ids: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

function invalidateCache() {
  cache = { ids: null, expiresAt: 0 };
}

async function isAdminAsync(userId) {
  if (!userId) return false;
  const id = String(userId);
  if (PROTECTED_ADMIN_IDS.has(id)) return true;
  const ids = await getEffectiveAdminIds();
  return ids.has(id);
}

async function requireSuperAdmin(userId) {
  if (!userId) return false;
  const id = String(userId);
  if (PROTECTED_ADMIN_IDS.has(id)) return true;
  try {
    const [rows] = await pool.query('SELECT role FROM admin_accounts WHERE discord_id = ? LIMIT 1', [id]);
    if (rows.length && rows[0].role === 'SUPER_ADMIN') return true;
  } catch (e) {}
  return false;
}

async function listAdminAccounts() {
  try {
    const [rows] = await pool.query(`
      SELECT discord_id, username, role, note, added_by_id, added_by_username, created_at
      FROM admin_accounts
      ORDER BY (discord_id = ?) DESC, created_at ASC
    `, [PROTECTED_ADMIN_ID]);
    return rows;
  } catch (e) {
    return [];
  }
}

async function addAdminAccount({ discordId, username, role, note, addedById, addedByUsername }) {
  if (!discordId || !/^\d{16,22}$/.test(String(discordId))) {
    throw new Error('Discord ID는 16~22자리 숫자여야 합니다.');
  }
  if (PROTECTED_ADMIN_IDS.has(String(discordId))) {
    throw new Error('시스템 절대 보호 관리자는 별도 권한 구조를 가지며 추가 작업이 불필요합니다.');
  }
  const safeRole = (role === 'SUPER_ADMIN') ? 'SUPER_ADMIN' : 'ADMIN';
  try {
    await pool.query(`
      INSERT INTO admin_accounts (discord_id, username, role, note, added_by_id, added_by_username)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        username = VALUES(username),
        role = VALUES(role),
        note = VALUES(note),
        added_by_id = VALUES(added_by_id),
        added_by_username = VALUES(added_by_username)
    `, [String(discordId), username || null, safeRole, note || null, addedById || null, addedByUsername || null]);
    invalidateCache();
    return { success: true };
  } catch (e) {
    throw new Error('관리자 추가 실패: ' + e.message);
  }
}

async function removeAdminAccount({ discordId, removedById }) {
  if (!discordId) throw new Error('Discord ID가 필요합니다.');
  if (PROTECTED_ADMIN_IDS.has(String(discordId))) {
    throw new Error('🚫 시스템 절대 보호 관리자(886478189520637992)는 절대 삭제할 수 없습니다.');
  }
  if (removedById && String(removedById) === String(discordId)) {
    throw new Error('자기 자신을 관리자 목록에서 삭제할 수 없습니다.');
  }
  try {
    const [result] = await pool.query('DELETE FROM admin_accounts WHERE discord_id = ?', [String(discordId)]);
    if (!result.affectedRows) {
      throw new Error('해당 Discord ID는 관리자 목록에 없습니다.');
    }
    invalidateCache();
    return { success: true, affectedRows: result.affectedRows };
  } catch (e) {
    throw new Error('관리자 삭제 실패: ' + e.message);
  }
}

module.exports = {
  PROTECTED_ADMIN_ID,
  isAdminAsync,
  requireSuperAdmin,
  listAdminAccounts,
  addAdminAccount,
  removeAdminAccount,
  invalidateCache,
  getEffectiveAdminIds
};