const { pool } = require('../config/database');
const config = require('../config/config');
const { cleanIp, lookupIp, isValidIp, isLocalIp } = require('../utils/geoIp');
const { formatKstDateTime } = require('../utils/formatters');
const session = require('./session');
const { checkVpnOrProxy, renderVpnBlockPage } = require('../utils/vpnShield');

// ============================================================
// 🛡️ 웹 보안 시스템 (Web Security Shield)
// - 악성 경로 차단 (해킹 시도, 스캐너, 정보 탈취 등)
// - IP 기반 자동 차단 (의심 요청 누적 시 자동 밴)
// - 관리자 Discord DM 알림 (내부망·도커 프록시는 제외, 쿨다운 적용)
// ============================================================

// ── 🔴 차단할 악성 경로 패턴 ──────────────────────────────
const BLOCKED_PATHS = [
  // 환경변수/설정 파일 탈취 시도
  /\.env(\.|$)/i,
  /\.env\./i,
  /config\.php/i,
  /configuration\.php/i,
  /settings\.php/i,
  /web\.config/i,
  /appsettings/i,

  // 서버 정보 탈취
  /\/etc\/(passwd|shadow|hosts)/i,
  /\/proc\//i,
  /\/var\/log/i,
  /php\.ini/i,
  /server\.xml/i,
  /httpd\.conf/i,

  // 관리자 패널 스캔 (실제 앱 경로 /admin, /api/admin 은 제외)
  /wp-admin/i,
  /wp-login/i,
  /wp-content/i,
  /wp-includes/i,
  /xmlrpc\.php/i,
  /phpmyadmin/i,
  /phpMyAdmin/i,
  /adminer/i,
  /pma\//i,
  /cpanel/i,
  /plesk/i,
  /webmin/i,
  /\/administrator(\.|\/|$)/i,
  /\/admin\.(php|asp|aspx|cgi|html)/i,

  // SQL 인젝션 패턴
  /union.*select/i,
  /select.*from.*where/i,
  /insert.*into/i,
  /drop.*table/i,
  /exec(\s|\+)+(xp_|sp_)/i,

  // 디렉터리 트래버설
  /\.\.\//,
  /\.\.\\/,
  /%2e%2e%2f/i,
  /%252e%252e/i,

  // 일반 취약점 스캐너
  /\.git\//i,
  /\.svn\//i,
  /\.DS_Store/i,
  /\.htaccess/i,
  /\.htpasswd/i,
  /backup\.(sql|zip|tar|gz|bak)/i,
  /database\.(sql|bak)/i,
  /dump\.sql/i,

  // 쉘/업로드 공격
  /shell\.php/i,
  /cmd\.php/i,
  /eval-stdin\.php/i,
  /c99\.php/i,
  /r57\.php/i,
  /\/cgi-bin\//i,

  // 기타 탐색 시도
  /\/manager\//i,
  /actuator\//i,
  /\.aws\//i,
  /aws_access_key/i,
  /credentials/i,
];

// ── 🤖 차단할 무단 크롤러 및 스캐너 봇 User-Agent ───────────
const BLOCKED_BOT_AGENTS = [
  /sqlmap/i,
  /nikto/i,
  /nmap/i,
  /masscan/i,
  /zgrab/i,
  /gobuster/i,
  /dirbuster/i,
  /wpscan/i,
  /censys/i,
  /shodan/i,
  /SemrushBot/i,
  /AhrefsBot/i,
  /MJ12bot/i,
  /DotBot/i,
  /PetalBot/i,
  /Bytespider/i,
  /GPTBot/i,
  /CCBot/i,
  /DataForSeoBot/i
];

// ── 🛡️ 화이트리스트 IP 목록 (절대 차단 불가) ──────────────
function buildWhitelistIps() {
  const set = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
  const fromEnv = String(process.env.SECURITY_WHITELIST_IPS || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) {
    for (const ip of fromEnv) set.add(cleanIp(ip));
  } else {
    // env가 없으면 기존 운영 IP를 유지한다.
    set.add('14.49.239.61');
  }
  return set;
}
const WHITELIST_IPS = buildWhitelistIps();

