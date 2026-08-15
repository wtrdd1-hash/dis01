const { pool } = require('../config/database');
const config = require('../config/config');

// ============================================================
// 🛡️ 웹 보안 시스템 (Web Security Shield)
// - 악성 경로 차단 (해킹 시도, 스캐너, 정보 탈취 등)
// - IP 기반 자동 차단 (의심 요청 누적 시 자동 밴)
// - 관리자 Discord DM 즉시 알림
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

  // 관리자 패널 스캔
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
  /\/(admin|administrator)(\.|\/|$)/i,
  /\/manager\//i,
  /actuator\//i,
  /\.aws\//i,
  /aws_access_key/i,
  /credentials/i,
];

// ── 🛡️ 화이트리스트 IP 목록 (절대 차단 불가) ──────────────
const WHITELIST_IPS = new Set([
  '14.49.239.61',
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  'localhost'
]);

// ── 🚦 Rate Limiter (IP별 요청 제한) ─────────────────────
const requestCounts = new Map(); // IP → { count, firstTime, blocked }
const RATE_LIMIT_WINDOW_MS  = 60 * 1000; // 1분 윈도우
const RATE_LIMIT_MAX         = 120;       // 1분에 120회 초과 시 경고
const RATE_LIMIT_HARD_BAN    = 300;       // 300회 초과 시 자동 IP 차단
const SUSPICIOUS_THRESHOLD   = 5;         // 악성 경로 5회 누적 시 자동 밴

// ── 🚫 메모리 IP 블랙리스트 (재시작 전까지 유지) ─────────
const memoryBanList = new Map(); // IP → { reason, bannedAt, expires }

// ── 📊 보안 이벤트 통계 ──────────────────────────────────
let securityStats = {
  totalBlocked: 0,
  totalBanned: 0,
  attacksByPath: {},
  attacksByIp: {},
  lastAlertTime: {},   // IP별 마지막 알림 시간 (중복 알림 방지)
};

// ── 헬퍼: 클라이언트 실제 IP ────────────────────────────
function getClientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ── 헬퍼: 관리자 여부 확인 ────────────────────────────────
function isUserAdmin(req) {
  try {
    if (req.cookies && req.cookies.discord_user) {
      const user = typeof req.cookies.discord_user === 'string' 
        ? JSON.parse(req.cookies.discord_user) 
        : req.cookies.discord_user;
      if (user && config.isAdmin(user.id)) return true;
    }
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

  // 같은 IP에 대해 5분 내 중복 알림 방지
  const now = Date.now();
  const lastAlert = securityStats.lastAlertTime[data.ip] || 0;
  if (type !== 'IP_BANNED' && now - lastAlert < 5 * 60 * 1000) return;
  securityStats.lastAlertTime[data.ip] = now;

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
    const urlPath = decodeURIComponent(req.path || req.url || '/').toLowerCase();
    const method  = req.method;
    const ua      = (req.headers['user-agent'] || '').substring(0, 200);
    const country = req.geoCountry || '';
    const countryName = req.geoCountryName || '';

    // ── 0. 화이트리스트 및 관리자 확인 (절대 차단 불가) ────
    if (isWhitelisted(ip, req)) {
      return next();
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

    // ── 2. Rate Limit 체크 ─────────────────────────────
    const now = Date.now();
    let rc = requestCounts.get(ip);
    if (!rc || now - rc.firstTime > RATE_LIMIT_WINDOW_MS) {
      rc = { count: 0, firstTime: now, suspicious: 0 };
      requestCounts.set(ip, rc);
    }
    rc.count++;

    if (rc.count > RATE_LIMIT_HARD_BAN) {
      // 하드 밴 (10분)
      memoryBanList.set(ip, { reason: '요청 폭탄 (DDoS 의심)', bannedAt: now, expires: now + 10 * 60 * 1000 });
      securityStats.totalBanned++;
      logSecurityEvent(ip, 'IP_BANNED', urlPath, `분당 ${rc.count}회 요청 (DDoS 의심)`, country, countryName);
      alertAdmins(client, 'IP_BANNED', { ip, country, countryName, method, path: urlPath, reason: `분당 ${rc.count}회 요청 → 10분 자동 차단`, count: rc.count });
      res.setHeader('X-Security', 'Rate-Banned');
      return res.status(429).json({ error: '너무 많은 요청입니다.' });
    }

    if (rc.count > RATE_LIMIT_MAX) {
      // 경고만 (차단은 아직 안 함)
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

    // ── 4. 의심스러운 User-Agent 감지 ─────────────────
    const suspiciousUA = [
      /sqlmap/i, /nikto/i, /nmap/i, /masscan/i, /zgrab/i,
      /dirbuster/i, /gobuster/i, /wfuzz/i, /hydra/i,
      /python-requests\/2\.[0-9]\./i,
      /curl\/[0-9]/i,
      /go-http-client/i,
    ];
    for (const uaPattern of suspiciousUA) {
      if (uaPattern.test(ua)) {
        rc.suspicious = (rc.suspicious || 0) + 2;
        logSecurityEvent(ip, 'SUSPICIOUS_UA', urlPath, `의심스러운 UA: ${ua}`, country, countryName);
        if (rc.suspicious >= SUSPICIOUS_THRESHOLD) {
          memoryBanList.set(ip, { reason: `의심 UA: ${ua}`, bannedAt: now, expires: now + 30 * 60 * 1000 });
          securityStats.totalBanned++;
          alertAdmins(client, 'IP_BANNED', { ip, country, countryName, method, path: urlPath, reason: `의심 스캐너 감지 → 30분 자동 차단 (UA: ${ua.substring(0,50)})`, count: rc.suspicious });
          return res.status(403).end();
        }
        break;
      }
    }

    // ── 5. 보안 헤더 삽입 ──────────────────────────────
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

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
        bannedAt: new Date(data.bannedAt).toLocaleString('ko-KR'),
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
        bannedAt: new Date(data.bannedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
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
  const cleanIp = ip.trim();
  if (WHITELIST_IPS.has(cleanIp)) {
    return { success: false, message: `⚠️ '${cleanIp}'는 화이트리스트 보호 IP이므로 차단할 수 없습니다.` };
  }
  const now = Date.now();
  memoryBanList.set(cleanIp, { reason, bannedAt: now, expires: now + durationMinutes * 60 * 1000 });
  securityStats.totalBanned++;
  return { success: true, message: `✅ IP '${cleanIp}'가 ${durationMinutes}분 동안 성공적으로 차단되었습니다.` };
}

function unbanIp(ip) {
  if (!ip) return false;
  const cleanIp = ip.trim();
  const wasBanned = memoryBanList.delete(cleanIp);
  requestCounts.delete(cleanIp);
  return wasBanned;
}

function isIpBanned(ip) {
  if (!ip) return false;
  const cleanIp = ip.trim();
  const ban = memoryBanList.get(cleanIp);
  if (!ban) return false;
  if (ban.expires < Date.now()) { memoryBanList.delete(cleanIp); return false; }
  return true;
}

module.exports = {
  createSecurityMiddleware,
  getSecurityStats,
  getBannedIpsList,
  banIp,
  unbanIp,
  isIpBanned,
  WHITELIST_IPS,
};
