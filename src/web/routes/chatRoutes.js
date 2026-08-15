/**
 * 💬 실시간 광장 채팅 라우트 모듈
 */
const express = require('express');
const { pool } = require('../../config/database');
const config = require('../../config/config');

const chatCooldownMap = new Map();

function getSocketSessionUser(socket) {
  const cookieHeader = socket?.handshake?.headers?.cookie || '';
  const cookie = cookieHeader
    .split(';')
    .map(v => v.trim())
    .find(v => v.startsWith('discord_user='));

  if (!cookie) return null;

  try {
    let value = decodeURIComponent(cookie.slice('discord_user='.length));
    if (value.startsWith('j:')) value = value.slice(2);
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    return JSON.parse(value);
  } catch (e) {
    return null;
  }
}

function sanitizeChatMessage(message) {
  return message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function createChatMessage(session, rawMessage) {
  if (!session) {
    return { status: 401, success: false, error: 'Discord 로그인이 필요합니다.' };
  }

  if (!rawMessage || typeof rawMessage !== 'string') {
    return { status: 400, success: false, error: '메시지를 입력하세요.' };
  }

  const message = rawMessage.trim();
  if (message.length === 0) {
    return { status: 400, success: false, error: '메시지를 입력하세요.' };
  }
  if (message.length > 200) {
    return { status: 400, success: false, error: '메시지는 최대 200자까지 입력 가능합니다.' };
  }

  const userId = session.id;
  const now = Date.now();
  const lastChatTime = chatCooldownMap.get(userId) || 0;

  if (now - lastChatTime < 1500) {
    return {
      status: 429,
      success: false,
      error: '메시지를 너무 빠르게 전송하고 있습니다. 잠시 후 다시 시도하세요.'
    };
  }

  const sanitized = sanitizeChatMessage(message);
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

    if (global.__io) {
      global.__io.emit('chat:message', chatObj);
    }
    if (typeof global.__broadcastChatMessage === 'function') {
      global.__broadcastChatMessage(chatObj);
    }

    return { status: 200, success: true, message: chatObj };
  } catch (e) {
    return { status: 500, success: false, error: e.message };
  }
}

function installSocketChatHandler() {
  const io = global.__io;
  if (!io || io.__chatSendHandlerInstalled) return;

  io.__chatSendHandlerInstalled = true;

  io.on('connection', (socket) => {
    socket.on('chat:send', async (payload, callback) => {
      const session = getSocketSessionUser(socket);
      const result = await createChatMessage(session, payload?.message);
      const { status, ...response } = result;

      if (typeof callback === 'function') {
        callback(response);
      }
    });
  });
}

const SOCKET_CHAT_CLIENT_BRIDGE = `
<script id="socket-chat-send-bridge">
(function() {
  if (window.__socketChatSendBridgeInstalled) return;
  window.__socketChatSendBridgeInstalled = true;

  let chatSendSocket = null;

  function getChatSendSocket() {
    if (chatSendSocket) return chatSendSocket;
    if (typeof window.io !== 'function') return null;

    chatSendSocket = window.io({
      reconnectionAttempts: 15,
      reconnectionDelay: 1500,
      timeout: 8000
    });

    return chatSendSocket;
  }

  async function sendChatViaHttp(text) {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    return res.json();
  }

  function sendChatMessage(text) {
    const socket = getChatSendSocket();

    if (!socket || !socket.connected) {
      return sendChatViaHttp(text);
    }

    return new Promise((resolve) => {
      socket.timeout(8000).emit('chat:send', { message: text }, function(err, data) {
        if (err) {
          resolve({
            success: false,
            error: '실시간 채팅 응답 시간이 초과되었습니다. 다시 시도해주세요.'
          });
          return;
        }

        resolve(data || {
          success: false,
          error: '채팅 서버 응답이 올바르지 않습니다.'
        });
      });
    });
  }

  async function submitChat(inputId, buttonId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(buttonId);
    if (!input) return;

    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }

    if (btn) btn.disabled = true;

    try {
      const data = await sendChatMessage(text);

      if (!data.success) {
        if (typeof showToast === 'function') {
          showToast('error', '채팅 실패', data.error || '채팅 전송에 실패했습니다.');
        }
        return;
      }

      input.value = '';

      if (data.message && typeof appendLiveChatMessage === 'function') {
        appendLiveChatMessage(data.message, true);
      }
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast('error', '통신 오류', '채팅 서버와 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      if (btn) btn.disabled = false;
      input.focus();
    }
  }

  getChatSendSocket();

  window.handleSendChat = function(e) {
    if (e) e.preventDefault();
    return submitChat('chat-input', 'chat-submit-btn');
  };

  window.handleSendFloatingChat = function(e) {
    if (e) e.preventDefault();
    return submitChat('floating-chat-input', 'floating-chat-submit-btn');
  };
})();
</script>
`;

function installSocketChatClientBridge() {
  if (express.response.__socketChatSendBridgeInstalled) return;
  express.response.__socketChatSendBridgeInstalled = true;

  const originalSend = express.response.send;

  express.response.send = function patchedSend(body) {
    if (
      typeof body === 'string' &&
      body.includes('function handleSendChat') &&
      body.includes('function handleSendFloatingChat') &&
      !body.includes('socket-chat-send-bridge')
    ) {
      body = body.replace(/<\/body>/i, `${SOCKET_CHAT_CLIENT_BRIDGE}</body>`);
    }

    return originalSend.call(this, body);
  };
}

function createChatRoutes(getSessionUser, sseClients) {
  const router = express.Router();

  installSocketChatHandler();
  installSocketChatClientBridge();

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

  // 💬 채팅 메시지 전송 API
  // Socket.IO 연결이 불가능한 클라이언트를 위한 폴백으로 유지한다.
  router.post('/send', async (req, res) => {
    const session = getSessionUser(req);
    const result = await createChatMessage(session, req.body?.message);
    const { status, ...response } = result;
    return res.status(status).json(response);
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
      if (global.__io) {
        global.__io.emit('chat:deleted', { id: msgId });
      }
      return res.json({ success: true, message: '메시지가 삭제되었습니다.' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
}

module.exports = { createChatRoutes };