// ── 🚦 Rate Limiter (IP별 요청 제한 & DDoS 방어 기준 완화) ──
const requestCounts = new Map(); // IP → { count, firstTime, blocked }
const RATE_LIMIT_WINDOW_MS  = 60 * 1000; // 1분 윈도우
const RATE_LIMIT_MAX         = 1200;      // 1분에 1,200회 초과 시 경고 (연타/채굴/다중탭 친화적)
const RATE_LIMIT_HARD_BAN    = 3000;      // 3,000회 초과 시에만 비정상 공격으로 판단하여 자동 IP 차단
const SUSPICIOUS_THRESHOLD   = 15;        // 악성 경로 15회 누적 시 자동 밴
const RATE_LIMIT_SKIP_PATHS = new Set([
  '/healthz',
  '/nginx-health',
  '/robots.txt',
  '/sitemap.xml',
  '/rss',
  '/rss.xml',
  '/feed',
  '/favicon.ico',
  '/favicon.svg'
]);

// ── 🔍 구글 검색 / 주요 공인 검색엔진 크롤러 화이트리스트 ────────
const SEARCH_ENGINE_BOT_AGENTS = [
  /Googlebot/i,
  /Google-Site-Verification/i,
  /Google-InspectionTool/i,
  /Storebot-Google/i,
  /Google-Cloud-VertexBot/i,
  /AdsBot-Google/i,
  /Google-Safety/i,
  /Mediapartners-Google/i,
  /FeedFetcher-Google/i,
  /bingbot/i,
  /Yeti/i,      // 네이버 검색엔진
  /Daumoa/i     // 다음/카카오 검색엔진
];

function isSearchEngineRequest(ua, urlPath) {
  const path = String(urlPath || '/').toLowerCase();
  // 구글 소유권 확인 파일 또는 robots.txt / sitemap.xml / rss
  if (path === '/robots.txt' || path === '/sitemap.xml' || path === '/rss' || path === '/rss.xml' || path === '/feed' || /^\/google[a-z0-9_-]+\.html$/i.test(path)) {
    return true;
  }
  for (const regex of SEARCH_ENGINE_BOT_AGENTS) {
    if (regex.test(ua)) return true;
  }
  return false;
}
const ALERT_COOLDOWN_MS = {
  RATE_LIMIT: 45 * 60 * 1000,
  MALICIOUS_PATH: 15 * 60 * 1000,
  SQL_INJECTION: 15 * 60 * 1000,
  IP_BANNED: 20 * 60 * 1000
};
const GLOBAL_RATE_LIMIT_ALERT_MS = 20 * 60 * 1000;
let lastGlobalRateLimitAlert = 0;

// ── 🚫 메모리 IP 블랙리스트 (재시작 전까지 유지) ─────────
const memoryBanList = new Map(); // IP → { reason, bannedAt, expires }

// ── 📊 보안 이벤트 통계 ──────────────────────────────────
let securityStats = {
  totalBlocked: 0,
  totalBanned: 0,
  attacksByPath: {},
  attacksByIp: {},
  lastAlertTime: {},   // type:ip 마지막 알림 시각 (중복 DM 방지)
};

function pruneStatEntries(statMap, maxEntries = 1000) {
  const entries = Object.entries(statMap || {});
  if (entries.length <= maxEntries) return;
  entries
    .sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0))
    .slice(0, entries.length - maxEntries)
    .forEach(([key]) => delete statMap[key]);
}

function safeDecodePath(raw) {
  const value = String(raw || '/');
  try {
    return decodeURIComponent(value).toLowerCase();
  } catch (e) {
    return value.toLowerCase();
  }
}

function isTrustedProxySocket(req) {
  return isLocalIp(req.socket?.remoteAddress || '');
}

function pickForwardedClientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf && isValidIp(cf)) return cleanIp(cf);
  const realIp = String(req.headers['x-real-ip'] || '').split(',')[0].trim();
  if (realIp && isValidIp(realIp)) return cleanIp(realIp);
  const xff = String(req.headers['x-forwarded-for'] || '');
  const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const candidate = cleanIp(parts[i]);
    if (isValidIp(candidate) && !isLocalIp(candidate)) return candidate;
  }
  if (parts.length && isValidIp(parts[0])) return cleanIp(parts[0]);
  if (req.ip && isValidIp(req.ip)) return cleanIp(req.ip);
  return null;
}

