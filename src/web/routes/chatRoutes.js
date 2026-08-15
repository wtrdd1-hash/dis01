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

  const DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';
  let chatSocket = null;
  let chatFallback = null;
  let floatingOpen = false;

  function toast(type, title, message) {
    if (typeof window.showToast === 'function') {
      window.showToast(type, title, message);
    } else {
      console[type === 'error' ? 'error' : 'log']('[chat]', title, message);
    }
  }

  function getCurrentUserId() {
    if (typeof window.currentChatUserId !== 'undefined' && window.currentChatUserId) {
      return String(window.currentChatUserId);
    }
    return '';
  }

  function isCurrentAdmin() {
    return window.currentIsAdmin === true;
  }

  function getAvatarUrl(msg) {
    const avatar = msg && msg.avatar ? String(msg.avatar) : '';
    if (!avatar) return DEFAULT_AVATAR;
    if (/^https?:\/\//i.test(avatar)) return avatar;
    if (msg.user_id) {
      return 'https://cdn.discordapp.com/avatars/' + msg.user_id + '/' + avatar + '.png';
    }
    return DEFAULT_AVATAR;
  }

  function buildBubble(msg) {
    const wrapper = document.createElement('div');
    const currentUserId = getCurrentUserId();
    const isMine = currentUserId && String(msg.user_id) === currentUserId;
    const isAdmin = msg.is_admin === 1 || msg.is_admin === true;

    wrapper.className = 'chat-bubble ' + (isMine ? 'mine' : '') + ' ' + (isAdmin ? 'admin' : '');

    const avatar = document.createElement('img');
    avatar.className = 'chat-avatar';
    avatar.src = getAvatarUrl(msg);
    avatar.alt = 'Avatar';
    avatar.onerror = function() {
      avatar.onerror = null;
      avatar.src = DEFAULT_AVATAR;
    };

    const content = document.createElement('div');
    content.className = 'chat-content';

    const meta = document.createElement('div');
    meta.className = 'chat-meta';

    const username = document.createElement('b');
    username.textContent = '@' + (msg.username || '익명');
    meta.appendChild(username);

    if (isAdmin) {
      const badge = document.createElement('span');
      badge.className = 'badge-admin-chat';
      badge.textContent = '👑 관리자';
      meta.appendChild(document.createTextNode(' '));
      meta.appendChild(badge);
    }

    const time = document.createElement('span');
    time.textContent = msg.created_at
      ? new Date(msg.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      : '';
    meta.appendChild(document.createTextNode(' '));
    meta.appendChild(time);

    if (isCurrentAdmin() || isMine) {
      const del = document.createElement('button');
      del.className = 'btn-del-msg';
      del.type = 'button';
      del.title = '메시지 삭제';
      del.textContent = '✕';
      del.addEventListener('click', function() {
        window.deleteChatMessage(msg.id);
      });
      meta.appendChild(document.createTextNode(' '));
      meta.appendChild(del);
    }

    const text = document.createElement('div');
    // 서버에서 이미 XSS escape 된 문자열을 textContent로 넣어 안전하게 표시한다.
    const parser = document.createElement('textarea');
    parser.innerHTML = msg.message || '';
    text.textContent = parser.value;

    content.appendChild(meta);
    content.appendChild(text);
    wrapper.appendChild(avatar);
    wrapper.appendChild(content);
    return wrapper;
  }

  function appendLiveChatMessage(msg, shouldScroll) {
    if (!msg || msg.id === undefined || msg.id === null) return;
    if (shouldScroll === undefined) shouldScroll = true;

    const main = document.getElementById('chat-messages-container');
    const floating = document.getElementById('floating-chat-messages-container');
    const currentUserId = getCurrentUserId();
    const isMine = currentUserId && String(msg.user_id) === currentUserId;

    if (main && !document.getElementById('chat-msg-' + msg.id)) {
      const bubble = buildBubble(msg);
      bubble.id = 'chat-msg-' + msg.id;
      main.appendChild(bubble);
      if (shouldScroll) main.scrollTop = main.scrollHeight;
    }

    if (floating && !document.getElementById('fchat-msg-' + msg.id)) {
      const bubble = buildBubble(msg);
      bubble.id = 'fchat-msg-' + msg.id;
      floating.appendChild(bubble);
      if (shouldScroll && floatingOpen) floating.scrollTop = floating.scrollHeight;
    }

    if (!floatingOpen && !isMine && shouldScroll) {
      const unread = document.getElementById('floating-chat-badge');
      if (unread) unread.style.display = 'inline-block';
    }
  }

  async function loadChatMessages() {
    const main = document.getElementById('chat-messages-container');
    const floating = document.getElementById('floating-chat-messages-container');

    try {
      const res = await fetch('/api/chat/messages', { credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok || !data.success || !Array.isArray(data.messages)) {
        throw new Error(data.error || '채팅 목록 조회 실패');
      }

      if (main) main.innerHTML = '';
      if (floating) floating.innerHTML = '';

      if (data.messages.length === 0) {
        const empty = '<div style="text-align:center;color:#64748b;font-size:.85rem;padding:40px 0;">아직 작성된 채팅이 없습니다. 첫 메시지를 남겨보세요! 💬</div>';
        if (main) main.innerHTML = empty;
        if (floating) floating.innerHTML = empty;
        return;
      }

      data.messages.forEach(function(msg) {
        appendLiveChatMessage(msg, false);
      });

      if (main) main.scrollTop = main.scrollHeight;
      if (floating) floating.scrollTop = floating.scrollHeight;
    } catch (err) {
      const failed = '<div style="text-align:center;color:#ef4444;font-size:.85rem;padding:20px 0;">채팅 메시지를 불러오지 못했습니다.</div>';
      if (main) main.innerHTML = failed;
      if (floating) floating.innerHTML = failed;
      console.error('[chat] load failed:', err);
    }
  }

  function toggleFloatingChat() {
    const drawer = document.getElementById('floating-chat-drawer');
    const badge = document.getElementById('floating-chat-badge');
    if (!drawer) return;

    floatingOpen = !floatingOpen;
    drawer.style.display = floatingOpen ? 'flex' : 'none';

    if (floatingOpen) {
      if (badge) badge.style.display = 'none';
      loadChatMessages();
      const input = document.getElementById('floating-chat-input');
      if (input) setTimeout(function() { input.focus(); }, 50);
    }
  }

  function handleDeletedChat(data) {
    if (!data || data.id === undefined || data.id === null) return;
    const main = document.getElementById('chat-msg-' + data.id);
    const floating = document.getElementById('fchat-msg-' + data.id);
    if (main) main.remove();
    if (floating) floating.remove();
  }

  function startChatFallback() {
    if (chatFallback || typeof window.EventSource === 'undefined') return;

    chatFallback = new EventSource('/api/stream');
    chatFallback.onmessage = function(event) {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'CHAT_MESSAGE' && data.message) {
          appendLiveChatMessage(data.message, true);
        }
      } catch (e) {}
    };
    chatFallback.onerror = function() {
      if (chatFallback) {
        chatFallback.close();
        chatFallback = null;
      }
    };
  }

  function stopChatFallback() {
    if (!chatFallback) return;
    chatFallback.close();
    chatFallback = null;
  }

  function getChatSocket() {
    if (chatSocket) return chatSocket;
    if (typeof window.io !== 'function') {
      startChatFallback();
      return null;
    }

    chatSocket = window.io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 8000
    });

    chatSocket.on('connect', function() {
      stopChatFallback();
      console.info('[chat] Socket.IO connected:', chatSocket.id);
    });
    chatSocket.on('connect_error', function(err) {
      console.warn('[chat] Socket.IO connect_error:', err && err.message ? err.message : err);
      startChatFallback();
    });
    chatSocket.on('disconnect', function(reason) {
      console.warn('[chat] Socket.IO disconnected:', reason);
      startChatFallback();
    });
    chatSocket.on('chat:message', function(msg) {
      appendLiveChatMessage(msg, true);
    });
    chatSocket.on('chat:deleted', handleDeletedChat);

    return chatSocket;
  }

  async function sendChatViaHttp(text) {
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    const data = await res.json();
    if (!res.ok && data.success !== false) data.success = false;
    return data;
  }

  function sendChatMessage(text) {
    const socket = getChatSocket();
    if (!socket || !socket.connected) return sendChatViaHttp(text);

    return new Promise(function(resolve) {
      socket.timeout(8000).emit('chat:send', { message: text }, function(err, data) {
        if (err) {
          resolve({ success: false, error: '실시간 채팅 응답 시간이 초과되었습니다. 다시 시도해주세요.' });
          return;
        }
        resolve(data || { success: false, error: '채팅 서버 응답이 올바르지 않습니다.' });
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
        toast('error', '채팅 실패', data.error || '채팅 전송에 실패했습니다.');
        return;
      }
      input.value = '';
      if (data.message) appendLiveChatMessage(data.message, true);
    } catch (err) {
      toast('error', '통신 오류', '채팅 서버와 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      if (btn) btn.disabled = false;
      input.focus();
    }
  }

  async function deleteChatMessage(id) {
    if (!id) return;
    if (!window.confirm('이 메시지를 삭제하시겠습니까?')) return;
    try {
      const res = await fetch('/api/chat/message/' + encodeURIComponent(id), {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast('error', '삭제 실패', data.error || '삭제 권한이 없습니다.');
        return;
      }
      handleDeletedChat({ id: id });
    } catch (err) {
      toast('error', '삭제 실패', '채팅 삭제 요청에 실패했습니다.');
    }
  }

  function insertEmoji(emoji, inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value += emoji;
    input.focus();
  }

  // 메인 페이지 스크립트가 문법 오류로 중단되어도 채팅은 독립적으로 동작한다.
  window.appendLiveChatMessage = appendLiveChatMessage;
  window.loadChatMessages = loadChatMessages;
  window.toggleFloatingChat = toggleFloatingChat;
  window.deleteChatMessage = deleteChatMessage;
  window.handleSendChat = function(e) {
    if (e) e.preventDefault();
    return submitChat('chat-input', 'chat-submit-btn');
  };
  window.handleSendFloatingChat = function(e) {
    if (e) e.preventDefault();
    return submitChat('floating-chat-input', 'floating-chat-submit-btn');
  };
  window.insertEmoji = function(emoji) { insertEmoji(emoji, 'chat-input'); };
  window.insertFloatingEmoji = function(emoji) { insertEmoji(emoji, 'floating-chat-input'); };

  getChatSocket();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadChatMessages, { once: true });
  } else {
    loadChatMessages();
  }
})();
</script>
`;

function repairBrokenChatHtml(body) {
  if (typeof body !== 'string') return body;

  // server.js의 템플릿 리터럴이 브라우저로 렌더링될 때 \'가 소실되어
  // JS 문자열을 끊는 문제를 안전한 HTML entity 형태로 교정한다.
  return body.replace(
    /onerror="this\.src='https:\/\/cdn\.discordapp\.com\/embed\/avatars\/0\.png'"/g,
    'onerror="this.onerror=null;this.src=&quot;https://cdn.discordapp.com/embed/avatars/0.png&quot;"'
  );
}

function installSocketChatClientBridge() {
  if (express.response.__socketChatSendBridgeInstalled) return;
  express.response.__socketChatSendBridgeInstalled = true;

  const originalSend = express.response.send;

  express.response.send = function patchedSend(body) {
    body = repairBrokenChatHtml(body);

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

function createChatRoutes(getSessionUser) {
  const router = express.Router();

  installSocketChatHandler();
  installSocketChatClientBridge();

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

  router.post('/send', async (req, res) => {
    const session = getSessionUser(req);
    const result = await createChatMessage(session, req.body?.message);
    const { status, ...response } = result;
    return res.status(status).json(response);
  });

  router.delete('/message/:id', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const msgId = parseInt(req.params.id, 10);
    if (!Number.isInteger(msgId) || msgId <= 0) {
      return res.status(400).json({ success: false, error: '올바르지 않은 메시지 ID입니다.' });
    }

    try {
      const [rows] = await pool.query('SELECT user_id FROM chat_messages WHERE id = ?', [msgId]);
      if (rows.length === 0) return res.status(404).json({ success: false, error: '메시지를 찾을 수 없습니다.' });

      const isMine = String(rows[0].user_id) === String(session.id);
      const isAdmin = config.isAdmin(session.id);
      if (!isMine && !isAdmin) {
        return res.status(403).json({ success: false, error: '삭제 권한이 없습니다.' });
      }

      await pool.query('DELETE FROM chat_messages WHERE id = ?', [msgId]);
      if (global.__io) global.__io.emit('chat:deleted', { id: msgId });
      return res.json({ success: true, message: '메시지가 삭제되었습니다.' });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
}

module.exports = { createChatRoutes };
