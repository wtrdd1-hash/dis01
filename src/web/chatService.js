/**
 * 광장 채팅: 채널 / 스레드 / 1대1
 */
const { pool } = require('../config/database');
const config = require('../config/config');

const ROOM_TYPES = new Set(['channel', 'thread', 'dm']);
const DEFAULT_CHANNELS = [
  { id: 1, slug: 'plaza', title: '광장' },
  { id: 2, slug: 'trade', title: '거래' },
  { id: 3, slug: 'lounge', title: '잡담' }
];
const MAX_MESSAGE_LEN = 200;
const MAX_TITLE_LEN = 40;
const chatCooldownMap = new Map();

function sanitizeText(message) {
  return String(message || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function clipTitle(raw, fallback) {
  const text = String(raw || '').replace(/[<>]/g, '').trim().slice(0, MAX_TITLE_LEN);
  return text || fallback;
}

function isSnowflake(id) {
  return /^\d{16,22}$/.test(String(id || ''));
}

async function ensureDefaultRooms() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(16) NOT NULL,
      slug VARCHAR(64) NULL,
      title VARCHAR(100) NOT NULL,
      parent_room_id BIGINT NULL,
      parent_message_id BIGINT NULL,
      created_by VARCHAR(32) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_type (type),
      INDEX idx_parent_room (parent_room_id),
      UNIQUE KEY uniq_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_room_members (
      room_id BIGINT NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      last_read_id BIGINT NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (room_id, user_id),
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  const [cols] = await pool.query("SHOW COLUMNS FROM chat_messages LIKE 'room_id'");
  if (!cols.length) {
    await pool.query('ALTER TABLE chat_messages ADD COLUMN room_id BIGINT NOT NULL DEFAULT 1');
    await pool.query('ALTER TABLE chat_messages ADD INDEX idx_room_id (room_id)');
  }
  for (const ch of DEFAULT_CHANNELS) {
    await pool.query(
      `INSERT IGNORE INTO chat_rooms (id, type, slug, title)
       VALUES (?, 'channel', ?, ?)`,
      [ch.id, ch.slug, ch.title]
    );
  }
}

async function getRoomById(roomId) {
  const id = Number(roomId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const [rows] = await pool.query('SELECT * FROM chat_rooms WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function isMember(roomId, userId) {
  const [rows] = await pool.query(
    'SELECT user_id FROM chat_room_members WHERE room_id = ? AND user_id = ? LIMIT 1',
    [roomId, String(userId)]
  );
  return rows.length > 0;
}

async function addMember(roomId, userId) {
  await pool.query(
    'INSERT IGNORE INTO chat_room_members (room_id, user_id, last_read_id) VALUES (?, ?, 0)',
    [roomId, String(userId)]
  );
}

async function canAccessRoom(room, userId, { write = false } = {}) {
  if (!room) return false;
  if (room.type === 'channel') return write ? Boolean(userId) : true;
  if (room.type === 'thread') return Boolean(userId);
  if (room.type === 'dm') {
    if (!userId) return false;
    return isMember(room.id, userId);
  }
  return false;
}

function serializeRoom(row, extra) {
  return Object.assign({
    id: Number(row.id),
    type: row.type,
    slug: row.slug || null,
    title: row.title,
    parentRoomId: row.parent_room_id ? Number(row.parent_room_id) : null,
    parentMessageId: row.parent_message_id ? Number(row.parent_message_id) : null,
    createdBy: row.created_by || null
  }, extra || {});
}

async function listRooms(userId) {
  await ensureDefaultRooms();
  const uid = userId ? String(userId) : '';
  const [rows] = await pool.query(
    `
    SELECT
      r.*,
      (SELECT MAX(m.id) FROM chat_messages m WHERE m.room_id = r.id) AS last_msg_id,
      (SELECT m.message FROM chat_messages m WHERE m.room_id = r.id ORDER BY m.id DESC LIMIT 1) AS last_preview,
      COALESCE(mem.last_read_id, 0) AS last_read_id
    FROM chat_rooms r
    LEFT JOIN chat_room_members mem
      ON mem.room_id = r.id AND mem.user_id = ?
    WHERE
      r.type = 'channel'
      OR (? <> '' AND r.type = 'thread')
      OR (? <> '' AND r.type = 'dm' AND mem.user_id IS NOT NULL)
    ORDER BY
      CASE r.type WHEN 'channel' THEN 0 WHEN 'thread' THEN 1 ELSE 2 END,
      COALESCE((SELECT MAX(m.id) FROM chat_messages m WHERE m.room_id = r.id), r.id) DESC
    LIMIT 80
    `,
    [uid, uid, uid]
  );

  return rows.map((row) => {
    const lastId = Number(row.last_msg_id || 0);
    const lastRead = Number(row.last_read_id || 0);
    return serializeRoom(row, {
      lastMessageId: lastId || null,
      lastPreview: row.last_preview || '',
      unread: uid && lastRead > 0 && lastId > lastRead ? 1 : 0
    });
  });
}

async function listMessages(userId, roomId) {
  await ensureDefaultRooms();
  const room = await getRoomById(roomId || 1);
  if (!room) return { status: 404, success: false, error: '대화방을 찾을 수 없습니다.' };
  const ok = await canAccessRoom(room, userId, { write: false });
  if (!ok) return { status: 403, success: false, error: '이 대화를 볼 권한이 없습니다.' };

  if (userId && (room.type === 'thread' || room.type === 'dm')) {
    await addMember(room.id, userId);
  }

  const [messages] = await pool.query(
    `
    SELECT cm.id, cm.room_id, cm.user_id, cm.username, cm.avatar, cm.message, cm.is_admin, cm.created_at,
           COALESCE(eci.name, '') AS title
    FROM chat_messages cm
    LEFT JOIN user_cosmetic_loadout ucl ON cm.user_id = ucl.user_id AND ucl.slot = 'TITLE'
    LEFT JOIN economy_catalog_items eci ON ucl.item_key = eci.item_key
    WHERE cm.room_id = ?
    ORDER BY cm.id DESC
    LIMIT 80
    `,
    [room.id]
  );
  return {
    status: 200,
    success: true,
    room: serializeRoom(room),
    messages: messages.map(serializeMessage).reverse()
  };
}

async function markRead(userId, roomId, lastId) {
  if (!userId) return;
  const room = await getRoomById(roomId);
  if (!room) return;
  const ok = await canAccessRoom(room, userId, { write: false });
  if (!ok) return;
  await addMember(room.id, userId);
  const readId = Number(lastId) || 0;
  await pool.query(
    `INSERT INTO chat_room_members (room_id, user_id, last_read_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, VALUES(last_read_id))`,
    [room.id, String(userId), readId]
  );
}

function serializeMessage(row) {
  const isAdmin = row.is_admin || config.isAdmin(row.user_id);
  let title = row.title || '';
  if (isAdmin) {
    title = '👑 총괄 관리자';
  } else if (!title) {
    title = '🌱 시민';
  }
  return {
    id: row.id,
    room_id: Number(row.room_id || 1),
    user_id: row.user_id,
    username: row.username,
    avatar: row.avatar || '',
    message: row.message,
    title,
    is_admin: isAdmin ? 1 : 0,
    created_at: row.created_at
  };
}

function emitMessage(chatObj) {
  if (global.__io) {
    global.__io.to('chat:room:' + chatObj.room_id).emit('chat:message', chatObj);
  }
  if (typeof global.__broadcastChatMessage === 'function') {
    global.__broadcastChatMessage(chatObj);
  }
}

async function postSystemNotice(text, { userId, username, avatar } = {}) {
  await ensureDefaultRooms();
  const message = sanitizeText(String(text || '')).slice(0, MAX_MESSAGE_LEN);
  if (!message) return null;
  const [result] = await pool.query(
    `INSERT INTO chat_messages (room_id, user_id, username, avatar, message, is_admin)
     VALUES (1, ?, ?, ?, ?, 0)`,
    [userId || 'system', username || '채굴 속보', avatar || '', message]
  );
  const chatObj = {
    id: result.insertId,
    room_id: 1,
    user_id: userId || 'system',
    username: username || '채굴 속보',
    avatar: avatar || '',
    message,
    is_admin: 0,
    created_at: new Date().toISOString()
  };
  emitMessage(chatObj);
  return chatObj;
}

async function sendMessage(session, rawMessage, roomId) {
  if (!session) {
    return { status: 401, success: false, error: 'Discord 로그인이 필요합니다.' };
  }
  if (!rawMessage || typeof rawMessage !== 'string') {
    return { status: 400, success: false, error: '메시지를 입력하세요.' };
  }
  const message = rawMessage.trim();
  if (!message) return { status: 400, success: false, error: '메시지를 입력하세요.' };
  if (message.length > MAX_MESSAGE_LEN) {
    return { status: 400, success: false, error: '메시지는 최대 200자까지 입력 가능합니다.' };
  }

  await ensureDefaultRooms();
  const room = await getRoomById(roomId || 1);
  if (!room) return { status: 404, success: false, error: '대화방을 찾을 수 없습니다.' };
  const allowed = await canAccessRoom(room, session.id, { write: true });
  if (!allowed) return { status: 403, success: false, error: '이 대화에 글을 쓸 수 없습니다.' };

  const userId = session.id;
  const now = Date.now();
  const isAdmin = config.isAdmin(userId) ? 1 : 0;
  const lastChatTime = chatCooldownMap.get(userId) || 0;
  if (!isAdmin && now - lastChatTime < 200) {
    return {
      status: 429,
      success: false,
      error: '메시지를 너무 빠르게 전송하고 있습니다. 잠시 후 다시 시도하세요.'
    };
  }

  const sanitized = sanitizeText(message);
  chatCooldownMap.set(userId, now);

  try {
    const [result] = await pool.query(
      `INSERT INTO chat_messages (room_id, user_id, username, avatar, message, is_admin)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [room.id, userId, session.username || '익명 유저', session.avatar || '', sanitized, isAdmin]
    );
    await addMember(room.id, userId);
    await markRead(userId, room.id, result.insertId);

    let title = '';
    if (isAdmin) {
      title = '👑 총괄 관리자';
    } else {
      try {
        const [tRows] = await pool.query(
          `SELECT eci.name FROM user_cosmetic_loadout ucl
           JOIN economy_catalog_items eci ON ucl.item_key = eci.item_key
           WHERE ucl.user_id = ? AND ucl.slot = 'TITLE' LIMIT 1`,
          [userId]
        );
        if (tRows.length > 0 && tRows[0].name) {
          title = tRows[0].name;
        } else {
          title = session.title || '🌱 시민';
        }
      } catch (err) {
        title = session.title || '🌱 시민';
      }
    }

    const chatObj = {
      id: result.insertId,
      room_id: Number(room.id),
      user_id: userId,
      username: session.username || '익명 유저',
      avatar: session.avatar || '',
      message: sanitized,
      title,
      is_admin: isAdmin ? 1 : 0,
      created_at: new Date().toISOString()
    };
    emitMessage(chatObj);
    return { status: 200, success: true, message: chatObj };
  } catch (e) {
    return { status: 500, success: false, error: '채팅 전송 중 오류가 발생했습니다.' };
  }
}

async function openDm(userId, peerId) {
  if (!isSnowflake(userId) || !isSnowflake(peerId)) {
    return { status: 400, success: false, error: '올바른 유저를 선택하세요.' };
  }
  if (String(userId) === String(peerId)) {
    return { status: 400, success: false, error: '나와의 1대1 대화는 만들 수 없습니다.' };
  }
  await ensureDefaultRooms();
  const [a, b] = [String(userId), String(peerId)].sort();
  const slug = 'dm:' + a + ':' + b;
  const [peers] = await pool.query(
    'SELECT discord_id, username FROM users WHERE discord_id = ? LIMIT 1',
    [peerId]
  );
  const peerName = peers[0]?.username || ('유저_' + String(peerId).slice(-4));
  const title = '@' + peerName;

  const [existing] = await pool.query('SELECT * FROM chat_rooms WHERE slug = ? LIMIT 1', [slug]);
  let room = existing[0];
  if (!room) {
    try {
      const [ins] = await pool.query(
        `INSERT INTO chat_rooms (type, slug, title, created_by)
         VALUES ('dm', ?, ?, ?)`,
        [slug, title, userId]
      );
      room = { id: ins.insertId, type: 'dm', slug, title, parent_room_id: null, parent_message_id: null, created_by: userId };
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        const [again] = await pool.query('SELECT * FROM chat_rooms WHERE slug = ? LIMIT 1', [slug]);
        room = again[0];
      }
      if (!room) throw e;
    }
  }
  await addMember(room.id, a);
  await addMember(room.id, b);
  if (global.__io) {
    global.__io.to('chat:user:' + peerId).emit('chat:room', serializeRoom(room));
  }
  return { status: 200, success: true, room: serializeRoom(room) };
}

async function openThread(userId, parentRoomId, parentMessageId, titleRaw) {
  if (!userId) return { status: 401, success: false, error: '로그인이 필요합니다.' };
  await ensureDefaultRooms();
  const parent = await getRoomById(parentRoomId);
  if (!parent || parent.type !== 'channel') {
    return { status: 400, success: false, error: '채널 메시지에서만 스레드를 열 수 있습니다.' };
  }
  const msgId = Number(parentMessageId);
  if (!Number.isInteger(msgId) || msgId <= 0) {
    return { status: 400, success: false, error: '메시지 번호가 올바르지 않습니다.' };
  }
  const [msgs] = await pool.query(
    'SELECT id, message FROM chat_messages WHERE id = ? AND room_id = ? LIMIT 1',
    [msgId, parent.id]
  );
  if (!msgs[0]) return { status: 404, success: false, error: '원본 메시지를 찾을 수 없습니다.' };

  const [existing] = await pool.query(
    'SELECT * FROM chat_rooms WHERE type = ? AND parent_message_id = ? LIMIT 1',
    ['thread', msgId]
  );
  if (existing[0]) {
    await addMember(existing[0].id, userId);
    return { status: 200, success: true, room: serializeRoom(existing[0]) };
  }

  const fallback = clipTitle(String(msgs[0].message || '').replace(/&lt;|&gt;|&amp;|&quot;|&#039;/g, ' '), '스레드');
  const title = clipTitle(titleRaw, fallback);
  const [ins] = await pool.query(
    `INSERT INTO chat_rooms (type, slug, title, parent_room_id, parent_message_id, created_by)
     VALUES ('thread', NULL, ?, ?, ?, ?)`,
    [title, parent.id, msgId, userId]
  );
  const room = {
    id: ins.insertId,
    type: 'thread',
    slug: null,
    title,
    parent_room_id: parent.id,
    parent_message_id: msgId,
    created_by: userId
  };
  await addMember(room.id, userId);
  if (global.__io) {
    global.__io.to('chat:room:' + parent.id).emit('chat:room', serializeRoom(room));
  }
  return { status: 200, success: true, room: serializeRoom(room) };
}

async function listPeople(userId) {
  const [rows] = await pool.query(
    `
    SELECT discord_id, username, avatar
    FROM users
    WHERE discord_id <> ?
      AND username IS NOT NULL
      AND username <> ''
    ORDER BY created_at DESC
    LIMIT 50
    `,
    [String(userId)]
  );
  return rows.map((row) => ({
    id: String(row.discord_id),
    username: row.username,
    avatar: row.avatar || ''
  }));
}

async function joinSocketRooms(socket, userId) {
  if (!socket) return;
  if (userId) socket.join('chat:user:' + String(userId));
  await ensureDefaultRooms();
  const rooms = await listRooms(userId);
  for (const room of rooms) {
    socket.join('chat:room:' + room.id);
  }
}

async function deleteMessage(session, messageId) {
  if (!session || !session.id) {
    return { status: 401, success: false, error: '로그인이 필요합니다.' };
  }
  const msgId = parseInt(messageId, 10);
  if (!Number.isInteger(msgId) || msgId <= 0) {
    return { status: 400, success: false, error: '올바르지 않은 메시지 ID입니다.' };
  }
  try {
    const [rows] = await pool.query('SELECT user_id, room_id FROM chat_messages WHERE id = ?', [msgId]);
    if (rows.length === 0) {
      return { status: 404, success: false, error: '메시지를 찾을 수 없습니다.' };
    }
    const isMine = String(rows[0].user_id) === String(session.id);
    const isAdmin = config.isAdmin(session.id);
    if (!isMine && !isAdmin) {
      return { status: 403, success: false, error: '삭제 권한이 없습니다.' };
    }
    await pool.query('DELETE FROM chat_messages WHERE id = ?', [msgId]);
    if (global.__io) {
      global.__io.to('chat:room:' + rows[0].room_id).emit('chat:deleted', {
        id: msgId,
        room_id: Number(rows[0].room_id)
      });
    }
    return { status: 200, success: true, message: '메시지가 삭제되었습니다.' };
  } catch (err) {
    logger.error('chat delete error:', err);
    return { status: 500, success: false, error: '메시지 삭제 중 오류가 발생했습니다.' };
  }
}

async function editMessage(session, messageId, newText) {
  if (!session || !session.id) {
    return { status: 401, success: false, error: '로그인이 필요합니다.' };
  }
  const msgId = parseInt(messageId, 10);
  if (!Number.isInteger(msgId) || msgId <= 0) {
    return { status: 400, success: false, error: '올바르지 않은 메시지 ID입니다.' };
  }
  if (!newText || typeof newText !== 'string' || !newText.trim()) {
    return { status: 400, success: false, error: '수정할 내용을 입력해주세요.' };
  }
  try {
    const [rows] = await pool.query('SELECT user_id, room_id, message FROM chat_messages WHERE id = ?', [msgId]);
    if (rows.length === 0) {
      return { status: 404, success: false, error: '메시지를 찾을 수 없습니다.' };
    }
    const isMine = String(rows[0].user_id) === String(session.id);
    const isAdmin = config.isAdmin(session.id);
    if (!isMine && !isAdmin) {
      return { status: 403, success: false, error: '수정 권한이 없습니다.' };
    }
    const sanitized = sanitizeText(newText.trim()).slice(0, MAX_MESSAGE_LEN);
    await pool.query('UPDATE chat_messages SET message = ? WHERE id = ?', [sanitized, msgId]);
    if (global.__io) {
      global.__io.to('chat:room:' + rows[0].room_id).emit('chat:edited', {
        id: msgId,
        room_id: Number(rows[0].room_id),
        message: sanitized,
        is_edited: true
      });
    }
    return { status: 200, success: true, message: '메시지가 수정되었습니다.', data: { id: msgId, message: sanitized } };
  } catch (err) {
    logger.error('chat edit error:', err);
    return { status: 500, success: false, error: '메시지 수정 중 오류가 발생했습니다.' };
  }
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [id, ts] of chatCooldownMap.entries()) {
    if (!ts || ts < cutoff) chatCooldownMap.delete(id);
  }
}, 5 * 60 * 1000).unref();

module.exports = {
  DEFAULT_CHANNELS,
  ensureDefaultRooms,
  getRoomById,
  canAccessRoom,
  addMember,
  listRooms,
  listMessages,
  markRead,
  sendMessage,
  editMessage,
  deleteMessage,
  sanitizeText,
  postSystemNotice,
  openDm,
  openThread,
  listPeople,
  joinSocketRooms,
  serializeMessage
};
