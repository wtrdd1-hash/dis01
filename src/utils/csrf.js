/**
 * 🛡️ CSRF (Cross-Site Request Forgery) 토큰 발급 및 검증 유틸리티
 *
 * - Double Submit Cookie + HMAC 서명 패턴 사용
 * - Express 세션과 동일한 COOKIE_SECRET을 HMAC 키로 활용
 * - 토큰은 HttpOnly + Signed 쿠키로 보관하고, 클라이언트는 별도 헤더(X-CSRF-Token)로 회신
 * - 모든 관리자 POST/PUT/DELETE API는 requireCsrf() 미들웨어를 통과해야 함
 */
const crypto = require('crypto');
const session = require('../web/session');

const CSRF_COOKIE = 'wtrd_csrf';
const CSRF_HEADER = 'x-csrf-token';
const CSRF_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function cookieOptions(req) {
  const host = String((req && (req.headers['x-forwarded-host'] || req.headers.host)) || '').split(',')[0].toLowerCase();
  const hostname = host.split(':')[0];
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const opts = {
    httpOnly: true,
    secure: !isLocal,
    sameSite: 'lax',
    path: '/',
    maxAge: CSRF_MAX_AGE_MS
  };
  if (!isLocal && hostname) opts.domain = hostname.startsWith('www.') ? hostname.slice(4) : hostname;
  return opts;
}

function signToken(raw, req) {
  try {
    const secret = (session.getCookieSecret ? session.getCookieSecret() : process.env.COOKIE_SECRET) || '';
    return crypto.createHmac('sha256', secret).update(raw).digest('base64url');
  } catch (e) { return ''; }
}

function verifySignature(raw, signature, req) {
  if (!signature) return false;
  const expected = signToken(raw, req);
  if (!expected) return false;
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); }
  catch (e) { return false; }
}

function generateToken(req) {
  const raw = generateRawToken();
  const signature = signToken(raw, req);
  return `${raw}.${signature}`;
}

function parseToken(token, req) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const raw = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!verifySignature(raw, sig, req)) return null;
  return raw;
}

function ensureToken(req, res) {
  try {
    const existing = req.cookies && req.cookies[CSRF_COOKIE];
    if (existing && parseToken(existing, req)) return existing;
    const token = generateToken(req);
    res.cookie(CSRF_COOKIE, token, cookieOptions(req));
    return token;
  } catch (e) { return null; }
}

function issueCsrfToken(req, res) { return ensureToken(req, res); }

function exposeTokenHeader(req, res) {
  try {
    const token = ensureToken(req, res);
    if (token) res.setHeader('X-CSRF-Token', parseToken(req, token) || token);
  } catch (e) {}
}

function verifyToken(req) {
  try {
    const cookie = req.cookies && req.cookies[CSRF_COOKIE];
    if (!cookie) return false;
    const parsedCookie = parseToken(cookie, req);
    if (!parsedCookie) return false;
    const headerToken = String(req.headers[CSRF_HEADER] || req.headers['X-CSRF-Token'] || '').trim();
    if (!headerToken) return false;
    const parsedHeader = parseToken(headerToken, req);
    if (!parsedHeader) return false;
    return parsedCookie === parsedHeader;
  } catch (e) { return false; }
}

function clearCsrfCookie(req, res) {
  try { res.clearCookie(CSRF_COOKIE, { path: '/' }); } catch (e) {}
}

function requireCsrf(req, res, next) {
  // GET/HEAD/OPTIONS는 통과
  const method = String(req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    ensureToken(req, res);
    return next();
  }
  // POST/PUT/DELETE는 검증 필수
  if (verifyToken(req)) return next();
  try {
    const fromBody = String(req.body._csrf || req.body.csrfToken || '').trim();
    if (fromBody) {
      const cookie = req.cookies && req.cookies[CSRF_COOKIE];
      if (cookie && parseToken(cookie, req)) {
        const parsedBody = parseToken(fromBody, req);
        const parsedCookie = parseToken(cookie, req);
        if (parsedBody && parsedCookie && parsedBody === parsedCookie) {
          return next();
        }
      }
    }
  } catch (e) {}
  return res.status(403).json({ success: false, error: 'CSRF 토큰 검증 실패' });
}

module.exports = {
  ensureToken,
  issueCsrfToken,
  exposeTokenHeader,
  verifyToken,
  requireCsrf,
  clearCsrfCookie,
  CSRF_COOKIE,
  CSRF_HEADER
};
