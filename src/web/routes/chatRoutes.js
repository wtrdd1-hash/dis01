/**
 * 💬 실시간 광장 채팅 라우트 모듈
 */
const express = require('express');
const { pool } = require('../../config/database');
const config = require('../../config/config');

function createChatRoutes(getSessionUser, sseClients) {
  const router = express.Router();
  const chatCooldownMap = new Map();

  // 💬 최근 채팅 메시지 목록 조회 API (최근 60건)
  router.get('/messages', async (req, res) => {
    try {
      const [messages] = await pool.query(`
        SELECT id, user_id, username, avatar, message, is_admin, created_at
        FROM chat_messages
        ORDER BY id DESC
        LIMIT 60
      `);
      return res.json({ success: true, messages: messages.reverse() });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 💬 실시간 채팅 메시지 전송 API (XSS 방어 + 쿨다운 + 개인정보 보호)
  router.post('/send', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const userId = session.id;
    const now = Date.now();
    const lastChatTime = chatCooldownMap.get(userId) || 0;

    // 도배 방지: 1.5초 쿨다운
    if (now - lastChatTime < 1500) {
      return res.status(429).json({ success: false, error: '메시지를 너무 빠르게 전송하고 있습니다. 잠시 후 다시 시도하세요.' });
    }

    let { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: '메시지를 입력하세요.' });
    }

    message = message.trim();
    if (message.length === 0) return res.status(400).json({ success: false, error: '메시지를 입력하세요.' });
    if (message.length > 200) return res.status(400).json({ success: false, error: '메시지는 최대 200자까지 입력 가능합니다.' });

    // 🛡️ XSS 방어: HTML 태그 이스케이프
    const sanitized = message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    chatCooldownMap.set(userId, now);
    const isAdmin = config.isAdmin(userId) ? 1 : 0;

    try {
      const [result] = await pool.query(`
        INSERT INTO chat_messages (user_id, username, avatar, message, is_admin)
        VALUES (?, ?, ?, ?, ?)
      `, [userId, session.username || '익명 유저', session.avatar || '', sanitized, isAdmin]);

      const chatObj = {
        id: result.insertId,
        user_id: userId,
        username: session.username || '익명 유저',
        avatar: session.avatar || '',
        message: sanitized,
        is_admin: isAdmin,
        created_at: new Date().toISOString()
      };

      // 모든 실시간 접속자에게 SSE 푸시
      if (typeof global.__broadcastChatMessage === 'function') {
        global.__broadcastChatMessage(chatObj);
      }

      return res.json({ success: true, message: chatObj });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 💬 관리자 / 본인 메시지 삭제 API
  router.delete('/message/:id', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const msgId = parseInt(req.params.id, 10);
    try {
      const [rows] = await pool.query('SELECT user_id FROM chat_messages WHERE id = ?', [msgId]);
      if (rows.length === 0) return res.status(404).json({ success: false, error: '메시지를 찾을 수 없습니다.' });

      const isMine = String(rows[0].user_id) === String(session.id);
      const isAdmin = config.isAdmin(session.id);
      if (!isMine && !isAdmin) {
        return res.status(403).json({ success: false, error: '삭제 권한이 없습니다.' });
      }

      await pool.query('DELETE FROM chat_messages WHERE id = ?', [msgId]);
      return res.json({ success: true, message: '메시지가 삭제되었습니다.' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
}

module.exports = { createChatRoutes };
