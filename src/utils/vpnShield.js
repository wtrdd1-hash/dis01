'use strict';

const axios = require('axios');
const { cleanIp, isLocalIp, isValidIp } = require('./geoIp');

// 🔒 VPN/프록시/호스팅 ISP 및 ORG 키워드 블랙리스트
const VPN_HOSTING_KEYWORDS = [
  'vpn', 'proxy', 'tor', 'exit-node', 'relay',
  'm247', 'datacamp', 'digitalocean', 'linode', 'hetzner',
  'vultr', 'choopa', 'hostinger', 'leaseweb', 'nordvpn', 'expressvpn',
  'surfshark', 'cyberghost', 'purevpn', 'ipvanish', 'privateinternetaccess',
  'mullvad', 'protonvpn', 'tunnelbear', 'windscribe', 'hidemyass',
  'contabo', 'scaleway', 'kamatera', 'cogent', 'packethub', 'frantech',
  'buyvm', 'serverius', 'poney telecom', 'dedipath', 'tzulo',
  'colocrossing', 'quadranet', 'wholesaleinternet', 'fdcservers',
  'alibaba', 'tencent', 'aws', 'amazon data services', 'amazon.com',
  'google cloud', 'googleusercontent', 'microsoft azure', 'azure',
  'oracle cloud', 'fastly', 'cloudflare' // Cloudflare는 자체 CDN IP가 클라이언트로 잡힐 때만 해당
];

// 메모리 캐시 (IP -> { isBlocked: boolean, reason: string, isp: string, expiresAt: number })
const vpnCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6시간 캐시
const MAX_CACHE_SIZE = 15000;

// 내부/화이트리스트 IP는 검사 제외
const WHITELIST_IPS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '51.222.206.109' // OVH VPS 서버 자체 IP
]);

// 🔑 VPN 차단 제외 경로 (OAuth 로그인, 인증 핵심 경로)
const VPN_SKIP_PATHS = new Set([
  '/auth/discord',
  '/auth/discord/callback',
  '/auth/guide',
  '/auth/logout',
  '/auth/local',
  '/auth/local/login',
  '/auth/local/register',
  '/healthz',
  '/robots.txt',
  '/sitemap.xml'
]);

/**
 * 🛡️ 요청 헤더에서 VPN/프록시 시그니처 탐지
 */
function checkProxyHeaders(req) {
  if (!req || !req.headers) return null;

  const headers = req.headers;

  // Cloudflare 익명/Tor 국가 코드
  const cfCountry = String(headers['cf-ipcountry'] || '').toUpperCase();
  if (cfCountry === 'T1') {
    return 'Tor 익명 네트워크 접속 감지 (CF-IPCountry: T1)';
  }
  if (cfCountry === 'XX') {
    return '익명 프록시 네트워크 감지 (CF-IPCountry: XX)';
  }

  // 전형적인 공개 프록시 헤더
  if (headers['x-proxyuser-ip'] || headers['x-real-ip-proxy']) {
    return '비인가 프록시 헤더 감지';
  }

  return null;
}

/**
 * 🔍 실시간 IP Intelligence 조회를 통한 VPN/프록시/호스팅 판별
 */
