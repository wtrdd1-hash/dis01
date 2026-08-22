/**
 * 💬 실시간 광장 채팅 라우트 모듈
 */
const express = require('express');
const session = require('../session');
const config = require('../../config/config');
const { pool } = require('../../config/database');
const chat = require('../chatService');
const { assetUrl } = require('../assetUrl');

function getSocketSessionUser(socket) {
  return session.parseSessionFromCookieHeader(socket?.handshake?.headers?.cookie || '');
}

function installSocketChatHandler() {
  const io = global.__io;
  if (!io || io.__chatSendHandlerInstalled) return;
  io.__chatSendHandlerInstalled = true;

  io.on('connection', (socket) => {
    const user = getSocketSessionUser(socket);
    chat.joinSocketRooms(socket, user && user.id).catch(() => {});

    socket.on('chat:join', async (payload) => {
      try {
        const roomId = Number(payload && payload.roomId);
        if (!Number.isInteger(roomId) || roomId <= 0) return;
        const room = await chat.getRoomById(roomId);
        const ok = await chat.canAccessRoom(room, user && user.id, { write: false });
        if (!ok) return;
        socket.join('chat:room:' + roomId);
        if (user && user.id) await chat.addMember(roomId, user.id);
      } catch (err) {
        // 소켓 방 입장 실패는 연결 전체를 끊지 않는다.
      }
    });

    socket.on('chat:send', async (payload, callback) => {
      try {
        const sess = getSocketSessionUser(socket);
        const text = payload && (payload.message || payload.text || payload.content);
        const roomId = payload && (payload.roomId || payload.room_id || 1);
        const result = await chat.sendMessage(sess, text, roomId);
        const { status, ...response } = result;
        if (typeof callback === 'function') callback(response);
      } catch (err) {
        if (typeof callback === 'function') {
          callback({ success: false, error: '채팅 전송 중 오류가 발생했습니다.' });
        }
      }
    });

    socket.on('chat:message', async (payload, callback) => {
      try {
        const sess = getSocketSessionUser(socket);
        const text = payload && (payload.message || payload.text || payload.content);
        const roomId = payload && (payload.roomId || payload.room_id || 1);
        const result = await chat.sendMessage(sess, text, roomId);
        const { status, ...response } = result;
        if (typeof callback === 'function') callback(response);
      } catch (err) {
        if (typeof callback === 'function') {
          callback({ success: false, error: '채팅 전송 중 오류가 발생했습니다.' });
        }
      }
    });

    socket.on('chat:edit', async (payload, callback) => {
      try {
        const sess = getSocketSessionUser(socket);
        const msgId = payload && (payload.id || payload.messageId);
        const text = payload && (payload.message || payload.text || payload.content);
        const result = await chat.editMessage(sess, msgId, text);
        const { status, ...response } = result;
        if (typeof callback === 'function') callback(response);
      } catch (err) {
        if (typeof callback === 'function') {
          callback({ success: false, error: '채팅 수정 중 오류가 발생했습니다.' });
        }
      }
    });

    socket.on('chat:delete', async (payload, callback) => {
      try {
        const sess = getSocketSessionUser(socket);
        const msgId = payload && (payload.id || payload.messageId);
        const result = await chat.deleteMessage(sess, msgId);
        const { status, ...response } = result;
        if (typeof callback === 'function') callback(response);
      } catch (err) {
        if (typeof callback === 'function') {
          callback({ success: false, error: '채팅 삭제 중 오류가 발생했습니다.' });
        }
      }
    });
  });
}

function socketChatClientBridge() {
  return `
<script id="socket-chat-send-bridge">
(function() {
  if (window.__plazaChatScriptRequested) return;
  window.__plazaChatScriptRequested = true;
  var s = document.createElement('script');
  s.src = ${JSON.stringify(assetUrl('js/plaza-chat.js'))};
  s.defer = true;
  document.head.appendChild(s);
})();
</script>
`;
}