// ── 헬퍼: 클라이언트 실제 IP ────────────────────────────
// Nginx는 도커 브리지(172.18.x)에서 host:8080 으로 붙는다.
// 소켓이 로컬/사설망일 때만 포워드 헤더를 신뢰한다.
function getClientIp(req) {
  if (isTrustedProxySocket(req)) {
    const forwarded = pickForwardedClientIp(req);
    if (forwarded) return forwarded;
  }
  return cleanIp(req.socket?.remoteAddress || 'unknown');
}

function isInternalClient(ip, geo) {
  if (isLocalIp(ip)) return true;
  if (geo && (geo.country === 'LOCAL' || geo.countryName === '로컬/내부망')) return true;
  return false;
}

function shouldSkipRateLimit(urlPath) {
  const path = String(urlPath || '/').split('?')[0];
  if (RATE_LIMIT_SKIP_PATHS.has(path)) return true;
  if (path.startsWith('/css/') || path.startsWith('/js/') || path.startsWith('/public/') || path.startsWith('/images/')) return true;
  if (path.startsWith('/api/clicker/') || path.startsWith('/api/chat/') || path.startsWith('/api/game/') || path.startsWith('/socket.io/')) return true;
  return false;
}

// ── 헬퍼: 관리자 여부 확인 ────────────────────────────────
function isUserAdmin(req) {
  try {
    const user = session.getSessionUser(req);
    if (user && config.isAdmin(user.id)) return true;
  } catch (e) {}
  return false;
}

// ── 헬퍼: 화이트리스트 여부 확인 ──────────────────────────
function isWhitelisted(ip, req) {
  if (WHITELIST_IPS.has(ip)) return true;
  if (req && isUserAdmin(req)) return true;
  return false;
}

// ── 헬퍼: 이모지 국가코드 ────────────────────────────────
function countryFlag(code) {
  if (!code || code.length !== 2) return '🌐';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

// ── 🔔 관리자 Discord DM 알림 ────────────────────────────
async function alertAdmins(client, type, data) {
  if (!client) return;
  if (isInternalClient(data.ip, { countryName: data.countryName, country: data.country })) return;

  const now = Date.now();
  const cooldown = ALERT_COOLDOWN_MS[type] || 15 * 60 * 1000;
  const alertKey = `${type}:${data.ip || 'unknown'}`;
  const lastAlert = securityStats.lastAlertTime[alertKey] || 0;
  if (now - lastAlert < cooldown) return;
  if (type === 'RATE_LIMIT') {
    if (now - lastGlobalRateLimitAlert < GLOBAL_RATE_LIMIT_ALERT_MS) return;
    lastGlobalRateLimitAlert = now;
  }
  securityStats.lastAlertTime[alertKey] = now;

  const colorMap = {
    MALICIOUS_PATH: 0xFF4444,
    RATE_LIMIT:     0xFF8800,
    IP_BANNED:      0xFF0000,
    SQL_INJECTION:  0xFF0000,
  };

  const titleMap = {
    MALICIOUS_PATH: '🚨 악성 경로 접근 차단',
    RATE_LIMIT:     '⚠️ 과도한 요청 감지',
    IP_BANNED:      '🔴 IP 자동 차단 완료',
    SQL_INJECTION:  '🚨 SQL 인젝션 시도 차단',
  };

  const flag = countryFlag(data.country);
  const embed = {
    color: colorMap[type] || 0xFF4444,
    title: titleMap[type] || '🛡️ 보안 경고',
    fields: [
      { name: '🌐 IP 주소',      value: `\`${data.ip}\``,                         inline: true },
      { name: `${flag} 국가`,    value: data.countryName || data.country || '알 수 없음', inline: true },
      { name: '⏰ 시간',          value: new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }), inline: true },
      { name: '📋 요청',         value: `\`${data.method || 'GET'} ${(data.path || '/').substring(0, 100)}\``, inline: false },
      { name: '📌 사유',         value: data.reason || type, inline: false },
    ],
    footer: { text: '웹 보안 시스템 (Web Security Shield)' },
    timestamp: new Date().toISOString(),
  };

  if (data.count !== undefined) {
    embed.fields.push({ name: '🔢 누적 악성 시도', value: `**${data.count}회**`, inline: true });
  }

  for (const adminId of config.adminIds) {
    try {
      const adminUser = await client.users.fetch(adminId);
      await adminUser.send({ embeds: [embed] });
    } catch (e) {
      // DM 실패 무시
    }
  }
}

