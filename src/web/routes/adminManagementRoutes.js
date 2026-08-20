/**
 * 👑 관리자 계정 관리 라우트
 *
 * - 유저 계정 영구 삭제 (관리자 직권)
 * - 관리자 계정 추가 / 삭제 / 조회 (DB 기반)
 * - 모든 변경 작업은 CSRF 토큰 검증 필수
 */
const express = require('express');
const { pool } = require('../../config/database');
const { formatMoney } = require('../../utils/formatters');
const { logAdminAction } = require('../../utils/logger');
const { isDiscordSnowflake } = require('../httpSafe');
const { withdrawUserAccount } = require('../../utils/userWithdrawEngine');
const {
  listAdminAccounts,
  addAdminAccount,
  removeAdminAccount,
  requireSuperAdmin,
  PROTECTED_ADMIN_ID,
  invalidateCache
} = require('../../utils/adminAuth');

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsStr(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function createAdminManagementRoutes() {
  const router = express.Router();

  // 🛡️ POST/PUT/DELETE는 모두 CSRF 미들웨어 통과 필수
  router.use(require('../csrfGuard').requireCsrf);

  // ===========================================================
  // 🗑️ 유저 계정 영구 삭제 (관리자 직권)
  // ===========================================================
  router.post('/action/user-delete', async (req, res) => {
    const session = req.adminSession;
    const { userId, reason } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: '삭제할 유저 ID(또는 닉네임)를 입력하세요.' });
    }

    const why = String(reason || '').trim().slice(0, 200) || '관리자 직권 영구 계정 삭제';

    try {
      const raw = String(userId).trim();
      const mention = raw.match(/^<@!?(\d{16,22})>$/);
      let targetId = null;
      let username = null;
      if (mention) {
        targetId = mention[1];
      } else if (/^\d{16,22}$/.test(raw)) {
        targetId = raw;
      }
      if (targetId) {
        const [rows] = await pool.query('SELECT username FROM users WHERE discord_id = ? LIMIT 1', [targetId]);
        if (rows.length) username = rows[0].username;
      } else {
        const nick = raw.replace(/^@+/, '').trim();
        const [exact] = await pool.query('SELECT discord_id, username FROM users WHERE username = ? LIMIT 1', [nick]);
        if (exact.length) {
          targetId = exact[0].discord_id;
          username = exact[0].username;
        } else {
          const [fuzzy] = await pool.query('SELECT discord_id, username FROM users WHERE username LIKE ? LIMIT 1', [`%${nick}%`]);
          if (fuzzy.length) {
            targetId = fuzzy[0].discord_id;
            username = fuzzy[0].username;
          }
        }
      }

      if (!targetId) {
        return res.status(404).json({ success: false, error: '삭제할 유저를 찾을 수 없습니다.' });
      }

      if (String(targetId) === PROTECTED_ADMIN_ID) {
        return res.status(403).json({
          success: false,
          error: '🚫 시스템 절대 보호 관리자(886478189520637992)는 절대 삭제할 수 없습니다.'
        });
      }

      const [adminCheck] = await pool.query('SELECT 1 FROM admin_accounts WHERE discord_id = ? LIMIT 1', [String(targetId)]);
      if (adminCheck.length) {
        return res.status(403).json({
          success: false,
          error: '다른 관리자 계정은 admin_accounts 목록에서 먼저 제거한 후 삭제 가능합니다.'
        });
      }

      const result = await withdrawUserAccount(targetId, `관리자(@${session.username}) 영구 삭제: ${why}`);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_USER_DELETE', targetId, {
        username,
        reason: why
      }, req);

      return res.json({
        success: true,
        message: `[@${username || result.username}] 계정 및 모든 자산 데이터를 영구 삭제했습니다.`,
        data: result
      });
    } catch (e) {
      console.error('유저 영구 삭제 오류:', e);
      return res.status(500).json({ success: false, error: e.message || '유저 삭제 중 오류가 발생했습니다.' });
    }
  });

  // ===========================================================
  // 👑 관리자 계정 목록 조회
  // ===========================================================
  router.get('/admins/list', async (req, res) => {
    try {
      const rows = await listAdminAccounts();
      return res.json({
        success: true,
        protectedAdminId: PROTECTED_ADMIN_ID,
        total: rows.length,
        admins: rows.map((r) => ({
          discordId: String(r.discord_id),
          username: r.username || '-',
          role: r.role,
          note: r.note || '',
          addedById: r.added_by_id || null,
          addedByUsername: r.added_by_username || null,
          createdAt: r.created_at,
          isProtected: String(r.discord_id) === PROTECTED_ADMIN_ID
        }))
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===========================================================
  // ➕ 관리자 계정 추가 (SUPER_ADMIN 권한 필요)
  // ===========================================================
  router.post('/admins/add', async (req, res) => {
    const session = req.adminSession;
    const { discordId, username, role, note } = req.body;

    if (!discordId) {
      return res.status(400).json({ success: false, error: '추가할 Discord ID를 입력하세요.' });
    }
    if (!isDiscordSnowflake(String(discordId))) {
      return res.status(400).json({ success: false, error: 'Discord ID는 16~22자리 숫자(눈송이)여야 합니다.' });
    }

    const isSuper = await requireSuperAdmin(session.id);
    if (!isSuper) {
      return res.status(403).json({
        success: false,
        error: '🚫 SUPER_ADMIN 권한이 필요합니다. 일반 관리자는 관리자 계정을 추가할 수 없습니다.'
      });
    }

    try {
      const safeRole = (role === 'SUPER_ADMIN') ? 'SUPER_ADMIN' : 'ADMIN';
      await addAdminAccount({
        discordId: String(discordId),
        username: String(username || '').trim().slice(0, 100) || null,
        role: safeRole,
        note: String(note || '').trim().slice(0, 250) || null,
        addedById: session.id,
        addedByUsername: session.username || '관리자'
      });

      invalidateCache();

      await logAdminAction(session.id, session.username || '관리자', 'WEB_ADMIN_ADD', String(discordId), {
        addedDiscordId: String(discordId),
        addedUsername: username,
        role: safeRole,
        note: note
      }, req);

      return res.json({
        success: true,
        message: `Discord ID ${discordId}를 ${safeRole === 'SUPER_ADMIN' ? '최고' : '일반'} 관리자로 등록했습니다.`
      });
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }
  });

  // ===========================================================
  // ➖ 관리자 계정 삭제 (SUPER_ADMIN 권한 필요, 보호 관리자 제외)
  // ===========================================================
  router.post('/admins/remove', async (req, res) => {
    const session = req.adminSession;
    const { discordId, reason } = req.body;

    if (!discordId) {
      return res.status(400).json({ success: false, error: '삭제할 Discord ID를 입력하세요.' });
    }

    const isSuper = await requireSuperAdmin(session.id);
    if (!isSuper) {
      return res.status(403).json({
        success: false,
        error: '🚫 SUPER_ADMIN 권한이 필요합니다. 일반 관리자는 관리자 계정을 삭제할 수 없습니다.'
      });
    }

    try {
      const result = await removeAdminAccount({
        discordId: String(discordId),
        removedById: session.id
      });

      invalidateCache();

      await logAdminAction(session.id, session.username || '관리자', 'WEB_ADMIN_REMOVE', String(discordId), {
        removedDiscordId: String(discordId),
        reason: String(reason || '').slice(0, 200) || null
      }, req);

      return res.json({
        success: true,
        message: `Discord ID ${discordId} 관리자 권한을 박탈했습니다.`,
        data: result
      });
    } catch (e) {
      return res.status(400).json({ success: false, error: e.message });
    }
  });

  return router;
}

module.exports = { createAdminManagementRoutes };