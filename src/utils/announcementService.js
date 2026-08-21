'use strict';

const { pool } = require('../config/database');

const ANNOUNCEMENT_TYPES = Object.freeze(['IMPORTANT', 'EVENT', 'MAINTENANCE', 'GENERAL']);

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function normalizeDate(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw validationError(`${fieldName} 형식이 올바르지 않습니다.`);
  return date;
}

function normalizeAnnouncement(input = {}) {
  const title = String(input.title || '').trim();
  const content = String(input.content || '').trim();
  const type = String(input.type || 'GENERAL').trim().toUpperCase();
  const author = String(input.author || 'ADMIN').trim().slice(0, 64) || 'ADMIN';
  const startsAt = normalizeDate(input.startsAt ?? input.starts_at, '시작 시각');
  const endsAt = normalizeDate(input.endsAt ?? input.ends_at, '종료 시각');

  if (!title) throw validationError('공지 제목을 입력해주세요.');
  if (!content) throw validationError('공지 내용을 입력해주세요.');
  if (title.length > 200) throw validationError('공지 제목은 200자 이하여야 합니다.');
  if (content.length > 10000) throw validationError('공지 내용은 10,000자 이하여야 합니다.');
  if (!ANNOUNCEMENT_TYPES.includes(type)) throw validationError('지원하지 않는 공지 구분입니다.');
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw validationError('공지 종료 시각은 시작 시각보다 뒤여야 합니다.');
  }

  return {
    title,
    content,
    type,
    author,
    isPopup: input.isPopup === true || input.is_popup === true,
    startsAt,
    endsAt
  };
}

function publicPayload(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title,
    content: row.content,
    type: row.type,
    is_popup: !!row.is_popup,
    is_active: !!row.is_active,
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null
  };
}

function shouldBroadcast(notice, now = new Date()) {
  if (!notice.isPopup) return false;
  if (notice.startsAt && notice.startsAt > now) return false;
  if (notice.endsAt && notice.endsAt <= now) return false;
  return true;
}

async function createAnnouncement(input, deps = {}) {
  const db = deps.db || pool;
  const io = Object.prototype.hasOwnProperty.call(deps, 'io') ? deps.io : global.__io;
  const notice = normalizeAnnouncement(input);
  const [result] = await db.query(`
    INSERT INTO site_announcements
      (title, content, type, is_popup, is_active, author, starts_at, ends_at)
    VALUES (?, ?, ?, ?, 1, ?, COALESCE(?, NOW()), ?)
  `, [
    notice.title,
    notice.content,
    notice.type,
    notice.isPopup ? 1 : 0,
    notice.author,
    notice.startsAt,
    notice.endsAt
  ]);

  const created = publicPayload({
    id: result.insertId,
    title: notice.title,
    content: notice.content,
    type: notice.type,
    is_popup: notice.isPopup,
    is_active: true,
    starts_at: notice.startsAt,
    ends_at: notice.endsAt
  });

  if (io && typeof io.emit === 'function' && shouldBroadcast(notice)) {
    io.emit('announcement:popup', created);
  }
  return created;
}

async function listAnnouncements(limit = 100, deps = {}) {
  const db = deps.db || pool;
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const [rows] = await db.query(
    'SELECT * FROM site_announcements ORDER BY id DESC LIMIT ?',
    [safeLimit]
  );
  return rows;
}

async function deleteAnnouncement(id, deps = {}) {
  const db = deps.db || pool;
  const noticeId = Number(id);
  if (!Number.isSafeInteger(noticeId) || noticeId <= 0) throw validationError('공지 ID가 올바르지 않습니다.');
  const [result] = await db.query('DELETE FROM site_announcements WHERE id = ?', [noticeId]);
  return result.affectedRows > 0;
}

async function toggleAnnouncement(id, deps = {}) {
  const db = deps.db || pool;
  const io = Object.prototype.hasOwnProperty.call(deps, 'io') ? deps.io : global.__io;
  const noticeId = Number(id);
  if (!Number.isSafeInteger(noticeId) || noticeId <= 0) throw validationError('공지 ID가 올바르지 않습니다.');

  const [rows] = await db.query('SELECT * FROM site_announcements WHERE id = ? LIMIT 1', [noticeId]);
  if (!rows[0]) return null;
  const nextActive = rows[0].is_active ? 0 : 1;
  await db.query('UPDATE site_announcements SET is_active = ? WHERE id = ?', [nextActive, noticeId]);

  const updated = { ...rows[0], is_active: nextActive };
  if (nextActive && updated.is_popup && io && typeof io.emit === 'function') {
    const startsAt = normalizeDate(updated.starts_at, '시작 시각');
    const endsAt = normalizeDate(updated.ends_at, '종료 시각');
    if (shouldBroadcast({ isPopup: true, startsAt, endsAt })) {
      io.emit('announcement:popup', publicPayload(updated));
    }
  }
  return updated;
}

module.exports = {
  ANNOUNCEMENT_TYPES,
  normalizeAnnouncement,
  publicPayload,
  createAnnouncement,
  listAnnouncements,
  deleteAnnouncement,
  toggleAnnouncement
};