function repairBrokenChatHtml(body) {
  if (typeof body !== 'string') return body;
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
      !body.includes('socket-chat-send-bridge') &&
      !body.includes('plaza-chat.js')
    ) {
      body = body.replace(/<\/body>/i, `${socketChatClientBridge()}</body>`);
    }
    return originalSend.call(this, body);
  };
}

function createChatRoutes(getSessionUser) {
  const router = express.Router();
  installSocketChatHandler();
  installSocketChatClientBridge();
  chat.ensureDefaultRooms().catch(() => {});

  router.get('/rooms', async (req, res) => {
    const sess = getSessionUser(req);
    try {
      const rooms = await chat.listRooms(sess && sess.id);
      return res.json({ success: true, rooms });
    } catch (e) {
      return res.status(500).json({ success: false, error: '대화 목록을 불러오지 못했습니다.' });
    }
  });

  router.get('/people', async (req, res) => {
    const sess = getSessionUser(req);
    if (!sess) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const people = await chat.listPeople(sess.id);
      return res.json({ success: true, people });
    } catch (e) {
      return res.status(500).json({ success: false, error: '유저 목록을 불러오지 못했습니다.' });
    }
  });

  router.get('/messages', async (req, res) => {
    const sess = getSessionUser(req);
    const roomId = req.query.roomId || 1;
    try {
      const result = await chat.listMessages(sess && sess.id, roomId);
      const { status, ...response } = result;
      return res.status(status).json(response);
    } catch (e) {
      return res.status(500).json({ success: false, error: '채팅을 불러오지 못했습니다.' });
    }
  });

  router.post(['/send', '/messages'], async (req, res) => {
    const sess = getSessionUser(req);
    const text = req.body && (req.body.message || req.body.text || req.body.content);
    const roomId = req.body && (req.body.roomId || req.body.room_id || 1);
    const result = await chat.sendMessage(sess, text, roomId);
    const { status, ...response } = result;
    return res.status(status).json(response);
  });

  router.post('/rooms/dm', async (req, res) => {
    const sess = getSessionUser(req);
    if (!sess) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const result = await chat.openDm(sess.id, req.body && req.body.userId);
      const { status, ...response } = result;
      return res.status(status).json(response);
    } catch (e) {
      return res.status(500).json({ success: false, error: '1대1 대화를 열지 못했습니다.' });
    }
  });

  router.post('/rooms/thread', async (req, res) => {
    const sess = getSessionUser(req);
    if (!sess) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const result = await chat.openThread(
        sess.id,
        req.body && req.body.parentRoomId,
        req.body && req.body.parentMessageId,
        req.body && req.body.title
      );
      const { status, ...response } = result;
      return res.status(status).json(response);
    } catch (e) {
      return res.status(500).json({ success: false, error: '스레드를 열지 못했습니다.' });
    }
  });

  router.post('/rooms/:id/read', async (req, res) => {
    const sess = getSessionUser(req);
    if (!sess) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      await chat.markRead(sess.id, req.params.id, req.body && req.body.lastId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: '읽음 처리에 실패했습니다.' });
    }
  });

  router.delete('/message/:id', async (req, res) => {
    const sess = getSessionUser(req);
    const result = await chat.deleteMessage(sess, req.params.id);
    const { status, ...response } = result;
    return res.status(status).json(response);
  });

  router.patch('/message/:id', async (req, res) => {
    const sess = getSessionUser(req);
    const text = req.body && (req.body.message || req.body.text || req.body.content);
    const result = await chat.editMessage(sess, req.params.id, text);
    const { status, ...response } = result;
    return res.status(status).json(response);
  });

  router.post('/message/:id/edit', async (req, res) => {
    const sess = getSessionUser(req);
    const text = req.body && (req.body.message || req.body.text || req.body.content);
    const result = await chat.editMessage(sess, req.params.id, text);
    const { status, ...response } = result;
    return res.status(status).json(response);
  });

  return router;
}

module.exports = { createChatRoutes };
