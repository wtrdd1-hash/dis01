/**
 * 서명된 세션 쿠키 / OAuth state / 동일 출처 검사
 * Express 보안 가이드: HttpOnly + Secure + SameSite + 서명
 */
const crypto = require('crypto');
const config = require('../config/config');
const { isDiscordSnowflake, sanitizeUsername, safeAvatarUrl } = require('./httpSafe');

const IS_TEST_ENV = process.env.APP_ENV === 'test' || process.env.NODE_ENV === 'test';
const COOKIE_SUFFIX = IS_TEST_ENV ? '_test' : '';
const SESSION_COOKIE = `discord_user${COOKIE_SUFFIX}`;
const OAUTH_STATE_COOKIE = `oauth_state${COOKIE_SUFFIX}`;
const GUEST_COOKIE = `guest_play${COOKIE_SUFFIX}`;
const LOCAL_COOKIE = `web_user${COOKIE_SUFFIX}`;
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

const ALLOWED_ORIGINS = [
  'https://easy-scraping.com',
  'https://www.easy-scraping.com',
  'https://test.easy-scraping.com',
  'https://dev.easy-scraping.com',
  'https://nowplayz.com',
  'https://www.nowplayz.com',
  'http://localhost:8070',
  'http://127.0.0.1:8070',
  'http://localhost:8090',
  'http://127.0.0.1:8090',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:8085',
  'http://127.0.0.1:8085'
];

const ALLOWED_HOSTS = new Set([
  'easy-scraping.com',
  'www.easy-scraping.com',
  'test.easy-scraping.com',
  'dev.easy-scraping.com',
  'nowplayz.com',
  'www.nowplayz.com',
  'localhost:8070',
  '127.0.0.1:8070',
  'localhost:8090',
  '127.0.0.1:8090',
  'localhost:8080',
  '127.0.0.1:8080',
  'localhost:8085',
  '127.0.0.1:8085'
]);

let resolvedCookieSecret = null;
let warnedMissingCookieSecret = false;

function getCookieSecret() {
  if (resolvedCookieSecret) return resolvedCookieSecret;
  const fromEnv = String(config.cookieSecret || '').trim();
  if (fromEnv.length >= 16) {
    resolvedCookieSecret = fromEnv;
    return resolvedCookieSecret;
  }
  resolvedCookieSecret = crypto.randomBytes(32).toString('hex');
  if (!warnedMissingCookieSecret) {
    warnedMissingCookieSecret = true;
    console.warn('[session] COOKIE_SECRET가 없거나 너무 짧습니다. 이번 기동만 임시 키를 쓰며, 재시작 시 로그인이 풀립니다. COOKIE_SECRET을 환경변수로 설정하세요.');
  }
  return resolvedCookieSecret;
}

function requestHost(req) {
  return String((req && (req.headers['x-forwarded-host'] || req.headers.host)) || 'easy-scraping.com')
    .split(',')[0]
    .trim()
    .toLowerCase();
}

function isLocalHost(host) {
  const hostname = String(host || '').split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function resolvePublicBaseUrl(req) {
  const rawHost = requestHost(req);
  const host = ALLOWED_HOSTS.has(rawHost) ? rawHost : 'easy-scraping.com';
  if (isLocalHost(host)) {
    const protoRaw = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const proto = protoRaw === 'https' ? 'https' : 'http';
    return `${proto}://${host}`;
  }
  return `https://${host}`;
}

function cookieBaseOptions(req) {
  const host = requestHost(req);
  const local = isLocalHost(host);
  return {
    httpOnly: true,
    secure: !local,
    sameSite: 'lax',
    path: '/',
    signed: true
  };
}

function legacyDomainCookieOptions(req) {
  const opts = cookieBaseOptions(req);
  const host = requestHost(req);
  if (isLocalHost(host)) return null;
  opts.domain = host.includes('nowplayz.com') ? '.nowplayz.com' : '.easy-scraping.com';
  return opts;
}

function signValue(val, secret) {
  const hmac = crypto.createHmac('sha256', secret)
    .update(val)
    .digest('base64')
    .replace(/=+$/g, '');
  return 's:' + val + '.' + hmac;
}

function unsignValue(input, secret) {
  if (!input || typeof input !== 'string' || !input.startsWith('s:')) return false;
  const str = input.slice(2);
  const idx = str.lastIndexOf('.');
  if (idx < 0) return false;
  const val = str.slice(0, idx);
  const mac = str.slice(idx + 1);
  const expected = crypto.createHmac('sha256', secret)
    .update(val)
    .digest('base64')
    .replace(/=+$/g, '');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  return val;
}

function isGuestUserId(id) {
  return /^9\d{18}$/.test(String(id || ''));
}

function isLocalUserId(id) {
  return /^w_[a-f0-9]{16}$/.test(String(id || ''));
}

function cookieValuesNamed(cookieHeader, name) {
  const out = [];
  for (const part of String(cookieHeader || '').split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(name + '=')) out.push(trimmed.slice(name.length + 1));
  }
  return out;
}