async function checkVpnOrProxy(rawIp, req = null) {
  const ip = cleanIp(rawIp);

  // 1. 로컬망, 사설 IP, 화이트리스트 제외
  if (!isValidIp(ip) || isLocalIp(ip) || WHITELIST_IPS.has(ip)) {
    return { isBlocked: false, reason: null };
  }

  // 2. 헤더 기반 1차 고속 검사
  const headerReason = checkProxyHeaders(req);
  if (headerReason) {
    return { isBlocked: true, reason: headerReason, ip };
  }

  // 3. 메모리 캐시 확인
  const now = Date.now();
  const cached = vpnCache.get(ip);
  if (cached && cached.expiresAt > now) {
    return {
      isBlocked: cached.isBlocked,
      reason: cached.reason,
      isp: cached.isp,
      ip
    };
  }

  // 4. IP-API Intelligence 비동기 조회 (타임아웃 1.2초로 사이트 지연 방지)
  try {
    const response = await axios.get(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,isp,org,as,hosting,proxy,mobile`,
      { timeout: 1200 }
    );

    const data = response.data;
    if (data && data.status === 'success') {
      const ispLower = String(data.isp || '').toLowerCase();
      const orgLower = String(data.org || '').toLowerCase();
      const asLower = String(data.as || '').toLowerCase();
      const isHosting = data.hosting === true;
      const isProxy = data.proxy === true;

      // 키워드 매칭
      let matchedKeyword = null;
      for (const kw of VPN_HOSTING_KEYWORDS) {
        if (ispLower.includes(kw) || orgLower.includes(kw) || asLower.includes(kw)) {
          matchedKeyword = kw;
          break;
        }
      }

      const isBlocked = isProxy || isHosting || Boolean(matchedKeyword);
      let reason = null;
      if (isProxy) reason = '공개 익명 프록시(Proxy) 탐지';
      else if (isHosting) reason = `데이터센터/호스팅 VPS IP 탐지 (${data.isp || data.org || 'Hosting'})`;
      else if (matchedKeyword) reason = `VPN/클라우드 우회 대역 탐지 (${matchedKeyword.toUpperCase()})`;

      // 캐시 정리 및 저장
      if (vpnCache.size > MAX_CACHE_SIZE) {
        const oldestKey = vpnCache.keys().next().value;
        vpnCache.delete(oldestKey);
      }

      vpnCache.set(ip, {
        isBlocked,
        reason,
        isp: data.isp || data.org || 'Unknown',
        expiresAt: now + CACHE_TTL_MS
      });

      return {
        isBlocked,
        reason,
        isp: data.isp || data.org,
        ip
      };
    }
  } catch (err) {
    // API 타임아웃 또는 실패 시 웹사이트 접속이 먹통되지 않도록 안전하게 통과 처리 (Fail-open)
  }

  return { isBlocked: false, reason: null, ip };
}

/**
 * 🛡️ VPN 차단 안내 HTML 렌더링
 */
function renderVpnBlockPage(ip, reason) {
  return `
    <!DOCTYPE html>
    <html lang="ko">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>접근 제한 안내 - VPN/프록시 차단</title>
      <style>
        body { background:#030712; color:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; box-sizing:border-box; }
        .card { background:#0f172a; border:1px solid rgba(239,68,68,0.4); border-radius:16px; padding:32px; max-width:480px; width:100%; text-align:center; box-shadow:0 20px 40px rgba(0,0,0,0.8); }
        .icon { font-size:3.5rem; margin-bottom:12px; }
        h1 { color:#f87171; font-size:1.45rem; margin:0 0 8px 0; font-weight:800; }
        p { color:#94a3b8; font-size:0.9rem; line-height:1.6; margin:0 0 20px 0; }
        .info-box { background:#030712; border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:16px; text-align:left; margin-bottom:24px; }
        .info-row { display:flex; justify-content:space-between; margin-bottom:8px; font-size:0.85rem; }
        .info-row:last-child { margin-bottom:0; }
        .info-lbl { color:#64748b; font-weight:600; }
        .info-val { color:#f1f5f9; font-weight:700; }
        .btn-reload { display:inline-block; background:#1e293b; border:1px solid rgba(255,255,255,0.15); color:#fff; padding:10px 24px; border-radius:8px; text-decoration:none; font-weight:700; font-size:0.9rem; cursor:pointer; transition:all 0.2s; }
        .btn-reload:hover { background:#334155; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">🛡️</div>
        <h1>VPN / 프록시 접속이 차단되었습니다</h1>
        <p>서비스 보안 유지 및 어뷰징 방지를 위해 VPN, 프록시, 가상 호스팅 서버를 통한 우회 접속이 엄격히 제한됩니다.</p>
        <div class="info-box">
          <div class="info-row">
            <span class="info-lbl">접속 IP</span>
            <span class="info-val" style="color:#fca5a5;">${ip}</span>
          </div>
          <div class="info-row">
            <span class="info-lbl">차단 사유</span>
            <span class="info-val" style="color:#facc15;">${reason || 'VPN / 익명 프록시 네트워크 탐지'}</span>
          </div>
          <div class="info-row">
            <span class="info-lbl">해결 방법</span>
            <span class="info-val" style="color:#38bdf8;">VPN/프록시 해제 후 일반 네트워크로 재접속</span>
          </div>
        </div>
        <button type="button" class="btn-reload" onclick="location.reload()">새로고침하여 다시 시도</button>
      </div>
    </body>
    </html>
  `;
}

module.exports = {
  checkVpnOrProxy,
  renderVpnBlockPage,
  WHITELIST_IPS
};