// ── 🗄️ DB에 보안 이벤트 기록 ────────────────────────────
async function logSecurityEvent(ip, type, path, reason, country, countryName) {
  try {
    await pool.query(`
      INSERT INTO security_events (ip, event_type, path, reason, country, country_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [ip, type, path.substring(0, 500), reason.substring(0, 255), country || null, countryName || null]);
  } catch (e) {
    // 테이블 없으면 무시 (DB 초기화 전 보호용)
  }
}

// ── 🛡️ 메인 보안 미들웨어 ───────────────────────────────
function createSecurityMiddleware(client) {
  return async function securityMiddleware(req, res, next) {
    const ip      = getClientIp(req);
    const urlPath = safeDecodePath(req.path || req.url || '/');
    const method  = req.method;
    const ua      = (req.headers['user-agent'] || '').substring(0, 200);
    const geo = lookupIp(ip);
    req.geoCountry = geo.country;
    req.geoCountryName = geo.countryName;
    req.geoFlag = geo.flag;
    const country = geo.country || '';
    const countryName = geo.countryName || '';
    const internalClient = isInternalClient(ip, geo);
    const skipRate = internalClient || shouldSkipRateLimit(urlPath);

    // 화이트리스트·관리자 예외와 관계없이 모든 응답에 기본 보안 헤더를 적용한다.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    // ── 0. 화이트리스트 및 관리자 확인 (절대 차단 불가) ────
    if (isWhitelisted(ip, req)) {
      return next();
    }

    // ── 🔍 구글 검색 / 주요 공인 검색엔진 예외 처리 (크롤링 & 색인 보장) ────
    if (isSearchEngineRequest(ua, urlPath)) {
      return next();
    }

    // ── 🛡️ VPN 및 익명 프록시 차단 ──────────────────────────
    // OAuth 로그인·인증 경로는 VPN 검사에서 완전 제외 (로그인 불가 현상 방지)
    const isAuthPath = urlPath.startsWith('/auth/') || urlPath === '/auth';
    if (!skipRate && !isAuthPath && urlPath !== '/robots.txt' && urlPath !== '/sitemap.xml' && urlPath !== '/health') {
      try {
        const vpnCheck = await checkVpnOrProxy(ip, req);
        if (vpnCheck && vpnCheck.isBlocked) {
          logSecurityEvent(ip, 'VPN_PROXY_BLOCKED', urlPath, vpnCheck.reason || 'VPN/프록시 우회 접속 차단', country, countryName);
          securityStats.totalBlocked++;
          res.setHeader('X-Security', 'VPN-Blocked');
          if (req.accepts && req.accepts('html') && !urlPath.startsWith('/api/')) {
            return res.status(403).send(renderVpnBlockPage(ip, vpnCheck.reason));
          } else {
            return res.status(403).json({ success: false, error: 'VPN 또는 프록시를 통한 우회 접속이 차단되었습니다.', reason: vpnCheck.reason });
          }
        }
      } catch (err) {}
    }

    // ── 1. 메모리 밴 리스트 확인 ───────────────────────
    const ban = memoryBanList.get(ip);
    if (ban) {
      if (ban.expires > Date.now()) {
        res.setHeader('X-Security', 'Blocked');
        return res.status(403).json({ error: '접근이 차단되었습니다.' });
      } else {
        memoryBanList.delete(ip); // 만료된 밴 해제
      }
    }

    // ── 2. Rate Limit 체크 (내부망·헬스체크는 집계/차단/DM 제외) ─
    const now = Date.now();
    let rc = requestCounts.get(ip);
    if (!rc || now - rc.firstTime > RATE_LIMIT_WINDOW_MS) {
      rc = { count: 0, firstTime: now, suspicious: 0 };
      requestCounts.set(ip, rc);
    }
    if (!skipRate) {
      rc.count++;

      if (rc.count > RATE_LIMIT_HARD_BAN) {
        memoryBanList.set(ip, { reason: '요청 폭탄 (DDoS 의심)', bannedAt: now, expires: now + 10 * 60 * 1000 });
        securityStats.totalBanned++;
        logSecurityEvent(ip, 'IP_BANNED', urlPath, `분당 ${rc.count}회 요청 (DDoS 의심)`, country, countryName);
        alertAdmins(client, 'IP_BANNED', { ip, country, countryName, method, path: urlPath, reason: `분당 ${rc.count}회 요청 → 10분 자동 차단`, count: rc.count });
        res.setHeader('X-Security', 'Rate-Banned');
        return res.status(429).json({ error: '너무 많은 요청입니다.' });
      }

      if (rc.count === RATE_LIMIT_MAX + 1) {
        alertAdmins(client, 'RATE_LIMIT', { ip, country, countryName, method, path: urlPath, reason: `분당 ${rc.count}회 초과 요청`, count: rc.count });
      }
    }

    // ── 3. 악성 경로 패턴 차단 ─────────────────────────
    let isBlocked = false;
    let blockReason = '';

    for (const pattern of BLOCKED_PATHS) {
      if (pattern.test(urlPath) || pattern.test(req.url)) {
        isBlocked = true;
        // SQL 인젝션 여부 구분
        const isSqlInjection = /union.*select|select.*from|drop.*table|insert.*into/i.test(urlPath);
        blockReason = isSqlInjection ? `SQL 인젝션 시도: ${urlPath}` : `악성 경로 접근: ${urlPath}`;

        const alertType = isSqlInjection ? 'SQL_INJECTION' : 'MALICIOUS_PATH';

        // 누적 의심 카운트 증가
        rc.suspicious = (rc.suspicious || 0) + 1;
        securityStats.totalBlocked++;
        securityStats.attacksByIp[ip] = (securityStats.attacksByIp[ip] || 0) + 1;
        securityStats.attacksByPath[urlPath] = (securityStats.attacksByPath[urlPath] || 0) + 1;

        // DB 기록
        logSecurityEvent(ip, alertType, urlPath, blockReason, country, countryName);

        // 관리자 DM 알림
        alertAdmins(client, alertType, { ip, country, countryName, method, path: urlPath, reason: blockReason, count: rc.suspicious });

        // 5회 이상 악성 시도 시 IP 자동 밴 (30분)
        if (rc.suspicious >= SUSPICIOUS_THRESHOLD) {
          memoryBanList.set(ip, { reason: blockReason, bannedAt: now, expires: now + 30 * 60 * 1000 });
          securityStats.totalBanned++;
          alertAdmins(client, 'IP_BANNED', { ip, country, countryName, method, path: urlPath, reason: `악성 시도 ${rc.suspicious}회 누적 → 30분 자동 차단`, count: rc.suspicious });
        }

        break;
      }
    }

    if (isBlocked) {
      res.setHeader('X-Security', 'Blocked');
      // 404 반환 (차단 사실 숨기기)
      return res.status(404).end();
    }

    // ── 4. 의심스러운 User-Agent 및 무단 크롤러 감지 (robots.txt 제외) ─────────────────
    if (urlPath !== '/robots.txt' && urlPath !== '/favicon.ico' && urlPath !== '/favicon.svg') {
      for (const uaPattern of BLOCKED_BOT_AGENTS) {
        if (uaPattern.test(ua)) {
          rc.suspicious = (rc.suspicious || 0) + 1;
          logSecurityEvent(ip, 'SUSPICIOUS_UA', urlPath, `차단된 봇/스캐너 UA: ${ua}`, country, countryName);
          if (rc.suspicious >= SUSPICIOUS_THRESHOLD) {
            memoryBanList.set(ip, { reason: `의심 봇/스캐너 UA: ${ua}`, bannedAt: now, expires: now + 30 * 60 * 1000 });
            securityStats.totalBanned++;
            alertAdmins(client, 'IP_BANNED', { ip, country, countryName, method, path: urlPath, reason: `의심 봇/스캐너 감지 → 30분 자동 차단 (UA: ${ua.substring(0,50)})`, count: rc.suspicious });
          }
          res.setHeader('X-Security', 'Bot-Blocked');
          return res.status(403).end();
        }
      }
    }

    next();
  };
}

// ── 📊 보안 현황 조회 ────────────────────────────────────
function getSecurityStats() {
  const now = Date.now();
  const activeBans = [];
  for (const [ip, data] of memoryBanList.entries()) {
    if (data.expires > now) {
      activeBans.push({
        ip,
        reason: data.reason,
        bannedAt: formatKstDateTime(data.bannedAt),
        expiresIn: Math.max(0, Math.round((data.expires - now) / 60000)) + '분',
      });
    } else {
      memoryBanList.delete(ip);
    }
  }

  return {
    ...securityStats,
    bannedIpCount: activeBans.length,
    bannedIps: activeBans,
    whitelistIps: Array.from(WHITELIST_IPS),
    topAttackIps: Object.entries(securityStats.attacksByIp)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([ip, count]) => ({ ip, count })),
    topAttackPaths: Object.entries(securityStats.attacksByPath)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([path, count]) => ({ path, count })),
  };
}

// ── 📋 차단 목록 가져오기 ────────────────────────────────
function getBannedIpsList() {
  const now = Date.now();
  const list = [];
  for (const [ip, data] of memoryBanList.entries()) {
    if (data.expires > now) {
      list.push({
        ip,
        reason: data.reason,
        bannedAt: formatKstDateTime(data.bannedAt),
        remainingMinutes: Math.max(0, Math.round((data.expires - now) / 60000)),
      });
    } else {
      memoryBanList.delete(ip);
    }
  }
  return list;
}

// ── 수동 IP 밴/언밴 함수 ─────────────────────────────────
function banIp(ip, reason = '관리자 수동 차단', durationMinutes = 60 * 24) {
  if (!ip) return { success: false, message: '유효한 IP 주소를 입력하세요.' };
  const normalized = cleanIp(String(ip).trim());
  if (!isValidIp(normalized)) {
    return { success: false, message: `⚠️ '${ip}'는 올바른 IP 주소가 아닙니다.` };
  }
  if (WHITELIST_IPS.has(normalized) || WHITELIST_IPS.has(String(ip).trim())) {
    return { success: false, message: `⚠️ '${normalized}'는 화이트리스트 보호 IP이므로 차단할 수 없습니다.` };
  }
  if (isLocalIp(normalized)) {
    return { success: false, message: `⚠️ '${normalized}'는 내부망 IP라 차단하지 않습니다.` };
  }
  const mins = Math.max(1, Number(durationMinutes) || 1440);
  const now = Date.now();
  memoryBanList.set(normalized, { reason, bannedAt: now, expires: now + mins * 60 * 1000 });
  securityStats.totalBanned++;
  return { success: true, message: `✅ IP '${normalized}'가 ${mins}분 동안 성공적으로 차단되었습니다.`, ip: normalized };
}

function unbanIp(ip) {
  if (!ip) return false;
  const normalized = cleanIp(String(ip).trim());
  const wasBanned = memoryBanList.delete(normalized) || memoryBanList.delete(String(ip).trim());
  requestCounts.delete(normalized);
  requestCounts.delete(String(ip).trim());
  return wasBanned;
}

function isIpBanned(ip) {
  if (!ip) return false;
  const normalized = cleanIp(String(ip).trim());
  const ban = memoryBanList.get(normalized) || memoryBanList.get(String(ip).trim());
  if (!ban) return false;
  if (ban.expires < Date.now()) {
    memoryBanList.delete(normalized);
    return false;
  }
  return true;
}

function getCountryFromIp(ip) {
  try {
    return lookupIp(ip).country || 'N/A';
  } catch (e) {
    return 'N/A';
  }
}

function pruneSecurityMaps() {
  const now = Date.now();
  for (const [ip, data] of memoryBanList.entries()) {
    if (!data || data.expires <= now) memoryBanList.delete(ip);
  }
  for (const [ip, rc] of requestCounts.entries()) {
    if (!rc || now - rc.firstTime > RATE_LIMIT_WINDOW_MS * 2) requestCounts.delete(ip);
  }
  const lastAlert = securityStats.lastAlertTime || {};
  for (const key of Object.keys(lastAlert)) {
    if (now - lastAlert[key] > 2 * 60 * 60 * 1000) delete lastAlert[key];
  }
  pruneStatEntries(securityStats.attacksByIp);
  pruneStatEntries(securityStats.attacksByPath);
}

// ── 🛡️ 화이트리스트 DB 연동 관리 함수 ───────────────────────
async function loadWhitelistFromDb() {
  try {
    if (!pool) return;
    const [rows] = await pool.query('SELECT ip FROM admin_ip_whitelist');
    for (const row of rows) {
      if (row.ip) WHITELIST_IPS.add(cleanIp(row.ip));
    }
  } catch (e) {
    // DB 테이블이 아직 없거나 연결 전일 경우 무시
  }
}
setTimeout(loadWhitelistFromDb, 2000);

async function getWhitelistedIpsList() {
  try {
    if (!pool) return Array.from(WHITELIST_IPS).map(ip => ({ ip, description: '기본 화이트리스트', created_at: new Date() }));
    const [rows] = await pool.query('SELECT * FROM admin_ip_whitelist ORDER BY id DESC');
    const dbIps = new Set(rows.map(r => r.ip));
    // 기본 화이트리스트 중 DB에 없는 항목도 표시
    for (const ip of WHITELIST_IPS) {
      if (!dbIps.has(ip) && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        rows.push({ id: null, ip, description: '환경변수 / 시스템 기본 IP', created_by: 'SYSTEM', created_at: new Date() });
      }
    }
    return rows;
  } catch (e) {
    return Array.from(WHITELIST_IPS).map(ip => ({ id: null, ip, description: '메모리 화이트리스트', created_by: 'SYSTEM', created_at: new Date() }));
  }
}

async function addIpToWhitelist(ip, description = '', adminId = 'ADMIN') {
  if (!ip) return { success: false, error: '유효한 IP 주소를 입력하세요.' };
  const normalized = cleanIp(String(ip).trim());
  if (!isValidIp(normalized)) {
    return { success: false, error: `올바른 IPv4/IPv6 형식이 아닙니다: ${ip}` };
  }

  WHITELIST_IPS.add(normalized);
  unbanIp(normalized);

  try {
    if (pool) {
      await pool.query(
        `INSERT INTO admin_ip_whitelist (ip, description, created_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE description = VALUES(description)`,
        [normalized, description ? String(description).trim() : '관리자 등록 화이트리스트', adminId]
      );
    }
    return { success: true, message: `✅ IP '${normalized}'가 화이트리스트에 성공적으로 등록되었습니다.`, ip: normalized };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function removeIpFromWhitelist(ip) {
  if (!ip) return { success: false, error: 'IP를 입력하세요.' };
  const normalized = cleanIp(String(ip).trim());
  
  if (normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost') {
    return { success: false, error: '로컬 루프백 IP는 화이트리스트에서 삭제할 수 없습니다.' };
  }

  WHITELIST_IPS.delete(normalized);

  try {
    if (pool) {
      await pool.query('DELETE FROM admin_ip_whitelist WHERE ip = ?', [normalized]);
    }
    return { success: true, message: `🗑️ IP '${normalized}'가 화이트리스트에서 제거되었습니다.` };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  createSecurityMiddleware,
  getSecurityStats,
  getBannedIpsList,
  getWhitelistedIpsList,
  addIpToWhitelist,
  removeIpFromWhitelist,
  loadWhitelistFromDb,
  banIp,
  unbanIp,
  isIpBanned,
  getClientIp,
  getCountryFromIp,
  WHITELIST_IPS,
};