function tryParseSigned(raw) {
  if (!raw) return null;
  try {
    let value = decodeURIComponent(String(raw));
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    const unsigned = unsignValue(value, getCookieSecret());
    return unsigned === false ? null : unsigned;
  } catch (e) {
    return null;
  }
}

function normalizeSessionUser(parsed) {
  if (!parsed || !parsed.id) return null;
  const id = String(parsed.id);
  if (!isDiscordSnowflake(id) || isGuestUserId(id)) return null;
  return {
    id,
    username: sanitizeUsername(parsed.username || ''),
    avatar: safeAvatarUrl(parsed.avatar, id)
  };
}

function parseUserPayload(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') {
    return normalizeSessionUser(raw);
  }
  let value = String(raw);
  if (value.startsWith('j:')) value = value.slice(2);
  const parsed = JSON.parse(value);
  return normalizeSessionUser(parsed);
}

function parseLocalPayload(raw) {
  if (!raw) return null;
  const parsed = typeof raw === 'object' ? raw : JSON.parse(String(raw).replace(/^j:/, ''));
  if (!parsed || !parsed.id) return null;
  const id = String(parsed.id);
  if (!isLocalUserId(id)) return null;
  return {
    id,
    username: sanitizeUsername(parsed.username || ''),
    avatar: '',
    local: true
  };
}

function firstValidUser(req, cookieName, parseFn) {
  const seen = [];
  const signed = req.signedCookies && req.signedCookies[cookieName];
  if (signed) seen.push(signed);
  for (const raw of cookieValuesNamed(req.headers && req.headers.cookie, cookieName)) {
    const unsigned = tryParseSigned(raw);
    if (unsigned) seen.push(unsigned);
  }
  for (const item of seen) {
    try {
      const user = parseFn(item);
      if (user) return user;
    } catch (e) {}
  }
  return null;
}

function getSessionUser(req) {
  try {
    return firstValidUser(req, SESSION_COOKIE, parseUserPayload);
  } catch (e) {
    return null;
  }
}

function getLocalUser(req) {
  try {
    return firstValidUser(req, LOCAL_COOKIE, parseLocalPayload);
  } catch (e) {
    return null;
  }
}

function getPlayUser(req) {
  return getSessionUser(req) || getLocalUser(req);
}

function getGuestUser(req) {
  return getLocalUser(req);
}

function attachGuestForPlay(req, res, next) {
  next();
}

function setSessionCookie(res, user, req) {
  const normalized = normalizeSessionUser(user);
  if (!normalized) return;
  const legacyOptions = !IS_TEST_ENV && legacyDomainCookieOptions(req);
  if (legacyOptions) res.clearCookie(SESSION_COOKIE, legacyOptions);
  res.cookie(SESSION_COOKIE, JSON.stringify(normalized), {
    ...cookieBaseOptions(req),
    maxAge: SESSION_MAX_AGE_MS
  });
}

function setLocalCookie(res, user, req) {
  const normalized = parseLocalPayload(user);
  if (!normalized) return;
  const legacyOptions = !IS_TEST_ENV && legacyDomainCookieOptions(req);
  if (legacyOptions) res.clearCookie(LOCAL_COOKIE, legacyOptions);
  res.cookie(LOCAL_COOKIE, JSON.stringify(normalized), {
    ...cookieBaseOptions(req),
    maxAge: SESSION_MAX_AGE_MS
  });
}

function touchSessionCookie(req, res, user) {
  setSessionCookie(res, user, req);
}

function touchLocalCookie(req, res, user) {
  setLocalCookie(res, user, req);
}

