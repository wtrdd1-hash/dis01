/**
 * 웹 응답·입력 안전 헬퍼 (에러 메시지 누출 차단, URL/검색어 검증)
 */
const PUBLIC_ERROR = '처리 중 오류가 발생했습니다.';
const DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

function sendPublicError(res, err, fallbackStatus = 500) {
  const status = Number(err && err.status) || fallbackStatus;
  if (status >= 500) {
    if (err) console.error(err);
    return res.status(status).json({ success: false, error: PUBLIC_ERROR });
  }
  return res.status(status).json({
    success: false,
    error: (err && err.message) || '요청을 처리할 수 없습니다.'
  });
}

function publicErrorMessage(err) {
  const status = Number(err && err.status) || 500;
  if (status >= 500) {
    if (err) console.error(err);
    return PUBLIC_ERROR;
  }
  return (err && err.message) || '요청을 처리할 수 없습니다.';
}

function likeContains(raw, maxLen = 64) {
  const s = String(raw || '').slice(0, maxLen).replace(/[%_\\]/g, '');
  if (!s) return null;
  return `%${s}%`;
}

function clampInt(raw, def, min, max) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value ?? {}, (_, v) => (
    typeof v === 'bigint' ? v.toString() : v
  )));
}

function safeJsonForHtml(obj) {
  return JSON.stringify(jsonSafe(obj))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function isDiscordCdnHost(hostname) {
  return hostname === 'cdn.discordapp.com' || hostname === 'media.discordapp.net';
}

function safeAvatarUrl(url, userId) {
  const value = String(url || '').trim();
  if (!value) return DEFAULT_AVATAR;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return DEFAULT_AVATAR;
    if (!isDiscordCdnHost(parsed.hostname)) return DEFAULT_AVATAR;
    return parsed.href;
  } catch (e) {}
  if (userId && /^\d{16,22}$/.test(String(userId)) && /^[a-zA-Z0-9_]{16,}$/.test(value)) {
    return `https://cdn.discordapp.com/avatars/${userId}/${value}.png`;
  }
  return DEFAULT_AVATAR;
}

function safeUploadUrl(url) {
  const value = String(url || '').trim();
  if (/^\/uploads\/inquiries\/[A-Za-z0-9._-]+\.(jpg|jpeg|png)$/i.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' && isDiscordCdnHost(parsed.hostname)) {
      return parsed.href;
    }
    const host = parsed.hostname.toLowerCase();
    const allowedHost = (
      host === 'easy-scraping.com' ||
      host === 'www.easy-scraping.com' ||
      host === 'localhost' ||
      host === '127.0.0.1'
    );
    if (allowedHost && /^\/uploads\/inquiries\/[A-Za-z0-9._-]+\.(jpg|jpeg|png)$/i.test(parsed.pathname)) {
      return parsed.pathname;
    }
  } catch (e) {}
  return '';
}

function isDiscordSnowflake(id) {
  return /^\d{16,22}$/.test(String(id || ''));
}

function sanitizeUsername(name) {
  return String(name || '').replace(/[<>]/g, '').slice(0, 64);
}

function createKeyedRateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, row] of hits.entries()) {
      if (!row || row.start < cutoff) hits.delete(key);
    }
  }, Math.min(windowMs, 60 * 1000)).unref();

  return function allow(key) {
    const now = Date.now();
    let row = hits.get(key);
    if (!row || now - row.start > windowMs) {
      row = { start: now, count: 0 };
      hits.set(key, row);
    }
    row.count += 1;
    return row.count <= max;
  };
}

module.exports = {
  PUBLIC_ERROR,
  DEFAULT_AVATAR,
  sendPublicError,
  publicErrorMessage,
  likeContains,
  clampInt,
  jsonSafe,
  safeJsonForHtml,
  safeAvatarUrl,
  safeUploadUrl,
  isDiscordSnowflake,
  sanitizeUsername,
  createKeyedRateLimiter
};