function clearCookiePair(res, name, req) {
  res.clearCookie(name, cookieBaseOptions(req));
  const legacyOptions = !IS_TEST_ENV && legacyDomainCookieOptions(req);
  if (legacyOptions) res.clearCookie(name, legacyOptions);
}

function clearSessionCookie(res, req) {
  clearCookiePair(res, SESSION_COOKIE, req);
  clearCookiePair(res, OAUTH_STATE_COOKIE, req);
  clearCookiePair(res, LOCAL_COOKIE, req);
  clearCookiePair(res, GUEST_COOKIE, req);
}

function clearGuestCookie(res, req) {
  clearCookiePair(res, GUEST_COOKIE, req);
}

function createOAuthState(res, req) {
  const state = crypto.randomBytes(16).toString('hex');
  const legacyOptions = !IS_TEST_ENV && legacyDomainCookieOptions(req);
  if (legacyOptions) res.clearCookie(OAUTH_STATE_COOKIE, legacyOptions);
  res.cookie(OAUTH_STATE_COOKIE, state, {
    ...cookieBaseOptions(req),
    maxAge: OAUTH_STATE_MAX_AGE_MS
  });
  return state;
}

function consumeOAuthState(req, res, incomingState) {
  const expected = req.signedCookies && req.signedCookies[OAUTH_STATE_COOKIE];
  clearCookiePair(res, OAUTH_STATE_COOKIE, req);
  if (!incomingState || !expected || String(incomingState) !== String(expected)) {
    return false;
  }
  return true;
}

function parseSessionFromCookieHeader(cookieHeader) {
  const reqLike = { headers: { cookie: cookieHeader }, signedCookies: {} };
  return getSessionUser(reqLike) || getLocalUser(reqLike);
}

function isAllowedOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (origin && ALLOWED_ORIGINS.includes(origin)) return true;
  const referer = String(req.headers.referer || '');
  if (referer) {
    return ALLOWED_ORIGINS.some((base) => referer.startsWith(base + '/') || referer === base);
  }
  return false;
}

function requireSameOrigin(req, res, next) {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const path = req.path || '';
  if (path.startsWith('/socket.io')) return next();
  if (!isAllowedOrigin(req)) {
    return res.status(403).json({ success: false, error: '허용되지 않은 요청 출처입니다.' });
  }
  next();
}

function discordOnlyBlocked(res, feature) {
  return res.status(403).json({
    success: false,
    local: true,
    error: `${feature}은 Discord 로그인 계정만 이용할 수 있습니다.`
  });
}

const SKIP_ACCESS_LOG_PATHS = new Set([
  '/robots.txt',
  '/sitemap.xml',
  '/api/clicker/click',
  '/api/mine/state',
  '/api/mine/leaderboard',
  '/api/mine/catalog',
  '/api/version',
  '/healthz',
  '/api/user/me',
  '/api/user/summary',
  '/api/stocks',
  '/api/chat/messages',
  '/api/stream'
]);

function shouldSkipAccessLog(req) {
  const url = req.originalUrl || req.url || '';
  const pathOnly = url.split('?')[0];
  if (
    url.startsWith('/socket.io') ||
    url.startsWith('/favicon') ||
    url.startsWith('/static') ||
    url.startsWith('/uploads') ||
    pathOnly.startsWith('/api/system/activity-feed')
  ) {
    return true;
  }
  return SKIP_ACCESS_LOG_PATHS.has(pathOnly);
}

module.exports = {
  SESSION_COOKIE,
  LOCAL_COOKIE,
  GUEST_COOKIE,
  getCookieSecret,
  requestHost,
  getSessionUser,
  getLocalUser,
  getPlayUser,
  getGuestUser,
  attachGuestForPlay,
  setSessionCookie,
  setLocalCookie,
  touchSessionCookie,
  touchLocalCookie,
  clearSessionCookie,
  clearGuestCookie,
  createOAuthState,
  consumeOAuthState,
  parseSessionFromCookieHeader,
  requireSameOrigin,
  shouldSkipAccessLog,
  ALLOWED_ORIGINS,
  ALLOWED_HOSTS,
  resolvePublicBaseUrl,
  signValue,
  unsignValue,
  isGuestUserId,
  isLocalUserId,
  discordOnlyBlocked
};
