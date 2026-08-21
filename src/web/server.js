const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const config = require('../config/config');
const { pool, getOrCreateUser } = require('../config/database');
const { formatMoney, formatMoneyCompact, formatPercent, formatNumber, formatKstDateTime } = require('../utils/formatters');
const { getCurrentMarketRegime, getLastNews, getRecentNewsFeed } = require('../utils/stockEngine');
const { logWebAccess, logAdminAction } = require('../utils/logger');
const { createSecurityMiddleware, getSecurityStats, getBannedIpsList } = require('./security');
const { getFlagEmoji, lookupIp } = require('../utils/geoIp');
const { createChatRoutes } = require('./routes/chatRoutes');
const { createGameRoutes } = require('./routes/gameRoutes');
const { createEconomyRoutes } = require('./routes/economyRoutes');
const { createStockRoutes } = require('./routes/stockRoutes');
const { createAdminRoutes } = require('./routes/adminRoutes');
const { createAdminManagementRoutes } = require('./routes/adminManagementRoutes');
const { createCasinoLoopRoutes } = require('./routes/casinoLoopRoutes');
const { createBusinessRoutes } = require('./routes/businessRoutes');
const { createMineRoutes } = require('./routes/mineRoutes');
const { getAutoRefreshClient, getAppVersion, getAppVersionLabel } = require('./autoRefreshPatch');
const { registerHealthz } = require('./healthz');
const { attachLiveSyncSocket, startLiveSyncGc, getCacheStats } = require('../utils/liveSync');
const { startTotoEngine } = require('../utils/totoEngine');
const { attachCrashEngine } = require('../utils/crashEngine');
const session = require('./session');
const { createLocalAuthRoutes } = require('./localAuth');
const { createAuthRoutes, getDynamicRedirectUri } = require('./authRoutes');
const { createAdminPageRoutes } = require('./adminPageRoutes');
const { renderPrivacyPolicy, renderTermsOfService, renderOAuthGuide } = require('./staticPages');
const { BANK, LOAN, CLICKER, NET_WORTH_SQL } = require('../utils/economyBalance');
const { amountToUnits, mulPriceAmount } = require('../utils/moneyScale');
const { safeBigInt } = require('../utils/moneyValue');
const { checkUserBanStatus } = require('../utils/userBanEngine');
const { wherePublicPlayer, isEconomyPlayerId } = require('../utils/economyCohort');
const { publicTaxState, getTaxOverview } = require('../utils/taxEngine');
const taxEngine = require('../utils/taxEngine');
async function getPublicTaxViewSafe(userId) {
  if (typeof taxEngine.getPublicTaxView === 'function') {
    return taxEngine.getPublicTaxView(userId);
  }
  return publicTaxState(userId);
}
const { cssTag, jsTag, attachAssetLocals } = require('./assetUrl');
const { renderHelpPopupHtml } = require('./helpPopupHtml');
const { createHelpRoutes } = require('./routes/helpRoutes');
const {
  sanitizeInquiryCategory,
  safeImageUrl,
  safeAvatarUrl,
  parseInquiryImage
} = require('../utils/sanitize');
const {
  likeContains,
  clampInt,
  safeJsonForHtml,
  createKeyedRateLimiter
} = require('./httpSafe');

// 📁 문의 첨부 이미지 업로드 저장 디렉토리
const UPLOAD_DIR = path.join(__dirname, '../../uploads/inquiries');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
const inquiryCooldown = new Map();

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsStr(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r/g, '')
    .replace(/\n/g, '')
    .replace(/</g, '\\x3c')
    .replace(/>/g, '\\x3e');
}

function appearanceBootScript() {
  return `<script>(function(){try{var g=function(k,d){try{return localStorage.getItem(k)||d;}catch(e){return d;}};var t=g('wtrdd-theme','system');var d=g('wtrdd-density','cozy');var l=g('wtrdd-layout','default');var tk=g('wtrdd-ticker','on');var fc=g('wtrdd-float-chat','on');var h=document.documentElement;h.setAttribute('data-theme-pref',t);h.setAttribute('data-density',d);h.setAttribute('data-layout',l);h.setAttribute('data-ticker',tk);h.setAttribute('data-float-chat',fc);var r=t;if(t==='system')r=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches)?'light':'dark';h.setAttribute('data-theme',r);h.style.colorScheme=(r==='light'||r==='market')?'light':'dark';}catch(e){}})();</script>`;
}

function appearanceHeadLinks() {
  return cssTag('css/themes.css');
}

function appearanceButtonHtml() {
  return `<button type="button" class="btn-appearance" id="btn-appearance" aria-label="모양" title="테마와 인터페이스" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 18V4a8 8 0 010 16z"/></svg></button>`;
}

function appearanceClientScript() {
  return jsTag('js/theme.js');
}

function safeUploadUrl(url) {
  return safeImageUrl(url);
}

// 스파크라인 SVG 미니 차트 생성 헬퍼
function generateSparklineSvg(prices, isUp) {
  if (!prices || prices.length < 2) {
    return `<svg width="72" height="24" viewBox="0 0 72 24" class="sparkline-svg"><line x1="4" y1="12" x2="68" y2="12" stroke="${isUp ? '#c84a31' : '#1261c4'}" stroke-width="2" stroke-dasharray="3,3"/></svg>`;
  }
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const width = 72;
  const height = 24;
  const padding = 3;

  const points = prices.map((p, i) => {
    const x = padding + (i / (prices.length - 1)) * (width - padding * 2);
    const y = height - padding - ((p - min) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const strokeColor = isUp ? '#c84a31' : '#1261c4';
  const fillColor = isUp ? 'rgba(200, 74, 49, 0.12)' : 'rgba(18, 97, 196, 0.12)';

  const firstX = padding;
  const lastX = width - padding;
  const areaPoints = `${firstX},${height} ${points} ${lastX},${height}`;

  return `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="sparkline-svg">
      <polygon points="${areaPoints}" fill="${fillColor}" />
      <polyline points="${points}" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `;
}

function startWebServer(client) {
  const app = express();
  registerHealthz(app, pool);
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: ['https://easy-scraping.com', 'http://localhost:8080', 'http://127.0.0.1:8080'],
      methods: ['GET', 'POST'],
      credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6,
    perMessageDeflate: { threshold: 1024 },
    httpCompression: true,
    allowEIO3: false,
    upgradeTimeout: 10000,
    transports: ['websocket', 'polling']
  });
  global.__io = io;
  if (client) global.__discordClient = client;
  io.use(async (socket, next) => {
    const socketUser = session.parseSessionFromCookieHeader(socket?.handshake?.headers?.cookie || '');
    if (!socketUser || !socketUser.id) return next();
    try {
      const banInfo = await checkUserBanStatus(socketUser.id, { failClosed: true });
      if (banInfo.isBanned) return next(new Error('ACCOUNT_BANNED'));
      return next();
    } catch (err) {
      return next(new Error(err.code === 'BAN_STATUS_UNAVAILABLE' ? 'AUTH_CHECK_UNAVAILABLE' : 'ACCOUNT_BANNED'));
    }
  });
  attachLiveSyncSocket(io);
  startLiveSyncGc();
  attachCrashEngine(io);
  startTotoEngine();
  try {
    const balancer = require('../utils/economyBalancer');
    if (typeof balancer.loadDynamicSettingsFromDb === 'function') {
      balancer.loadDynamicSettingsFromDb().catch(() => {});
    }
  } catch (e) {}

  // 📡 Socket.IO 실시간 양방향 통신 핸들러 (실시간 주가 갱신 및 유저 자산 동기화)
  io.on('connection', async (socket) => {
    // 1. 접속 시 최신 주가 및 시장 국면 스냅샷 전송
    try {
      const [stocks] = await pool.query('SELECT * FROM stocks');
      const regime = getCurrentMarketRegime();
      const news = getLastNews();
      socket.emit('app:version', { version: getAppVersion(), label: getAppVersionLabel() });
      socket.emit('market:snapshot', {
        stocks: stocks.map(s => ({
          stock_id: s.stock_id,
          name: s.name,
          price: Number(s.price),
          prev_price: Number(s.prev_price || s.price),
          high_24h: Number(s.high_24h || s.price),
          low_24h: Number(s.low_24h || s.price),
          volume_24h: Number(s.volume_24h || 0),
          volatility: Number(s.volatility || 0.04)
        })),
        regime,
        news,
        timestamp: Date.now()
      });
    } catch (e) {}

    socket.data.lastMarketRefresh = 0;
    socket.on('market:refresh', async (payload, callback) => {
      const now = Date.now();
      if (now - (socket.data.lastMarketRefresh || 0) < 2000) {
        if (typeof callback === 'function') callback({ success: false, error: '새로고침이 너무 빠릅니다.' });
        return;
      }
      socket.data.lastMarketRefresh = now;
      try {
        const [stocks] = await pool.query('SELECT * FROM stocks');
        const regime = getCurrentMarketRegime();
        const news = getLastNews();
        const data = {
          stocks: stocks.map(s => ({
            stock_id: s.stock_id,
            name: s.name,
            price: Number(s.price),
            prev_price: Number(s.prev_price || s.price),
            high_24h: Number(s.high_24h || s.price),
            low_24h: Number(s.low_24h || s.price),
            volume_24h: Number(s.volume_24h || 0),
            volatility: Number(s.volatility || 0.04)
          })),
          regime,
          news,
          timestamp: Date.now()
        };
        socket.emit('market:update', data);
        if (typeof callback === 'function') callback({ success: true, data });
      } catch (e) {
        if (typeof callback === 'function') callback({ success: false, error: '시세를 불러오지 못했습니다.' });
      }
    });
  });

  const allowOauthAttempt = createKeyedRateLimiter({ windowMs: 10 * 60 * 1000, max: 20 });
  const allowInquiryHourly = createKeyedRateLimiter({ windowMs: 60 * 60 * 1000, max: 8 });

  const PORT = config.port || 8080;

  // 🚀 서버 성능 및 보안 최적화
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // 🎨 EJS 템플릿 엔진 설정
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');
  app.use(attachAssetLocals);

  // 🛠️ EJS 템플릿 전역 헬퍼 함수 등록
  app.locals.formatMoney = formatMoney;
  app.locals.formatMoneyCompact = formatMoneyCompact;
  app.locals.formatKstDateTime = formatKstDateTime;
  app.locals.escapeHtml = escapeHtml;
  app.locals.escapeJsStr = escapeJsStr;
  app.locals.safeBigInt = safeBigInt;

  app.use(cookieParser(session.getCookieSecret()));
  app.use(session.requireSameOrigin);
  app.use(createSecurityMiddleware(client));
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/api/support/inquiry' && !session.getSessionUser(req)) {
      return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });
    }
    const limit = req.path === '/api/support/inquiry' ? '3mb' : '256kb';
    return express.json({ limit })(req, res, next);
  });
  app.use(express.urlencoded({ extended: true, limit: '256kb' }));

  // ⚡ 정적 자원 캐싱 최적화 (7일 브라우저 캐시) — 이미지만 서빙
  app.use('/uploads', (req, res, next) => {
    const ext = path.extname(String(req.path || '')).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) return res.status(404).end();
    next();
  }, express.static(path.join(__dirname, '../../uploads'), {
    maxAge: '7d',
    index: false,
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.png') res.setHeader('Content-Type', 'image/png');
      else if (ext === '.jpg' || ext === '.jpeg') res.setHeader('Content-Type', 'image/jpeg');
      else res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
  }));
  if (fs.existsSync(path.join(__dirname, 'public'))) {
    app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));
  }


  // 파비콘 라우트 - 브라우저 기본 /favicon.ico 요청 처리
  const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1a73e8"/>
        <stop offset="100%" stop-color="#0d47a1"/>
      </linearGradient>
    </defs>
    <circle cx="50" cy="50" r="48" fill="url(#bg)"/>
    <circle cx="50" cy="50" r="48" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2"/>
    <text x="50" y="67" font-family="Arial,sans-serif" font-size="52" font-weight="bold"
          fill="white" text-anchor="middle">✦</text>
  </svg>`;

  app.get('/favicon.ico', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(FAVICON_SVG);
  });

  app.get('/favicon.svg', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(FAVICON_SVG);
  });

  // 🔍 구글 서치 콘솔 & 검색엔진 크롤링 최적화 (robots.txt)
  app.get('/robots.txt', (req, res) => {
    const baseUrl = getDynamicBaseUrl(req);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send([
      'User-agent: *',
      'Allow: /',
      'Allow: /terms',
      'Allow: /privacy',
      'Disallow: /admin/',
      'Disallow: /api/admin/',
      'Disallow: /auth/',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`
    ].join('\n') + '\n');
  });

  function escapeXml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // 🗺️ 구글 검색엔진용 동적 XML 사이트맵 (sitemap.xml)
  app.get('/sitemap.xml', async (req, res) => {
    const baseUrl = getDynamicBaseUrl(req);
    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    let stocks = [];
    try {
      stocks = await getCachedMarketStocks();
    } catch (e) {}

    let stockUrls = '';
    if (stocks && stocks.length) {
      stockUrls = stocks.map(s => `
  <url>
    <loc>${baseUrl}/#stock-${escapeXml(s.stock_id)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>always</changefreq>
    <priority>0.8</priority>
  </url>`).join('');
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/terms</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>${baseUrl}/privacy</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.5</priority>
  </url>${stockUrls}
</urlset>`;

    res.send(xml);
  });

  // 📡 구글 서치 콘솔 및 RSS 리더용 자동 생성 RSS 2.0 피드 (/rss, /rss.xml, /feed)
  const handleRssFeed = async (req, res) => {
    const baseUrl = getDynamicBaseUrl(req);
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800');

    let newsList = [];
    let stocks = [];
    try {
      newsList = await getRecentNewsFeed(20);
      stocks = await getCachedMarketStocks();
    } catch (e) {}

    const buildDate = new Date().toUTCString();

    const items = [];

    // 1. 최신 증시 뉴스 아이템
    for (const n of newsList) {
      const pubDate = n.created_at ? new Date(n.created_at).toUTCString() : buildDate;
      const title = n.title || '월덕 가상 증시 속보';
      const desc = n.content || '월덕 실시간 가상 주식 및 경제 변동 소식입니다.';
      const link = `${baseUrl}/#tab-news`;
      const guid = `${baseUrl}/news/${n.id || Date.now()}`;

      items.push(`
    <item>
      <title><![CDATA[${title}]]></title>
      <link>${link}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[${desc}]]></description>
      <category><![CDATA[${n.event_type || '증시공시'}]]></category>
    </item>`);
    }

    // 2. 주요 상장 주식 종목 시황 아이템
    for (const s of (stocks || []).slice(0, 10)) {
      items.push(`
    <item>
      <title><![CDATA[[종목] ${s.name} (${s.stock_id}) 실시간 시세 및 거래 정보]]></title>
      <link>${baseUrl}/#stock-${escapeXml(s.stock_id)}</link>
      <guid isPermaLink="false">${baseUrl}/stocks/${s.stock_id}</guid>
      <pubDate>${buildDate}</pubDate>
      <description><![CDATA[${s.name} (${s.stock_id}) - 현재가: ${Number(s.price).toLocaleString()}원 (${s.rate >= 0 ? '+' : ''}${s.rate.toFixed(2)}%). 실시간 매수 및 매도 주문이 가능합니다.]]></description>
      <category><![CDATA[가상주식]]></category>
    </item>`);
    }

    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>월덕 (WTRD) - 실시간 가상 경제 &amp; 증시 피드</title>
    <link>${baseUrl}/</link>
    <description>디스코드 최대 규모의 실시간 가상 경제, 18개 주식 종목 시세, 배당금 투자, 국고 기본소득 피드</description>
    <language>ko-KR</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <atom:link href="${baseUrl}/rss" rel="self" type="application/rss+xml" />
    ${items.join('\n')}
  </channel>
</rss>`;

    res.send(rssXml);
  };

  app.get('/rss', handleRssFeed);
  app.get('/rss.xml', handleRssFeed);
  app.get('/feed', handleRssFeed);

  // 🛡️ 구글 서치 콘솔 소유권 확인용 HTML 파일 자동 응답 (URL 접두사 인증)
  app.get(/^\/google([a-zA-Z0-9_-]+)\.html$/, (req, res) => {
    const code = req.params[0] || '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`google-site-verification: google${code}.html`);
  });

  function getDynamicBaseUrl(req) {
    return session.resolvePublicBaseUrl(req);
  }

  function getDynamicRedirectUri(req) {
    if (config.discord.redirectUri && !config.discord.redirectUri.includes('localhost')) {
      return config.discord.redirectUri;
    }
    return `${getDynamicBaseUrl(req)}/auth/discord/callback`;
  }

  const getSessionUser = session.getSessionUser;

  // 서명 쿠키가 남아 있어도 차단 상태를 매 요청마다(5초 캐시) 확인한다.
  app.use(async (req, res, next) => {
    if (req.path === '/auth/logout') return next();
    const currentUser = session.getPlayUser(req);
    if (!currentUser || !currentUser.id) return next();

    try {
      const banInfo = await checkUserBanStatus(currentUser.id, { failClosed: true });
      if (!banInfo.isBanned) return next();

      session.clearSessionCookie(res, req);
      const payload = {
        success: false,
        error: '계정 이용이 제한되었습니다.',
        reason: banInfo.reason,
        permanent: !!banInfo.isPermanent,
        remainingText: banInfo.remainingText || null
      };
      if (req.path.startsWith('/api/') || req.accepts(['json', 'html']) === 'json') {
        return res.status(403).json(payload);
      }
      return res.status(403).send(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>이용 제한</title><body><main><h1>계정 이용이 제한되었습니다.</h1><p>${escapeHtml(banInfo.reason || '')}</p><a href="/auth/logout">로그아웃</a></main></body></html>`);
    } catch (err) {
      console.error('[user-ban] request guard failed:', err);
      return res.status(503).json({ success: false, error: '사용자 이용 가능 상태를 확인하지 못했습니다.' });
    }
  });

  // 고빈도/정적 요청은 접속 로그에서 제외해 DB 부하를 줄인다.
  app.use((req, res, next) => {
    if (session.shouldSkipAccessLog(req)) return next();
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const currentUser = getSessionUser(req);
      logWebAccess(req, res, duration, currentUser);
    });
    next();
  });

  // 📡 SSE 실시간 접속자 클라이언트 Set
  const sseClients = new Set();

  // 3초 TTL 메모리 캐시
  let marketCache = { data: null, timestamp: 0 };
  let leaderboardCache = { data: null, timestamp: 0 };
  const CACHE_TTL_MS = 2500;

  // stockEngine에서 주가 갱신 후 캐시 즉시 무효화
  global.__invalidateMarketCache = () => { marketCache.timestamp = 0; };

  async function getCachedMarketStocks() {
    const now = Date.now();
    if (marketCache.data && (now - marketCache.timestamp < CACHE_TTL_MS)) {
      return marketCache.data;
    }
    const [stocks] = await pool.query('SELECT * FROM stocks ORDER BY price DESC');
    
    let historyRows = [];
    try {
      const [hRows] = await pool.query(`
        SELECT stock_id, price 
        FROM (
          SELECT stock_id, price, id,
                 ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY id DESC) as rn
          FROM stock_history
        ) t
        WHERE t.rn <= 25
        ORDER BY stock_id, id ASC
      `);
      historyRows = hRows;
    } catch (e) {}

    const historyMap = {};
    for (const h of historyRows) {
      if (!historyMap[h.stock_id]) historyMap[h.stock_id] = [];
      historyMap[h.stock_id].push(Number(h.price));
    }

    const enhancedStocks = stocks.map(s => {
      const price = BigInt(s.price);
      const prevPrice = BigInt(s.prev_price);
      const diff = price - prevPrice;
      const rate = prevPrice > 0n ? (Number(diff) / Number(prevPrice)) * 100 : 0;
      const hist = historyMap[s.stock_id] || [Number(prevPrice), Number(price)];
      if (hist.length === 1) hist.unshift(Number(prevPrice));
      return {
        ...s,
        rate,
        diff: diff.toString(),
        isUp: rate >= 0,
        history: hist
      };
    });

    marketCache = { data: enhancedStocks, timestamp: now };
    return enhancedStocks;
  }

  async function getCachedLeaderboard() {
    const now = Date.now();
    if (leaderboardCache.data && (now - leaderboardCache.timestamp < CACHE_TTL_MS)) {
      return leaderboardCache.data;
    }
    const filter = wherePublicPlayer('u.discord_id');
    const [rows] = await pool.query(`
      SELECT 
        u.discord_id, 
        u.username,
        u.avatar,
        u.cash,
        u.bank,
        ${NET_WORTH_SQL} AS net
      FROM users u
      LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
      LEFT JOIN stocks s ON us.stock_id = s.stock_id
      WHERE ${filter.sql}
      GROUP BY u.discord_id, u.username, u.avatar, u.cash, u.bank
      ORDER BY net DESC
      LIMIT 10
    `, filter.params);
    leaderboardCache = { data: rows, timestamp: now };
    return rows;
  }

  app.get('/api/version', (req, res) => {
    res.json({
      success: true,
      version: getAppVersion(),
      label: getAppVersionLabel()
    });
  });

  // ========================================  // 1. 현재 로그인 유저 상세 정보 API
  app.get('/api/user/me', async (req, res) => {
    const discordUser = getSessionUser(req);
    const playUser = discordUser || session.getLocalUser(req);
    if (!playUser) return res.json({ success: false, loggedIn: false });
    if (discordUser) session.touchSessionCookie(req, res, discordUser);
    else session.touchLocalCookie(req, res, playUser);

    try {
      let userData;
      if (discordUser) {
        userData = await getOrCreateUser(playUser.id, playUser.username, playUser.avatar || null);
      } else {
        const [localRows] = await pool.query('SELECT * FROM users WHERE discord_id = ?', [playUser.id]);
        userData = localRows[0] || {
          username: playUser.username,
          avatar: '',
          cash: config.initialBalance,
          bank: 0,
          clicker_level: 1,
          auto_miner_level: 0,
          total_clicks: 0,
          daily_streak: 0,
          last_daily: null
        };
      }

      const [userStocks] = await pool.query(`
        SELECT us.stock_id, us.amount, us.total_spent, s.name, s.price
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.user_id = ? AND us.amount > 0
      `, [playUser.id]);

      let stockVal = 0n;
      const formattedStocks = discordUser ? userStocks.map(us => {
        const amountText = String(us.amount || '0');
        const curPrice = safeBigInt(us.price);
        const spent = safeBigInt(us.total_spent);
        const evalVal = mulPriceAmount(curPrice, amountText);
        stockVal += evalVal;
        return {
          stock_id: us.stock_id,
          name: us.name,
          amount: amountText,
          price: curPrice.toString(),
          spent: spent.toString(),
          evalVal: evalVal.toString(),
          profit: (evalVal - spent).toString()
        };
      }) : [];

      const cash = safeBigInt(userData.cash);
      const bank = safeBigInt(userData.bank);
      const netWorth = cash + bank + stockVal;

      const now = new Date();
      const lastDaily = userData.last_daily ? new Date(userData.last_daily) : null;
      const canDaily = !lastDaily || (now.getTime() - lastDaily.getTime() >= 24 * 60 * 60 * 1000);
      const canSubsidy = netWorth < 50000n;

      res.json({
        success: true,
        loggedIn: true,
        discord: !!discordUser,
        local: !discordUser,
        guest: false,
        user: {
          id: playUser.id,
          username: userData.username || playUser.username,
          avatar: userData.avatar || playUser.avatar,
          cash: cash.toString(),
          bank: bank.toString(),
          stockVal: stockVal.toString(),
          netWorth: netWorth.toString(),
          clicker_level: userData.clicker_level || 1,
          auto_miner_level: userData.auto_miner_level || 0,
          total_clicks: Number(userData.total_clicks || 0),
          daily_streak: userData.daily_streak || 0,
          canDaily,
          canSubsidy,
          stocks: formattedStocks,
          isAdmin: !!(discordUser && config.isAdmin(discordUser.id)),
          loan: await (async () => {
            try { return await require('../utils/loanEngine').getPublicLoanView(playUser.id); }
            catch (e) { return { hasLoan: false, eligible: false, maxBorrow: '0' }; }
          })()
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  // ── 📦 분리된 모듈형 라우터 마운트 ────────────────────────
  app.use('/api/chat', createChatRoutes(getSessionUser, sseClients));
  app.use('/api/game', createGameRoutes(session.getPlayUser));
  app.use('/api/casino', createCasinoLoopRoutes(session.getPlayUser));
  app.use('/api/mine', createMineRoutes(session.getPlayUser));
  app.use('/api/p2p', require('./routes/p2pRoutes')(session.getPlayUser));
  app.use('/api', createEconomyRoutes(session.getPlayUser));
  app.use('/api/business', createBusinessRoutes(session.getPlayUser));
  app.use('/api/stocks', createStockRoutes(session.getPlayUser));
  app.use('/api/stock', createStockRoutes(session.getPlayUser));
  app.use('/api', createStockRoutes(session.getPlayUser));
  app.use('/auth', createLocalAuthRoutes());
  app.use(createHelpRoutes(session.getPlayUser));

  // 🔌 모듈화된 라우터 마운트 (auth)
  createAuthRoutes({ getOrCreateUser, allowOauthAttempt })(app);

  // 12. 📰 실시간 증시 뉴스 & 공시 피드 API
  app.get('/api/market/news', async (req, res) => {
    const { category, search, limit } = req.query;
    try {
      let query = 'SELECT * FROM market_news_feed';
      const params = [];
      const conditions = [];

      if (category && category !== 'ALL') {
        conditions.push('event_type = ?');
        params.push(String(category).slice(0, 32));
      }
      const like = likeContains(search, 64);
      if (like) {
        conditions.push('(title LIKE ? OR content LIKE ? OR related_stock LIKE ? OR impact_sector LIKE ?)');
        params.push(like, like, like, like);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
      query += ' ORDER BY id DESC LIMIT ?';
      params.push(clampInt(limit, 30, 1, 50));

      const [rows] = await pool.query(query, params);
      res.json({ success: true, count: rows.length, news: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  // 13. ⚡ [통합 라이브 피드 & 모든 로그 실시간 스트림 API] (관리자 전용)
  app.get('/api/system/activity-feed', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자만 열람할 수 있는 시스템 로그입니다.' });
    }

    const { type = 'ALL', search = '', limit = 50 } = req.query;
    const maxLimit = Math.min(parseInt(limit, 10) || 50, 100);

    try {
      const feedItems = [];

      // 1. 주가 변동 틱 로그
      if (type === 'ALL' || type === 'STOCK_PRICE') {
        const [priceRows] = await pool.query('SELECT * FROM stock_price_logs ORDER BY id DESC LIMIT ?', [maxLimit]);
        for (const p of priceRows) {
          const isUp = Number(p.diff) >= 0;
          feedItems.push({
            id: `p_${p.id}`,
            rawId: p.id,
            type: 'STOCK_PRICE',
            badge: isUp ? '📈 주가 상승' : '📉 주가 하락',
            badgeClass: isUp ? 'badge-up' : 'badge-down',
            color: isUp ? '#34d399' : '#f87171',
            title: `[${p.stock_id}] ${p.stock_name} ${isUp ? '▲' : '▼'} ${isUp ? '+' : ''}${p.change_rate}%`,
            desc: `현재가: ${formatMoney(p.new_price)} (변동: ${isUp ? '+' : ''}${formatMoney(p.diff)}) · ${p.reason || p.regime}`,
            time: p.created_at,
            actor: '실시간 시장 엔진',
            data: { stock_id: p.stock_id, price: p.new_price, rate: p.change_rate }
          });
        }
      }

      // 2. 주식 매매 체결 로그
      if (type === 'ALL' || type === 'STOCK_TRADE') {
        const [tradeRows] = await pool.query('SELECT * FROM stock_transactions ORDER BY id DESC LIMIT ?', [maxLimit]);
        for (const t of tradeRows) {
          const isBuy = t.action === 'BUY';
          feedItems.push({
            id: `t_${t.id}`,
            rawId: t.id,
            type: 'STOCK_TRADE',
            badge: isBuy ? '🛒 매수 체결' : '💰 매도 체결',
            badgeClass: isBuy ? 'badge-buy' : 'badge-sell',
            color: isBuy ? '#38bdf8' : '#fb923c',
            title: `@${t.username} 님의 [${t.stock_name}] ${formatNumber(t.amount)}주 ${isBuy ? '매수' : '매도'}`,
            desc: `주당 단가: ${formatMoney(t.price)} · 총 체결금액: ${formatMoney(t.total_price)}`,
            time: t.created_at,
            actor: `@${t.username}`,
            data: { stock_id: t.stock_id, amount: t.amount, total: t.total_price }
          });
        }
      }

      // 3. 카지노 도박 로그
      if (type === 'ALL' || type === 'GAMBLE') {
        const [gambleRows] = await pool.query(`
          SELECT g.*, u.username 
          FROM gambling_logs g
          LEFT JOIN users u ON g.user_id = u.discord_id
          ORDER BY g.id DESC LIMIT ?
        `, [maxLimit]);
        for (const g of gambleRows) {
          const profit = safeBigInt(g.profit);
          const isWin = profit > 0n;
          feedItems.push({
            id: `g_${g.id}`,
            rawId: g.id,
            type: 'GAMBLE',
            badge: isWin ? '🎰 당첨/잭팟' : '💀 도박 실패',
            badgeClass: isWin ? 'badge-win' : 'badge-lose',
            color: isWin ? '#fbbf24' : '#9ca3af',
            title: `@${g.username || '유저'} 님의 [${g.game}] ${isWin ? '승리 및 보상' : '배팅 손실'}`,
            desc: `배팅: ${formatMoney(g.bet)} ➔ 당첨금: ${formatMoney(g.payout)} (손익: ${profit >= 0n ? '+' : ''}${formatMoney(profit)})`,
            time: g.created_at,
            actor: `@${g.username || '유저'}`,
            data: { game: g.game, bet: g.bet, profit: g.profit }
          });
        }
      }

      // 4. 경제 지원금 및 은행 로그
      if (type === 'ALL' || type === 'ECONOMY') {
        const [ecoRows] = await pool.query('SELECT * FROM economy_logs ORDER BY id DESC LIMIT ?', [maxLimit]);
        for (const e of ecoRows) {
          feedItems.push({
            id: `e_${e.id}`,
            rawId: e.id,
            type: 'ECONOMY',
            badge: '🎁 경제/은행',
            badgeClass: 'badge-eco',
            color: '#a855f7',
            title: `@${e.username} - ${e.description}`,
            desc: `금액: ${formatMoney(e.amount)} (이전 잔고: ${formatMoney(e.balance_before)} ➔ 갱신 잔고: ${formatMoney(e.balance_after)})`,
            time: e.created_at,
            actor: `@${e.username}`,
            data: { type: e.type, amount: e.amount }
          });
        }
      }

      // 5. 실시간 증시 공시 뉴스
      if (type === 'ALL' || type === 'NEWS') {
        const [newsRows] = await pool.query('SELECT * FROM market_news_feed ORDER BY id DESC LIMIT ?', [maxLimit]);
        for (const n of newsRows) {
          const isBull = n.sentiment === 'BULL';
          feedItems.push({
            id: `n_${n.id}`,
            rawId: n.id,
            type: 'NEWS',
            badge: isBull ? '🔥 호재 공시' : '⚠️ 악재 공시',
            badgeClass: isBull ? 'badge-bull' : 'badge-bear',
            color: isBull ? '#34d399' : '#f87171',
            title: `[${n.event_type}] ${n.title}`,
            desc: `${n.content} (영향 섹터: ${n.impact_sector || '전체'})`,
            time: n.created_at,
            actor: '증시공시센터',
            data: { related_stock: n.related_stock }
          });
        }
      }

      // 최신 시간순 정렬
      feedItems.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

      // 검색 필터링
      let filtered = feedItems;
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(item => 
          item.title.toLowerCase().includes(q) || 
          item.desc.toLowerCase().includes(q) || 
          item.actor.toLowerCase().includes(q)
        );
      }

      res.json({
        success: true,
        count: filtered.length,
        items: filtered.slice(0, maxLimit)
      });
    } catch (err) {
      res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });


  // API - 관리자 전용 JSON 로그들
  app.get('/api/admin/logs/gambling', async (req, res) => {
    const currentUser = getSessionUser(req);
    if (!currentUser || !config.isAdmin(currentUser.id)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    try {
      const [rows] = await pool.query(`SELECT g.*, u.username FROM gambling_logs g LEFT JOIN users u ON g.user_id = u.discord_id ORDER BY g.id DESC LIMIT 100`);
      res.json({ success: true, count: rows.length, logs: rows });
    } catch (err) { res.status(500).json({ error: '처리 중 오류가 발생했습니다.' }); }
  });

  app.get('/api/admin/logs/access', async (req, res) => {
    const currentUser = getSessionUser(req);
    if (!currentUser || !config.isAdmin(currentUser.id)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    try {
      const [rows] = await pool.query('SELECT * FROM web_access_logs ORDER BY id DESC LIMIT 100');
      res.json({ success: true, count: rows.length, logs: rows });
    } catch (err) { res.status(500).json({ error: '처리 중 오류가 발생했습니다.' }); }
  });

  app.get('/api/admin/logs/commands', async (req, res) => {
    const currentUser = getSessionUser(req);
    if (!currentUser || !config.isAdmin(currentUser.id)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    try {
      const [rows] = await pool.query('SELECT * FROM command_logs ORDER BY id DESC LIMIT 100');
      res.json({ success: true, count: rows.length, logs: rows });
    } catch (err) { res.status(500).json({ error: '처리 중 오류가 발생했습니다.' }); }
  });

  // 📩 유저 1:1 고객센터 문의 접수 API (관리자 Discord DM 실시간 알림 발송)
  app.post('/api/support/inquiry', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { category, title, content, image } = req.body;
    const safeCategory = sanitizeInquiryCategory(category);
    const safeTitle = String(title || '').trim().slice(0, 100);
    const safeContent = String(content || '').trim().slice(0, 4000);
    if (!safeTitle || safeTitle.length < 2) {
      return res.status(400).json({ success: false, error: '문의 제목을 2글자 이상 입력해주세요.' });
    }
    if (!safeContent || safeContent.length < 5) {
      return res.status(400).json({ success: false, error: '문의 내용을 5글자 이상 상세히 입력해주세요.' });
    }

    const nowTs = Date.now();
    const lastInquiry = inquiryCooldown.get(session.id) || 0;
    if (nowTs - lastInquiry < 30 * 1000) {
      return res.status(429).json({ success: false, error: '문의를 너무 빠르게 보내고 있습니다. 잠시 후 다시 시도하세요.' });
    }
    if (!allowInquiryHourly(session.id)) {
      return res.status(429).json({ success: false, error: '문의 접수 한도를 초과했습니다. 잠시 후 다시 시도하세요.' });
    }

    try {
      const userData = await getOrCreateUser(session.id, session.username, session.avatar);
      const userCash = BigInt(userData.cash || 0);
      const userBank = BigInt(userData.bank || 0);

      let finalImageUrl = null;
      let localAttachmentPath = null;
      let localAttachmentFilename = null;

      if (image && typeof image === 'string') {
        const parsedImg = parseInquiryImage(image);
        if (!parsedImg) {
          return res.status(400).json({ success: false, error: '이미지는 PNG/JPEG만 가능하며 최대 1.5MB입니다. 외부 URL은 허용되지 않습니다.' });
        }
        const filename = `inquiry_${crypto.randomBytes(16).toString('hex')}.${parsedImg.ext}`;
        const uploadRoot = path.resolve(UPLOAD_DIR);
        const filePath = path.resolve(uploadRoot, filename);
        if (!filePath.startsWith(uploadRoot + path.sep)) {
          return res.status(400).json({ success: false, error: '이미지 저장 경로가 올바르지 않습니다.' });
        }
        fs.writeFileSync(filePath, parsedImg.buf);
        finalImageUrl = `/uploads/inquiries/${filename}`;
        localAttachmentPath = filePath;
        localAttachmentFilename = filename;
      }

      inquiryCooldown.set(session.id, nowTs);

      // 주식 평가액 계산
      let stockVal = 0n;
      try {
        const [holdings] = await pool.query(`
          SELECT h.amount, s.price 
          FROM user_stocks h
          JOIN stocks s ON h.stock_id = s.stock_id
          WHERE h.user_id = ?
        `, [session.id]);
        for (const h of holdings) {
          stockVal += mulPriceAmount(safeBigInt(h.price), h.amount);
        }
      } catch (e) {}

      const netWorth = userCash + userBank + stockVal;

      const [result] = await pool.query(`
        INSERT INTO inquiries (user_id, username, avatar, category, title, content, image_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING')
      `, [session.id, session.username, session.avatar, safeCategory, safeTitle, safeContent, finalImageUrl]);

      const ticketId = result.insertId;
      const publicImageUrl = finalImageUrl ? `${getDynamicBaseUrl(req)}${finalImageUrl}` : null;

      // 🔔 모든 봇 관리자에게 디스코드 DM으로 실시간 문의 알림 전송
      if (client && client.users) {
        for (const adminId of config.adminIds) {
          try {
            const adminUser = await client.users.fetch(adminId);
            if (adminUser) {
              const dmEmbed = new EmbedBuilder()
                .setTitle(`📩 [새 1:1 고객센터 문의 접수] Ticket #${ticketId}`)
                .setColor(0xf59e0b)
                .setThumbnail(safeAvatarUrl(session.id, session.avatar))
                .setDescription(
                  `**작성 유저:** <@${session.id}> (\`${session.username}\` / ID: \`${session.id}\`)\n` +
                  `**문의 분류:** \`${safeCategory}\`\n` +
                  `**접수 일시:** <t:${Math.floor(Date.now() / 1000)}:F>`
                )
                .addFields(
                  { name: '📌 문의 제목', value: safeTitle, inline: false },
                  { name: '📝 상세 문의 내용', value: safeContent.length > 1000 ? safeContent.slice(0, 1000) + '...' : safeContent, inline: false },
                  { 
                    name: '💳 유저 자산 현황', 
                    value: `💵 현금: **${formatMoney(userCash)}** | 🏦 예금: **${formatMoney(userBank)}** | 💎 순자산: **${formatMoney(netWorth)}**`, 
                    inline: false 
                  }
                );

              if (publicImageUrl) {
                dmEmbed.setImage(publicImageUrl);
                dmEmbed.addFields({ name: '🖼️ 첨부 이미지/스크린샷', value: `[클릭하여 첨부 사진 원본 보기](${publicImageUrl})`, inline: false });
              }

              dmEmbed.addFields({
                name: '⚡ 빠른 관리자 답장 명령어',
                value: `\`/admin_reply 문의번호:${ticketId} 답변내용:답변할내용\`\n또는 웹 관리자 패널([easy-scraping.com/admin](https://easy-scraping.com/admin))에서 즉시 답장 가능`,
                inline: false
              });

              dmEmbed.setFooter({ text: `월덕 1:1 고객센터 관제 시스템 (Ticket #${ticketId})` });
              dmEmbed.setTimestamp();

              if (localAttachmentPath && fs.existsSync(localAttachmentPath)) {
                await adminUser.send({
                  embeds: [dmEmbed],
                  files: [new AttachmentBuilder(localAttachmentPath, { name: localAttachmentFilename })]
                });
              } else {
                await adminUser.send({ embeds: [dmEmbed] });
              }
            }
          } catch (dmErr) {
            console.warn(`[Inquiry DM] 관리자(${adminId}) DM 전송 실패:`, dmErr.message);
          }
        }
      }

      res.json({
        success: true,
        ticketId,
        message: `🎉 1:1 문의(Ticket #${ticketId})가 정상 접수되어 관리자에게 실시간 알림이 전송되었습니다!`
      });
    } catch (err) {
      console.error('Inquiry Submit Error:', err);
      res.status(500).json({ success: false, error: '문의 접수 중 오류가 발생했습니다.' });
    }
  });

  // 📋 내 1:1 문의 내역 및 답변 조회 API
  app.get('/api/support/my-inquiries', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const [rows] = await pool.query(`
        SELECT id, category, title, content, status, answer, answered_by, answered_at, created_at, image_url
        FROM inquiries
        WHERE user_id = ?
        ORDER BY id DESC LIMIT 50
      `, [session.id]);

      const inquiries = rows.map((row) => ({
        ...row,
        image_url: safeImageUrl(row.image_url)
      }));
      res.json({ success: true, count: inquiries.length, inquiries });
    } catch (err) {
      res.status(500).json({ success: false, error: '문의 내역을 불러오지 못했습니다.' });
    }
  });

  // 💬 [관리자] 1:1 문의 답변 등록 API (유저에게 Discord DM 알림 발송)
  app.post('/api/admin/inquiry/reply', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자 권한이 필요합니다.' });
    }

    const { ticketId, answer } = req.body;
    if (req.body.confirm !== true) {
      return res.status(400).json({ success: false, error: '확인 후 다시 실행하세요.' });
    }
    if (!ticketId || !answer || answer.trim().length === 0) {
      return res.status(400).json({ success: false, error: '문의 번호와 답변 내용을 입력해주세요.' });
    }

    try {
      const [tickets] = await pool.query('SELECT * FROM inquiries WHERE id = ?', [ticketId]);
      if (tickets.length === 0) {
        return res.status(404).json({ success: false, error: '해당 문의를 찾을 수 없습니다.' });
      }

      const ticket = tickets[0];
      await pool.query(`
        UPDATE inquiries
        SET status = 'ANSWERED', answer = ?, answered_by = ?, answered_at = NOW()
        WHERE id = ?
      `, [answer.trim(), session.username, ticketId]);

      // 유저에게 Discord DM 알림 전송 시도
      let dmNotified = false;
      if (client && client.users) {
        try {
          const targetUser = await client.users.fetch(ticket.user_id);
          if (targetUser) {
            const userDmEmbed = new EmbedBuilder()
              .setTitle(`📬 [1:1 고객센터 답변 도착] Ticket #${ticketId}`)
              .setColor(0x10b981)
              .setDescription(`안녕하세요, **${ticket.username}**님!\n접수하신 1:1 문의에 관리자 답변이 등록되었습니다.`)
              .addFields(
                { name: '📌 내 문의 제목', value: ticket.title, inline: false },
                { name: '💬 관리자 공식 답변', value: `\`\`\`\n${answer.trim()}\n\`\`\``, inline: false }
              )
              .setFooter({ text: `답변자: @${session.username} · 웹사이트 [내 프로필]에서도 언제든 확인 가능합니다.` })
              .setTimestamp();
            await targetUser.send({ embeds: [userDmEmbed] });
            dmNotified = true;
          }
        } catch (e) {
          console.warn(`[Inquiry DM] 유저(${ticket.user_id}) DM 알림 실패:`, e.message);
        }
      }

      logAdminAction(session.id, session.username, 'INQUIRY_REPLY_WEB', ticket.user_id, {
        ticketId,
        user: ticket.username,
        answer: answer.trim()
      });

      res.json({
        success: true,
        message: `Ticket #${ticketId} 답변 등록 완료! (유저 DM 알림: ${dmNotified ? '성공' : '실패/웹에서 확인 가능'})`
      });
    } catch (err) {
      res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  // 📋 [관리자] 전체 1:1 문의 목록 조회 API
  app.get('/api/admin/inquiries', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자 권한이 필요합니다.' });
    }

    try {
      const [rows] = await pool.query('SELECT * FROM inquiries ORDER BY id DESC LIMIT 100');
      const inquiries = rows.map((row) => ({
        ...row,
        image_url: safeImageUrl(row.image_url)
      }));
      res.json({ success: true, count: inquiries.length, inquiries });
    } catch (err) {
      res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  app.get('/api/market', async (req, res) => {
    try {
      const stocks = await getCachedMarketStocks();
      const regime = getCurrentMarketRegime();
      const news = getLastNews();
      const gainers = [...stocks].sort((a, b) => b.rate - a.rate);
      const upCount = stocks.filter(s => s.rate > 0).length;
      const downCount = stocks.filter(s => s.rate < 0).length;
      const flatCount = stocks.filter(s => s.rate === 0).length;
      const avgRate = stocks.reduce((acc, s) => acc + s.rate, 0) / (stocks.length || 1);

      res.json({
        success: true,
        stocks,
        gainers,
        marketSummary: { upCount, downCount, flatCount, avgRate: avgRate.toFixed(2), isMarketBull: avgRate >= 0 },
        regime,
        news
      });
    } catch (err) { res.status(500).json({ error: '처리 중 오류가 발생했습니다.' }); }
  });

  // ── 📡 SSE 실시간 스트림 (Server-Sent Events) ────────────
  // 주가 변동이 생길 때마다 연결된 모든 브라우저에 즉시 push
  // stockEngine 주가 갱신 후 여기를 호출하면 전체 broadcast
  global.__broadcastMarketUpdate = async function () {
    if (sseClients.size === 0) return;
    try {
      const stocks = await getCachedMarketStocks();
      const regime = getCurrentMarketRegime();
      const news   = getLastNews();
      const upCount   = stocks.filter(s => s.rate > 0).length;
      const downCount = stocks.filter(s => s.rate < 0).length;
      const avgRate   = stocks.reduce((acc, s) => acc + s.rate, 0) / (stocks.length || 1);

      const payload = JSON.stringify({
        type: 'MARKET_UPDATE',
        stocks,
        marketSummary: { upCount, downCount, avgRate: avgRate.toFixed(2), isMarketBull: avgRate >= 0 },
        regime,
        news,
        timestamp: Date.now(),
      });

      const dead = [];
      for (const client of sseClients) {
        try {
          client.write(`data: ${payload}\n\n`);
        } catch (e) {
          dead.push(client);
        }
      }
      dead.forEach(c => sseClients.delete(c));
    } catch (e) {}
  };

  // GET /api/stream  – 클라이언트가 이 URL을 구독하면 실시간 데이터 수신
  app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx proxy buffering 비활성화
    res.flushHeaders();

    // 연결 즉시 현재 시장 데이터 전송
    getCachedMarketStocks().then(stocks => {
      const regime  = getCurrentMarketRegime();
      const news    = getLastNews();
      const upCount = stocks.filter(s => s.rate > 0).length;
      const downCount = stocks.filter(s => s.rate < 0).length;
      const avgRate = stocks.reduce((acc, s) => acc + s.rate, 0) / (stocks.length || 1);
      const payload = JSON.stringify({
        type: 'MARKET_UPDATE',
        stocks, regime, news,
        marketSummary: { upCount, downCount, avgRate: avgRate.toFixed(2), isMarketBull: avgRate >= 0 },
        timestamp: Date.now(),
      });
      res.write(`data: ${payload}\n\n`);
    }).catch(() => {});

    // 30초마다 heartbeat (연결 유지)
    const heartbeat = setInterval(() => {
      try { res.write(`: heartbeat\n\n`); } catch (e) { clearInterval(heartbeat); }
    }, 30000);

    sseClients.add(res);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  // 💬 실시간 채팅 SSE 브로드캐스트 함수
  global.__broadcastChatMessage = (msgData) => {
    try {
      const payload = JSON.stringify({
        type: 'CHAT_MESSAGE',
        message: msgData,
        timestamp: Date.now()
      });
      const dead = [];
      for (const client of sseClients) {
        try {
          client.write(`data: ${payload}\n\n`);
        } catch (e) {
          dead.push(client);
        }
      }
      dead.forEach(c => sseClients.delete(c));
    } catch (e) {}
  };


  const AuthController = require('./controllers/AuthController');
  const PageController = require('./controllers/PageController');

  app.get('/auth/discord', AuthController.loginWithDiscord);
  app.get('/auth/discord/callback', AuthController.discordCallback);
  app.get(['/logout', '/auth/logout'], AuthController.logout);

  app.get(['/', '/home'], PageController.renderHome);
  app.get(['/plaza', '/metaverse', '/map', '/world'], PageController.renderPlaza);
  app.get(['/stocks', '/stock'], PageController.renderStocks);
  app.get(['/casino', '/gamble'], PageController.renderCasino);
  app.get(['/arcade', '/puzzle', '/game'], PageController.renderArcade);
  app.get(['/mining', '/mine', '/clicker'], PageController.renderMining);
  app.get(['/ranking', '/leaderboard'], PageController.renderRanking);
  app.get(['/shop', '/cosmetics', '/wardrobe', '/dressroom', '/prestige', '/workshop', '/duckhouse'], PageController.renderShop);

  app.get('/api/leaderboard', async (req, res) => {
    try {
      const rows = await getCachedLeaderboard();
      res.json({ leaderboard: rows });
    } catch (err) { res.status(500).json({ error: '처리 중 오류가 발생했습니다.' }); }
  });

  // 메인 웹사이트 대시보드 및 게임 허브
  app.get('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const stocks = await getCachedMarketStocks();
      const leaderboardRows = await getCachedLeaderboard();
      const regime = getCurrentMarketRegime();
      const news = getLastNews();
      const recentNewsList = await getRecentNewsFeed(15);

      const redirectUri = getDynamicRedirectUri(req);
      const clientId = config.discord.clientId;
      const hasOauthConfig = Boolean(clientId);

      const discordLoginUrl = hasOauthConfig ? '/auth/discord' : '/auth/guide';

      let currentUser = null;
      let userAssets = null;
      let isAdminUser = false;
      let userTurnsInfo = { turns: 50, maxTurns: 50 };
      let portfolioSectionHtml = '';
      let userHoldingsMap = {};

      currentUser = getSessionUser(req);
      const discordUser = currentUser;
      if (discordUser) {
        session.touchSessionCookie(req, res, discordUser);
        session.clearGuestCookie(res, req);
      }
      const localUser = discordUser ? null : session.getLocalUser(req);
      if (localUser) session.touchLocalCookie(req, res, localUser);
      const isLocalPlay = !!localUser;
      const isDiscordUser = !!discordUser;
      if (localUser) currentUser = localUser;
      const isGuestPlay = false;
      const playUser = currentUser;

      // 🦆 비로그인 방문자 (Guest) -> 즉시 대시보드 및 가상경제/메타버스 체험 가능하도록 게스트 세션 발급
      if (!playUser) {
        const guestId = 'guest_' + Math.random().toString(36).slice(2, 9);
        const guestUsername = '여행자덕_' + Math.floor(Math.random() * 900 + 100);
        const newLocal = { id: guestId, username: guestUsername, avatar: 'https://cdn.discordapp.com/embed/avatars/0.png' };
        try {
          session.setLocalUserCookie(res, req, newLocal);
        } catch (e) {}
        currentUser = newLocal;
      }

      const pageTax = await getPublicTaxViewSafe(discordUser && discordUser.id);
      let pageLoan = { hasLoan: false, eligible: false, maxBorrow: '0', debt: '0', locked: '0' };
      if (playUser) {
        try { pageLoan = await require('../utils/loanEngine').getPublicLoanView(playUser.id); } catch (e) {}
      }
      if (playUser) {
        try {
          isAdminUser = !!(discordUser && config.isAdmin(discordUser.id));
          let userData;
          if (discordUser) {
            userData = await getOrCreateUser(discordUser.id, discordUser.username, discordUser.avatar);
          } else {
            const [localRows] = await pool.query('SELECT * FROM users WHERE discord_id = ?', [playUser.id]);
            userData = localRows[0] || {
              cash: config.initialBalance,
              bank: 0,
              daily_streak: 0,
              clicker_level: 1,
              auto_miner_level: 0,
              total_clicks: 0
            };
          }

          const [stocksRows] = discordUser ? await pool.query(`
            SELECT us.amount, s.price
            FROM user_stocks us
            JOIN stocks s ON us.stock_id = s.stock_id
            WHERE us.user_id = ? AND us.amount > 0
          `, [discordUser.id]) : [[]];

          let stockVal = 0n;
          for (const item of stocksRows) {
            stockVal += mulPriceAmount(safeBigInt(item.price), item.amount);
          }

          const cash = safeBigInt(userData.cash);
          const bank = safeBigInt(userData.bank);
          const netWorth = cash + bank + stockVal;

          userAssets = {
            cash,
            bank,
            stockVal,
            netWorth,
            streak: userData.daily_streak || 0,
            clickerLevel: userData.clicker_level || 1,
            autoLevel: userData.auto_miner_level || 0,
            totalClicks: userData.total_clicks || 0
          };

          if (discordUser) {
          // 📊 내 보유 주식 포트폴리오 상세 분석
          const [portfolioRows] = await pool.query(`
            SELECT us.stock_id, us.amount, us.total_spent, s.name, s.price, s.prev_price, s.sector
            FROM user_stocks us
            JOIN stocks s ON us.stock_id = s.stock_id
            WHERE us.user_id = ? AND us.amount > 0
            ORDER BY (us.amount * s.price) DESC
          `, [discordUser.id]);

          for (const item of portfolioRows) {
            userHoldingsMap[item.stock_id] = Number(item.amount);
          }

          let portfolioItemsHtml = '';
          let totalPortfolioInvested = 0n;
          let totalPortfolioCurrent = 0n;

          for (const item of portfolioRows) {
            const amountNum = Number(item.amount);
            const spent = BigInt(item.total_spent || 0);
            const currentPrice = BigInt(item.price);
            const amountUnits = amountToUnits(item.amount);
            const val = mulPriceAmount(currentPrice, item.amount);
            const avg = amountUnits > 0n ? (spent * 10000n) / amountUnits : 0n;
            const profit = val - spent;
            const profitRate = spent > 0n ? ((Number(profit) / Number(spent)) * 100).toFixed(2) : '0.00';
            const isProfit = profit >= 0n;
            const userHolding = amountNum;
            const displayHolding = (amountNum % 1 === 0) ? amountNum.toLocaleString() : amountNum.toFixed(4);

            totalPortfolioInvested += spent;
            totalPortfolioCurrent += val;

            portfolioItemsHtml += `
              <div class="portfolio-item-card">
                <div class="portfolio-item-top">
                  <div>
                    <span class="stock-symbol">[${item.stock_id}] · ${item.sector || '성장주'}</span>
                    <h4 class="stock-name" onclick="openDetailModal('${escapeJsStr(item.stock_id)}')" style="cursor: pointer; font-size: 1.05rem; margin-top: 2px;">${escapeHtml(item.name)}</h4>
                  </div>
                  <span class="badge ${isProfit ? 'badge-up' : 'badge-down'}">${isProfit ? '▲ +' : '▼ '}${profitRate}%</span>
                </div>
                <div class="portfolio-grid-stats">
                  <div class="port-stat"><span>보유 수량</span><b>${displayHolding}주</b></div>
                  <div class="port-stat"><span>매수 평단가</span><b title="${formatMoney(avg)}">${formatMoneyCompact(avg)}</b></div>
                  <div class="port-stat"><span>현재 평가액</span><b style="color: #38bdf8;" title="${formatMoney(val)}">${formatMoneyCompact(val)}</b></div>
                  <div class="port-stat"><span>평가 손익</span><b class="${isProfit ? 'text-up' : 'text-down'}" title="${formatMoney(profit)}">${isProfit ? '+' : ''}${formatMoneyCompact(profit)}</b></div>
                </div>
                <div class="stock-trade-actions" style="margin-top: 10px;">
                  <button class="btn-trade btn-detail" data-stock-id="${escapeHtml(item.stock_id)}" onclick="event.stopPropagation(); openDetailModal(this.dataset.stockId)">🔍 분석</button>
                  <button class="btn-trade btn-buy" data-stock-id="${escapeHtml(item.stock_id)}" data-name="${escapeHtml(item.name)}" data-price="${escapeHtml(String(item.price))}" data-holding="${Number(userHolding)}" onclick="event.stopPropagation(); openTradeModal(this.dataset.stockId, this.dataset.name, this.dataset.price, 'buy', this.dataset.holding)">🛒 추가 매수</button>
                  <button class="btn-trade btn-sell" data-stock-id="${escapeHtml(item.stock_id)}" data-name="${escapeHtml(item.name)}" data-price="${escapeHtml(String(item.price))}" data-holding="${Number(userHolding)}" onclick="event.stopPropagation(); openTradeModal(this.dataset.stockId, this.dataset.name, this.dataset.price, 'sell', this.dataset.holding)">💰 전량 매도</button>
                </div>
              </div>
            `;
          }

          const totalProfit = totalPortfolioCurrent - totalPortfolioInvested;
          const totalProfitRate = totalPortfolioInvested > 0n ? ((Number(totalProfit) / Number(totalPortfolioInvested)) * 100).toFixed(2) : '0.00';
          const isTotalProfit = totalProfit >= 0n;

          portfolioSectionHtml = portfolioRows.length > 0 ? `
            <div class="portfolio-panel">
              <div class="portfolio-header">
                <div class="portfolio-title">
                  <span class="pulse-dot"></span>
                  보유 종목
                </div>
                <div class="portfolio-summary-pill">
                  <span>총 투자금: <b title="${formatMoney(totalPortfolioInvested)}">${formatMoneyCompact(totalPortfolioInvested)}</b></span>
                  <span>총 평가액: <b style="color:#38bdf8;" title="${formatMoney(totalPortfolioCurrent)}">${formatMoneyCompact(totalPortfolioCurrent)}</b></span>
                  <span class="${isTotalProfit ? 'text-up' : 'text-down'}">총 손익: <b>${isTotalProfit ? '+' : ''}${formatMoneyCompact(totalProfit)} (${isTotalProfit ? '+' : ''}${totalProfitRate}%)</b></span>
                </div>
              </div>
              <div class="portfolio-cards-grid">
                ${portfolioItemsHtml}
              </div>
            </div>
          ` : `
            <div class="portfolio-panel empty-port">
              <p>보유 종목이 없습니다. 오른쪽 주문창에서 매수하면 여기에 표시됩니다.</p>
            </div>
          `;
          }
        } catch (e) {
          console.error('[dashboard] 자산 로드 실패:', e && e.message);
          if (!userAssets) {
            userAssets = {
              cash: 0n,
              bank: 0n,
              stockVal: 0n,
              netWorth: 0n,
              streak: 0,
              clickerLevel: 1,
              autoLevel: 0,
              totalClicks: 0
            };
          }
        }
      }

      const gainers = [...stocks].sort((a, b) => b.rate - a.rate);
      const upCount = stocks.filter(s => s.rate > 0).length;
      const downCount = stocks.filter(s => s.rate < 0).length;
      const avgRate = (stocks.reduce((acc, s) => acc + s.rate, 0) / (stocks.length || 1)).toFixed(2);
      const isMarketPositive = Number(avgRate) >= 0;

      // 실시간 급등주 TOP 3 배너
      let topGainersHtml = '';
      gainers.slice(0, 3).forEach((g, idx) => {
        const medal = (idx + 1) + '위';
        const isUp = g.rate >= 0;
        const colorClass = isUp ? 'text-up' : 'text-down';
        const sign = isUp ? '+' : '';
        topGainersHtml += `
          <div class="gainer-card" onclick="openDetailModal('${escapeJsStr(g.stock_id)}')" style="cursor: pointer;">
            <div class="gainer-rank">${medal}</div>
            <div class="gainer-info">
              <span class="gainer-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
              <span class="gainer-symbol">[${escapeHtml(g.stock_id)}] · ${escapeHtml(g.sector || '성장주')}</span>
            </div>
            <div class="gainer-rate ${colorClass}">
              ${sign}${g.rate.toFixed(2)}%
            </div>
          </div>
        `;
      });

      // 주식 카드 HTML
      let stockCardsHtml = '';
      for (const s of stocks) {
        const price = BigInt(s.price);
        const prevPrice = BigInt(s.prev_price);
        const rate = s.rate;
        const isUp = s.isUp;
        const pillClass = isUp ? 'badge-up' : 'badge-down';
        const arrow = isUp ? '▲' : '▼';
        const sign = isUp ? '+' : '';
        const sparklineSvg = generateSparklineSvg(s.history, isUp);
        const userHolding = userHoldingsMap[s.stock_id] || 0;

        const tradeButtons = discordUser
          ? `
            <div class="stock-trade-actions" onclick="event.stopPropagation()">
              <button class="btn-trade btn-buy" data-stock-id="${escapeHtml(s.stock_id)}" data-name="${escapeHtml(s.name)}" data-price="${escapeHtml(String(s.price))}" data-holding="${Number(userHolding)}" onclick="event.stopPropagation(); openTradeModal(this.dataset.stockId, this.dataset.name, this.dataset.price, 'buy', this.dataset.holding)">매수</button>
              <button class="btn-trade btn-sell" data-stock-id="${escapeHtml(s.stock_id)}" data-name="${escapeHtml(s.name)}" data-price="${escapeHtml(String(s.price))}" data-holding="${Number(userHolding)}" onclick="event.stopPropagation(); openTradeModal(this.dataset.stockId, this.dataset.name, this.dataset.price, 'sell', this.dataset.holding)">매도</button>
            </div>
          `
          : `
            <div class="stock-trade-actions" onclick="event.stopPropagation()">
              <a href="${discordLoginUrl}" class="btn-trade-login">로그인</a>
            </div>
          `;

        stockCardsHtml += `
          <div class="stock-card" id="stock-${s.stock_id}" data-stock-id="${escapeHtml(s.stock_id)}" data-name="${escapeHtml(s.name)}" data-price="${escapeHtml(String(s.price))}" data-holding="${Number(userHolding)}" onclick="openTradeModal(this.dataset.stockId, this.dataset.name, this.dataset.price, 'buy', this.dataset.holding)">
            <div class="sr-name">
              <span class="stock-symbol">${escapeHtml(s.stock_id)}</span>
              <span class="stock-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
              ${userHolding > 0 ? `<span class="sr-hold">${userHolding.toLocaleString()}주</span>` : ''}
            </div>
            <div class="stock-price ${isUp ? 'text-up' : 'text-down'}" id="price-${s.stock_id}" data-raw="${String(price)}" title="${formatMoney(price)}">${formatMoneyCompact(price)}</div>
            <span class="badge ${pillClass}">${arrow} ${sign}${Math.abs(rate).toFixed(2)}%</span>
            <div class="sparkline-box" onclick="event.stopPropagation(); openDetailModal('${escapeJsStr(s.stock_id)}')">${sparklineSvg}</div>
            ${tradeButtons}
            <div class="stock-footer">
              <span>이전가: ${formatMoneyCompact(prevPrice)}</span>
              <span class="trend-text ${isUp ? 'text-up' : 'text-down'}">${isUp ? '상승' : '하락'}</span>
            </div>
          </div>
        `;
      }

      // 뉴스 피드 HTML
      function buildNewsCardHtml(n) {
        const timeStr = n.created_at ? new Date(n.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '방금';
        const isBull = n.sentiment === 'BULL';
        const sentimentTag = isBull 
          ? `<span class="news-sentiment-badge sentiment-bull">🔥 호재 / 상승</span>`
          : `<span class="news-sentiment-badge sentiment-bear">⚠️ 악재 / 조정</span>`;

        const stockBtn = n.related_stock && n.related_stock !== 'ALL'
          ? `<button class="btn-news-stock" onclick="openDetailModal('${escapeJsStr(n.related_stock)}')">📈 [${escapeHtml(n.related_stock)}] 차트보기</button>`
          : `<span class="news-market-badge">🌐 전 종목 영향</span>`;

        return `
          <div class="news-item" data-category="${escapeHtml(n.event_type || 'ALL')}" data-stock="${escapeHtml(n.related_stock || 'ALL')}">
            <div class="news-meta">
              <div style="display: flex; gap: 6px; align-items: center;">
                <span class="news-tag">${escapeHtml(n.event_type || '증시공시')}</span>
                ${sentimentTag}
              </div>
              <span class="news-time">⏱️ ${timeStr}</span>
            </div>
            <div class="news-headline">${escapeHtml(n.title)}</div>
            <div class="news-desc">${escapeHtml(n.content)}</div>
            <div class="news-footer-row">
              <span class="news-sector-pill">🏢 ${escapeHtml(n.impact_sector || '시장 전반')}</span>
              ${stockBtn}
            </div>
          </div>
        `;
      }

      let newsFeedHtml = recentNewsList.map(buildNewsCardHtml).join('');

      // 순위표 HTML
      let leaderboardRowsHtml = '';
      const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      for (let i = 0; i < leaderboardRows.length; i++) {
        const row = leaderboardRows[i];
        const emoji = rankEmojis[i] || '🔹';
        const net = BigInt(Math.floor(Number(row.net || 0)));

        let displayName = row.username;
        if (!displayName && client && client.users) {
          const cachedUser = client.users.cache.get(row.discord_id);
          if (cachedUser) displayName = cachedUser.globalName || cachedUser.username || cachedUser.tag;
        }
        if (!displayName) displayName = `유저_${row.discord_id.slice(-4)}`;
        if (!displayName.startsWith('@')) displayName = `@${displayName}`;

        const isRowAdmin = config.isAdmin(row.discord_id);
        const adminBadge = isRowAdmin ? `<span class="admin-badge-mini">👑 관리자</span>` : '';
        const avatarSrc = escapeHtml(safeAvatarUrl(row.discord_id, row.avatar || (client && client.users?.cache.get(row.discord_id)?.displayAvatarURL())));

        leaderboardRowsHtml += `
          <tr>
            <td class="rank-cell">${emoji} ${i + 1}위</td>
            <td>
              <div class="user-info-box">
                <img src="${avatarSrc}" class="rank-avatar" alt="Avatar" onError="this.src='https://cdn.discordapp.com/embed/avatars/0.png';">
                <div class="user-text-col">
                  <span class="user-nickname-title">${escapeHtml(displayName)} ${adminBadge}</span>
                  <span class="user-id-sub">ID: ${escapeHtml(row.discord_id)}</span>
                </div>
              </div>
            </td>
            <td class="net-cell" title="${formatMoney(net)}">${formatMoneyCompact(net)}</td>
          </tr>
        `;
      }

      const adminNavButton = isAdminUser ? `<a href="/admin" class="btn-admin-nav" onclick="event.stopPropagation()">관리</a>` : '';
      const navbarRightHtml = currentUser
        ? `
          <div class="user-panel" onclick="openProfileModal()" title="프로필">
            <img src="${escapeHtml(safeAvatarUrl(currentUser.id, currentUser.avatar))}" class="nav-avatar-img" alt="" onError="this.src='https://cdn.discordapp.com/embed/avatars/0.png';">
            <div class="user-panel-meta">
              <span class="nav-username-text">${escapeHtml(currentUser.username)}</span>
              <span class="user-panel-sub">${isAdminUser ? '관리자' : (isLocalPlay ? '웹 계정' : '온라인')}</span>
            </div>
            ${adminNavButton}
            <button type="button" class="btn-user-settings" title="설정" aria-label="설정" onclick="event.stopPropagation(); openUserSettings('interface')">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.6-.22l-2.39.96c-.5-.4-1.04-.7-1.63-.94l-.36-2.54A.5.5 0 0013.9 2h-3.8a.5.5 0 00-.5.42l-.36 2.54c-.59.24-1.13.55-1.63.94l-2.39-.96a.5.5 0 00-.6.22L2.8 8.84a.5.5 0 00.12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.92 14.52a.5.5 0 00-.12.64l1.92 3.32c.13.23.4.32.64.22l2.39-.96c.5.39 1.04.7 1.63.94l.36 2.54c.05.24.26.42.5.42h3.8c.24 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.55 1.63-.94l2.39.96c.24.1.51 0 .64-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z"/></svg>
            </button>
            <a href="/auth/logout" class="btn-logout" onclick="event.stopPropagation()">나가기</a>
          </div>
        `
        : `
          <div class="user-panel guest">
            <span class="guest-play-chip">계정으로 게임하기</span>
            <form id="local-login-form" class="local-auth-form" onsubmit="submitLocalAuth(event, 'login'); return false;">
              <input type="text" name="username" maxlength="16" autocomplete="username" placeholder="아이디" required>
              <input type="password" name="password" maxlength="72" autocomplete="current-password" placeholder="비밀번호" required>
              <button type="submit" class="btn-discord btn-discord-block">로그인</button>
            </form>
            <form id="local-register-form" class="local-auth-form" onsubmit="submitLocalAuth(event, 'register'); return false;">
              <input type="text" name="username" maxlength="16" autocomplete="username" placeholder="새 아이디" required>
              <input type="password" name="password" maxlength="72" autocomplete="new-password" placeholder="비밀번호 8자 이상" required>
              <button type="submit" class="btn-discord btn-discord-block">계정 만들기</button>
            </form>
            <a href="${discordLoginUrl}" class="btn-discord btn-discord-block">Discord로 로그인</a>
            <p class="local-auth-hint">송금은 Discord 계정만 됩니다.</p>
          </div>
        `;

      const totalAssetNum = userAssets ? (Number(userAssets.netWorth) || 1) : 1;
      const cashPct = userAssets ? Math.min(100, Math.max(0, Math.round((Number(userAssets.cash) / totalAssetNum) * 100))) : 0;
      const bankPct = userAssets ? Math.min(100 - cashPct, Math.max(0, Math.round((Number(userAssets.bank) / totalAssetNum) * 100))) : 0;
      const stockPct = userAssets ? Math.max(0, 100 - cashPct - bankPct) : 0;

      const heroSectionHtml = userAssets
        ? `
          <div class="wallet-rail${isLocalPlay ? ' guest' : ''}">
            ${isLocalPlay ? `<div class="guest-play-banner" role="status">웹 계정으로 게임 중입니다. 카지노·채굴은 이 계정으로 할 수 있고, 송금은 Discord 계정만 됩니다.</div>` : ''}
            <div class="rail-label">${isLocalPlay ? '웹 계정 자산' : '자산'}</div>
            <div class="personal-asset-grid">
              <div class="asset-card">
                <span class="asset-lbl">현금</span>
                <span class="asset-val" id="my-cash" data-raw="${String(userAssets.cash)}" title="${formatMoney(userAssets.cash)}">${formatMoneyCompact(userAssets.cash)}</span>
              </div>
              <div class="asset-card">
                <span class="asset-lbl">예금</span>
                <span class="asset-val" id="my-bank" data-raw="${String(userAssets.bank)}" title="${formatMoney(userAssets.bank)}">${formatMoneyCompact(userAssets.bank)}</span>
              </div>
              <div class="asset-card">
                <span class="asset-lbl">주식</span>
                <span class="asset-val" id="my-stock-val" data-raw="${String(userAssets.stockVal)}" title="${formatMoney(userAssets.stockVal)}">${formatMoneyCompact(userAssets.stockVal)}</span>
              </div>
              <div class="asset-card highlight">
                <span class="asset-lbl">순자산</span>
                <span class="asset-val" id="my-net-worth" data-raw="${String(userAssets.netWorth)}" title="${formatMoney(userAssets.netWorth)}">${formatMoneyCompact(userAssets.netWorth)}</span>
              </div>
            </div>
            <div class="asset-ratio-container">
              <div class="asset-ratio-header">
                <span>배분</span>
                <span>현금 ${cashPct}% · 예금 ${bankPct}% · 주식 ${stockPct}%</span>
              </div>
              <div class="asset-ratio-bar">
                <div class="ratio-segment ratio-cash" style="width: ${cashPct}%;" title="현금 ${cashPct}%"></div>
                <div class="ratio-segment ratio-bank" style="width: ${bankPct}%;" title="예금 ${bankPct}%"></div>
                <div class="ratio-segment ratio-stock" style="width: ${stockPct}%;" title="주식 ${stockPct}%"></div>
              </div>
            </div>
            <div class="hero-quick-actions">
              <button type="button" class="btn-quick" onclick="claimDailyReward()">출석</button>
              <button type="button" class="btn-quick" onclick="claimSubsidyReward()">지원금</button>
              <button type="button" class="btn-quick" onclick="openBankModal()">은행</button>
              <button type="button" class="btn-quick" onclick="openTransferModal()" style="background: rgba(56, 189, 248, 0.15); border-color: rgba(56, 189, 248, 0.4); color: #38bdf8;">💸 송금</button>
              <button type="button" class="btn-quick" onclick="switchTab('tab-business')">사업</button>
              <button type="button" class="btn-quick" onclick="switchTab('tab-clicker')">채굴</button>
            </div>
            <div id="wallet-tax-note" style="padding:2px 10px 8px;font-size:12px;line-height:1.4;color:${pageTax.rate > 0 && !pageTax.exempt ? '#fbbf24' : '#949ba4'};">${pageTax.exempt ? '관리자 계정은 세금이 없습니다.' : (pageTax.rate > 0 ? `거래·송금세 ${escapeHtml(pageTax.rateText)} · 현금+예금 ${escapeHtml(formatMoney(pageTax.threshold))} 초과 시 현금·예금에서 회수` : '현재 거래세 없음 (경제 안정)')}</div>
            <div id="wallet-tax-next" style="padding:0 10px 8px;font-size:12px;line-height:1.4;color:#9ca3af;"></div>
            <div id="wallet-loan-note" style="padding:0 10px 10px;font-size:12px;line-height:1.4;color:${pageLoan.overdue ? '#f87171' : '#a5b4fc'};">${pageLoan.hasLoan ? (pageLoan.overdue ? '대출 연체 ' : '대출 ') + escapeHtml(formatMoney(pageLoan.debt)) + ' · 담보 ' + escapeHtml(formatMoney(pageLoan.collateral)) : (pageLoan.exempt || String(pageLoan.maxBorrow || '0') === '0' ? '' : '대출 한도 ' + escapeHtml(formatMoney(pageLoan.maxBorrow)) + ' · 이자 ' + escapeHtml(pageLoan.rateText || LOAN.LABEL))}</div>
          </div>
        `
        : `
          <div class="wallet-rail guest">
            <div class="rail-label">계정</div>
            <p class="guest-play-banner">아이디·비밀번호로 계정을 만들면 게임을 할 수 있습니다. 송금은 Discord 계정만 됩니다.</p>
            <form id="local-login-form-rail" class="local-auth-form" onsubmit="submitLocalAuth(event, 'login'); return false;">
              <input type="text" name="username" maxlength="16" autocomplete="username" placeholder="아이디" required>
              <input type="password" name="password" maxlength="72" autocomplete="current-password" placeholder="비밀번호" required>
              <button type="submit" class="btn-discord btn-discord-block">로그인</button>
            </form>
            <form id="local-register-form-rail" class="local-auth-form" onsubmit="submitLocalAuth(event, 'register'); return false;">
              <input type="text" name="username" maxlength="16" autocomplete="username" placeholder="새 아이디" required>
              <input type="password" name="password" maxlength="72" autocomplete="new-password" placeholder="비밀번호 8자 이상" required>
              <button type="submit" class="btn-discord btn-discord-block">계정 만들기</button>
            </form>
            <a href="${discordLoginUrl}" class="btn-discord btn-discord-block">Discord로 로그인</a>
          </div>
        `;

      const breakingNewsTicker = news 
        ? `${news.title || news.text}` 
        : `장중 거래가 이어지고 있습니다.`;

      const currentClickerLevel = userAssets ? userAssets.clickerLevel : 1;
      const currentAutoLevel = userAssets ? userAssets.autoLevel : 0;
      const powerPerLevel = CLICKER.POWER_PER_LEVEL;
      const upgradeCostPerLevel = CLICKER.POWER_COST_PER_LEVEL;
      const autoIncomePerLevel = CLICKER.AUTO_PER_LEVEL_PER_SEC;
      const autoCostPerNextLevel = CLICKER.AUTO_COST_BASE;
      const powerCost = currentClickerLevel * upgradeCostPerLevel;
      const autoCost = (currentAutoLevel + 1) * autoCostPerNextLevel;
      const powerVal = currentClickerLevel * powerPerLevel;
      const autoVal = currentAutoLevel * autoIncomePerLevel;
      const userHoldingsJson = safeJsonForHtml(userHoldingsMap || {});

      const adminFeedTabHtml = isAdminUser ? `
        <!-- 탭: ⚡ 실시간 모든 로그 (관리자 전용) -->
        <div id="tab-feed" class="tab-pane">
          <div class="feed-container">
            <div class="feed-header">
              <div class="feed-title">
                <span class="pulse-dot"></span>
                ⚡ 실시간 모든 시스템 로그 & 주가 변동 스트림 (관리자 전용)
              </div>
              <div class="feed-status-badge">
                <span class="pulse-dot"></span>
                3초 자동 갱신 라이브 피드
              </div>
            </div>

            <div class="feed-filter-bar">
              <button class="btn-feed-filter active" onclick="setFeedFilter('ALL')">🌐 전체 로그</button>
              <button class="btn-feed-filter" onclick="setFeedFilter('STOCK_PRICE')">📈 주가 변동 틱</button>
              <button class="btn-feed-filter" onclick="setFeedFilter('STOCK_TRADE')">🛒 주식 매매 체결</button>
              <button class="btn-feed-filter" onclick="setFeedFilter('GAMBLE')">🎰 카지노 도박</button>
              <button class="btn-feed-filter" onclick="setFeedFilter('ECONOMY')">🎁 경제/지원금</button>
              <button class="btn-feed-filter" onclick="setFeedFilter('NEWS')">📰 시장 공시/속보</button>
              <input type="text" id="feed-search-input" class="feed-search-input" placeholder="🔍 유저명, 종목명, 키워드 검색..." oninput="filterFeedLocally()">
            </div>

            <div class="feed-stream-list" id="feed-stream-container">
              <div style="text-align: center; color: #9ca3af; padding: 30px;">
                <span class="pulse-dot"></span> 실시간 시스템 로그 데이터를 불러오는 중...
              </div>
            </div>
            <div class="cx-card" style="margin-top:16px">
              <div class="cx-k">카지노 운영</div>
              <div class="bet-input-group">
                <label>잭팟 팟 강제 설정</label>
                <div style="display:flex; gap:6px;">
                  <input type="text" id="admin-jackpot-amt" class="bet-input" value="1000000" inputmode="decimal" placeholder="100만 또는 1양" style="flex:1;">
                  <button type="button" class="btn-play-game" id="btn-admin-jackpot" style="white-space:nowrap;">적용</button>
                  <button type="button" class="btn-chip" onclick="document.getElementById('admin-jackpot-amt').value='1000000'; document.getElementById('btn-admin-jackpot').click();" style="white-space:nowrap; background:#ef4444; color:#fff;" title="잭팟 100만원으로 즉시 리셋">🔄 100만 초기화</button>
                </div>
              </div>
              <div style="display:flex;gap:8px;margin:10px 0;flex-wrap:wrap">
                <button type="button" class="btn-chip" id="btn-admin-happy-on">행시 ON</button>
                <button type="button" class="btn-chip" id="btn-admin-happy-off">행시 OFF</button>
                <button type="button" class="btn-chip" id="btn-admin-happy-auto">행시 자동</button>
              </div>
              <div class="bet-input-group">
                <label>토토 경기 수동 정산</label>
                <input type="text" id="admin-toto-id" class="bet-input" placeholder="경기 번호">
                <select id="admin-toto-result" class="bet-input">
                  <option value="home">홈</option>
                  <option value="draw">무</option>
                  <option value="away">원정</option>
                </select>
                <button type="button" class="btn-play-game" id="btn-admin-toto">정산</button>
              </div>
            </div>
          </div>
        </div>
      ` : '';

      const profileHeaderHtml = currentUser && userAssets
        ? `
          <div class="profile-user-header">
            <img src="${escapeHtml(safeAvatarUrl(currentUser.id, currentUser.avatar))}" class="profile-avatar-big" alt="Avatar" onError="this.src='https://cdn.discordapp.com/embed/avatars/0.png';">
            <div>
              <h3 style="font-size: 1.25rem; font-weight: 800; color: #fff;">@${escapeHtml(currentUser.username)} ${isAdminUser ? '<span class="admin-tag" style="font-size:0.85rem; vertical-align:middle;">👑 관리자</span>' : ''}</h3>
              <p style="color: #9ca3af; font-size: 0.8rem; margin-top: 2px;">${isLocalPlay ? '웹 계정' : 'Discord ID'}: <code>${escapeHtml(currentUser.id)}</code></p>
            </div>
          </div>
        `
        : '';

      const profileStatsHtml = currentUser && userAssets
        ? `
          <div class="profile-stats-grid">
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">💵 보유 현금</span>
              <span class="profile-stat-val" id="modal-user-cash" data-raw="${String(userAssets.cash)}" style="color: #34d399;" title="${formatMoney(userAssets.cash)}">${formatMoneyCompact(userAssets.cash)}</span>
            </div>
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">🏦 은행 예금</span>
              <span class="profile-stat-val" id="modal-user-bank" data-raw="${String(userAssets.bank)}" style="color: #818cf8;" title="${formatMoney(userAssets.bank)}">${formatMoneyCompact(userAssets.bank)}</span>
            </div>
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">📈 보유 주식 평가액</span>
              <span class="profile-stat-val" id="modal-user-stock" data-raw="${String(userAssets.stockVal)}" style="color: #60a5fa;" title="${formatMoney(userAssets.stockVal)}">${formatMoneyCompact(userAssets.stockVal)}</span>
            </div>
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">💎 총 순자산</span>
              <span class="profile-stat-val" id="modal-user-net" data-raw="${String(userAssets.netWorth)}" style="color: #fbbf24;" title="${formatMoney(userAssets.netWorth)}">${formatMoneyCompact(userAssets.netWorth)}</span>
            </div>
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">🔥 출석 연속 기록</span>
              <span class="profile-stat-val" id="modal-user-streak" style="color: #f43f5e;">${userAssets.streak || 0}일 연속</span>
            </div>
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">⛏️ 채굴기 / 자동봇 레벨</span>
              <span class="profile-stat-val" id="modal-user-levels" style="color: #a855f7;">Lv.${currentClickerLevel} / Lv.${currentAutoLevel}</span>
            </div>
          </div>

          <div style="display: flex; gap: 8px;">
            <button class="btn-upgrade" style="flex: 1; padding: 10px;" onclick="closeProfileModal(); openInquiryModal();">✍️ 1:1 관리자 문의하기</button>
            <a href="/auth/logout" class="btn-logout" style="display: flex; align-items: center; justify-content: center; padding: 10px 16px; margin: 0;">🚪 로그아웃</a>
          </div>
        `
        : `
          <div style="text-align: center; padding: 30px 10px;">
            <p style="color: #9ca3af; margin-bottom: 16px;">로그인 후 내 정보와 1:1 문의를 확인하실 수 있습니다.</p>
            <a href="${discordLoginUrl}" class="btn-discord">🎮 Discord 로그인</a>
          </div>
        `;

      const chatInputHtml = isDiscordUser
        ? `
          <form id="chat-send-form" onsubmit="handleSendChat(event)">
            <input type="text" id="chat-input" placeholder="#광장에 메시지 보내기" maxlength="200" autocomplete="off">
            <button type="submit" id="chat-submit-btn">보내기</button>
          </form>
        `
        : `
          <div class="chat-composer">
            <p style="font-size:13px;color:#949ba4;margin-bottom:8px;">로그인하면 #광장에 글을 쓸 수 있습니다.</p>
            <a href="${discordLoginUrl}" class="btn-discord">Discord로 로그인</a>
          </div>
        `;

      const floatingChatInputHtml = isDiscordUser
        ? `
          <form id="floating-chat-send-form" onsubmit="handleSendFloatingChat(event)">
            <input type="text" id="floating-chat-input" placeholder="메시지 보내기" maxlength="200" autocomplete="off">
            <button type="submit" id="floating-chat-submit-btn">보내기</button>
          </form>
        `
        : `
          <div style="text-align: center; padding: 6px;">
            <a href="${discordLoginUrl}" class="btn-discord" style="display: block; padding: 8px 12px; font-size: 0.82rem;">🎮 Discord 로그인 후 채팅</a>
          </div>
        `;


      function renderBetChips(inputId, extras) {
        const extra = Array.isArray(extras) ? extras : [];
        const extraHtml = extra.map((item) => {
          const amt = item[0];
          const label = item[1];
          return `<button type="button" class="btn-chip chip-add" onclick="addNumericBet('${inputId}', ${amt})">${label}</button>`;
        }).join('');
        return `
                    <div class="btn-chip-grid">
                      <button type="button" class="btn-chip chip-add" onclick="addNumericBet('${inputId}', 1000)">+1천</button>
                      <button type="button" class="btn-chip chip-add" onclick="addNumericBet('${inputId}', 5000)">+5천</button>
                      <button type="button" class="btn-chip chip-add" onclick="addNumericBet('${inputId}', 10000)">+1만</button>
                      <button type="button" class="btn-chip chip-add" onclick="addNumericBet('${inputId}', 50000)">+5만</button>
                      ${extraHtml}
                      <button type="button" class="btn-chip chip-add chip-custom" onclick="addCustomBet('${inputId}')">+칩</button>
                      <button type="button" class="btn-chip" onclick="addNumericBet('${inputId}', 'reset')">리셋</button>
                      <button type="button" class="btn-chip chip-allin" onclick="setNumericBet('${inputId}', 'all')">올인</button>
                    </div>`;
      }

      function renderBetPlus(inputId) {
        return `<button type="button" class="btn-bet-plus" onclick="addCustomBet('${inputId}')" title="설정한 칩 단위만큼 추가">+</button>`;
      }

      function renderChipUnit() {
        return `
              <div class="cx-card bet-chip-unit">
                <span class="cx-k">칩 단위</span>
                <input type="text" class="bet-input bet-chip-step" value="10000" inputmode="decimal" placeholder="1만 또는 1양" title="플러스 버튼을 누를 때마다 더해지는 금액">
                <div class="bet-chip-presets">
                  <button type="button" class="btn-chip" onclick="setChipStep(1000)">1천</button>
                  <button type="button" class="btn-chip" onclick="setChipStep(10000)">1만</button>
                  <button type="button" class="btn-chip" onclick="setChipStep(50000)">5만</button>
                  <button type="button" class="btn-chip" onclick="setChipStep(100000)">10만</button>
                </div>
                <span class="cx-k bet-chip-hint">+ 또는 +칩을 누를 때마다 이 금액이 추가됩니다</span>
              </div>`;
      }

      res.send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <!-- Google Tag Manager -->
          <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
          new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
          j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
          'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
          })(window,document,'script','dataLayer','GTM-58KTJGG4');</script>
          <!-- End Google Tag Manager -->
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover">
          <meta name="theme-color" content="#1e1f22">
          <meta name="mobile-web-app-capable" content="yes">
          <meta name="apple-mobile-web-app-capable" content="yes">
          <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
          <title>월덕</title>
          ${appearanceBootScript()}
          <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700;800;900&family=Inter:wght@400;500;600;700;800&display=swap">
          ${cssTag('css/app.css')}
          ${cssTag('css/dashboard-ux.css')}
          ${appearanceHeadLinks()}
          ${cssTag('css/casino-ux.css')}
          ${cssTag('css/arcade.css')}
          ${cssTag('css/mine-genres.css')}
          ${cssTag('css/help.css')}
          ${cssTag('css/help-popup.css')}
          <script src="/socket.io/socket.io.js"></script>
          <style>
            input, textarea { -webkit-user-select: text !important; user-select: text !important; }
          </style>
        </head>
        <body data-tab="tab-stocks">
          <!-- Google Tag Manager (noscript) -->
          <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-58KTJGG4"
          height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
          <!-- End Google Tag Manager (noscript) -->
          <div id="toast-container"></div>
          <div class="mobile-backdrop" id="mobile-backdrop" onclick="closeDrawers()"></div>

          <div class="app-shell">
            <nav class="server-rail" aria-label="메뉴">
              <a href="/" class="server-home" title="월덕">월</a>
              <div class="server-sep"></div>
              <button type="button" class="server-btn tab-btn active" data-tab="tab-stocks" onclick="switchTab('tab-stocks')" title="주식-시장">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18V6h2v12H4zm5 0V10h2v8H9zm5 0V8h2v10h-2zm5 0v-6h2v6h-2z"/></svg>
              </button>
              <button type="button" class="server-btn tab-btn" data-tab="tab-business" onclick="switchTab('tab-business')" title="사업">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21V8l9-5 9 5v13h-6v-7H9v7H3z"/></svg>
              </button>
              <button type="button" class="server-btn tab-btn" data-tab="tab-clicker" onclick="switchTab('tab-clicker')" title="채굴">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12l7-7 3 3-7 7H3v-3zm11.5-6.5l3 3 3.5-3.5-3-3-3.5 3.5z"/></svg>
              </button>
              <button type="button" class="server-btn tab-btn" data-tab="tab-news" onclick="switchTab('tab-news')" title="시장-뉴스">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v16H5V4zm2 3v2h10V7H7zm0 4v2h10v-2H7zm0 4v2h7v-2H7z"/></svg>
              </button>
              <button type="button" class="server-btn tab-btn" data-tab="tab-p2p" onclick="switchTab('tab-p2p')" title="대부업">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h3v7H4v-7zm6 0h3v7h-3v-7zm6 0h3v7h-3v-7zM2 20h19v2H2v-2zM11.5 2L2 7v2h19V7l-9.5-5z"/></svg>
              </button>
              <div class="server-sep"></div>
              <button type="button" class="server-btn tab-btn" data-tab="tab-chat" onclick="switchTab('tab-chat')" title="광장">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H7l-3 3V4zm4 5h8v2H8V9zm0 3h5v2H8v-2z"/></svg>
              </button>
              <button type="button" class="server-btn tab-btn" data-tab="tab-ranking" onclick="switchTab('tab-ranking')" title="자산-순위">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v2.2A4.5 4.5 0 0113 9.6V12h3v2H8v-2h3V9.6A4.5 4.5 0 017 5.2V3zM5 4H3v2a3 3 0 003 3V5.5A2 2 0 015 4zm14 0h2v2a3 3 0 01-3 3V5.5A2 2 0 0119 4zM8 16h8v2H8v-2z"/></svg>
              </button>
              <div class="server-sep"></div>
              <button type="button" class="server-btn tab-btn" data-tab="tab-casino" onclick="switchTab('tab-casino')" title="미니게임">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l3.5 6.1L22 10.2l-5 4.9 1.2 6.9L12 18.8 5.8 22l1.2-6.9-5-4.9 6.5-1.1z"/></svg>
              </button>
              <button type="button" class="server-btn tab-btn" data-tab="tab-hot" onclick="switchTab('tab-hot')" title="핫게임">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c2 4 6 6 6 11a6 6 0 11-12 0c0-5 4-7 6-11z"/></svg>
              </button>
              <button type="button" class="server-btn tab-btn" data-tab="tab-horse" onclick="switchTab('tab-horse')" title="경마">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h2v18H6V3zm3 1h11l-3.2 4 3.2 4H9V4z"/></svg>
              </button>
              <button type="button" class="server-btn tab-btn" data-tab="tab-arcade" onclick="switchTab('tab-arcade')" title="아케이드">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10a5 5 0 0110 0v4H7v-4zm-3 4h16v4H4v-4zM9 6V3h2v3H9zm4 0V2h2v4h-2z"/></svg>
              </button>
              <div class="server-sep"></div>
              <button type="button" class="server-btn" onclick="window.WuiHelp&&WuiHelp.open()" title="도움말" aria-label="도움말">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 100 18 9 9 0 000-18zm.1 13.6a1.2 1.2 0 110-2.4 1.2 1.2 0 010 2.4zm1.5-4.7c-.55.28-.8.52-.8 1.05h-1.9c0-1.15.62-1.9 1.72-2.42.78-.38 1.18-.7 1.18-1.28 0-.7-.58-1.18-1.48-1.18-.92 0-1.52.46-1.78 1.22l-1.78-.4C9.1 7.55 10.42 6.3 12.2 6.3c2.12 0 3.5 1.22 3.5 3.02 0 1.42-.78 2.22-2.1 2.58z"/></svg>
              </button>
              ${isAdminUser ? `<button type="button" class="server-btn tab-btn" data-tab="tab-feed" onclick="switchTab('tab-feed')" title="관리자-로그"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l8 4v6c0 5-3.4 9.4-8 10-4.6-.6-8-5-8-10V6l8-4z"/></svg></button>` : ''}
            </nav>

            <aside class="channel-sidebar" id="channel-sidebar">
              <div class="guild-header">
                <span>월덕</span>
                <button type="button" onclick="closeDrawers()" aria-label="닫기">×</button>
              </div>
              <div class="sidebar-ticker">
                <div class="news-ticker-bar">
                  <span class="ticker-live-dot"></span>
                  <span class="ticker-content" id="breaking-ticker-text">${breakingNewsTicker}</span>
                </div>
              </div>
              <div class="channel-scroll">
                <div class="channel-cat">경제</div>
                <button type="button" class="tab-btn channel-item active" data-tab="tab-stocks" onclick="switchTab('tab-stocks')"><span class="channel-hash">📈</span>주식-시장</button>
                <button type="button" class="tab-btn channel-item" data-tab="tab-business" onclick="switchTab('tab-business')"><span class="channel-hash">🏢</span>사업</button>
                <button type="button" class="tab-btn channel-item" data-tab="tab-clicker" onclick="switchTab('tab-clicker')"><span class="channel-hash">⛏️</span>채굴</button>
                <button type="button" class="tab-btn channel-item" data-tab="tab-p2p" onclick="switchTab('tab-p2p')"><span class="channel-hash">🏦</span>대부업</button>
                <button type="button" class="tab-btn channel-item" data-tab="tab-news" onclick="switchTab('tab-news')"><span class="channel-hash">📰</span>시장-뉴스</button>
                <div class="channel-cat">커뮤니티</div>
                <button type="button" class="tab-btn channel-item" data-tab="tab-chat" onclick="switchTab('tab-chat')"><span class="channel-hash">💬</span>광장</button>
                <button type="button" class="tab-btn channel-item" data-tab="tab-ranking" onclick="switchTab('tab-ranking')"><span class="channel-hash">🏆</span>자산-순위</button>
                <div class="channel-cat">엔터테인먼트 게임</div>
                <button type="button" class="tab-btn channel-item" data-tab="tab-casino" onclick="switchTab('tab-casino')"><span class="channel-hash">🎮</span>미니게임</button>
                <button type="button" class="tab-btn channel-item" data-tab="tab-hot" onclick="switchTab('tab-hot')"><span class="channel-hash">🔥</span>핫게임</button>
                <button type="button" class="tab-btn channel-item" data-tab="tab-horse" onclick="switchTab('tab-horse')"><span class="channel-hash">🏇</span>경마</button>
                <button type="button" class="tab-btn channel-item" data-tab="tab-arcade" onclick="switchTab('tab-arcade')"><span class="channel-hash">🕹️</span>아케이드</button>
                ${isAdminUser ? `<div class="channel-cat">관리</div><button type="button" class="tab-btn channel-item" data-tab="tab-feed" onclick="switchTab('tab-feed')"><span class="channel-hash">🛡️</span>관리자-로그</button>` : ''}
              </div>
              ${navbarRightHtml}
            </aside>

            <div class="app-main">
              <header class="channel-topbar">
                <button type="button" class="mobile-menu" onclick="toggleSidebar()" aria-label="채널">☰</button>
                <span class="topbar-hash">#</span>
                <h1 id="channel-header-title">주식-시장</h1>
                <div class="topbar-right">
                  <div class="next-tick-badge">
                    <span class="pulse-dot"></span>
                    <span id="price-tick-countdown">03:00</span>
                    <button type="button" class="btn-quick-refresh" onclick="refreshStockPricesLive(true)" title="시세 새로고침">↻</button>
                  </div>
                  <button type="button" class="btn-help-top" onclick="window.WuiHelp&&WuiHelp.open()" title="도움말" aria-label="도움말">?</button>
                  ${appearanceButtonHtml()}
                  <button type="button" class="mobile-wallet" onclick="toggleWallet()" aria-label="자산">₩</button>
                </div>
              </header>
              <div class="channel-content">
            ${isLocalPlay ? `<div class="guest-play-strip" role="status">웹 계정으로 게임 중입니다. 송금은 Discord 계정만 됩니다. <a href="${discordLoginUrl}">Discord 로그인</a></div>` : ''}

            <!-- 탭 1: 주식 시장 & 차트 -->
            <div id="tab-stocks" class="tab-pane active">
              <div class="market-toolbar">
                <div class="mt-stats">
                  <span>상승 <b class="text-up">${upCount}</b></span>
                  <span>하락 <b class="text-down">${downCount}</b></span>
                  <span class="${isMarketPositive ? 'text-up' : 'text-down'}">${isMarketPositive ? '+' : ''}${avgRate}%</span>
                  <span class="mt-regime">${regime ? escapeHtml(regime.name) : '보합'}</span>
                  <span id="mt-tax-rate" style="color:${pageTax.rate > 0 && !pageTax.exempt ? '#fbbf24' : '#9ca3af'};">${pageTax.exempt ? '거래세 면제' : `거래세 ${escapeHtml(pageTax.rateText)}`}</span>
                  <span id="mt-tax-next" style="color:#9ca3af;"></span>
                </div>
                <div class="mt-gainers">${topGainersHtml}</div>
              </div>
              <p class="market-flash">${news ? escapeHtml(news.text) : '장중 거래가 이어지고 있습니다.'}</p>
              ${isDiscordUser ? portfolioSectionHtml : ''}
              <div class="market-layout">
                <div class="market-list">
                  <div class="market-cols">
                    <span>종목</span><span>현재가</span><span>등락</span><span>추이</span><span>주문</span>
                  </div>
                  <div class="stocks-grid">
                    ${stockCardsHtml}
                  </div>
                </div>
                <div id="order-dock" class="order-dock"></div>
              </div>
            </div>

            <!-- 💬 탭: 실시간 광장 채팅 (Real-time Live Community Chat) -->
            <div id="tab-chat" class="tab-pane">
              <div class="chat-app">
                <aside class="chat-nav" id="chat-nav">
                  <div class="chat-nav-sec">채널</div>
                  <div id="chat-channel-list"></div>
                  <div class="chat-nav-sec">스레드</div>
                  <div id="chat-thread-list"></div>
                  <div class="chat-nav-sec">1대1</div>
                  <div id="chat-dm-list"></div>
                  ${isDiscordUser ? '<button type="button" class="chat-nav-new" onclick="openPlazaDmPicker()">+ 새 대화</button>' : '<div class="chat-nav-empty">광장 글쓰기는 Discord 로그인 후 이용할 수 있습니다</div>'}
                </aside>
                <div class="chat-stage">
                  <div id="chat-open-tabs" class="chat-tabs"></div>
                  <div class="chat-stage-head">
                    <span id="chat-active-title"># 광장</span>
                    <button type="button" class="chat-nav-toggle" onclick="document.getElementById('chat-nav').classList.toggle('open')" aria-label="대화 목록">☰</button>
                  </div>
                  <div id="chat-messages-container" class="chat-stream">
                    <div style="text-align:center;color:#6d6f78;font-size:14px;padding:40px 0;">메시지를 불러오는 중</div>
                  </div>
                  <div class="chat-composer">
                    <div class="chat-emoji-bar">
                      <button type="button" class="chat-emoji-btn" onclick="insertEmoji('🦆')">🦆</button>
                      <button type="button" class="chat-emoji-btn" onclick="insertEmoji('📈')">📈</button>
                      <button type="button" class="chat-emoji-btn" onclick="insertEmoji('🔥')">🔥</button>
                      <button type="button" class="chat-emoji-btn" onclick="insertEmoji('🎰')">🎰</button>
                    </div>
                  ${chatInputHtml}
                  </div>
                </div>
                <div id="chat-dm-modal" class="chat-dm-modal" style="display:none;" onclick="if(event.target===this)closePlazaDmPicker()">
                  <div class="chat-dm-card">
                    <div class="chat-dm-head">
                      <strong>1대1 대화 상대</strong>
                      <button type="button" onclick="closePlazaDmPicker()">닫기</button>
                    </div>
                    <div id="chat-dm-people" class="chat-dm-people">로그인 후 목록이 표시됩니다.</div>
                  </div>
                </div>
              </div>
            </div>

            ${adminFeedTabHtml}

            <!-- 탭 2: 📰 시장 뉴스 & 경제 공시 허브 -->
            <div id="tab-news" class="tab-pane">
              <div class="news-control-bar">
                <div class="news-search-box">
                  <input type="text" id="news-search-input" class="news-search-input" placeholder="🔍 종목명, 키워드(월덕, 광산, 카지노, 냥코, 치킨, 복권, 데이터 등) 검색..." oninput="filterNewsList()">
                </div>
                <div class="news-category-filters">
                  <button class="btn-filter active" onclick="selectNewsCategory('ALL')">전체</button>
                  <button class="btn-filter" onclick="selectNewsCategory('WTRD_UPDATE')">월덕</button>
                  <button class="btn-filter" onclick="selectNewsCategory('MINING_BOOM')">광산</button>
                  <button class="btn-filter" onclick="selectNewsCategory('CASINO_JACKPOT')">카지노</button>
                  <button class="btn-filter" onclick="selectNewsCategory('BANK_POLICY')">은행</button>
                  <button class="btn-filter" onclick="selectNewsCategory('NEKO_QUANTUM')">냥코</button>
                  <button class="btn-filter" onclick="selectNewsCategory('FOOD_SURPRISE')">치킨</button>
                  <button class="btn-filter" onclick="selectNewsCategory('LOTTERY_FEVER')">복권</button>
                  <button class="btn-filter" onclick="selectNewsCategory('TECH_INFRA')">데이터</button>
                </div>
              </div>

              <div class="news-feed-grid" id="news-feed-container">
                ${newsFeedHtml || '<p style="color:#9ca3af;">등록된 시장 뉴스가 없습니다.</p>'}
              </div>
            </div>

            <!-- 탭 3: ⛏️ 골드 채굴 클리커 게임 -->
            <div id="tab-clicker" class="tab-pane">
              <div class="clicker-container mine-hub">
                <div class="clicker-box" id="clicker-zone">
                  <div class="mine-head">
                    <div>
                      <h2 style="font-size:16px;font-weight:600;color:#f2f3f5;margin-bottom:4px;">채굴</h2>
                      <p style="color:#949ba4;font-size:13px;margin:0;" id="mine-genre-desc">보석을 클릭해서 현금을 법니다. 장르만 다르고 수익 공식은 같습니다.</p>
                    </div>
                    <div class="mine-weather" id="mine-weather">☀️ 맑음</div>
                  </div>
                  <div class="mine-genre-tabs" id="mine-genre-tabs"></div>
                  <div class="mine-hud">
                    <div>콤보<b id="mine-combo">0</b></div>
                    <div>깊이<b id="mine-depth">0m</b></div>
                    <div>배지<b id="mine-badge">🌱 견습</b></div>
                  </div>
                  <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--card-border); padding: 12px; border-radius: 14px; margin-bottom: 8px; display: flex; justify-content: space-around;">
                    <div>
                      <span style="font-size: 0.75rem; color: #9ca3af; display: block;">클릭당 채굴량</span>
                      <b id="clicker-power-val" style="color: #34d399; font-size: 1.1rem; font-family: inherit;">+${powerVal.toLocaleString()}원</b>
                    </div>
                    <div>
                      <span style="font-size: 0.75rem; color: #9ca3af; display: block;">누적 클릭수</span>
                      <b id="clicker-clicks-val" style="color: #fbbf24; font-size: 1.1rem; font-family: inherit;">${userAssets ? Number(userAssets.totalClicks).toLocaleString() : 0}회</b>
                    </div>
                    <div>
                      <span style="font-size: 0.75rem; color: #9ca3af; display: block;">자동 초당 채굴</span>
                      <b id="clicker-auto-val" style="color: #818cf8; font-size: 1.1rem; font-family: inherit;">+${autoVal.toLocaleString()}원/s</b>
                    </div>
                  </div>
                  <div class="mine-stage" id="mine-stage" data-genre="classic">
                    <button type="button" class="big-click-gem" id="gem-clicker" onclick="handleClickMining(event)">채굴</button>
                  </div>
                  <div class="mine-unlock-bar" id="mine-unlock-bar"></div>
                  <div style="font-size: 0.85rem; font-weight: 600; color: #cbd5e1; margin-top: 10px;" id="click-feedback-msg">
                    광석을 클릭하면 10% 확률로 3배 크리티컬 대박이 터집니다!
                  </div>
                </div>
                <div class="shop-box">
                  <h3 style="font-size:16px;font-weight:600;color:#f2f3f5;margin-bottom:16px;">업그레이드</h3>
                  <div class="shop-item">
                    <div class="shop-item-info">
                      <h4>🔨 클릭 파워 강화 (Lv.<span id="shop-power-lv">${currentClickerLevel}</span>)</h4>
                      <p>클릭당 현금 획득량 +${powerPerLevel.toLocaleString()}원 증가</p>
                    </div>
                    <button class="btn-upgrade" onclick="buyUpgrade('power')"><span id="shop-power-cost">${powerCost.toLocaleString()}원</span> 강화</button>
                  </div>
                  <div class="shop-item">
                    <div class="shop-item-info">
                      <h4>🤖 자동 채굴 봇 (Lv.<span id="shop-auto-lv">${currentAutoLevel}</span>)</h4>
                      <p>아무것도 안 해도 초당 현금 +${autoIncomePerLevel.toLocaleString()}원 자동 채굴</p>
                    </div>
                    <button class="btn-upgrade" onclick="buyUpgrade('auto')"><span id="shop-auto-cost">${autoCost.toLocaleString()}원</span> 구매</button>
                  </div>
                  <div class="mine-board">
                    <h4>장르 순위</h4>
                    <div id="mine-leaderboard"><p style="color:#949ba4;font-size:13px">로그인하면 순위가 열립니다.</p></div>
                  </div>
                  <div class="mine-badges" id="mine-badges"></div>
                </div>
              </div>
            </div>

            <div id="tab-business" class="tab-pane">
              <div class="biz-hud">
                <div class="cx-card">
                  <span class="cx-k">대기 수익</span>
                  <span class="cx-v" id="biz-pending">0원</span>
                </div>
                <div class="cx-card">
                  <span class="cx-k">분당 합계</span>
                  <span class="cx-v" id="biz-income">+0원</span>
                </div>
                <div class="cx-card">
                  <span class="cx-k">투자금</span>
                  <span class="cx-v" id="biz-invested">0원</span>
                </div>
                <button type="button" class="btn-play-game" id="btn-biz-collect-all" onclick="collectBusiness(null)">전체 수금</button>
              </div>
              <div class="biz-hq" id="biz-hq">
                <div>
                  <div class="biz-name">본사</div>
                  <p class="biz-blurb" id="biz-hq-copy">본사 1레벨부터 자동 수금을 켤 수 있습니다. 레벨마다 전체 매출이 올라갑니다.</p>
                </div>
                <div class="biz-actions">
                  <button type="button" class="btn-chip" id="btn-biz-hq" onclick="upgradeHq()">본사 업글</button>
                  <button type="button" class="btn-chip" id="btn-biz-auto" onclick="toggleBizAuto()">자동 수금</button>
                </div>
              </div>
              <p class="casino-desc" style="margin-bottom:12px;">점포는 선행 개업이 필요합니다. 알바는 매출을 올리지만 급여가 빠집니다. 오프라인 수익은 최대 8시간, 매각은 투자금 60%입니다.</p>
              <div class="biz-grid" id="biz-grid">
                <p class="casino-desc">로그인하면 사업을 시작할 수 있습니다.</p>
              </div>
            </div>

            <!-- 탭 4: 웹 카지노 & 도박 -->
            <div id="tab-casino" class="tab-pane">
              <div class="cx-hud">
                <div class="cx-card cx-jackpot"><span class="cx-k">PROGRESSIVE JACKPOT</span><span class="cx-v" id="cx-jackpot">0원</span></div>
                <div class="cx-card"><span class="cx-k">연승 / 연패</span><span class="cx-v" id="cx-streak">-</span></div>
                <div class="cx-card"><span class="cx-k">행운의시간</span><span class="cx-v" id="cx-happy">대기</span><div class="cx-k" id="cx-vip" style="margin-top:6px">VIP</div><button type="button" class="cx-sound-btn" id="cx-vip-claim" style="margin-top:6px;width:100%">VIP 지원금</button></div>
                <button type="button" class="cx-sound-btn" id="cx-sound-btn">사운드 ON</button>
              </div>
              ${renderChipUnit()}
              <div class="cx-card" style="margin-bottom:14px">
                <span class="cx-k">오늘 미션</span>
                <div class="cx-mission-list" id="cx-missions"></div>
              </div>
              <div class="casino-hub-grid">
                
                <!-- 슬롯머신 -->
                <div class="casino-card">
                  <span class="turn-cost-tag">트리플 50배</span>
                  <div class="casino-title">슬롯</div>
                  <p class="casino-desc">7️⃣세븐(50배), 💎다이아(20배), 🔔벨(10배), 그 외 트리플(10배), 페어(1.5배)</p>
                  
                  <div class="slot-display">
                    <div class="slot-reel" id="reel-1">🍒</div>
                    <div class="slot-reel" id="reel-2">7️⃣</div>
                    <div class="slot-reel" id="reel-3">💎</div>
                  </div>
                  <div class="game-call" id="slot-call">릴이 왼쪽부터 순서대로 멈춥니다.</div>

                  <div class="bet-input-group">
                    <label>배팅 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="text" id="slot-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                      ${renderBetPlus('slot-bet')}
                    </div>
                    ${renderBetChips('slot-bet')}
                  </div>

                  <button class="btn-play-game" id="btn-spin-slot" onclick="playSlotMachine()">돌리기</button>
                  <div class="game-result-box" id="slot-result">배팅금을 정하고 레버를 당겨보세요!</div>
                </div>

                <!-- 동전 던지기 -->
                <div class="casino-card">
                  <span class="turn-cost-tag">1.9배</span>
                  <div class="casino-title">동전</div>
                  <p class="casino-desc">앞면 또는 뒷면을 선택하고 동전을 던져 1.9배의 보상을 획득하세요!</p>
                  
                  <div class="coin-box" id="coin-element">🦅</div>
                  <div class="game-call" id="coin-call">앞면 또는 뒷면을 고른 뒤 던져보세요.</div>

                  <div class="choice-btn-group">
                    <button class="btn-choice selected" id="choice-front" onclick="selectCoinChoice('앞면')">앞면</button>
                    <button class="btn-choice" id="choice-back" onclick="selectCoinChoice('뒷면')">뒷면</button>
                  </div>

                  <div class="bet-input-group">
                    <label>배팅 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="text" id="coin-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                      ${renderBetPlus('coin-bet')}
                    </div>
                    ${renderBetChips('coin-bet')}
                  </div>

                  <button class="btn-play-game" id="btn-flip-coin" onclick="playCoinFlip()">던지기</button>
                  <div class="game-result-box" id="coin-result">앞면/뒷면을 고르고 동전을 던져보세요!</div>
                </div>

                <!-- 주사위 대결 -->
                <div class="casino-card">
                  <span class="turn-cost-tag">1.9배 · 무승부 환불</span>
                  <div class="casino-title">주사위</div>
                  <p class="casino-desc">나와 딜러가 각각 2개의 주사위를 굴려 더 높은 숫자가 나오면 1.9배 승리!</p>
                  
                  <div class="slot-display" style="gap: 25px;">
                    <div class="dice-side">
                      <span class="dice-side-label">나의 주사위</span>
                      <div class="dice-pair" id="user-dice-box"></div>
                    </div>
                    <div class="dice-vs">VS</div>
                    <div class="dice-side">
                      <span class="dice-side-label">딜러 주사위</span>
                      <div class="dice-pair" id="bot-dice-box"></div>
                    </div>
                  </div>

                  <div class="bet-input-group">
                    <label>배팅 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="text" id="dice-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                      ${renderBetPlus('dice-bet')}
                    </div>
                    ${renderBetChips('dice-bet')}
                  </div>

                  <button class="btn-play-game" id="btn-roll-dice" onclick="playDice()">굴리기</button>
                  <div class="game-call" id="dice-call">내 주사위가 먼저 멈추고, 이어서 딜러가 받습니다.</div>
                  <div class="game-result-box" id="dice-result">딜러와의 한판 승부! 주사위를 굴려보세요.</div>
                </div>

                <!-- 🎫 럭키세븐 즉석 복권 -->
                <div class="casino-card">
                  <span class="turn-cost-tag">트리플 최대 40배</span>
                  <div class="casino-title">복권</div>
                  <p class="casino-desc">💎다이아(40배), 7️⃣세븐(20배), 🦆오리(12배), 💰머니(8배), 그 외 트리플(4배), 페어(1.2배)</p>
                  
                  <div class="slot-display">
                    <div class="slot-reel" id="lottery-slot-1">?</div>
                    <div class="slot-reel" id="lottery-slot-2">?</div>
                    <div class="slot-reel" id="lottery-slot-3">?</div>
                  </div>
                  <div class="game-call" id="lottery-call">칸을 왼쪽부터 한 장씩 긁습니다.</div>

                  <div class="bet-input-group">
                    <label>복권 구매 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="text" id="lottery-bet" class="bet-input" value="1000" inputmode="decimal" placeholder="1천 또는 1양">
                      ${renderBetPlus('lottery-bet')}
                    </div>
                    ${renderBetChips('lottery-bet')}
                  </div>

                  <button class="btn-play-game" id="btn-scratch-lottery" onclick="playInstantLottery()">긁기</button>
                  <div class="game-result-box" id="lottery-result">복권 장수를 정하고 즉석 복권을 긁어보세요!</div>
                </div>

                <div class="casino-card">
                  <span class="turn-cost-tag">2배 / 15배</span>
                  <div class="casino-title">룰렛</div>
                  <p class="casino-desc">레드·블랙 2배(각 47%), 그린 15배(6%). 유럽식 하우스 엣지에 가깝게 맞춤.</p>
                  <div class="roulette-stage">
                    <div class="roulette-pointer"></div>
                    <div class="roulette-wheel" id="roulette-wheel">
                      <div class="roulette-hub" id="roulette-hub">?</div>
                    </div>
                    <div class="game-call" id="roulette-call">레드·블랙·그린 중 하나를 고르세요.</div>
                  </div>
                  <div class="roulette-felt">
                    <button type="button" class="roulette-chip red selected" id="roulette-red" onclick="selectRoulette('RED')">R</button>
                    <button type="button" class="roulette-chip black" id="roulette-black" onclick="selectRoulette('BLACK')">B</button>
                    <button type="button" class="roulette-chip green" id="roulette-green" onclick="selectRoulette('GREEN')">0</button>
                  </div>
                  <div class="bet-input-group">
                    <label>배팅 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="text" id="roulette-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                      ${renderBetPlus('roulette-bet')}
                    </div>
                    ${renderBetChips('roulette-bet')}
                  </div>
                  <button class="btn-play-game" id="btn-spin-roulette" onclick="playRoulette()">돌리기</button>
                  <div class="game-result-box" id="roulette-result">색을 고르고 돌리세요.</div>
                </div>

                <div class="casino-card">
                  <span class="turn-cost-tag">2배 / BJ 2.5배</span>
                  <div class="casino-title">블랙잭</div>
                  <p class="casino-desc">히트·스탠드. 블랙잭은 2.5배, 승 2배, 푸시 환불. 딜러는 16에서 히트.</p>
                  <div class="bj-hand"><span class="bj-label">딜러</span><div id="bj-dealer">—</div></div>
                  <div class="bj-hand"><span class="bj-label">나</span><div id="bj-player">—</div></div>
                  <div class="game-call" id="bj-call">히트 또는 스탠드. 딜러는 16에서 히트합니다.</div>
                  <div class="bet-input-group">
                    <label>배팅 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="text" id="bj-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                      ${renderBetPlus('bj-bet')}
                    </div>
                    ${renderBetChips('bj-bet')}
                  </div>
                  <div style="display:flex;gap:8px;">
                    <button class="btn-play-game" id="btn-bj-start" onclick="startBlackjack()">딜</button>
                    <button class="btn-play-game" id="btn-bj-hit" onclick="hitBlackjack()" disabled>히트</button>
                    <button class="btn-play-game" id="btn-bj-stand" onclick="standBlackjack()" disabled>스탠드</button>
                  </div>
                  <div class="game-result-box" id="bj-result">배팅 후 딜을 누르세요.</div>
                </div>

                <div class="casino-card pk-card-wrap">
                  <span class="turn-cost-tag">팟 승자 전액</span>
                  <div class="casino-title">포커</div>
                  <p class="casino-desc">텍사스 홀덤 vs 딜러. 시작 시 양쪽 유닛(블라인드)이 팟에 들어갑니다. 체크·벳·콜·폴드·올인. 승자가 팟을 가져갑니다.</p>
                  <div class="pk-felt" id="pk-felt">
                    <div class="pk-row">
                      <span class="bj-label">딜러 <span id="pk-mood"></span></span>
                      <div id="pk-dealer">—</div>
                      <span class="pk-hand-name" id="pk-dealer-hand"></span>
                    </div>
                    <div class="pk-board-row">
                      <span class="bj-label">보드</span>
                      <div id="pk-board">—</div>
                    </div>
                    <div class="pk-row">
                      <span class="bj-label">나</span>
                      <div id="pk-player">—</div>
                      <span class="pk-hand-name" id="pk-player-hand"></span>
                    </div>
                    <div class="pk-meta">
                      <span id="pk-street">대기</span>
                      <span id="pk-pot">팟 0원</span>
                    </div>
                  </div>
                  <div class="game-call" id="pk-call">유닛을 정한 뒤 딜을 누르면 핸드가 시작됩니다.</div>
                  <div class="bet-input-group">
                    <label>유닛 (블라인드, 원)</label>
                    <div class="bet-input-row">
                      <input type="text" id="pk-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                      ${renderBetPlus('pk-bet')}
                    </div>
                    ${renderBetChips('pk-bet')}
                  </div>
                  <div class="pk-actions">
                    <button class="btn-play-game" id="btn-pk-start" onclick="startPoker()">딜</button>
                    <button class="btn-play-game" id="btn-pk-fold" onclick="pokerAct('fold')" disabled>폴드</button>
                    <button class="btn-play-game" id="btn-pk-check" onclick="pokerAct('check')" disabled>체크</button>
                    <button class="btn-play-game" id="btn-pk-call" onclick="pokerAct('call')" disabled>콜</button>
                    <button class="btn-play-game" id="btn-pk-bet" onclick="pokerAct('bet')" disabled>벳</button>
                    <button class="btn-play-game" id="btn-pk-allin" onclick="pokerAct('allin')" disabled>올인</button>
                  </div>
                  <div class="game-result-box" id="pk-result">배팅 후 딜을 누르세요.</div>
                  <div class="pk-history" id="pk-history"></div>
                </div>

                <div class="casino-card pk-card-wrap">
                  <span class="turn-cost-tag">팟 승자 전액</span>
                  <div class="casino-title">세븐포커</div>
                  <p class="casino-desc">7카드 스터드 vs 딜러. 3장(숨김 2+오픈 1)부터 시작해 4·5·6 오픈, 7번째는 숨김. 최선 5장 족보. 승자가 팟을 가져갑니다.</p>
                  <div class="pk-felt" id="sp-felt">
                    <div class="pk-row">
                      <span class="bj-label">딜러 <span id="sp-mood"></span></span>
                      <div id="sp-dealer">—</div>
                      <span class="pk-hand-name" id="sp-dealer-hand"></span>
                    </div>
                    <div class="pk-row">
                      <span class="bj-label">나</span>
                      <div id="sp-player">—</div>
                      <span class="pk-hand-name" id="sp-player-hand"></span>
                    </div>
                    <div class="pk-meta">
                      <span id="sp-street">대기</span>
                      <span id="sp-pot">팟 0원</span>
                    </div>
                  </div>
                  <div class="game-call" id="sp-call">유닛을 정한 뒤 딜을 누르면 3스트리트가 시작됩니다.</div>
                  <div class="bet-input-group">
                    <label>유닛 (블라인드, 원)</label>
                    <div class="bet-input-row">
                      <input type="text" id="sp-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                      ${renderBetPlus('sp-bet')}
                    </div>
                    ${renderBetChips('sp-bet')}
                  </div>
                  <div class="pk-actions">
                    <button class="btn-play-game" id="btn-sp-start" onclick="startSevenPoker()">딜</button>
                    <button class="btn-play-game" id="btn-sp-fold" onclick="sevenPokerAct('fold')" disabled>폴드</button>
                    <button class="btn-play-game" id="btn-sp-check" onclick="sevenPokerAct('check')" disabled>체크</button>
                    <button class="btn-play-game" id="btn-sp-call" onclick="sevenPokerAct('call')" disabled>콜</button>
                    <button class="btn-play-game" id="btn-sp-bet" onclick="sevenPokerAct('bet')" disabled>벳</button>
                    <button class="btn-play-game" id="btn-sp-allin" onclick="sevenPokerAct('allin')" disabled>올인</button>
                  </div>
                  <div class="game-result-box" id="sp-result">배팅 후 딜을 누르세요.</div>
                  <div class="pk-history" id="sp-history"></div>
                </div>

                <div class="casino-card">
                  <span class="turn-cost-tag">60+ 1.8배 / 90+ 3.5배</span>
                  <div class="casino-title">하이로우</div>
                  <p class="casino-desc">1~100. 60 이상 1.8배, 90 이상 3.5배. 기대값은 하우스 약 11%.</p>
                  <div class="hl-stage">
                    <div class="hl-meter" id="hl-roll">—</div>
                    <div class="hl-bar"><div class="hl-fill" id="hl-fill"></div></div>
                    <div class="game-call" id="hl-call">60 이상 1.8배 · 90 이상 3.5배</div>
                  </div>
                  <div class="bet-input-group">
                    <label>배팅 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="text" id="hl-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                      ${renderBetPlus('hl-bet')}
                    </div>
                    ${renderBetChips('hl-bet')}
                  </div>
                  <button class="btn-play-game" id="btn-hl" onclick="playHighLow()">굴리기</button>
                  <div class="game-result-box" id="hl-result">60 이상을 노립니다.</div>
                </div>

              </div>
            </div>

            <div id="tab-hot" class="tab-pane">
              ${renderChipUnit()}
              <div class="hot-lobby">
                <div class="cx-card">
                  <div class="cx-k">가상 토토</div>
                  <div class="casino-title" style="margin-bottom:8px">승부예측</div>
                  <p class="casino-desc">2~3분마다 자동 정산. 배당은 경기마다 다릅니다.</p>
                  <div class="bet-input-group">
                    <label>배팅 금액</label>
                    <div class="bet-input-row">
                      <input type="text" id="toto-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                      ${renderBetPlus('toto-bet')}
                    </div>
                    ${renderBetChips('toto-bet')}
                  </div>
                  <button type="button" class="btn-play-game" id="btn-toto-reload">경기 새로고침</button>
                  <div id="toto-list"></div>
                </div>
                <div>
                  <div class="cx-card" style="margin-bottom:12px">
                    <div class="cx-k">CRASH</div>
                    <div class="crash-board" id="crash-board">
                      <div class="crash-mult" id="crash-mult">1.00x</div>
                      <div class="crash-phase" id="crash-phase">배팅 대기</div>
                      <div class="crash-call" id="crash-call">배팅 창이 열리면 타고, 비행 중 타이밍을 봐서 탈출하세요.</div>
                    </div>
                    <div class="crash-history" id="crash-history"></div>
                    <div class="bet-input-group" style="margin-top:10px">
                      <div class="bet-input-row">
                        <input type="text" id="crash-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                        ${renderBetPlus('crash-bet')}
                      </div>
                      ${renderBetChips('crash-bet')}
                    </div>
                    <div style="display:flex;gap:8px">
                      <button type="button" class="btn-play-game" id="btn-crash-bet">배팅</button>
                      <button type="button" class="btn-play-game" id="btn-crash-out">탈출</button>
                    </div>
                  </div>
                  <div class="cx-card" style="margin-bottom:12px">
                    <div class="cx-k">MINES</div>
                    <div class="mines-grid" id="mines-grid"></div>
                    <div class="bet-input-group">
                      <div class="bet-input-row">
                        <input type="text" id="mines-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                        ${renderBetPlus('mines-bet')}
                      </div>
                      ${renderBetChips('mines-bet')}
                      <label>지뢰 수</label>
                      <select id="mines-count" class="bet-input"><option>3</option><option selected>5</option><option>8</option><option>10</option></select>
                    </div>
                    <div style="display:flex;gap:8px">
                      <button type="button" class="btn-play-game" id="btn-mines-start">시작</button>
                      <button type="button" class="btn-play-game" id="btn-mines-cashout">탈출</button>
                    </div>
                    <div class="game-result-box" id="mines-result">칸을 열고 지뢰를 피하세요.</div>
                  </div>
                  <div class="cx-card">
                    <div class="cx-k">PLINKO</div>
                    <div class="plinko-board" id="plinko-board"></div>
                    <div class="bet-input-group">
                      <div class="bet-input-row">
                        <input type="text" id="plinko-bet" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양">
                        ${renderBetPlus('plinko-bet')}
                      </div>
                      ${renderBetChips('plinko-bet')}
                      <select id="plinko-risk" class="bet-input">
                        <option value="low">로우</option>
                        <option value="med" selected>미디엄</option>
                        <option value="high">하이</option>
                      </select>
                    </div>
                    <button type="button" class="btn-play-game" id="btn-plinko">떨어뜨리기</button>
                    <div class="game-result-box" id="plinko-result">공이 떨어질 칸을 운에 맡기세요.</div>
                  </div>
                </div>
              </div>
            </div>

            <div id="tab-arcade" class="tab-pane">
              <div class="arc-wrap">
                <div class="arc-hud">
                  <div class="arc-lv"><span class="arc-k">LEVEL</span><span id="arc-level">1</span></div>
                  <div class="arc-xp">
                    <div class="arc-xp-meta"><span class="arc-k">NEXT</span><span id="arc-xp-label">0 / 140</span></div>
                    <div class="arc-xp-bar"><i id="arc-xp-fill"></i></div>
                  </div>
                  <div class="arc-life" id="arc-life">예전에 번 돈과 배팅 이력이 경험치가 됩니다. 레벨이 오르면 모드가 열립니다.</div>
                </div>
                <div class="arc-actions" id="arc-actions">
                  <button type="button" class="arc-act" id="arc-btn-rebirth">환생</button>
                  <button type="button" class="arc-act" id="arc-btn-shop">환생 상점</button>
                  <button type="button" class="arc-act" id="arc-btn-portal">세계 포탈</button>
                  <span class="arc-rp" data-lvl-rp>RP 0</span>
                  <span class="arc-rebirth-hint" id="arc-rebirth-hint">만렙(Lv.40)에 도달하면 환생할 수 있습니다.</span>
                </div>
                <p class="casino-desc">원래 #카지노 · #핫게임 · #경마는 그대로 있습니다. 여기는 다른 화면으로 같은 게임을 하는 모드입니다.</p>
                <div id="arc-ranks" class="arc-ranks"></div>
                <div id="arc-lobby" class="arc-lobby"></div>
              </div>
              <div id="arcade-stage" class="arc-stage" hidden></div>
            </div>

            <!-- 탭: 🏇 월덕 그랑프리 실시간 경마장 -->
            <div id="tab-horse" class="tab-pane">
              <div class="horse-board">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; border-bottom: 1px solid var(--card-border); padding-bottom: 14px;">
                  <div>
                    <h2 style="font-size:16px;font-weight:600;color:#f2f3f5;display:flex;align-items:center;gap:8px;">
                      경마
                    </h2>
                    <p style="color: #9ca3af; font-size: 0.85rem; margin-top: 4px;">단승·복승·연승·복연승·쌍승. 시간대마다 주로 날씨가 바뀌고 배당도 함께 움직입니다.</p>
                  </div>
                  <span style="background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24; padding: 6px 14px; border-radius: 999px; font-weight: 700; font-size: 0.8rem;">
                    🏆 쌍승 최대 80배
                  </span>
                </div>

                <div class="horse-condition" id="horse-condition-banner">
                  <span style="font-size:1.4rem;" id="horse-cond-emoji">☀️</span>
                  <div>
                    <div style="font-weight:800;color:#fde68a;" id="horse-cond-title">주로 정보를 불러오는 중...</div>
                    <div style="font-size:0.78rem;color:#9ca3af;" id="horse-cond-desc">시간대별 날씨가 배당에 반영됩니다.</div>
                  </div>
                </div>

                <div class="horse-mode-row" id="horse-mode-row">
                  <button type="button" class="horse-mode-btn selected" data-mode="win" onclick="setHorseBetMode('win')">단승<small>1착만</small></button>
                  <button type="button" class="horse-mode-btn" data-mode="place" onclick="setHorseBetMode('place')">복승<small>1·2착</small></button>
                  <button type="button" class="horse-mode-btn" data-mode="show" onclick="setHorseBetMode('show')">연승<small>1~3착</small></button>
                  <button type="button" class="horse-mode-btn" data-mode="quinella" onclick="setHorseBetMode('quinella')">복연승<small>1·2착 조합</small></button>
                  <button type="button" class="horse-mode-btn" data-mode="exacta" onclick="setHorseBetMode('exacta')">쌍승<small>1착→2착</small></button>
                </div>

                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px;">
                  <div class="horse-card selected" id="horse-card-1" onclick="selectHorse(1)" style="cursor: pointer; background: rgba(0,0,0,0.4); border: 2px solid #fbbf24; border-radius: 12px; padding: 14px; text-align: center; transition: all 0.2s;">
                    <div style="font-size: 1.8rem;">⚡</div>
                    <div style="font-weight: 800; color: #fff; font-size: 1rem; margin-top: 4px;">1번 황금번개</div>
                    <div id="horse-odds-1" style="color: #fbbf24; font-weight: 800; font-size: 1.1rem; margin: 4px 0;">2.0배</div>
                    <div class="horse-sub-odds" id="horse-sub-1" style="font-size: 0.72rem; color: #9ca3af;">복승 / 연승 배당은 카드 선택 후 확인</div>
                    <div class="horse-pick-tag" id="horse-tag-1"></div>
                  </div>
                  <div class="horse-card" id="horse-card-2" onclick="selectHorse(2)" style="cursor: pointer; background: rgba(0,0,0,0.4); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px; text-align: center; transition: all 0.2s;">
                    <div style="font-size: 1.8rem;">🌪️</div>
                    <div style="font-weight: 800; color: #fff; font-size: 1rem; margin-top: 4px;">2번 질풍노도</div>
                    <div id="horse-odds-2" style="color: #38bdf8; font-weight: 800; font-size: 1.1rem; margin: 4px 0;">3.0배</div>
                    <div class="horse-sub-odds" id="horse-sub-2" style="font-size: 0.72rem; color: #9ca3af;">균형형</div>
                    <div class="horse-pick-tag" id="horse-tag-2"></div>
                  </div>
                  <div class="horse-card" id="horse-card-3" onclick="selectHorse(3)" style="cursor: pointer; background: rgba(0,0,0,0.4); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px; text-align: center; transition: all 0.2s;">
                    <div style="font-size: 1.8rem;">🖤</div>
                    <div style="font-weight: 800; color: #fff; font-size: 1rem; margin-top: 4px;">3번 다크호스</div>
                    <div id="horse-odds-3" style="color: #a855f7; font-weight: 800; font-size: 1.1rem; margin: 4px 0;">5.0배</div>
                    <div class="horse-sub-odds" id="horse-sub-3" style="font-size: 0.72rem; color: #9ca3af;">복병마</div>
                    <div class="horse-pick-tag" id="horse-tag-3"></div>
                  </div>
                  <div class="horse-card" id="horse-card-4" onclick="selectHorse(4)" style="cursor: pointer; background: rgba(0,0,0,0.4); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px; text-align: center; transition: all 0.2s;">
                    <div style="font-size: 1.8rem;">🦆</div>
                    <div style="font-weight: 800; color: #fff; font-size: 1rem; margin-top: 4px;">4번 월덕스피릿</div>
                    <div id="horse-odds-4" style="color: #f43f5e; font-weight: 800; font-size: 1.1rem; margin: 4px 0;">8.0배</div>
                    <div class="horse-sub-odds" id="horse-sub-4" style="font-size: 0.72rem; color: #9ca3af;">커뮤니티 대표마</div>
                    <div class="horse-pick-tag" id="horse-tag-4"></div>
                  </div>
                  <div class="horse-card" id="horse-card-5" onclick="selectHorse(5)" style="cursor: pointer; background: rgba(0,0,0,0.4); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px; text-align: center; transition: all 0.2s;">
                    <div style="font-size: 1.8rem;">💎</div>
                    <div style="font-weight: 800; color: #fff; font-size: 1rem; margin-top: 4px;">5번 로또잭팟</div>
                    <div id="horse-odds-5" style="color: #ec4899; font-weight: 800; font-size: 1.1rem; margin: 4px 0;">15.0배</div>
                    <div class="horse-sub-odds" id="horse-sub-5" style="font-size: 0.72rem; color: #9ca3af;">인생역전 잭팟</div>
                    <div class="horse-pick-tag" id="horse-tag-5"></div>
                  </div>
                </div>

                ${renderChipUnit()}
                <div style="background: rgba(0,0,0,0.25); border: 1px solid var(--card-border); border-radius: 12px; padding: 16px; margin-bottom: 20px;">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <label style="font-size: 0.85rem; color: #9ca3af; font-weight: 600;">배팅 금액 (원)</label>
                    <span style="font-size: 0.8rem; color: #34d399;">선택: <b id="selected-horse-txt" style="color: #fbbf24;">단승 · 1번 황금번개</b></span>
                  </div>
                  <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                    <input type="text" id="horse-bet-input" class="bet-input" value="5000" inputmode="decimal" placeholder="5천 또는 1양" style="flex: 1;">
                    ${renderBetPlus('horse-bet-input')}
                    <button id="btn-start-race" class="btn-play-game btn-race" onclick="startWebHorseRace()">경주 시작</button>
                  </div>
                    ${renderBetChips('horse-bet-input', [[100000, '+10만']])}
                </div>

                <div style="background: #090d16; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; position: relative; overflow: hidden;">
                  <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: #64748b; margin-bottom: 12px; border-bottom: 1px dashed rgba(255,255,255,0.1); padding-bottom: 6px;">
                    <span>🚩 출발선 (START)</span>
                    <span id="race-status-banner" style="font-weight: 700; color: #fbbf24;">🏇 레이스 대기 중</span>
                    <span>🏁 결승선 (FINISH)</span>
                  </div>

                  <div style="display: flex; flex-direction: column; gap: 12px;" id="race-lanes-box">
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 0.8rem; font-weight: 700; color: #fbbf24; width: 85px;">1. 황금번개</span>
                      <div style="flex: 1; background: rgba(255,255,255,0.05); height: 26px; border-radius: 6px; position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div id="horse-runner-1" style="position: absolute; left: 0%; top: 2px; font-size: 1.1rem; transition: left 0.3s ease-out;">⚡🏇</div>
                      </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 0.8rem; font-weight: 700; color: #38bdf8; width: 85px;">2. 질풍노도</span>
                      <div style="flex: 1; background: rgba(255,255,255,0.05); height: 26px; border-radius: 6px; position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div id="horse-runner-2" style="position: absolute; left: 0%; top: 2px; font-size: 1.1rem; transition: left 0.3s ease-out;">🌪️🏇</div>
                      </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 0.8rem; font-weight: 700; color: #a855f7; width: 85px;">3. 다크호스</span>
                      <div style="flex: 1; background: rgba(255,255,255,0.05); height: 26px; border-radius: 6px; position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div id="horse-runner-3" style="position: absolute; left: 0%; top: 2px; font-size: 1.1rem; transition: left 0.3s ease-out;">🖤🏇</div>
                      </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 0.8rem; font-weight: 700; color: #f43f5e; width: 85px;">4. 월덕스피릿</span>
                      <div style="flex: 1; background: rgba(255,255,255,0.05); height: 26px; border-radius: 6px; position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div id="horse-runner-4" style="position: absolute; left: 0%; top: 2px; font-size: 1.1rem; transition: left 0.3s ease-out;">🦆🏇</div>
                      </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 0.8rem; font-weight: 700; color: #ec4899; width: 85px;">5. 로또잭팟</span>
                      <div style="flex: 1; background: rgba(255,255,255,0.05); height: 26px; border-radius: 6px; position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div id="horse-runner-5" style="position: absolute; left: 0%; top: 2px; font-size: 1.1rem; transition: left 0.3s ease-out;">💎🏇</div>
                      </div>
                    </div>
                  </div>

                  <div id="horse-podium" class="horse-podium"></div>
                  <div id="horse-race-result-box" style="margin-top: 16px; padding: 12px; background: rgba(0,0,0,0.5); border-radius: 8px; text-align: center; font-size: 0.95rem; font-weight: 700; color: #9ca3af;">
                    배팅 종류를 고르고 출전마를 선택한 뒤 [경주 시작]을 누르세요.
                  </div>
                </div>

              </div>
            </div>

            <!-- 탭 6: 순위표 -->
            <div id="tab-ranking" class="tab-pane">
              <h2 class="section-title">일반 유저 자산 순위</h2>
              <div class="leaderboard-card">
                <table>
                  <thead>
                    <tr>
                      <th>순위</th>
                      <th>유저</th>
                      <th style="text-align: right;">총 자산 (현금 + 예금 + 주식)</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${leaderboardRowsHtml}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 탭: 🏦 P2P 사채/대부업 & 법원 강제집행 센터 -->
            <div id="tab-p2p" class="tab-pane">
              <div class="channel-header" style="margin-bottom: 16px;">
                <div class="channel-title-wrap">
                  <h1 class="channel-name" style="color: #38bdf8;">🏦 P2P 대부업 & 법원 강제집행 센터</h1>
                </div>
                <p class="channel-topic">유저 간 사채/대출 거래, 주식·예금 담보 설정, 법정최고이자(최대 30%), 이자세(15%) 및 법원 자동승인 강제징수(추심)</p>
              </div>

              <!-- 대부업 면허 카드 -->
              <div style="background: linear-gradient(135deg, rgba(15,23,42,0.95), rgba(30,41,59,0.9)); border: 1px solid rgba(56,189,248,0.3); border-radius: 12px; padding: 18px; margin-bottom: 20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                  <div>
                    <h3 style="font-size:1.1rem; color:#38bdf8; margin-bottom:4px;" id="p2p-lic-title">🏢 공인 대부업 면허 상태: <span style="color:#9ca3af;">조회 중...</span></h3>
                    <p style="font-size:0.8rem; color:#9ca3af;" id="p2p-lic-desc">대부업 면허(50만원 면허세 국고 납부)가 있어야 다른 유저에게 대출을 제안할 수 있습니다.</p>
                  </div>
                  <div id="p2p-lic-action">
                    <button type="button" class="btn-play-game" onclick="claimWebP2PLicense()" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">🏛️ 대부업 면허 발급 (50만원)</button>
                  </div>
                </div>
              </div>

              <!-- 대출 제안 등록 폼 & 계약 관리 그리드 -->
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px;">
                
                <!-- 1. 새 대출 제안서 작성 -->
                <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--card-border); border-radius: 12px; padding: 16px;">
                  <h3 style="font-size:1rem; color:#fbbf24; margin-bottom:12px;">📝 새 P2P 대출 제안서 등록</h3>
                  <div style="display:flex; flex-direction:column; gap:10px;">
                    <div>
                      <label style="font-size:0.8rem; color:#9ca3af;">차입자 (Discord ID 또는 @닉네임)</label>
                      <input type="text" id="p2p-input-target" class="bet-input" placeholder="상대방 ID 또는 닉네임">
                    </div>
                    <div style="display:flex; gap:8px;">
                      <div style="flex:1;">
                        <label style="font-size:0.8rem; color:#9ca3af;">원금 (원)</label>
                        <input type="text" id="p2p-input-principal" class="bet-input" placeholder="예: 100만, 500000">
                      </div>
                      <div style="width:110px;">
                        <label style="font-size:0.8rem; color:#9ca3af;">이자율 % (최대30%)</label>
                        <input type="number" id="p2p-input-rate" class="bet-input" placeholder="20" min="0" max="30" step="0.5">
                      </div>
                    </div>
                    <div style="display:flex; gap:8px;">
                      <div style="flex:1;">
                        <label style="font-size:0.8rem; color:#9ca3af;">만기 기간 (시간)</label>
                        <input type="number" id="p2p-input-hours" class="bet-input" placeholder="24" min="1" max="720">
                      </div>
                      <div style="flex:1;">
                        <label style="font-size:0.8rem; color:#9ca3af;">담보 설정</label>
                        <select id="p2p-input-coltype" class="bet-input" onchange="toggleP2PColInputs(this.value)">
                          <option value="none">❌ 무담보 (신용)</option>
                          <option value="stock">📈 주식 담보</option>
                          <option value="bank">🏦 예금 담보</option>
                        </select>
                      </div>
                    </div>
                    <div id="p2p-col-stock-group" style="display:none; gap:8px;">
                      <div style="flex:1;">
                        <label style="font-size:0.8rem; color:#9ca3af;">담보 종목 코드</label>
                        <input type="text" id="p2p-input-stockid" class="bet-input" placeholder="예: WTRD, MINE, TECH">
                      </div>
                      <div style="flex:1;">
                        <label style="font-size:0.8rem; color:#9ca3af;">담보 주식 수량</label>
                        <input type="number" id="p2p-input-stockamt" class="bet-input" placeholder="주식 수" min="1">
                      </div>
                    </div>
                    <div id="p2p-col-bank-group" style="display:none;">
                      <label style="font-size:0.8rem; color:#9ca3af;">담보 예금 금액</label>
                      <input type="text" id="p2p-input-bankamt" class="bet-input" placeholder="예: 50만">
                    </div>
                    <button type="button" class="btn-play-game" onclick="submitWebP2POffer()" style="margin-top:6px;">💰 대출 제안서 발행하기</button>
                  </div>
                </div>

                <!-- 2. 대부업 법률 & 법원 안내 -->
                <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--card-border); border-radius: 12px; padding: 16px;">
                  <h3 style="font-size:1rem; color:#a5b4fc; margin-bottom:10px;">⚖️ 대부업 금융 법률 & 법원 강제집행 규정</h3>
                  <div style="font-size:0.82rem; color:#cbd5e1; line-height:1.6;">
                    <p style="margin-bottom:8px;">• **법정 최고 이자율 30% 준수**: 폭리 방지를 위해 30%를 초과하는 고리대금은 시스템에서 원천 차단됩니다.</p>
                    <p style="margin-bottom:8px;">• **이자 소득세 15% 원천징수**: 차입자가 상환할 때 발생한 이자의 15%는 국고 세금으로 자동 징수됩니다.</p>
                    <p style="margin-bottom:8px;">• **주식/예금 담보 동결**: 계약 체결 시 차입자의 자산이 안전하게 락업(동결)됩니다.</p>
                    <p>• **⚖️ 법원 자동 강제집행 (추심)**: 만기일까지 빚을 갚지 않으면 채권자가 법원에 강제 징수를 신청하여 담보 몰수 및 차입자 계좌를 강제 압류할 수 있습니다.</p>
                  </div>
                </div>
              </div>

              <!-- 내가 빌려준 대출 (채권) 테이블 -->
              <h3 style="font-size:1rem; color:#38bdf8; margin:20px 0 10px;">💰 내가 빌려준 대출 목록 (채권 관리 & 법원 강제집행)</h3>
              <div class="leaderboard-table-wrap" style="margin-bottom:24px;">
                <table class="leaderboard-table">
                  <thead>
                    <tr>
                      <th>대출#</th>
                      <th>차입자</th>
                      <th style="text-align:right;">원금</th>
                      <th style="text-align:right;">만기 상환액</th>
                      <th>이자율</th>
                      <th>담보</th>
                      <th>상태</th>
                      <th>만기일</th>
                      <th>관리</th>
                    </tr>
                  </thead>
                  <tbody id="p2p-lent-tbody">
                    <tr><td colspan="9" style="text-align:center; color:#9ca3af;">대출 장부를 불러오는 중...</td></tr>
                  </tbody>
                </table>
              </div>

              <!-- 내가 빌린 대출 (채무) 테이블 -->
              <h3 style="font-size:1rem; color:#f87171; margin:20px 0 10px;">💳 내가 빌린 대출 목록 (채무 상환 & 계약 수락)</h3>
              <div class="leaderboard-table-wrap">
                <table class="leaderboard-table">
                  <thead>
                    <tr>
                      <th>대출#</th>
                      <th>대부업자(채권자)</th>
                      <th style="text-align:right;">원금</th>
                      <th style="text-align:right;">상환해야 할 총액</th>
                      <th>이자율</th>
                      <th>담보</th>
                      <th>상태</th>
                      <th>만기일</th>
                      <th>작업</th>
                    </tr>
                  </thead>
                  <tbody id="p2p-borrowed-tbody">
                    <tr><td colspan="9" style="text-align:center; color:#9ca3af;">채무 내역을 불러오는 중...</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 💬 24시간 1:1 고객센터 & 관리자 문의창구 배너 -->
            <div class="support-footer-banner">
              <div class="support-banner-left">
                <div class="support-avatar-badge">🎧</div>
                <div>
                  <h3 class="support-title">문의</h3>
                  <p class="support-subtitle">오류, 복구, 건의는 여기로 남기면 됩니다.</p>
                </div>
              </div>
              <div class="support-banner-right">
                <button class="btn-support-action btn-support-write" onclick="openInquiryModal()">문의하기</button>
                <button class="btn-support-action btn-support-view" onclick="openProfileModal('inquiries')">내 문의</button>
              </div>
            </div>

            <!-- 🌐 사이트 푸터 & 개인정보처리방침 링크 -->
            <footer class="app-site-footer">
              <div class="footer-content">
                <div class="footer-brand">
                  <div class="footer-logo">월덕</div>
                  <p class="footer-desc">디스코드 봇과 연동되는 가상 경제.</p>
                </div>
                <div class="footer-links">
                  <a href="/privacy" class="footer-link highlight">🔒 개인정보처리방침</a>
                  <a href="/terms" class="footer-link">📜 서비스 이용약관</a>
                  <a href="javascript:void(0)" onclick="openInquiryModal()" class="footer-link">✍️ 1:1 고객센터</a>
                  <a href="https://status.easy-scraping.com" class="footer-link" target="_blank" rel="noopener">📡 서비스 상태</a>
                  <a href="/auth/guide" class="footer-link">⚙️ OAuth 안내</a>
                </div>
              </div>
              <div class="footer-bottom">
                <span>© 2026 Duck Economy Project. All rights reserved. 본 웹 애플리케이션의 모든 가상 화폐 및 주식은 Discord 봇 게임용 가상 데이터입니다.</span>
              </div>
            </footer>
              </div>
            </div>

            <aside class="member-rail" id="member-rail">
              <button type="button" class="member-rail-close" onclick="closeDrawers()" aria-label="자산 패널 닫기">×</button>
              ${heroSectionHtml}
            </aside>
          </div>

          ${renderHelpPopupHtml()}

          <!-- 🔍 종목 상세 분석 & 고해상도 차트 모달 -->
          <div class="modal-overlay" id="detail-modal">
            <div class="modal-box">
              <div class="modal-title">
                <span id="detail-stock-name">종목 상세 분석</span>
                <button class="btn-close-modal" onclick="closeDetailModal()">&times;</button>
              </div>

              <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px;">
                <div>
                  <span id="detail-symbol" style="color: #818cf8; font-weight: 700; font-size: 0.85rem;">[CODE]</span>
                  <span id="detail-sector" style="color: #9ca3af; font-size: 0.85rem; margin-left: 6px;">섹터</span>
                </div>
                <div style="text-align: right;">
                  <span id="detail-price" style="font-family: inherit; font-size: 1.5rem; font-weight: 800; color: #fff;">0원</span>
                  <span id="detail-rate" style="font-size: 0.85rem; font-weight: 700; margin-left: 6px;">+0.00%</span>
                </div>
              </div>

              <div class="chart-view-box">
                <div id="detail-chart-svg" style="width: 100%; height: 160px; display: flex; align-items: center; justify-content: center;">
                  차트 렌더링 중...
                </div>
              </div>

              <div class="chart-stat-grid" style="grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));">
                <div class="stat-tile">
                  <span class="stat-lbl">24H 최고가</span>
                  <span class="stat-val text-up" id="detail-high">0원</span>
                </div>
                <div class="stat-tile">
                  <span class="stat-lbl">24H 최저가</span>
                  <span class="stat-val text-down" id="detail-low">0원</span>
                </div>
                <div class="stat-tile">
                  <span class="stat-lbl">추정 시가총액</span>
                  <span class="stat-val" id="detail-cap">0원</span>
                </div>
                <div class="stat-tile">
                  <span class="stat-lbl">PER / 배당수익률</span>
                  <span class="stat-val" id="detail-pe-div">15.0x / 2.5%</span>
                </div>
                <div class="stat-tile">
                  <span class="stat-lbl">내 보유 수량</span>
                  <span class="stat-val" id="detail-my-holding" style="color: #38bdf8;">0주</span>
                </div>
                <div class="stat-tile">
                  <span class="stat-lbl">매수 평단가</span>
                  <span class="stat-val" id="detail-my-avg" style="color: #c084fc;">0원</span>
                </div>
                <div class="stat-tile" style="grid-column: 1 / -1; background: rgba(99, 102, 241, 0.08); border-color: rgba(99, 102, 241, 0.2);">
                  <span class="stat-lbl" style="color: #a5b4fc;">🛡️ 1회 최대 구매 한도 (경제상황 연동)</span>
                  <span class="stat-val" id="detail-max-buy" style="color: #facc15; font-size: 0.95rem;">-</span>
                </div>
              </div>

              <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--card-border); padding: 14px; border-radius: 12px; margin-bottom: 18px;">
                <span style="font-size: 0.8rem; font-weight: 700; color: #a5b4fc; display: block; margin-bottom: 4px;">🏢 기업 개요 및 성장 비전</span>
                <p id="detail-description" style="font-size: 0.85rem; color: #cbd5e1; line-height: 1.5;">기업 설명 로딩 중...</p>
              </div>

              <div style="display: flex; gap: 10px;">
                <button class="btn-play-game" style="background: linear-gradient(135deg, #10b981, #059669); flex: 1;" onclick="openTradeFromDetail('buy')">🛒 즉시 매수하기</button>
                <button class="btn-play-game" style="background: linear-gradient(135deg, #ef4444, #dc2626); flex: 1;" onclick="openTradeFromDetail('sell')">💰 즉시 매도하기</button>
              </div>
            </div>
          </div>

          <!-- 주식 거래 모달 -->
          <div class="modal-overlay" id="trade-modal">
            <div class="modal-box">
              <div class="modal-title">
                <span id="modal-trade-title">주식 주문</span>
                <button class="btn-close-modal" onclick="closeTradeModal()">&times;</button>
              </div>
              <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--card-border); padding: 12px; border-radius: 12px; margin-bottom: 16px;">
                <div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: #9ca3af; margin-bottom: 4px;">
                  <span id="modal-stock-info">종목 정보</span>
                  <span id="modal-user-holding-info" style="color: #38bdf8; font-weight: 700;">내 보유: 0주</span>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: #9ca3af; margin-bottom: 4px;">
                  <span>보유 현금</span>
                  <span id="modal-user-cash-info" style="color: #34d399; font-weight: 700;" data-raw="${userAssets ? String(userAssets.cash) : '0'}">${userAssets ? formatMoneyCompact(userAssets.cash) : '0원'}</span>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.82rem; color: #9ca3af; padding-top: 5px; border-top: 1px dashed rgba(255,255,255,0.08);">
                  <span id="modal-max-limit-label">최대 주문 한도</span>
                  <span id="modal-max-limit-val" style="color: #fbbf24; font-weight: 800;">계산 중...</span>
                </div>
              </div>
              
              <div class="bet-input-group">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <label style="margin: 0;">주문 수량 (소수점 거래 가능)</label>
                  <span style="font-size: 0.75rem; color: #818cf8;">소수점(0.1주~) 및 전량 지원</span>
                </div>
                <input type="text" id="trade-amount-input" class="bet-input" value="1" min="0.0001" step="0.01" oninput="calcTradeTotal()">
                
                <!-- 비중(퍼센트/전량) 칩 -->
                <div class="btn-chip-grid" style="margin-top: 8px;">
                  <button type="button" class="btn-chip" onclick="setTradePercent(10)">10%</button>
                  <button type="button" class="btn-chip" onclick="setTradePercent(25)">25%</button>
                  <button type="button" class="btn-chip" onclick="setTradePercent(50)">50%</button>
                  <button type="button" class="btn-chip" onclick="setTradePercent(75)">75%</button>
                  <button type="button" class="btn-chip" style="background: rgba(99, 102, 241, 0.35); border-color: #818cf8; color: #fff; font-weight: 800;" onclick="setTradePercent(100)">🔥 100% (전량)</button>
                </div>

                <!-- 소수점 & 정수 수량 퀵 칩 -->
                <div class="btn-chip-grid" style="margin-top: 6px;">
                  <button type="button" class="btn-chip" style="background: rgba(56, 189, 248, 0.15); border-color: #38bdf8; color: #7dd3fc;" onclick="addTradeAmount(0.1)">+0.1주</button>
                  <button type="button" class="btn-chip" style="background: rgba(56, 189, 248, 0.15); border-color: #38bdf8; color: #7dd3fc;" onclick="addTradeAmount(0.5)">+0.5주</button>
                  <button type="button" class="btn-chip" onclick="addTradeAmount(1)">+1주</button>
                  <button type="button" class="btn-chip" onclick="addTradeAmount(10)">+10주 (1스택)</button>
                  <button type="button" class="btn-chip" onclick="addTradeAmount(100)">+100주</button>
                  <button type="button" class="btn-chip" style="background: rgba(239, 68, 68, 0.15); border-color: #ef4444; color: #fca5a5;" onclick="resetTradeAmount()">↺ 1주 리셋</button>
                </div>
              </div>

              <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--card-border); padding: 14px; border-radius: 12px; margin-bottom: 20px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 0.85rem; color: #9ca3af;">
                  <span>현재 1주당 단가</span>
                  <span id="modal-unit-price">0원</span>
                </div>
                <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 1.1rem; color: #fff;">
                  <span>총 결제/정산 예정액</span>
                  <span id="modal-total-price" style="color: #818cf8;">0원</span>
                </div>
                <div id="modal-tax-line" style="display:none; justify-content: space-between; margin-top: 6px; font-size: 0.82rem; color: #fbbf24;">
                  <span>거래세</span>
                  <span id="modal-tax-price">0원</span>
                </div>
                <div id="trade-warning-msg" style="display: none; font-size: 0.8rem; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.08);"></div>
              </div>

              <button class="btn-play-game" id="btn-submit-trade" onclick="submitTradeOrder()">주문 실행</button>
            </div>
          </div>

          <!-- 덕스 중앙은행 입출금 모달 -->
          <div class="modal-overlay" id="bank-modal">
            <div class="modal-box">
              <div class="modal-title">
                <span>🏦 덕스 중앙은행 입출금 센터</span>
                <button class="btn-close-modal" onclick="closeBankModal()">&times;</button>
              </div>
              <p style="font-size: 0.82rem; color: #a5b4fc; margin: 0 0 12px;">예금 이자는 ${BANK.LABEL} 기준으로 1분마다 분할 지급됩니다. 대출 이자는 ${LOAN.LABEL}, 만기 ${LOAN.TERM_HOURS}시간입니다.</p>
              <div class="choice-btn-group">
                <button class="btn-choice selected" id="bank-act-deposit" onclick="selectBankAction('deposit')">💵 입금 (현금 ➔ 예금)</button>
                <button class="btn-choice" id="bank-act-withdraw" onclick="selectBankAction('withdraw')">🏧 출금 (예금 ➔ 현금)</button>
              </div>

              <div class="bet-input-group">
                <label>이체 금액 (원)</label>
                <input type="text" id="bank-amount-input" class="bet-input" value="10000" inputmode="decimal" placeholder="1만 또는 1양">
                <div class="btn-chip-grid" style="margin-top: 8px;">
                  <button class="btn-chip" onclick="setBankAmount(10000)">1만원</button>
                  <button class="btn-chip" onclick="setBankAmount(50000)">5만원</button>
                  <button class="btn-chip" onclick="setBankAmount(100000)">10만원</button>
                  <button class="btn-chip" onclick="setBankAmount(500000)">50만원</button>
                  <button class="btn-chip" style="background: rgba(99, 102, 241, 0.25); border-color: #818cf8; color: #fff;" onclick="setBankAllAmount()">🔥 전액(ALL)</button>
                </div>
              </div>

              <button class="btn-play-game" onclick="submitBankTransfer()">이체 실행</button>

              <div id="bank-loan-panel" style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(165,180,252,.28);">
                <div style="font-weight:700;color:#c7d2fe;margin-bottom:8px;">💳 대출</div>
                <p id="bank-loan-status" style="font-size:0.8rem;color:#a5b4fc;margin:0 0 10px;line-height:1.45;"></p>
                <div class="bet-input-group">
                  <label>대출 / 상환 금액</label>
                  <input type="text" id="loan-amount-input" class="bet-input" value="" inputmode="decimal" placeholder="1만 · 올인 · 비우면 전액 상환">
                </div>
                <div style="display:flex; gap:8px; margin-top:10px;">
                  <button type="button" class="btn-play-game" id="btn-loan-borrow" onclick="submitLoanBorrow()" style="flex:1;">대출 받기</button>
                  <button type="button" class="btn-play-game" id="btn-loan-repay" onclick="submitLoanRepay()" style="flex:1; background:#1f2937;">상환</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 💸 실시간 유저 송금 모달 -->
          <div class="modal-overlay" id="transfer-modal">
            <div class="modal-box" style="max-width: 520px;">
              <div class="modal-title">
                <span>💸 실시간 유저 송금 센터</span>
                <button class="btn-close-modal" onclick="closeTransferModal()">&times;</button>
              </div>
              <p style="font-size: 0.82rem; color: #94a3b8; margin: 0 0 14px;">다른 유저에게 안전하게 자금을 송금합니다. 최소 송금액은 1,000원입니다.</p>

              <!-- 상대방 검색/선택 -->
              <div class="bet-input-group" style="margin-bottom: 12px;">
                <label>받는 상대방 (Discord ID 또는 닉네임 검색)</label>
                <div style="position: relative;">
                  <input type="text" id="transfer-target-input" class="bet-input" placeholder="상대방 닉네임 또는 Discord ID 입력..." oninput="debounceSearchTransferUser(this.value)">
                  <div id="transfer-user-dropdown" style="display:none; position:absolute; top:100%; left:0; right:0; background:#0f172a; border:1px solid rgba(56,189,248,0.4); border-radius:8px; z-index:100; max-height:180px; overflow-y:auto; box-shadow:0 8px 24px rgba(0,0,0,0.5);"></div>
                </div>
                <div id="transfer-selected-user" style="display:none; margin-top:8px; padding:8px 12px; background:rgba(56,189,248,0.1); border:1px solid rgba(56,189,248,0.3); border-radius:6px; font-size:0.85rem; color:#38bdf8; font-weight:700; display:flex; justify-content:space-between; align-items:center;">
                  <span id="transfer-selected-label"></span>
                  <button type="button" onclick="clearSelectedTransferUser()" style="background:none; border:none; color:#f87171; font-weight:800; cursor:pointer; font-size:0.9rem;">&times; 변경</button>
                </div>
              </div>

              <!-- 송금 금액 입력 -->
              <div class="bet-input-group" style="margin-bottom: 12px;">
                <label>송금 금액 (원, 5만, 100만, 1억, 전액)</label>
                <input type="text" id="transfer-amount-input" class="bet-input" placeholder="예: 10000, 5만, 10억" oninput="debounceCalcTransferQuote()">
                <div class="btn-chip-grid" style="margin-top: 8px;">
                  <button class="btn-chip" onclick="setTransferAmount(10000)">1만원</button>
                  <button class="btn-chip" onclick="setTransferAmount(50000)">5만원</button>
                  <button class="btn-chip" onclick="setTransferAmount(100000)">10만원</button>
                  <button class="btn-chip" onclick="setTransferAmount(1000000)">100만원</button>
                  <button class="btn-chip" style="background: rgba(56, 189, 248, 0.2); border-color: #38bdf8; color: #fff;" onclick="setTransferAllAmount()">🔥 보유 전액(ALL)</button>
                </div>
              </div>

              <!-- 송금 메모 -->
              <div class="bet-input-group" style="margin-bottom: 14px;">
                <label>송금 메모 / 사유 (선택)</label>
                <input type="text" id="transfer-memo-input" class="bet-input" placeholder="예: 주식 배당금, 친목 지원, 이벤트 상금 등">
              </div>

              <!-- 실시간 송금세 및 정산 요약 -->
              <div id="transfer-quote-box" style="background:#030712; border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:12px; font-size:0.85rem; margin-bottom:16px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:6px; color:#94a3b8;">
                  <span>보내는 금액:</span>
                  <span id="tq-amount" style="font-weight:700; color:#fff;">0원</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:6px; color:#94a3b8;">
                  <span>송금세 (국고 귀속):</span>
                  <span id="tq-tax" style="font-weight:700; color:#fbbf24;">0원 (0.0%)</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding-top:6px; border-top:1px solid rgba(255,255,255,0.08); font-weight:800; font-size:0.92rem;">
                  <span style="color:#e2e8f0;">총 현금 차감액:</span>
                  <span id="tq-total" style="color:#38bdf8;">0원</span>
                </div>
              </div>

              <button class="btn-play-game" id="btn-submit-transfer" onclick="submitTransferMoney()" style="background:linear-gradient(135deg, #0284c7, #0ea5e9); box-shadow:0 4px 12px rgba(14,165,233,0.3);">💸 송금 실행하기</button>
            </div>
          </div>

          <!-- 👤 내 프로필 & 1:1 고객센터 문의 모달 -->
          <div class="modal-overlay" id="profile-modal">
            <div class="modal-box" style="max-width: 580px;">
              <div class="modal-title">
                <span>👤 내 정보 & 고객센터 센터</span>
                <button class="btn-close-modal" onclick="closeProfileModal()">&times;</button>
              </div>

              ${profileHeaderHtml}

              <!-- 서브 탭 -->
              <div class="profile-subtabs-nav">
                <button class="profile-subtab-btn active" id="btn-subtab-profile" onclick="switchProfileTab('profile')">👤 내 자산 현황</button>
                <button class="profile-subtab-btn" id="btn-subtab-inquiries" onclick="switchProfileTab('inquiries')">📩 내 1:1 문의 내역 (<span id="inquiry-count-badge">0</span>)</button>
                <button class="profile-subtab-btn" id="btn-subtab-settings" onclick="switchProfileTab('settings')">설정</button>
              </div>

              <!-- 서브 탭 1: 자산 현황 -->
              <div id="subtab-pane-profile">
                ${profileStatsHtml}
              </div>

              <!-- 서브 탭 2: 내 문의 내역 -->
              <div id="subtab-pane-inquiries" style="display: none;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
                  <span style="font-size: 0.85rem; color: #9ca3af;">내가 접수한 문의 목록과 관리자 답변입니다.</span>
                  <button class="btn-filter active" style="font-size: 0.75rem; padding: 4px 10px;" onclick="openInquiryModal()">✍️ 새 문의</button>
                </div>

                <div id="my-inquiries-list-box" style="max-height: 380px; overflow-y: auto;">
                  <div style="text-align: center; color: #9ca3af; padding: 30px;">
                    <span class="pulse-dot"></span> 문의 내역을 불러오는 중...
                  </div>
                </div>
              </div>

            </div>
          </div>

          <!-- ✍️ 새 1:1 고객센터 문의 작성 모달 -->
          <div class="modal-overlay" id="inquiry-modal">
            <div class="modal-box">
              <div class="modal-title">
                <span>✍️ 1:1 관리자 고객센터 문의하기</span>
                <button class="btn-close-modal" onclick="closeInquiryModal()">&times;</button>
              </div>

              <div class="inquiry-form-group">
                <label>문의 분류</label>
                <select id="inquiry-category-select" class="inquiry-select">
                  <option value="🐞 버그 / 오류 제보">🐞 버그 / 오류 제보</option>
                  <option value="💡 기능 제안 / 아이디어">💡 기능 제안 / 아이디어</option>
                  <option value="💰 계정 / 자산 복구 문의">💰 계정 / 자산 복구 문의</option>
                  <option value="💬 기타 1:1 일반 문의" selected>💬 기타 1:1 일반 문의</option>
                </select>
              </div>

              <div class="inquiry-form-group">
                <label>문의 제목</label>
                <input type="text" id="inquiry-title-input" class="inquiry-input" placeholder="문의 제목을 요약하여 입력해주세요 (예: 지원금 관련 문의)">
              </div>

              <div class="inquiry-form-group">
                <label>상세 내용</label>
                <textarea id="inquiry-content-input" class="inquiry-textarea" placeholder="발생한 상황, 시간, 요청 사항 등을 자세하게 적어주시면 관리자에게 디스코드 DM으로 전송되며 신속하게 답변해 드립니다."></textarea>
              </div>

              <!-- 📷 스크린샷 / 이미지 첨부 영역 -->
              <div class="inquiry-form-group">
                <label>📷 스크린샷 / 이미지 첨부 (선택)</label>
                <div style="display: flex; gap: 10px; align-items: center;">
                  <input type="file" id="inquiry-image-file" accept="image/png,image/jpeg" class="inquiry-input" style="padding: 6px 10px; font-size: 0.82rem;" onchange="handleInquiryImageSelect(event)">
                  <button type="button" class="btn-filter" id="btn-clear-img" style="display: none; padding: 6px 12px; font-size: 0.8rem; border-color: #ef4444; color: #f87171;" onclick="clearInquiryImage()">✕ 제거</button>
                </div>
                <div id="inquiry-img-preview-box" style="display: none; margin-top: 10px; text-align: center; background: rgba(0,0,0,0.3); padding: 8px; border-radius: 10px; border: 1px solid var(--card-border);">
                  <img id="inquiry-img-preview" src="" style="max-height: 140px; max-width: 100%; border-radius: 8px; object-fit: contain;" alt="첨부 미리보기">
                  <div style="font-size: 0.72rem; color: #34d399; margin-top: 4px;">✅ 첨부 이미지가 등록되었습니다.</div>
                </div>
              </div>

              <button class="btn-submit-inquiry" id="btn-submit-inquiry" onclick="submitInquiryForm()">📨 관리자에게 1:1 문의 전송 (DM 알림)</button>
            </div>
          </div>

          <!-- 💬 전역 상시 플로팅 채팅 독 (Floating Global Chat Dock) -->
          <div id="floating-chat-container">
            <button id="btn-floating-chat-toggle" onclick="toggleFloatingChat()" title="실시간 광장 채팅" aria-label="실시간 광장 채팅 열기">
              <svg class="chat-toggle-icon" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #ffffff; display: block; pointer-events: none;">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
                <circle cx="8.5" cy="11.5" r="1" fill="currentColor"></circle>
                <circle cx="12" cy="11.5" r="1" fill="currentColor"></circle>
                <circle cx="15.5" cy="11.5" r="1" fill="currentColor"></circle>
              </svg>
              <span id="floating-chat-badge" class="chat-unread-badge" style="display:none;">NEW</span>
            </button>

            <!-- 플로팅 채팅 드로어 창 -->
            <div id="floating-chat-drawer" style="display: none;">
              <div class="floating-chat-header">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span class="pulse-dot"></span>
                  <span style="font-weight:600;font-size:14px;color:#f2f3f5;">#광장</span>
                </div>
                <button class="btn-chat-min" onclick="toggleFloatingChat()" title="채팅창 최소화">✕</button>
              </div>

              <!-- 플로팅 메시지 뷰어 -->
              <div id="floating-chat-messages-container" class="floating-chat-body">
                <div style="text-align: center; color: #64748b; font-size: 0.82rem; padding: 25px 0;">
                  <span class="pulse-dot"></span> 실시간 광장 채팅을 연결하는 중...
                </div>
              </div>

              <!-- 빠른 이모지 바 -->
              <div class="chat-quick-emojis" style="padding: 6px 10px; gap: 4px; background: rgba(15,23,42,0.9); border-top: 1px solid rgba(255,255,255,0.06); display: flex; overflow-x: auto;">
                <button type="button" class="btn-emoji-quick" onclick="insertFloatingEmoji('🦆')">🦆</button>
                <button type="button" class="btn-emoji-quick" onclick="insertFloatingEmoji('💎')">💎</button>
                <button type="button" class="btn-emoji-quick" onclick="insertFloatingEmoji('📈')">📈</button>
                <button type="button" class="btn-emoji-quick" onclick="insertFloatingEmoji('🚀')">🚀</button>
                <button type="button" class="btn-emoji-quick" onclick="insertFloatingEmoji('💰')">💰</button>
                <button type="button" class="btn-emoji-quick" onclick="insertFloatingEmoji('🔥')">🔥</button>
                <button type="button" class="btn-emoji-quick" onclick="insertFloatingEmoji('🎰')">🎰</button>
                <button type="button" class="btn-emoji-quick" onclick="insertFloatingEmoji('🏆')">🏆</button>
              </div>

              <!-- 플로팅 입력 폼 -->
              <div class="floating-chat-footer">
                ${floatingChatInputHtml}
              </div>
            </div>
          </div>

          <!-- 웹 인터랙티브 & 실시간 라이브 스트림 스크립트 -->
          <script id="user-holdings-data" type="application/json">${userHoldingsJson}</script>
          ${jsTag('js/game-fx.js')}
          <script>
            window.__IS_GUEST_PLAY__ = false;
            window.__IS_LOCAL_PLAY__ = ${isLocalPlay ? 'true' : 'false'};
            window.__IS_DISCORD_USER__ = ${isDiscordUser ? 'true' : 'false'};
            window.CLICKER_CFG = {
              powerPerLevel: ${powerPerLevel},
              upgradeCostPerLevel: ${upgradeCostPerLevel},
              autoIncomePerLevel: ${autoIncomePerLevel},
              autoCostPerNextLevel: ${autoCostPerNextLevel},
              maxClicksPerRequest: ${CLICKER.MAX_CLICKS_PER_REQUEST},
              critChance: ${CLICKER.CRIT_CHANCE},
              critMultiplier: ${CLICKER.CRIT_MULT}
            };
            let userHoldings = {};
            try {
              userHoldings = JSON.parse(document.getElementById('user-holdings-data').textContent || '{}');
            } catch(e) {}
            window.__applyUserHoldings = function(nextHoldings) {
              if (!nextHoldings || typeof nextHoldings !== 'object') return;
              const next = {};
              Object.keys(nextHoldings).forEach(function(k) {
                const n = Number(nextHoldings[k]);
                next[k] = Number.isFinite(n) ? n : 0;
              });
              userHoldings = next;
              if (typeof window.__syncStockHoldingBadges === 'function') window.__syncStockHoldingBadges();
            };
            let selectedCoin = '앞면';
            let currentTrade = { stockId: '', name: '', price: 0, action: 'buy' };
            let currentDetailStock = null;
            let currentBankAction = 'deposit';
            let clickHitBuffer = [];
            let clickFlushTimer = null;
            let lastSamePixelToastAt = 0;
            let minerWindowBlocked = false;
            let currentNewsCategory = 'ALL';
            let currentFeedType = 'ALL';
            let feedItemsCache = [];
            let isGameInProgress = false;
            window.isGameInProgress = false;

            async function submitLocalAuth(ev, kind) {
              ev.preventDefault();
              const form = ev.target;
              const fd = new FormData(form);
              const username = String(fd.get('username') || '').trim();
              const password = String(fd.get('password') || '');
              const btn = form.querySelector('button[type="submit"]');
              if (btn) btn.disabled = true;
              try {
                const res = await fetch(kind === 'register' ? '/auth/local/register' : '/auth/local/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'same-origin',
                  body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (!data.success) {
                  showToast('error', '계정', data.error || '실패했습니다.');
                  return false;
                }
                location.reload();
              } catch (e) {
                showToast('error', '계정', '서버와 연결할 수 없습니다.');
              } finally {
                if (btn) btn.disabled = false;
              }
              return false;
            }

            // 🌟 사용자 친화적 플로팅 토스트 알림 함수
            function escapeHtml(str) {
              return String(str == null ? '' : str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
            }

            function showToast(type, title, message) {
              const rawMsg = String(message == null ? '' : message);
              if ((window.__IS_GUEST_PLAY__ || window.__IS_LOCAL_PLAY__) && /로그인/.test(rawMsg)) {
                type = 'info';
                title = window.__IS_LOCAL_PLAY__ ? '웹 계정' : '로그인';
                message = /송금/.test(rawMsg)
                  ? '송금은 Discord 계정만 이용할 수 있습니다.'
                  : rawMsg;
              }
              const container = document.getElementById('toast-container');
              if (!container) return;
              const key = String(type || '') + '|' + String(title || '') + '|' + String(message || '');
              const open = container.querySelectorAll('.toast:not(.toast-hide)');
              for (let i = 0; i < open.length; i++) {
                if (open[i].getAttribute('data-toast-key') === key) {
                  const n = (Number(open[i].getAttribute('data-toast-n')) || 1) + 1;
                  open[i].setAttribute('data-toast-n', String(n));
                  const msgEl = open[i].querySelector('.toast-msg');
                  if (msgEl) msgEl.textContent = String(message || '') + ' ×' + n;
                  return;
                }
              }
              while (container.querySelectorAll('.toast:not(.toast-hide)').length >= 4) {
                const oldest = container.querySelector('.toast:not(.toast-hide)');
                if (!oldest) break;
                oldest.remove();
              }
              const toast = document.createElement('div');
              toast.className = 'toast';
              toast.setAttribute('data-toast-key', key);
              toast.setAttribute('data-toast-n', '1');
              const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : (type === 'warn' ? '⚠️' : 'ℹ️'));
              const borderCol = type === 'success' ? '#10b981' : (type === 'error' ? '#ef4444' : (type === 'warn' ? '#f59e0b' : '#6366f1'));
              toast.style.borderColor = borderCol;
              toast.innerHTML =
                '<span class="toast-icon">' + icon + '</span>' +
                '<div>' +
                  '<div class="toast-title">' + escapeHtml(title) + '</div>' +
                  '<div class="toast-msg">' + escapeHtml(message) + '</div>' +
                '</div>';
              container.appendChild(toast);
              setTimeout(function () {
                toast.classList.add('toast-hide');
                setTimeout(function () { toast.remove(); }, 300);
              }, 3200);
            }
            window.showToast = showToast;

            function parseMoneyText(text) {
              if (typeof window.parseClientMoney === 'function') return window.parseClientMoney(text);
              const m = String(text || '').replace(/\u00a0/g, '').replace(/원/g, '').match(/-?[0-9][0-9,]*/);
              if (!m) return '0';
              return m[0].replace(/,/g, '');
            }

            function readMoneyElLocal(el) {
              if (typeof window.readMoneyEl === 'function') return window.readMoneyEl(el);
              if (!el) return '0';
              const raw = el.getAttribute('data-raw');
              const fromRaw = (raw !== null && raw !== '') ? (String(raw).replace(/[^\d-]/g, '') || '0') : '0';
              const parsed = parseMoneyText(el.innerText || el.textContent || '');
              const fromText = (!parsed || parsed === 'ALL') ? '0' : (String(parsed).replace(/[^\d-]/g, '') || '0');
              try {
                const a = BigInt(fromRaw);
                const b = BigInt(fromText);
                return (a >= b ? a : b).toString();
              } catch (e) {
                return fromRaw !== '0' ? fromRaw : fromText;
              }
            }

            function getRawMoneyStr(id) {
              if (id === 'my-cash' && typeof window.readWalletCash === 'function') {
                return window.readWalletCash();
              }
              return readMoneyElLocal(document.getElementById(id));
            }

            function getRawMoney(id) {
              const s = getRawMoneyStr(id);
              try { return BigInt(s); } catch (e) { return 0n; }
            }

            function getCurrentUserCashNum() {
              return getRawMoney('my-cash');
            }

            function getCurrentUserBankNum() {
              return getRawMoney('my-bank');
            }

            function fmtMoneyUi(v) {
              if (typeof window.formatMoneyCompact === 'function') return window.formatMoneyCompact(v);
              try { return BigInt(String(v || '0').split('.')[0]).toLocaleString('ko-KR') + '원'; }
              catch (e) { return String(v) + '원'; }
            }
            window.fmtMoneyUi = fmtMoneyUi;

            function holdingShares(stockId, fallback) {
              if (Object.prototype.hasOwnProperty.call(userHoldings, stockId)) {
                const n = Number(userHoldings[stockId]);
                if (Number.isFinite(n)) return n;
              }
              const n = Number(fallback);
              return Number.isFinite(n) ? n : 0;
            }

            function addHoldingShares(stockId, delta) {
              const next = Math.round((holdingShares(stockId, 0) + Number(delta || 0)) * 10000) / 10000;
              userHoldings[stockId] = next < 0 ? 0 : next;
              return userHoldings[stockId];
            }

            function formatShareQty(n) {
              const v = Number(n) || 0;
              if (Math.abs(v % 1) < 1e-9) return v.toLocaleString('ko-KR');
              return String(Math.round(v * 10000) / 10000);
            }

            function syncStockHoldingBadges() {
              document.querySelectorAll('.stock-card[id^="stock-"]').forEach(function(card) {
                const id = card.id.slice('stock-'.length);
                const n = holdingShares(id, 0);
                const nameBox = card.querySelector('.sr-name');
                if (!nameBox) return;
                let badge = nameBox.querySelector('.sr-hold');
                if (n > 0) {
                  if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'sr-hold';
                    nameBox.appendChild(badge);
                  }
                  badge.textContent = formatShareQty(n) + '주';
                } else if (badge) {
                  badge.remove();
                }
              });
            }
            window.__syncStockHoldingBadges = syncStockHoldingBadges;

            function readLiveStockPrice(stockId, fallback) {
              const el = document.getElementById('price-' + stockId);
              if (el) {
                const raw = el.getAttribute('data-raw');
                if (raw) return String(raw).split('.')[0];
                const parsed = parseMoneyText(el.innerText || el.textContent || '');
                if (parsed && parsed !== 'ALL' && parsed !== '0') return parsed;
              }
              return String(fallback == null ? '0' : fallback).split('.')[0];
            }

            function maxBuySharesUi(cashBig, priceRaw, rate) {
              let price = 0n;
              let cash = 0n;
              try { price = BigInt(String(priceRaw || '0').split('.')[0] || '0'); } catch (e) { price = 0n; }
              try { cash = typeof cashBig === 'bigint' ? cashBig : BigInt(String(cashBig || '0').split('.')[0] || '0'); } catch (e) { cash = 0n; }
              const bps = BigInt(Math.max(0, Math.round((Number(rate) || 0) * 10000)));
              if (price <= 0n || cash <= 0n) return 0;
              const units = (cash * 100000000n) / (price * (10000n + bps));
              const asNum = Number(units) / 10000;
              return Number.isFinite(asNum) ? asNum : 0;
            }

            function syncTradePanelCash() {
              const cashElem = document.getElementById('modal-user-cash-info');
              if (!cashElem) return;
              const cashStr = getRawMoneyStr('my-cash');
              cashElem.setAttribute('data-raw', cashStr);
              cashElem.textContent = fmtMoneyUi(cashStr);
            }
            window.__onWalletCashUpdated = function() {
              syncTradePanelCash();
              const modal = document.getElementById('trade-modal');
              if (modal && modal.style.display === 'flex' && currentTrade && currentTrade.stockId) {
                try { calcTradeTotal(); } catch (e) {}
              }
            };

            function markAllIn(input, on) {
              if (!input) return;
              if (on) input.setAttribute('data-all-in', '1');
              else input.removeAttribute('data-all-in');
            }

            function isAllInInput(input) {
              if (!input) return false;
              if (input.getAttribute('data-all-in') === '1') return true;
              const v = String(input.value || '').trim().toLowerCase();
              return v === 'all' || v === '전액' || v === '올인' || v === '전량' || v === '전체' || v === 'max' || v === '최대';
            }

            function getBetPayload(input) {
              if (!input) return '';
              return isAllInInput(input) ? 'all' : input.value;
            }

            function setGameLock(inProgress) {
              isGameInProgress = inProgress;
              window.isGameInProgress = inProgress;
              const buttons = [
                document.getElementById('btn-spin-slot'),
                document.getElementById('btn-flip-coin'),
                document.getElementById('btn-roll-dice'),
                document.getElementById('btn-scratch-lottery'),
                document.getElementById('btn-start-race'),
                document.getElementById('btn-spin-roulette'),
                document.getElementById('btn-hl'),
                document.getElementById('btn-bj-start'),
                document.getElementById('btn-pk-start'),
                document.getElementById('btn-sp-start'),
                document.getElementById('btn-crash-bet'),
                document.getElementById('btn-mines-start'),
                document.getElementById('btn-plinko')
              ];
              buttons.forEach(btn => {
                if (btn) {
                  btn.disabled = inProgress;
                  btn.style.opacity = inProgress ? '0.6' : '1';
                  btn.style.cursor = inProgress ? 'not-allowed' : 'pointer';
                }
              });
            }

            function closeDrawers() {
              const side = document.getElementById('channel-sidebar');
              const wallet = document.getElementById('member-rail');
              const back = document.getElementById('mobile-backdrop');
              if (side) side.classList.remove('open');
              if (wallet) wallet.classList.remove('open');
              if (back) back.classList.remove('open');
            }
            function toggleSidebar() {
              const side = document.getElementById('channel-sidebar');
              const wallet = document.getElementById('member-rail');
              const back = document.getElementById('mobile-backdrop');
              if (!side) return;
              const open = !side.classList.contains('open');
              side.classList.toggle('open', open);
              if (wallet) wallet.classList.remove('open');
              if (back) back.classList.toggle('open', open);
            }
            function toggleWallet() {
              const wallet = document.getElementById('member-rail');
              const side = document.getElementById('channel-sidebar');
              const back = document.getElementById('mobile-backdrop');
              if (!wallet) return;
              const open = !wallet.classList.contains('open');
              wallet.classList.toggle('open', open);
              if (side) side.classList.remove('open');
              if (back) back.classList.toggle('open', open);
            }
            function switchTab(tabId) {
              if (!tabId || !document.getElementById(tabId)) return;

              document.querySelectorAll('.tab-btn').forEach(btn => {
                const on = btn.getAttribute('onclick') || '';
                const data = btn.getAttribute('data-tab') || '';
                btn.classList.toggle('active', data === tabId || on.indexOf(tabId) !== -1);
              });
              document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));

              const targetPane = document.getElementById(tabId);
              if (targetPane) targetPane.classList.add('active');

              const titles = {
                'tab-stocks': '주식-시장',
                'tab-plaza': '메타버스-광장',
                'tab-chat': '광장',
                'tab-horse': '경마',
                'tab-casino': '카지노',
                'tab-hot': '핫게임',
                'tab-arcade': '아케이드',
                'tab-news': '시장-뉴스',
                'tab-p2p': '대부업',
                'tab-clicker': '채굴',
                'tab-business': '사업',
                'tab-ranking': '자산-순위',
                'tab-feed': '관리자-로그'
              };
              const titleEl = document.getElementById('channel-header-title');
              if (titleEl && titles[tabId]) titleEl.textContent = titles[tabId];
              document.body.dataset.tab = tabId;
              closeDrawers();
              // 모바일/데스크탑 모두에서 버튼 포커스 잔상 제거
              try {
                const ae = document.activeElement;
                if (ae && typeof ae.blur === 'function' && ae !== document.body) ae.blur();
              } catch (e) {}
              if (tabId === 'tab-p2p' && typeof loadP2PState === 'function') loadP2PState();
              if (tabId === 'tab-business' && typeof loadBusinesses === 'function') loadBusinesses();
              if (tabId === 'tab-arcade' && window.Arcade && typeof window.Arcade.load === 'function') window.Arcade.load();
               if (tabId === 'tab-plaza' && typeof MetaversePlazaEngine === 'function') {
                 if (!window.__metaEngine) window.__metaEngine = new MetaversePlazaEngine('metaverse-canvas', 'metaverse-container');
               }

              // 🔥 새로고침 시에도 현재 메뉴 상태 유지 (localStorage + URL Hash)
              try {
                localStorage.setItem('duck_active_tab', tabId);
                if (history.replaceState) {
                  history.replaceState(null, '', '#' + tabId);
                }
              } catch (e) {}

              if (tabId === 'tab-feed') {
                fetchLiveActivityFeed();
              } else if (tabId === 'tab-chat') {
                loadChatMessages();
                const chatInput = document.getElementById('chat-input');
                if (chatInput) setTimeout(() => chatInput.focus(), 150);
              } else if (tabId === 'tab-horse') {
                if (typeof refreshHorseCard === 'function') refreshHorseCard();
              }
            }
            window.switchTab = switchTab;
            window.closeDrawers = closeDrawers;
            window.toggleSidebar = toggleSidebar;
            window.toggleWallet = toggleWallet;

            // 🚀 페이지 로드 시 이전에 열어둔 탭 복원
            function restoreActiveTabOnLoad() {
              try {
                const hash = window.location.hash ? window.location.hash.replace('#', '') : '';
                const savedTab = hash || localStorage.getItem('duck_active_tab');
                if (savedTab === 'tab-help' || savedTab === 'help') {
                  document.body.dataset.tab = 'tab-stocks';
                } else if (savedTab && document.getElementById(savedTab)) {
                  switchTab(savedTab);
                } else {
                  document.body.dataset.tab = 'tab-stocks';
                }
              } catch (e) {}
            }
            window.addEventListener('DOMContentLoaded', restoreActiveTabOnLoad);
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
              restoreActiveTabOnLoad();
            }

            // ⚡ 실시간 모든 로그 (라이브 피드) 비동기 호출 & 렌더링
            async function fetchLiveActivityFeed() {
              try {
                const res = await fetch('/api/system/activity-feed?type=' + currentFeedType + '&limit=50');
                const data = await res.json();
                if (!data.success) return;
                feedItemsCache = data.items;
                renderFeedList(feedItemsCache);
              } catch (e) {}
            }

            function setFeedFilter(type) {
              currentFeedType = type;
              document.querySelectorAll('.btn-feed-filter').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('onclick')?.includes(type));
              });
              fetchLiveActivityFeed();
            }

            function filterFeedLocally() {
              const search = (document.getElementById('feed-search-input')?.value || '').toLowerCase().trim();
              if (!search) {
                renderFeedList(feedItemsCache);
                return;
              }
              const filtered = feedItemsCache.filter(item => 
                item.title.toLowerCase().includes(search) || 
                item.desc.toLowerCase().includes(search) || 
                item.actor.toLowerCase().includes(search)
              );
              renderFeedList(filtered);
            }

            function renderFeedList(items) {
              const container = document.getElementById('feed-stream-container');
              if (!items || items.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: #6b7280; padding: 40px;">기록된 실시간 로그가 없습니다.</div>';
                return;
              }

              let html = '';
              items.forEach(item => {
                const timeStr = new Date(item.time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                html += 
                  '<div class="feed-card">' +
                    '<div class="feed-card-left">' +
                      '<span class="feed-badge ' + item.badgeClass + '">' + item.badge + '</span>' +
                      '<div class="feed-info-col">' +
                        '<h4>' + escapeHtml(item.title) + '</h4>' +
                        '<p>' + escapeHtml(item.desc) + '</p>' +
                      '</div>' +
                    '</div>' +
                    '<div class="feed-time-col">' +
                      '<span class="feed-time-text">⏱️ ' + timeStr + '</span>' +
                      '<span class="feed-actor-tag">' + escapeHtml(item.actor) + '</span>' +
                    '</div>' +
                  '</div>';
              });
              container.innerHTML = html;
            }

            // 3초 주기 라이브 피드 자동 새로고침
            setInterval(() => {
              const feedTab = document.getElementById('tab-feed');
              if (feedTab && feedTab.classList.contains('active')) {
                fetchLiveActivityFeed();
              }
            }, 3000);

            function selectCoinChoice(choice) {
              if (isGameInProgress) return;
              selectedCoin = choice;
              document.getElementById('choice-front').classList.toggle('selected', choice === '앞면');
              document.getElementById('choice-back').classList.toggle('selected', choice === '뒷면');
            }

            function applyAllInBet(inputId) {
              const input = document.getElementById(inputId);
              if (!input) return;
              const cash = getCurrentUserCashNum();
              if (cash <= 0n) {
                input.value = '0';
                markAllIn(input, false);
                if (typeof showToast === 'function') {
                  showToast('error', '배팅', '현금이 0원이라 올인할 수 없습니다.');
                }
                return;
              }
              input.value = '올인';
              markAllIn(input, true);
            }

            function setNumericBet(inputId, val) {
              const input = document.getElementById(inputId);
              if (!input) return;
              if (val === 'all') {
                applyAllInBet(inputId);
                return;
              }
              input.value = val;
              markAllIn(input, false);
            }

            function getChipStep() {
              const el = document.querySelector('.bet-chip-step');
              let raw = el ? parseMoneyText(el.value) : '0';
              if (raw === '0' || raw === 'ALL') {
                try { raw = parseMoneyText(localStorage.getItem('wtrdd-bet-chip') || '10000'); } catch (e) { raw = '10000'; }
              }
              try {
                const n = BigInt(raw);
                return n >= 1000n ? n : 10000n;
              } catch (e) { return 10000n; }
            }

            function syncChipStepInputs(n) {
              document.querySelectorAll('.bet-chip-step').forEach(function(el) {
                el.value = String(n);
              });
              try { localStorage.setItem('wtrdd-bet-chip', String(n)); } catch (e) {}
            }

            function persistChipStep(e) {
              const src = e && e.target ? e.target.value : String(getChipStep());
              let n = 10000n;
              try {
                const parsed = parseMoneyText(src);
                if (parsed !== 'ALL') n = BigInt(parsed);
              } catch (err) { n = 10000n; }
              if (n < 1000n) n = 1000n;
              syncChipStepInputs(n);
            }

            function setChipStep(amount) {
              let n = 10000n;
              try {
                const parsed = parseMoneyText(amount);
                if (parsed !== 'ALL') n = BigInt(parsed);
              } catch (e) { n = 10000n; }
              if (n < 1000n) n = 1000n;
              syncChipStepInputs(n);
            }

            function addNumericBet(inputId, val) {
              if (typeof isGameInProgress !== 'undefined' && isGameInProgress) return;
              const input = document.getElementById(inputId);
              if (!input) return;
              if (val === 'all') {
                applyAllInBet(inputId);
                return;
              }
              if (val === 'reset') {
                input.value = '1000';
                markAllIn(input, false);
                return;
              }
              let add = 0n;
              try { add = BigInt(parseMoneyText(val)); } catch (e) { add = 0n; }
              if (add <= 0n) return;
              let cur = 0n;
              if (isAllInInput(input)) {
                cur = getCurrentUserCashNum();
              } else {
                try {
                  const parsedCur = parseMoneyText(input.value);
                  if (parsedCur === 'ALL') cur = getCurrentUserCashNum();
                  else cur = BigInt(parsedCur);
                } catch (e) { cur = 0n; }
              }
              const cash = getCurrentUserCashNum();
              let next = cur + add;
              if (cash > 0n && next >= cash) {
                applyAllInBet(inputId);
                return;
              }
              input.value = String(next);
              markAllIn(input, false);
            }

            function addCustomBet(inputId) {
              addNumericBet(inputId, getChipStep());
            }

            function initBetChipStep() {
              let saved = 10000;
              try {
                const parsed = parseMoneyText(localStorage.getItem('wtrdd-bet-chip') || '');
                if (parsed && parsed !== 'ALL' && parsed !== '0') saved = parsed;
              } catch (e) {}
              document.querySelectorAll('.bet-chip-step').forEach(function(el) {
                el.value = String(saved);
                el.addEventListener('change', persistChipStep);
                el.addEventListener('blur', persistChipStep);
              });
            }

            let bizState = null;
            function fmtWon(n) {
              const v = Math.trunc(Number(n) || 0);
              return v.toLocaleString('ko-KR') + '원';
            }
            function paintBusinessState(state) {
              if (!state) return;
              state._loadedAt = Date.now();
              bizState = state;
              const pendingEl = document.getElementById('biz-pending');
              const incomeEl = document.getElementById('biz-income');
              const investedEl = document.getElementById('biz-invested');
              if (pendingEl) pendingEl.textContent = fmtWon(state.pendingTotal || 0);
              if (incomeEl) incomeEl.textContent = '+' + fmtWon(state.incomeTotal || 0) + '/분';
              if (investedEl) investedEl.textContent = fmtWon(state.investedTotal || 0);
              const hqCopy = document.getElementById('biz-hq-copy');
              const hqBtn = document.getElementById('btn-biz-hq');
              const autoBtn = document.getElementById('btn-biz-auto');
              if (hqCopy) {
                hqCopy.textContent = '본사 Lv.' + state.hqLevel + '/' + state.maxHq +
                  ' · 전체 매출 +' + (state.hqLevel * (state.hqBonusPct || 6)) + '%' +
                  (state.autoUnlocked ? (state.autoCollect ? ' · 자동수금 ON' : ' · 자동수금 OFF') : ' · 1레벨부터 자동수금');
              }
              if (hqBtn) {
                hqBtn.disabled = !state.hqCost;
                hqBtn.textContent = state.hqCost ? ('본사 업글 ' + fmtWon(state.hqCost)) : '본사 MAX';
              }
              if (autoBtn) {
                autoBtn.disabled = !state.autoUnlocked;
                autoBtn.textContent = state.autoCollect ? '자동 수금 끄기' : '자동 수금 켜기';
              }
              const grid = document.getElementById('biz-grid');
              if (!grid || !Array.isArray(state.items)) return;
              grid.innerHTML = state.items.map(function(item) {
                const keyAttr = ' data-biz-key="' + String(item.key || '') + '"';
                if (!item.owned) {
                  const lock = item.locked
                    ? '<div class="biz-meta">선행: ' + (item.requiresName || '-') + '</div><div class="biz-actions"><button type="button" class="btn-chip" disabled>잠김</button></div>'
                    : '<div class="biz-actions"><button type="button" class="btn-play-game"' + keyAttr + ' onclick="buyBusiness(this.dataset.bizKey)">개업 ' + fmtWon(item.cost) + '</button></div>';
                  return '<article class="biz-card' + (item.locked ? ' locked' : '') + '">' +
                    '<div class="biz-card-top"><div class="biz-name">' + item.emoji + ' ' + item.name + '</div></div>' +
                    '<p class="biz-blurb">' + item.blurb + '</p>' +
                    '<div class="biz-meta">개업 ' + fmtWon(item.cost) + ' · 분당 +' + fmtWon(item.incomePerMin) + '</div>' +
                    lock +
                    '</article>';
                }
                const up = item.upgradeCost
                  ? '<button type="button" class="btn-chip"' + keyAttr + ' onclick="upgradeBusiness(this.dataset.bizKey)">업글 ' + fmtWon(item.upgradeCost) + '</button>'
                  : '<span class="biz-meta">MAX</span>';
                const hire = item.hireCost
                  ? '<button type="button" class="btn-chip"' + keyAttr + ' onclick="hireStaff(this.dataset.bizKey)">알바 +' + fmtWon(item.hireCost) + '</button>'
                  : '<span class="biz-meta">알바 MAX</span>';
                const capMin = item.capMin || 480;
                const totalElapsedSec = (Number(item.elapsedSec) || 0);
                const pct = Math.min(100, Math.round((totalElapsedSec / 60 / capMin) * 100));
                const isFull = pct >= 100;
                return '<article class="biz-card owned' + (isFull ? ' is-full' : '') + '" id="biz-card-' + item.key + '">' +
                  '<div class="biz-card-top"><div class="biz-name">' + item.emoji + ' ' + item.name + '</div><span class="biz-meta">Lv.' + item.level + ' · 알바 ' + item.staff + '/' + item.maxStaff + '</span></div>' +
                  '<p class="biz-blurb">' + item.blurb + '</p>' +
                  '<div class="biz-meta">분당 +' + fmtWon(item.incomePerMin) + ' <span style="font-size:0.75rem; color:#9ca3af;">(급여 차감 순익)</span></div>' +
                  '<div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">' +
                    '<div class="biz-pending" data-biz-pending="' + item.key + '">대기 ' + fmtWon(item.pending || 0) + '</div>' +
                    '<span style="font-size:0.75rem; color:#94a3b8;" data-biz-pct="' + item.key + '">' + pct + '% (8시간 만충)</span>' +
                  '</div>' +
                  '<div class="biz-progress-track"><div class="biz-progress-fill' + (isFull ? ' is-max' : '') + '" data-biz-fill="' + item.key + '" style="width:' + pct + '%;"></div></div>' +
                  '<div class="biz-actions">' +
                    '<button type="button" class="btn-play-game"' + keyAttr + ' onclick="collectBusiness(this.dataset.bizKey)">수금</button>' +
                    up + hire +
                    '<button type="button" class="btn-chip chip-allin"' + keyAttr + ' onclick="sellBusiness(this.dataset.bizKey)">매각 ' + fmtWon(item.sellValue) + '</button>' +
                  '</div></article>';
              }).join('');
            }
            async function loadBusinesses() {
              try {
                const res = await fetch('/api/business', { credentials: 'same-origin' });
                const data = await res.json();
                if (!data.success) {
                  const grid = document.getElementById('biz-grid');
                  if (grid) grid.innerHTML = '<p class="casino-desc">' + (data.error || '로그인 후 이용하세요.') + '</p>';
                  return;
                }
                paintBusinessState(data.state);
              } catch (e) {}
            }
            async function postBusiness(url, body, confirmText) {
              if (confirmText && !window.confirm(confirmText)) return;
              try {
                const res = await fetch(url, {
                  method: 'POST',
                  credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(body || {})
                });
                const data = await res.json();
                if (!data.success) {
                  showToast('error', '사업', data.error || '실패');
                  return;
                }
                if (data.cash !== undefined && typeof updateUserCashDisplay === 'function') {
                  updateUserCashDisplay(data.cash);
                }
                if (data.state) {
                  paintBusinessState(data.state);
                } else {
                  loadBusinesses();
                }
                showToast('success', '사업', data.message || '완료');
              } catch (e) {
                showToast('error', '사업', '서버에 연결하지 못했습니다.');
              }
            }
            function buyBusiness(key) { return postBusiness('/api/business/buy', { key: key }); }
            function upgradeBusiness(key) { return postBusiness('/api/business/upgrade', { key: key }); }
            function hireStaff(key) { return postBusiness('/api/business/hire', { key: key }); }
            function upgradeHq() { return postBusiness('/api/business/hq', {}); }
            function toggleBizAuto() {
              const on = !(bizState && bizState.autoCollect);
              return postBusiness('/api/business/auto', { on: on });
            }
            function collectBusiness(key) { return postBusiness('/api/business/collect', key ? { key: key } : {}); }
            function sellBusiness(key) { return postBusiness('/api/business/sell', { key: key }, '이 점포를 매각할까요? 투자금의 60%와 대기 수익이 들어옵니다.'); }
            setInterval(function() {
              const pane = document.getElementById('tab-business');
              if (!pane || !pane.classList.contains('active')) return;
              if (!bizState || !bizState.items) return;
              const now = Date.now();
              const clientElapsedSec = Math.max(0, (now - (bizState._loadedAt || now)) / 1000);
              let total = 0;
              bizState.items.forEach(function(item) {
                if (!item.owned) return;
                const totalElapsedSec = (Number(item.elapsedSec) || 0) + clientElapsedSec;
                const capMin = item.capMin || 480;
                const mins = Math.min(capMin, totalElapsedSec / 60);
                const pending = mins >= 1 ? Math.floor((item.incomePerMin || 0) * mins) : 0;
                total += pending;
                const pct = Math.min(100, Math.round((mins / capMin) * 100));
                const isFull = pct >= 100;

                const el = document.querySelector('[data-biz-pending="' + item.key + '"]');
                if (el) el.textContent = '대기 ' + fmtWon(pending);
                const pctEl = document.querySelector('[data-biz-pct="' + item.key + '"]');
                if (pctEl) pctEl.textContent = pct + '% (8시간 만충)';
                const fillEl = document.querySelector('[data-biz-fill="' + item.key + '"]');
                if (fillEl) {
                  fillEl.style.width = pct + '%';
                  fillEl.className = 'biz-progress-fill' + (isFull ? ' is-max' : '');
                }
                const cardEl = document.getElementById('biz-card-' + item.key);
                if (cardEl) {
                  cardEl.classList.toggle('is-full', isFull);
                }
              });
              const pendingEl = document.getElementById('biz-pending');
              if (pendingEl) pendingEl.textContent = fmtWon(total);
            }, 1000);

            function setSlotBet(val) {
              addNumericBet('slot-bet', val);
            }

            function setCoinBet(val) {
              addNumericBet('coin-bet', val);
            }

            function setDiceBet(val) {
              addNumericBet('dice-bet', val);
            }

            function selectNewsCategory(cat) {
              currentNewsCategory = cat;
              document.querySelectorAll('.btn-filter').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('onclick')?.includes(cat));
              });
              filterNewsList();
            }

            function filterNewsList() {
              const search = (document.getElementById('news-search-input')?.value || '').toLowerCase().trim();
              const items = document.querySelectorAll('.news-item');

              items.forEach(item => {
                const itemCat = item.getAttribute('data-category') || 'ALL';
                const text = item.innerText.toLowerCase();

                const matchesCat = (currentNewsCategory === 'ALL' || itemCat === currentNewsCategory);
                const matchesSearch = !search || text.includes(search);

                item.style.display = (matchesCat && matchesSearch) ? 'flex' : 'none';
              });
            }

            function getMinerWindowId() {
              try {
                let id = sessionStorage.getItem('wtrddMinerId');
                if (!id) {
                  id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
                  sessionStorage.setItem('wtrddMinerId', id);
                }
                return id;
              } catch (err) {
                if (!window.__wtrddMinerId) {
                  window.__wtrddMinerId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
                }
                return window.__wtrddMinerId;
              }
            }

            function clickPointFromEvent(e) {
              if (!e || typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return null;
              const zone = document.getElementById('clicker-zone');
              if (!zone) return null;
              const rect = zone.getBoundingClientRect();
              return {
                x: Math.round(e.clientX - rect.left),
                y: Math.round(e.clientY - rect.top)
              };
            }

            // 1. ⛏️ 클리커 채굴 클릭 핸들러
            function handleClickMining(e) {
              if (document.hidden) return;
              if (e && e.isTrusted === false) return;
              const pt = clickPointFromEvent(e);
              if (!pt) return;

              clickHitBuffer.push(pt);
              const cfg = window.CLICKER_CFG || {};
              const maxBatch = cfg.maxClicksPerRequest || 4;
              if (clickHitBuffer.length >= maxBatch) {
                if (clickFlushTimer) clearTimeout(clickFlushTimer);
                clickFlushTimer = null;
                flushClickBuffer();
              } else {
                if (clickFlushTimer) clearTimeout(clickFlushTimer);
                clickFlushTimer = setTimeout(flushClickBuffer, 200);
              }

              if (minerWindowBlocked) return;

              const gem = document.getElementById('gem-clicker');
              if (gem) {
                gem.classList.remove('gem-hit');
                void gem.offsetWidth;
                gem.classList.add('gem-hit');
              }

              const isCrit = Math.random() < (cfg.critChance || 0.10);
              const powerValStr = document.getElementById('clicker-power-val')?.innerText || '2';
              const powerVal = parseInt(powerValStr.replace(/[^0-9]/g, ''), 10) || 2;
              const critMult = cfg.critMultiplier || 3;
              const gain = isCrit ? (powerVal * critMult) : powerVal;
              const text = isCrit ? ('🔥 ' + critMult + 'X 대박! +' + gain.toLocaleString() + '원') : ('+' + gain.toLocaleString() + '원');

              const floatElem = document.createElement('div');
              floatElem.className = 'floating-coin' + (isCrit ? ' crit' : '');
              floatElem.innerText = text;

              const zone = document.getElementById('clicker-zone');
              if (zone) {
                const zoneRect = zone.getBoundingClientRect();
                floatElem.style.left = Math.max(10, Math.min(zoneRect.width - 120, pt.x - 30)) + 'px';
                floatElem.style.top = Math.max(10, pt.y - 20) + 'px';
                zone.appendChild(floatElem);
                setTimeout(() => floatElem.remove(), 700);
              }

              if (window.MineHub && typeof window.MineHub.onEarned === 'function') {
                window.MineHub.onEarned(e, isCrit, gain);
              }
            }

            async function flushClickBuffer() {
              if (document.hidden) {
                clickHitBuffer = [];
                return;
              }
              if (clickHitBuffer.length <= 0) return;
              const hits = clickHitBuffer.splice(0, clickHitBuffer.length);
              const count = hits.length;
              const hub = window.MineHub || {};

              try {
                const res = await fetch('/api/clicker/click', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    count,
                    hits,
                    wid: getMinerWindowId(),
                    genre: typeof hub.genre === 'function' ? hub.genre() : 'classic',
                    combo: typeof hub.combo === 'function' ? hub.combo() : 0,
                    depth: typeof hub.depth === 'function' ? hub.depth() : 0
                  })
                });
                const data = await res.json();
                if (!data.success) {
                  showToast('info', '⛏️ 광산 점검', data.error || '채굴 기능이 일시 중단되었습니다.');
                  return;
                }
                if (data.success) {
                  updateUserCashDisplay(data.newCash);
                  const clicksValElem = document.getElementById('clicker-clicks-val');
                  if (clicksValElem && data.totalClicks) {
                    clicksValElem.innerText = Number(data.totalClicks).toLocaleString() + '회';
                  }
                  if (data.blocked === 'window') {
                    minerWindowBlocked = true;
                    if (Date.now() - lastSamePixelToastAt > 2500) {
                      lastSamePixelToastAt = Date.now();
                      showToast('error', '채굴', '다른 창에서 이미 채굴 중입니다. 한 창에서만 눌러 주세요.');
                    }
                  } else if (data.clicks > 0) {
                    minerWindowBlocked = false;
                  }
                  if (data.dropped > 0 && Date.now() - lastSamePixelToastAt > 2500) {
                    lastSamePixelToastAt = Date.now();
                    showToast('error', '채굴', '같은 자리를 반복해서 누르면 인정되지 않습니다. 살짝 움직이면서 눌러 주세요.');
                  }
                }
              } catch (e) {}
            }

            document.addEventListener('visibilitychange', function () {
              if (document.hidden) {
                clickHitBuffer = [];
                if (clickFlushTimer) {
                  clearTimeout(clickFlushTimer);
                  clickFlushTimer = null;
                }
              }
            });

            async function buyUpgrade(type) {
              try {
                const res = await fetch('/api/clicker/upgrade', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ type })
                });
                const data = await res.json();
                if (!data.success) {
                  showToast('error', '업그레이드 실패', data.error);
                  return;
                }
                showToast('success', '업그레이드 완료', data.message);
                updateUserCashDisplay(data.newCash);
                const cfg = window.CLICKER_CFG || {};
                const ppl = cfg.powerPerLevel || 10;
                const upc = cfg.upgradeCostPerLevel || 4500;
                const ail = cfg.autoIncomePerLevel || 15;
                const acn = cfg.autoCostPerNextLevel || 12000;
                if (data.clickerLevel !== undefined) {
                  document.getElementById('clicker-power-val').innerText = '+' + (data.clickerLevel * ppl).toLocaleString() + '원';
                  document.getElementById('shop-power-lv').innerText = data.clickerLevel;
                  document.getElementById('shop-power-cost').innerText = (data.clickerLevel * upc).toLocaleString() + '원';
                }
                if (data.autoLevel !== undefined) {
                  document.getElementById('clicker-auto-val').innerText = '+' + (data.autoLevel * ail).toLocaleString() + '원/s';
                  document.getElementById('shop-auto-lv').innerText = data.autoLevel;
                  document.getElementById('shop-auto-cost').innerText = ((data.autoLevel + 1) * acn).toLocaleString() + '원';
                }
              } catch (e) { showToast('error', '통신 오류', '서버와 연결할 수 없습니다.'); }
            }

            // 2. 종목 상세 차트 모달 열기
            async function openDetailModal(stockId) {
              document.getElementById('detail-modal').style.display = 'flex';
              document.getElementById('detail-stock-name').innerText = '종목 데이터 불러오는 중...';

              try {
                const res = await fetch('/api/stock/' + stockId);
                const data = await res.json();
                if (!data.success) {
                  showToast('error', '조회 실패', data.error || '종목 정보를 불러올 수 없습니다.');
                  closeDetailModal();
                  return;
                }

                const s = data.stock;
                currentDetailStock = s;

                const diff = s.price - s.prev_price;
                const rate = s.prev_price > 0 ? ((diff / s.prev_price) * 100).toFixed(2) : '0.00';
                const isUp = diff >= 0;

                document.getElementById('detail-stock-name').innerText = s.name;
                document.getElementById('detail-symbol').innerText = '[' + s.stock_id + ']';
                document.getElementById('detail-sector').innerText = s.sector;
                document.getElementById('detail-price').innerText = fmtMoneyUi(s.price);

                const rateElem = document.getElementById('detail-rate');
                rateElem.innerText = (isUp ? '▲ +' : '▼ ') + rate + '%';
                rateElem.style.color = isUp ? '#34d399' : '#f87171';

                document.getElementById('detail-high').innerText = fmtMoneyUi(s.high_24h);
                document.getElementById('detail-low').innerText = fmtMoneyUi(s.low_24h);
                document.getElementById('detail-cap').innerText = formatCap(s.market_cap);
                document.getElementById('detail-pe-div').innerText = s.pe_ratio + '배 / ' + s.dividend_yield + '%';

                const userHoldNum = holdingShares(s.stock_id, s.userHolding);
                const stackStr = userHoldNum > 0 ? (userHoldNum / 10).toFixed(1) + '스택' : '0스택';
                const holdingElem = document.getElementById('detail-my-holding');
                if (holdingElem) holdingElem.innerText = userHoldNum.toLocaleString() + '주 (' + stackStr + ')';
                const avgElem = document.getElementById('detail-my-avg');
                if (avgElem) avgElem.innerText = (s.userAvgPrice ? Number(s.userAvgPrice).toLocaleString() : '0') + '원';

                const maxBuyElem = document.getElementById('detail-max-buy');
                if (maxBuyElem) {
                  maxBuyElem.innerText = (s.maxBuySharesText || '한도 산출 중') + (s.regimeBuyPolicy ? ' (' + s.regimeBuyPolicy + ')' : '');
                }

                document.getElementById('detail-description').innerText = s.description;

                renderDetailChart(data.history.map(h => h.price), isUp);

              } catch (e) {
                showToast('error', '로딩 실패', '종목 정보 통신에 실패했습니다.');
                closeDetailModal();
              }
            }

            function closeDetailModal() {
              document.getElementById('detail-modal').style.display = 'none';
            }

            function openTradeFromDetail(action) {
              if (!currentDetailStock) return;
              closeDetailModal();
              openTradeModal(currentDetailStock.stock_id, currentDetailStock.name, currentDetailStock.price, action, currentDetailStock.userHolding);
            }

            function formatCap(num) {
              if (!num) return '1,000억원';
              if (num >= 1000000000000) return (num / 1000000000000).toFixed(1) + '조원';
              if (num >= 100000000) return (num / 100000000).toLocaleString() + '억원';
              return num.toLocaleString() + '원';
            }

            function renderDetailChart(prices, isUp) {
              const box = document.getElementById('detail-chart-svg');
              if (!prices || prices.length < 2) {
                box.innerHTML = '<span style="color:#9ca3af;">차트 히스토리가 부족합니다.</span>';
                return;
              }

              const min = Math.min(...prices);
              const max = Math.max(...prices);
              const range = max - min || 1;
              const width = 440;
              const height = 150;
              const padX = 10;
              const padY = 15;

              const points = prices.map((p, i) => {
                const x = padX + (i / (prices.length - 1)) * (width - padX * 2);
                const y = height - padY - ((p - min) / range) * (height - padY * 2);
                return x.toFixed(1) + ',' + y.toFixed(1);
              }).join(' ');

              const stroke = isUp ? '#10b981' : '#ef4444';
              const fill = isUp ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)';
              const area = padX + ',' + height + ' ' + points + ' ' + (width - padX) + ',' + height;

              box.innerHTML = '<svg width="100%" height="100%" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' +
                '<line x1="' + padX + '" y1="' + padY + '" x2="' + (width-padX) + '" y2="' + padY + '" stroke="rgba(255,255,255,0.06)" stroke-dasharray="4,4"/>' +
                '<line x1="' + padX + '" y1="' + (height/2) + '" x2="' + (width-padX) + '" y2="' + (height/2) + '" stroke="rgba(255,255,255,0.06)" stroke-dasharray="4,4"/>' +
                '<polygon points="' + area + '" fill="' + fill + '"/>' +
                '<polyline points="' + points + '" fill="none" stroke="' + stroke + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
                '</svg>';
            }

            // 3. 🎰 슬롯머신 실행
            async function playSlotMachine() {
              if (isGameInProgress) return;
              const fx = window.GameFx;
              if (window.CasinoAudio) window.CasinoAudio.play('slot', '슬롯머신');
              setGameLock(true);

              const bet = getBetPayload(document.getElementById('slot-bet'));
              const resultBox = document.getElementById('slot-result');
              const btn = document.getElementById('btn-spin-slot');
              const reels = [document.getElementById('reel-1'), document.getElementById('reel-2'), document.getElementById('reel-3')];
              const syms = (fx && fx.SLOT_SYMS) || ['🍒', '🍋', '🍇', '🍉', '🔔', '💎', '7️⃣'];

              reels.forEach(function(el, i) {
                if (!el) return;
                el.classList.add('spinning');
                if (fx) fx.cycleText(el, syms, 'slot' + i, 70);
              });
              if (btn) btn.innerText = '릴 회전 중...';
              if (fx) fx.setCall('slot-call', '릴이 돌아가고 있습니다...', '#fbbf24');
              if (resultBox) {
                resultBox.innerText = '🎰 왼쪽 릴부터 순서대로 멈춥니다.';
                resultBox.style.color = '#fbbf24';
              }

              try {
                const res = await fetch('/api/game/slot', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bet })
                });
                const data = await res.json();

                if (!data.success) {
                  reels.forEach(function(el, i) {
                    if (fx) fx.clearTimer('slot' + i);
                    if (el) el.classList.remove('spinning');
                  });
                  setGameLock(false);
                  if (btn) btn.innerText = '돌리기';
                  if (resultBox) {
                    resultBox.innerText = '❌ ' + (data.error || '오류 발생');
                    resultBox.style.color = '#ef4444';
                  }
                  showToast('error', '슬롯 오류', data.error);
                  return;
                }

                const landed = data.displayReels || data.slots || data.reels || [];
                if (fx) await fx.stopReelsInOrder(reels, landed, 'slot');
                else {
                  reels.forEach(function(el, i) {
                    if (el) { el.classList.remove('spinning'); el.innerText = landed[i] || '❓'; }
                  });
                }

                const title = data.isWin ? '적중 ' + Number(data.multiplier || 0).toFixed(1) + '배' : '이번 판은 빗나감';
                if (fx) fx.paintResult('slot-result', data.isWin, title, data.message, data.flavor);
                else if (resultBox) {
                  resultBox.innerText = data.message;
                  resultBox.style.color = data.isWin ? '#34d399' : '#f87171';
                }
                if (fx) fx.setCall('slot-call', data.flavor || (data.isWin ? '라인이 맞았습니다.' : '다음 스핀에서.'), data.isWin ? '#34d399' : '#94a3b8');
                if (btn) btn.innerText = '돌리기';
                updateUserCashDisplay(data.newCash);
                showToast(data.isWin ? 'success' : 'info', '🎰 슬롯 결과', data.message);
                if (window.CasinoUX) window.CasinoUX.onGameResult(Object.assign({ game: '슬롯머신' }, data));
                setGameLock(false);
              } catch (e) {
                reels.forEach(function(el, i) {
                  if (fx) fx.clearTimer('slot' + i);
                  if (el) el.classList.remove('spinning');
                });
                setGameLock(false);
                if (btn) btn.innerText = '돌리기';
                if (resultBox) resultBox.innerText = '서버 통신 실패';
                showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
              }
            }

            // 4. 🪙 동전 던지기 실행
            async function playCoinFlip() {
              if (isGameInProgress) return;
              const fx = window.GameFx;
              if (window.CasinoAudio) window.CasinoAudio.play('coin', '동전뒤집기');
              setGameLock(true);

              const bet = getBetPayload(document.getElementById('coin-bet'));
              const coin = document.getElementById('coin-element');
              const resultBox = document.getElementById('coin-result');
              const btn = document.getElementById('btn-flip-coin');

              if (coin) {
                coin.classList.remove('landing');
                coin.classList.add('flipping');
              }
              if (btn) btn.innerText = '공중...';
              if (fx) fx.setCall('coin-call', '동전이 회전하고 있습니다...', '#fbbf24');
              if (resultBox) resultBox.innerText = '🪙 어느 면이 위를 향할까요?';

              try {
                const res = await fetch('/api/game/coinflip', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bet, choice: selectedCoin })
                });
                const data = await res.json();

                if (fx) {
                  await fx.sleep(380);
                  if (fx) fx.setCall('coin-call', '마지막 회전...', '#fde68a');
                  await fx.sleep(520);
                } else {
                  await new Promise(function(r) { setTimeout(r, 900); });
                }

                if (coin) {
                  coin.classList.remove('flipping');
                  coin.classList.add('landing');
                }
                if (btn) btn.innerText = '던지기';

                if (!data.success) {
                  setGameLock(false);
                  if (resultBox) {
                    resultBox.innerText = '❌ ' + (data.error || '오류 발생');
                    resultBox.style.color = '#ef4444';
                  }
                  showToast('error', '동전 던지기 오류', data.error);
                  return;
                }

                const coinFace = data.result || data.coinResult;
                if (coin) coin.innerText = coinFace === '앞면' ? '🦅' : '👑';
                const title = data.isWin ? '적중 · ' + coinFace : '반대면 · ' + coinFace;
                if (fx) fx.paintResult('coin-result', data.isWin, title, data.message, data.flavor);
                else if (resultBox) {
                  resultBox.innerText = data.message;
                  resultBox.style.color = data.isWin ? '#34d399' : '#f87171';
                }
                if (fx) fx.setCall('coin-call', data.flavor || '', data.isWin ? '#34d399' : '#94a3b8');
                updateUserCashDisplay(data.newCash);
                showToast(data.isWin ? 'success' : 'info', '🪙 동전 결과', data.message);
                if (window.CasinoUX) window.CasinoUX.onGameResult(Object.assign({ game: '동전뒤집기' }, data));
                setGameLock(false);
              } catch (e) {
                setGameLock(false);
                if (btn) btn.innerText = '던지기';
                if (coin) coin.classList.remove('flipping');
                if (resultBox) resultBox.innerText = '서버 통신 실패';
                showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
              }
            }

            // 5. 🎲 주사위 대결
            const DICE_PIP_MAP = {
              1: [5],
              2: [1, 9],
              3: [1, 5, 9],
              4: [1, 3, 7, 9],
              5: [1, 3, 5, 7, 9],
              6: [1, 3, 4, 6, 7, 9]
            };

            function buildDiceFace(n, rolling) {
              const value = (n >= 1 && n <= 6) ? n : 0;
              const active = DICE_PIP_MAP[value] || [];
              let pips = '';
              for (let i = 1; i <= 9; i++) {
                pips += '<span class="dice-pip' + (active.indexOf(i) !== -1 ? ' on' : '') + '"></span>';
              }
              return '<div class="dice-face' + (rolling ? ' rolling' : '') + '" data-n="' + value + '">' + pips + '</div>';
            }

            function paintDiceBox(el, values, rolling) {
              if (!el) return;
              const pair = Array.isArray(values) && values.length >= 2 ? values : [0, 0];
              el.innerHTML = buildDiceFace(pair[0], rolling) + buildDiceFace(pair[1], rolling);
            }

            function randomDicePair() {
              return [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1];
            }

            paintDiceBox(document.getElementById('user-dice-box'), [0, 0], false);
            paintDiceBox(document.getElementById('bot-dice-box'), [0, 0], false);

            async function playDice() {
              if (isGameInProgress) return;
              const fx = window.GameFx;
              if (window.CasinoAudio) window.CasinoAudio.play('dice', '주사위대결');
              setGameLock(true);

              const bet = getBetPayload(document.getElementById('dice-bet'));
              const userBox = document.getElementById('user-dice-box');
              const botBox = document.getElementById('bot-dice-box');
              const resultBox = document.getElementById('dice-result');
              const btn = document.getElementById('btn-roll-dice');

              if (btn) btn.innerText = '굴리는 중...';
              if (fx) fx.setCall('dice-call', '주사위가 테이블 위를 구릅니다...', '#fbbf24');
              if (resultBox) resultBox.innerText = '🎲 내 차례...';
              paintDiceBox(userBox, randomDicePair(), true);
              paintDiceBox(botBox, randomDicePair(), true);
              const rollTimer = setInterval(function() {
                paintDiceBox(userBox, randomDicePair(), true);
                paintDiceBox(botBox, randomDicePair(), true);
              }, 110);

              try {
                const res = await fetch('/api/game/dice', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bet })
                });
                const data = await res.json();

                if (!data.success) {
                  clearInterval(rollTimer);
                  setGameLock(false);
                  if (btn) btn.innerText = '굴리기';
                  paintDiceBox(userBox, [0, 0], false);
                  paintDiceBox(botBox, [0, 0], false);
                  if (resultBox) {
                    resultBox.innerText = '❌ ' + (data.error || '오류 발생');
                    resultBox.style.color = '#ef4444';
                  }
                  showToast('error', '주사위 오류', data.error);
                  return;
                }

                await (fx ? fx.sleep(520) : new Promise(function(r){ setTimeout(r, 520); }));
                paintDiceBox(userBox, Array.isArray(data.userDice) ? data.userDice : [0, 0], false);
                if (fx) fx.setCall('dice-call', '내 눈 ' + (data.userTotal || '') + '. 딜러가 받습니다...', '#fde68a');
                if (resultBox) resultBox.innerText = '🎲 딜러의 차례...';

                await (fx ? fx.sleep(640) : new Promise(function(r){ setTimeout(r, 640); }));
                clearInterval(rollTimer);
                paintDiceBox(userBox, Array.isArray(data.userDice) ? data.userDice : [0, 0], false);
                paintDiceBox(botBox, Array.isArray(data.botDice) ? data.botDice : [0, 0], false);

                const title = data.isTie ? '무승부' : (data.isWin ? '승리' : '패배');
                if (fx) fx.paintResult('dice-result', data.isWin, title + ' · 나 ' + data.userTotal + ' vs 딜러 ' + data.botTotal, data.message, data.flavor, data.isTie);
                else if (resultBox) {
                  resultBox.innerText = data.message;
                  resultBox.style.color = data.isWin ? '#34d399' : (data.isTie ? '#fbbf24' : '#f87171');
                }
                if (fx) fx.setCall('dice-call', data.flavor || '', data.isTie ? '#fbbf24' : (data.isWin ? '#34d399' : '#94a3b8'));
                if (btn) btn.innerText = '굴리기';
                updateUserCashDisplay(data.newCash);
                showToast(data.isWin ? 'success' : (data.isTie ? 'warn' : 'info'), '🎲 주사위 결과', data.message);
                if (window.CasinoUX) window.CasinoUX.onGameResult(Object.assign({ game: '주사위대결' }, data));
                setGameLock(false);
              } catch (e) {
                clearInterval(rollTimer);
                setGameLock(false);
                if (btn) btn.innerText = '굴리기';
                paintDiceBox(userBox, [0, 0], false);
                paintDiceBox(botBox, [0, 0], false);
                if (resultBox) resultBox.innerText = '서버 통신 실패';
                showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
              }
            }

            // 5.5 🎫 럭키세븐 즉석 복권 게임
            function setLotteryBet(amount) {
              addNumericBet('lottery-bet', amount);
            }

            async function playInstantLottery() {
              if (isGameInProgress) return;
              const fx = window.GameFx;
              if (window.CasinoAudio) window.CasinoAudio.play('slot', '즉석복권');
              setGameLock(true);

              const bet = getBetPayload(document.getElementById('lottery-bet'));
              const slots = [document.getElementById('lottery-slot-1'), document.getElementById('lottery-slot-2'), document.getElementById('lottery-slot-3')];
              const resultBox = document.getElementById('lottery-result');
              const btn = document.getElementById('btn-scratch-lottery');
              const syms = (fx && fx.LOTTO_SYMS) || ['💰', '🦆', '💎', '7️⃣', '💣', '⭐'];

              slots.forEach(function(el, i) {
                if (!el) return;
                el.innerText = '?';
                el.classList.add('spinning');
                if (fx) fx.cycleText(el, syms, 'lotto' + i, 80);
              });
              if (btn) btn.innerText = '긁는 중...';
              if (fx) fx.setCall('lottery-call', '왼쪽 칸부터 긁고 있습니다...', '#c084fc');
              if (resultBox) {
                resultBox.innerText = '🎫 용지를 한 칸씩 확인합니다.';
                resultBox.style.color = '#c084fc';
              }

              try {
                const res = await fetch('/api/game/lottery', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bet })
                });
                const data = await res.json();

                if (!data.success) {
                  slots.forEach(function(el, i) {
                    if (fx) fx.clearTimer('lotto' + i);
                    if (el) el.classList.remove('spinning');
                  });
                  setGameLock(false);
                  if (btn) btn.innerText = '긁기';
                  if (resultBox) {
                    resultBox.innerText = '❌ ' + (data.error || '오류 발생');
                    resultBox.style.color = '#ef4444';
                  }
                  showToast('error', '복권 오류', data.error);
                  return;
                }

                const landed = data.displayReels || data.symbols || (data.payload && data.payload.symbols) || (data.details && data.details.symbols) || [];
                if (fx) await fx.stopReelsInOrder(slots, landed, 'lotto');
                else {
                  slots.forEach(function(el, i) {
                    if (el) { el.classList.remove('spinning'); el.innerText = landed[i] || '?'; }
                  });
                }

                const title = data.isWin ? '당첨 ' + Number(data.multiplier || 0).toFixed(1) + '배' : '꽝';
                if (fx) fx.paintResult('lottery-result', data.isWin, title, data.message, data.flavor);
                else if (resultBox) {
                  resultBox.innerText = data.message;
                  resultBox.style.color = data.isWin ? '#34d399' : '#f87171';
                }
                if (fx) fx.setCall('lottery-call', data.flavor || '', data.isWin ? '#34d399' : '#94a3b8');
                if (btn) btn.innerText = '긁기';
                updateUserCashDisplay(data.newCash);
                showToast(data.isWin ? 'success' : 'info', '🎫 복권 결과', data.message);
                if (window.CasinoUX) window.CasinoUX.onGameResult(Object.assign({ game: '즉석복권' }, data));
                setGameLock(false);
              } catch (e) {
                slots.forEach(function(el, i) {
                  if (fx) fx.clearTimer('lotto' + i);
                  if (el) el.classList.remove('spinning');
                });
                setGameLock(false);
                if (btn) btn.innerText = '긁기';
                if (resultBox) resultBox.innerText = '서버 통신 실패';
                showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
              }
            }

            // 5.6 🏇 월덕 그랑프리 실시간 경마 스크립트
            let selectedHorseId = 1;
            let selectedHorseId2 = 0;
            let horseBetMode = 'win';
            let horseCardCache = { horses: [] };
            const HORSE_RUNNERS = { 1: '⚡🏇', 2: '🌪️🏇', 3: '🖤🏇', 4: '🦆🏇', 5: '💎🏇' };
            const HORSES_INFO = {
              1: { name: '1번 황금번개', odds: '2.0배', color: '#fbbf24' },
              2: { name: '2번 질풍노도', odds: '3.0배', color: '#38bdf8' },
              3: { name: '3번 다크호스', odds: '5.0배', color: '#a855f7' },
              4: { name: '4번 월덕스피릿', odds: '8.0배', color: '#f43f5e' },
              5: { name: '5번 로또잭팟', odds: '15.0배', color: '#ec4899' }
            };
            const HORSE_MODE_META = {
              win: { name: '단승', picks: 1 },
              place: { name: '복승', picks: 1 },
              show: { name: '연승', picks: 1 },
              quinella: { name: '복연승', picks: 2 },
              exacta: { name: '쌍승', picks: 2 }
            };

            function horseById(id) {
              const list = horseCardCache.horses || [];
              return list.find(function(h) { return Number(h.id) === Number(id); }) || null;
            }

            function horseOddsText(odds) {
              const n = Number(odds);
              if (!Number.isFinite(n) || n <= 1) return '마감';
              return n.toFixed(1) + '배';
            }

            function horseOddsLabel(id) {
              const h = horseById(id);
              if (!h) return (HORSES_INFO[id] && HORSES_INFO[id].odds) || '';
              if (horseBetMode === 'place') return horseOddsText(h.placeOdds);
              if (horseBetMode === 'show') return horseOddsText(h.showOdds);
              return horseOddsText(h.winOdds);
            }

            function paintHorseCards() {
              const picks = (HORSE_MODE_META[horseBetMode] || HORSE_MODE_META.win).picks;
              for (let i = 1; i <= 5; i++) {
                const card = document.getElementById('horse-card-' + i);
                const tag = document.getElementById('horse-tag-' + i);
                const oddsEl = document.getElementById('horse-odds-' + i);
                const subEl = document.getElementById('horse-sub-' + i);
                const h = horseById(i);
                if (oddsEl) oddsEl.textContent = horseOddsLabel(i);
                if (subEl && h) {
                  subEl.textContent = '복승 ' + horseOddsText(h.placeOdds) + ' · 연승 ' + horseOddsText(h.showOdds);
                }
                const on = (i === selectedHorseId || i === selectedHorseId2);
                if (card) {
                  card.style.border = on ? '2px solid #fbbf24' : '1px solid var(--card-border)';
                  card.style.transform = on ? 'scale(1.03)' : 'scale(1)';
                  card.classList.toggle('selected', on);
                }
                if (tag) {
                  if (picks === 2 && i === selectedHorseId) tag.textContent = horseBetMode === 'exacta' ? '1착 예상' : '조합 1';
                  else if (picks === 2 && i === selectedHorseId2) tag.textContent = horseBetMode === 'exacta' ? '2착 예상' : '조합 2';
                  else tag.textContent = '';
                }
              }
              const txt = document.getElementById('selected-horse-txt');
              const modeName = (HORSE_MODE_META[horseBetMode] || {}).name || '단승';
              const a = horseById(selectedHorseId);
              const b = horseById(selectedHorseId2);
              let label = modeName + ' · ';
              if (picks === 2) {
                label += (a ? a.name : '1번 말') + (b ? ' + ' + b.name : ' + (두 번째 말 선택)');
                const pairs = horseCardCache.pairOdds || {};
                let pairOdds = 0;
                if (selectedHorseId && selectedHorseId2) {
                  if (horseBetMode === 'quinella') {
                    const key = Math.min(selectedHorseId, selectedHorseId2) + '-' + Math.max(selectedHorseId, selectedHorseId2);
                    pairOdds = pairs.quinella && pairs.quinella[key];
                  } else {
                    pairOdds = pairs.exacta && pairs.exacta[selectedHorseId + '-' + selectedHorseId2];
                  }
                }
                if (pairOdds) label += ' (' + Number(pairOdds).toFixed(1) + '배)';
              } else {
                label += (a ? a.name : (HORSES_INFO[selectedHorseId] || {}).name || '') + ' (' + horseOddsLabel(selectedHorseId) + ')';
              }
              if (txt) {
                txt.textContent = label;
                txt.style.color = (a && a.color) || '#fbbf24';
              }
            }

            async function refreshHorseCard() {
              try {
                const res = await fetch('/api/game/horse-card');
                const data = await res.json();
                if (!data.success) return;
                horseCardCache = data;
                const emoji = document.getElementById('horse-cond-emoji');
                const title = document.getElementById('horse-cond-title');
                const desc = document.getElementById('horse-cond-desc');
                if (data.condition) {
                  if (emoji) emoji.textContent = data.condition.emoji || '☀️';
                  if (title) title.textContent = (data.condition.emoji || '') + ' ' + data.condition.name + ' 주로';
                  if (desc) desc.textContent = data.condition.desc || '';
                }
                paintHorseCards();
              } catch (e) {}
            }

            function setHorseBetMode(mode) {
              horseBetMode = HORSE_MODE_META[mode] ? mode : 'win';
              document.querySelectorAll('.horse-mode-btn').forEach(function(btn) {
                btn.classList.toggle('selected', btn.getAttribute('data-mode') === horseBetMode);
              });
              if ((HORSE_MODE_META[horseBetMode] || {}).picks === 1) selectedHorseId2 = 0;
              paintHorseCards();
            }

            function selectHorse(id) {
              const picks = (HORSE_MODE_META[horseBetMode] || HORSE_MODE_META.win).picks;
              if (picks === 1) {
                selectedHorseId = id;
                selectedHorseId2 = 0;
              } else if (selectedHorseId === id) {
                selectedHorseId = selectedHorseId2 || 0;
                selectedHorseId2 = 0;
              } else if (selectedHorseId2 === id) {
                selectedHorseId2 = 0;
              } else if (!selectedHorseId) {
                selectedHorseId = id;
              } else if (!selectedHorseId2) {
                selectedHorseId2 = id;
              } else {
                selectedHorseId2 = id;
              }
              paintHorseCards();
            }

            function setHorseBet(amount) {
              addNumericBet('horse-bet-input', amount);
            }

            async function startWebHorseRace() {
              if (isGameInProgress) return;
              const picks = (HORSE_MODE_META[horseBetMode] || HORSE_MODE_META.win).picks;
              if (!selectedHorseId || (picks === 2 && !selectedHorseId2)) {
                showToast('error', '경마', picks === 2 ? '두 마리를 선택해주세요.' : '출전마를 선택해주세요.');
                return;
              }
              if (window.CasinoAudio) window.CasinoAudio.play('horse', '월덕경마');
              setGameLock(true);

              const betInput = document.getElementById('horse-bet-input');
              const bet = getBetPayload(betInput);
              const btn = document.getElementById('btn-start-race');
              const banner = document.getElementById('race-status-banner');
              const resultBox = document.getElementById('horse-race-result-box');
              const podium = document.getElementById('horse-podium');
              if (podium) podium.innerHTML = '';

              for (let i = 1; i <= 5; i++) {
                const el = document.getElementById('horse-runner-' + i);
                if (el) {
                  el.style.left = '0%';
                  el.innerText = HORSE_RUNNERS[i];
                }
              }

              btn.innerText = '🏇 경주 진행 중...';
              banner.innerText = '🏃💨 탕! 경주가 시작되었습니다!';
              banner.style.color = '#fbbf24';
              resultBox.innerText = '🏁 말들이 결승선을 향해 치열하게 질주하고 있습니다!';
              resultBox.style.color = '#fbbf24';

              try {
                const res = await fetch('/api/game/horse-race', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    mode: horseBetMode,
                    horseId: selectedHorseId,
                    horseId2: selectedHorseId2 || undefined,
                    amount: bet
                  })
                });
                const data = await res.json();

                if (!data.success) {
                  setGameLock(false);
                  btn.innerText = '경주 시작';
                  banner.innerText = '⚠️ 오류 발생';
                  resultBox.innerText = '❌ ' + (data.error || '오류 발생');
                  resultBox.style.color = '#ef4444';
                  showToast('error', '경마 오류', data.error);
                  return;
                }

                const ranking = Array.isArray(data.ranking) ? data.ranking : [];

                setTimeout(function() {
                  banner.innerText = '🔥 200m 통과! 선두권 쟁탈전 치열!';
                  for (let i = 1; i <= 5; i++) {
                    const el = document.getElementById('horse-runner-' + i);
                    if (el) el.style.left = (Math.random() * 25 + 15) + '%';
                  }
                }, 800);

                setTimeout(function() {
                  banner.innerText = '⚡ 마지막 직선 주로 진입! 라스트 스퍼트!';
                  ranking.forEach(function(h, idx) {
                    const el = document.getElementById('horse-runner-' + h.id);
                    if (el) el.style.left = (72 - idx * 8) + '%';
                  });
                }, 1800);

                setTimeout(function() {
                  setGameLock(false);
                  btn.innerText = '경주 시작';
                  banner.innerText = '🏁 결승선 통과 완료!';

                  ranking.forEach(function(h, idx) {
                    const el = document.getElementById('horse-runner-' + h.id);
                    if (!el) return;
                    el.style.left = (88 - idx * 7) + '%';
                    el.innerText = idx === 0 ? '🏆🏇' : HORSE_RUNNERS[h.id];
                  });

                  if (podium && ranking.length >= 3) {
                    podium.innerHTML =
                      '<div class="horse-podium-item">🥇 ' + escapeHtml(ranking[0].name) + '</div>' +
                      '<div class="horse-podium-item">🥈 ' + escapeHtml(ranking[1].name) + '</div>' +
                      '<div class="horse-podium-item">🥉 ' + escapeHtml(ranking[2].name) + '</div>';
                  }

                  const modeName = escapeHtml(data.modeName || '단승');
                  const winnerName = escapeHtml((data.winner && data.winner.name) || '');
                  const chosenName = escapeHtml((data.chosenHorse && data.chosenHorse.name) || '');
                  const flavor = data.flavor ? '<div style="margin-top:8px;font-size:0.78rem;font-weight:500;color:#94a3b8;">' + escapeHtml(data.flavor) + '</div>' : '';
                  if (data.isWin) {
                    resultBox.innerHTML = '🎉 <b style="color:#10b981;">' + modeName + ' 적중!</b> 1착: <b>' + winnerName + '</b> (' + Number(data.odds || data.multiplier).toFixed(1) + '배) | 상금: <b>+' + Number(data.payout).toLocaleString() + '원</b>' + flavor;
                    resultBox.style.color = '#10b981';
                    showToast('success', '🏇 경마 적중!', modeName + ' 성공! +' + fmtMoneyUi(data.payout));
                  } else {
                    resultBox.innerHTML = '💀 <b style="color:#f87171;">' + modeName + ' 불발</b> 1착: <b>' + winnerName + '</b> (내 선택: ' + chosenName + ') | 손실: -' + fmtMoneyUi(data.bet) + flavor;
                    resultBox.style.color = '#f87171';
                    showToast('info', '🏇 경마 결과', '1착은 [' + ((data.winner && data.winner.name) || '') + '] 입니다.');
                  }

                  updateUserCashDisplay(data.newCash);
                  if (window.CasinoUX) window.CasinoUX.onGameResult(Object.assign({ game: '월덕경마' }, data));
                  refreshHorseCard();
                }, 3000);

              } catch (e) {
                setGameLock(false);
                btn.innerText = '경주 시작';
                resultBox.innerText = '서버 통신 실패';
                showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
              }
            }
            window.setHorseBetMode = setHorseBetMode;
            window.selectHorse = selectHorse;
            window.startWebHorseRace = startWebHorseRace;
            window.refreshHorseCard = refreshHorseCard;
            refreshHorseCard();

            // 6. 출석체크 & 지원금
            async function claimDailyReward() {
              try {
                const res = await fetch('/api/economy/daily', { method: 'POST' });
                const data = await res.json();
                if (!data.success) {
                  showToast('error', '출석체크 안내', data.error);
                  return;
                }
                showToast('success', '🎁 출석 보상 완료', data.message);
                updateUserCashDisplay(data.newCash);
              } catch (e) { showToast('error', '통신 오류', '출석체크 서버 연결 실패'); }
            }

            async function claimSubsidyReward() {
              try {
                const res = await fetch('/api/economy/subsidy', { method: 'POST' });
                const data = await res.json();
                if (!data.success) {
                  showToast('error', '지원금 신청 불가', data.error);
                  return;
                }
                showToast('success', '🏛️ 기본소득 지급 완료', data.message);
                updateUserCashDisplay(data.newCash);
              } catch (e) { showToast('error', '통신 오류', '지원금 신청 서버 연결 실패'); }
            }

            // 7. 주식 거래 모달 & 수량 프리셋 / 전량(MAX) 처리
            function dockTradeModal() {
              const modal = document.getElementById('trade-modal');
              if (!modal) return;
              if (modal.parentElement !== document.body && document.body) {
                document.body.appendChild(modal);
              }
              syncTradePanelCash();
            }
            window.addEventListener('DOMContentLoaded', dockTradeModal);

            function openTradeModal(stockId, name, price, action, directHolding) {
              try {
                const tradeModal = document.getElementById('trade-modal');
                if (!tradeModal) return;
                if (tradeModal.parentElement !== document.body && document.body) {
                  document.body.appendChild(tradeModal);
                }
                tradeModal.classList.add('is-open');
                tradeModal.style.display = 'flex';
                tradeModal.style.position = 'fixed';
                tradeModal.style.inset = '0';
                tradeModal.style.zIndex = '10000';
                tradeModal.style.alignItems = 'center';
                tradeModal.style.justifyContent = 'center';
                tradeModal.style.background = 'rgba(0,0,0,0.8)';
                tradeModal.style.backdropFilter = 'blur(6px)';

                document.querySelectorAll('.stock-card').forEach(function(el){ el.classList.toggle('selected', el.id === 'stock-' + stockId); });
                const livePrice = (typeof readLiveStockPrice === 'function') ? readLiveStockPrice(stockId, price) : String(price || '0').split('.')[0];
                currentTrade = { stockId, name: name || stockId, price: livePrice, action: action || 'buy', isAll: false };
                
                const titleEl = document.getElementById('modal-trade-title');
                if (titleEl) titleEl.innerText = (action === 'buy' ? '🛒 매수 주문 체결 - ' : '💰 매도 주문 체결 - ') + (name || stockId);
                
                const submitBtn0 = document.getElementById('btn-submit-trade');
                if (submitBtn0) submitBtn0.classList.toggle('sell', action === 'sell');
                
                const infoEl = document.getElementById('modal-stock-info');
                if (infoEl) infoEl.innerText = '종목코드: [' + stockId + ']';
                
                const unitEl = document.getElementById('modal-unit-price');
                if (unitEl) unitEl.innerText = fmtMoneyUi(livePrice);
                
                const holding = holdingShares(stockId, directHolding);
                userHoldings[stockId] = holding;

                const holdingElem = document.getElementById('modal-user-holding-info');
                if (holdingElem) {
                  if (holding > 0) {
                    holdingElem.innerHTML = '내 보유: <b style="color: #38bdf8;">' + formatShareQty(holding) + '주</b>';
                  } else {
                    holdingElem.innerHTML = '내 보유: <b style="color: #9ca3af;">0주 (보유 없음)</b>';
                  }
                }

                if (typeof syncTradePanelCash === 'function') syncTradePanelCash();

                const input = document.getElementById('trade-amount-input');
                if (input) {
                  if (action === 'sell') {
                    input.value = holding > 0 ? holding : 0;
                    currentTrade.isAll = (holding > 0);
                  } else {
                    input.value = 1;
                    currentTrade.isAll = false;
                  }
                }

                const submitBtn = document.getElementById('btn-submit-trade');
                if (submitBtn) {
                  submitBtn.disabled = false;
                  submitBtn.innerText = (action === 'buy' ? '🛒 매수 주문 체결' : '💰 매도 주문 체결');
                  submitBtn.style.background = (action === 'buy' ? 'linear-gradient(135deg, #059669, #10b981)' : 'linear-gradient(135deg, #dc2626, #ef4444)');
                }

                calcTradeTotal();
              } catch (err) {
                console.error('주식 모달 열기 오류:', err);
              }
            }

            function setTradePercent(pct) {
              const input = document.getElementById('trade-amount-input');
              if (!input || !currentTrade) return;
              const stockId = currentTrade.stockId;
              const holding = holdingShares(stockId, 0);
              const userCash = getCurrentUserCashNum();

              if (pct === 100) {
                currentTrade.isAll = true;
              } else {
                currentTrade.isAll = false;
              }

              if (currentTrade.action === 'buy') {
                const rate = getTradeTaxRate();
                const maxCanBuy = maxBuySharesUi(userCash, currentTrade.price, rate);
                if (maxCanBuy < 0.0001) {
                  input.value = 0;
                  currentTrade.isAll = false;
                  showToast('info', '현금 부족', '현재 보유 현금으로 매수할 수 없습니다.');
                } else {
                  if (pct === 100) {
                    input.value = Math.floor(maxCanBuy * 10000) / 10000;
                  } else {
                    const frac = Math.floor((maxCanBuy * (pct / 100)) * 10000) / 10000;
                    input.value = Math.max(0.0001, frac);
                  }
                }
              } else {
                if (holding <= 0) {
                  input.value = 0;
                  currentTrade.isAll = false;
                  showToast('info', '보유량 없음', '매도할 수 있는 주식을 보유하고 있지 않습니다.');
                } else {
                  if (pct === 100) {
                    input.value = holding;
                  } else {
                    const frac = Math.floor((holding * (pct / 100)) * 10000) / 10000;
                    input.value = Math.max(0.0001, frac);
                  }
                }
              }
              calcTradeTotal();
            }

            function setTradeMax() {
              setTradePercent(100);
            }

            function addTradeAmount(qty) {
              if (!currentTrade) return;
              currentTrade.isAll = false;
              const input = document.getElementById('trade-amount-input');
              if (!input) return;
              const current = parseFloat(input.value) || 0;
              const stockId = currentTrade.stockId;
              const holding = holdingShares(stockId, 0);
              
              let nextVal = Math.round((current + qty) * 10000) / 10000;
              if (nextVal < 0.0001) nextVal = 0.0001;
              if (currentTrade.action === 'sell' && holding > 0 && nextVal > holding) {
                nextVal = holding;
              }
              input.value = nextVal;
              calcTradeTotal();
            }

            function resetTradeAmount() {
              if (currentTrade) currentTrade.isAll = false;
              const input = document.getElementById('trade-amount-input');
              if (input) input.value = 1;
              calcTradeTotal();
            }

            function closeTradeModal() {
              const modal = document.getElementById('trade-modal');
              if (!modal) return;
              modal.classList.remove('is-open');
              modal.style.display = 'none';
            }

            window.openTradeModal = openTradeModal;
            window.closeTradeModal = closeTradeModal;
            window.submitTradeOrder = submitTradeOrder;
            window.setTradePercent = setTradePercent;
            window.setTradeMax = setTradeMax;
            window.addTradeAmount = addTradeAmount;
            window.resetTradeAmount = resetTradeAmount;
            window.calcTradeTotal = calcTradeTotal;

            function getTradeTaxRate() {
              const tax = window.__economyTax || {};
              if (tax.exempt) return 0;
              const n = Number(tax.rate);
              return Number.isFinite(n) && n > 0 ? n : 0;
            }

            function formatTaxCountdown(tax) {
              if (!tax || tax.exempt) return '관리자 계정은 세금이 없습니다.';
              if (!(Number(tax.rate) > 0)) return '지금은 자산세를 걷지 않습니다.';
              var sec = Number(tax.nextWealthTaxInSec);
              if (tax.nextWealthTaxAt) {
                sec = Math.max(0, Math.floor((Number(tax.nextWealthTaxAt) - Date.now()) / 1000));
              }
              var m = Math.floor(sec / 60);
              var s = sec % 60;
              var levy = String(tax.estimatedLevy || '0');
              var extra = (levy !== '0' && levy !== '') ? (' · 이번 회차 예상 ' + fmtMoneyUi(levy)) : '';
              return '다음 자산세 ' + m + '분 ' + String(s).padStart(2, '0') + '초' + extra;
            }

            function applyEconomyTax(tax) {
              if (!tax || typeof tax !== 'object') return;
              window.__economyTax = tax;
              const rateEl = document.getElementById('mt-tax-rate');
              if (rateEl) {
                rateEl.textContent = tax.exempt ? '거래세 면제' : ('거래세 ' + (tax.rateText || ((Number(tax.rate || 0) * 100).toFixed(1) + '%')));
                rateEl.style.color = (!tax.exempt && Number(tax.rate) > 0) ? '#fbbf24' : '#9ca3af';
              }
              const note = document.getElementById('wallet-tax-note');
              if (note) {
                if (tax.exempt) {
                  note.textContent = '관리자 계정은 세금이 없습니다.';
                  note.style.color = '#949ba4';
                } else if (Number(tax.rate) > 0) {
                  note.textContent = '거래·송금세 ' + (tax.rateText || '') + ' · 현금+예금 ' + fmtMoneyUi(tax.threshold || 0) + ' 초과 시 현금·예금에서 회수';
                  note.style.color = '#fbbf24';
                } else {
                  note.textContent = '현재 거래세 없음 (경제 안정)';
                  note.style.color = '#949ba4';
                }
              }
              const nextText = formatTaxCountdown(tax);
              const nextWallet = document.getElementById('wallet-tax-next');
              if (nextWallet) nextWallet.textContent = tax.exempt ? '' : nextText;
              const nextMarket = document.getElementById('mt-tax-next');
              if (nextMarket) nextMarket.textContent = tax.exempt ? '' : nextText;
              const modal = document.getElementById('trade-modal');
              if (modal && modal.style.display === 'flex') calcTradeTotal();
            }
            window.applyEconomyTax = applyEconomyTax;
            if (window.__economyTax) applyEconomyTax(window.__economyTax);
            setInterval(function() {
              if (window.__economyTax) applyEconomyTax(window.__economyTax);
            }, 1000);

            function calcTradeTotal() {
              const input = document.getElementById('trade-amount-input');
              const countStr = String((input && input.value) || '0');
              let total = 0n;
              try {
                const price = BigInt(String(currentTrade.price || 0).split('.')[0] || '0');
                const units = (function() {
                  const n = Number(countStr);
                  if (Number.isFinite(n) && n < 1e12) return BigInt(Math.round(n * 10000));
                  return BigInt(parseMoneyText(countStr) === 'ALL' ? '0' : parseMoneyText(countStr)) * 10000n;
                })();
                total = (price * units) / 10000n;
              } catch (e) { total = 0n; }
              const rate = getTradeTaxRate();
              const tax = (function() {
                try { return (total * BigInt(Math.round(rate * 10000))) / 10000n; } catch (e) { return 0n; }
              })();
              const payable = currentTrade.action === 'buy' ? (total + tax) : (total > tax ? total - tax : 0n);
              const stockId = currentTrade.stockId;
              const holding = holdingShares(stockId, 0);
              const userCash = getCurrentUserCashNum();
              const loan = window.__economyLoan || {};

              document.getElementById('modal-total-price').innerText = fmtMoneyUi(payable);
              const taxLine = document.getElementById('modal-tax-line');
              const taxPrice = document.getElementById('modal-tax-price');
              if (taxLine && taxPrice) {
                if (tax > 0) {
                  taxLine.style.display = 'flex';
                  taxPrice.textContent = tax.toLocaleString() + '원 (' + (rate * 100).toFixed(1) + '%)';
                } else {
                  taxLine.style.display = 'none';
                }
              }

              const maxLimitLabel = document.getElementById('modal-max-limit-label');
              const maxLimitVal = document.getElementById('modal-max-limit-val');

              // 🛡️ 종목별 & 경제상황 연동 매수 한도 계산
              const stockPriceNum = Number(currentTrade.price || 0);
              let baseStockLimit = 2000000;
              if (stockPriceNum < 1000) baseStockLimit = 10000000;
              else if (stockPriceNum < 10000) baseStockLimit = 2000000;
              else if (stockPriceNum < 100000) baseStockLimit = 500000;
              else if (stockPriceNum < 1000000) baseStockLimit = 100000;
              else baseStockLimit = 20000;

              let currentMultiplier = 1.0;
              if (window.__economyMarketRegime) {
                const r = window.__economyMarketRegime;
                if (r.type === 'SUPER_BULL' || r.id === 'BOOM') { currentMultiplier = 2.0; }
                else if (r.type === 'BULL' || r.drift > 0) { currentMultiplier = 1.5; }
                else if (r.type === 'CRASH') { currentMultiplier = 0.5; }
                else if (r.type === 'RECESSION' || r.drift < 0) { currentMultiplier = 0.7; }
              }
              const effectiveStockLimit = Math.max(10, Math.floor(baseStockLimit * currentMultiplier));
              const effectiveStockLimitText = effectiveStockLimit.toLocaleString() + '주';

              if (maxLimitLabel && maxLimitVal) {
                if (currentTrade.action === 'buy') {
                  const maxCanBuy = Math.min(effectiveStockLimit, maxBuySharesUi(userCash, currentTrade.price, rate));
                  maxLimitLabel.textContent = '내 지갑 기준 구매 가능';
                  maxLimitVal.innerHTML = '<b style="color: #34d399;">' + formatShareQty(maxCanBuy) + '주</b> <span style="font-size:0.75rem; color:#facc15; margin-left:4px;">(종목 규정 한도: ' + effectiveStockLimitText + ')</span>';
                } else {
                  maxLimitLabel.textContent = '최대 매도 가능';
                  maxLimitVal.innerHTML = '<b style="color: #f87171;">' + formatShareQty(holding) + '주 (전량)</b>';
                }
              }

              const warnBox = document.getElementById('trade-warning-msg');
              const submitBtn = document.getElementById('btn-submit-trade');

              if (!warnBox) return;

              const count = Number(countStr);
              if (currentTrade.action === 'buy' && loan.overdue) {
                warnBox.style.display = 'block';
                warnBox.style.color = '#ef4444';
                warnBox.innerText = '⚠️ 대출이 연체되어 매수할 수 없습니다. 은행에서 먼저 갚으세요.';
                if (submitBtn) submitBtn.disabled = true;
              } else if (currentTrade.action === 'buy' && count > 10000000) {
                warnBox.style.display = 'block';
                warnBox.style.color = '#ef4444';
                warnBox.innerText = '⚠️ 1회 최대 주문 가능 수량(10,000,000주)을 초과했습니다.';
                if (submitBtn) submitBtn.disabled = true;
              } else if ((!currentTrade.isAll && !(count >= 0.0001)) && total <= 0n) {
                warnBox.style.display = 'block';
                warnBox.style.color = '#fbbf24';
                warnBox.innerText = '⚠️ 주문 수량은 최소 0.0001주 이상이어야 합니다.';
                if (submitBtn) submitBtn.disabled = true;
              } else if (currentTrade.action === 'sell' && !currentTrade.isAll && count > (holding + 0.00001)) {
                warnBox.style.display = 'block';
                warnBox.style.color = '#ef4444';
                warnBox.innerText = '⚠️ 보유 수량(' + formatShareQty(holding) + '주)을 초과하여 매도할 수 없습니다.';
                if (submitBtn) submitBtn.disabled = true;
              } else if (currentTrade.action === 'buy' && !currentTrade.isAll && payable > userCash) {
                warnBox.style.display = 'block';
                warnBox.style.color = '#ef4444';
                warnBox.innerText = '⚠️ 보유 현금(' + fmtMoneyUi(userCash) + ')이 부족합니다.' + (tax > 0n ? ' 거래세 포함.' : '');
                if (submitBtn) submitBtn.disabled = true;
              } else {
                warnBox.style.display = 'none';
                if (submitBtn) submitBtn.disabled = false;
              }
            }

            // 🔄 실시간 자산/상태 변경 감지 및 무중단 자동 동기화 (Silent Live Auto-Sync)
            let lastSyncedCash = null;
            let lastSyncedBank = null;
            let lastSyncedNet = null;

            async function syncUserDataSilently() {
              try {
                if (window.__liveSocket && window.__liveSocket.connected) return;
                const res = await fetch('/api/user/summary');
                const data = await res.json();
                if (!data.success || !data.loggedIn) return;

                if (data.tax && typeof window.applyEconomyTax === 'function') {
                  window.applyEconomyTax(data.tax);
                }
                if (typeof window.applyUserLiveSnapshot === 'function') {
                  window.applyUserLiveSnapshot({
                    cash: data.cash,
                    bank: data.bank,
                    stockVal: data.stockVal,
                    netWorth: data.netWorth,
                    clicker_level: data.clickerLevel,
                    auto_miner_level: data.autoLevel,
                    daily_streak: data.streak,
                    holdings: data.holdings,
                    tax: data.tax,
                    loan: data.loan
                  });
                } else {
                  if (data.holdings && typeof window.__applyUserHoldings === 'function') {
                    window.__applyUserHoldings(data.holdings);
                  } else if (data.holdings) {
                    userHoldings = data.holdings;
                  }
                  updateUserCashDisplay(data.cash);
                  const bankElem = document.getElementById('my-bank');
                  if (bankElem && data.bank !== undefined) {
                    bankElem.innerText = fmtMoneyUi(data.bank);
                  }
                }

                lastSyncedCash = Number(data.cash || 0);
                lastSyncedBank = Number(data.bank || 0);
                lastSyncedNet = Number(data.netWorth || 0);
              } catch (e) {}
            }

            // 12초마다 실시간 자산 자동 동기화 백그라운드 폴링
            setInterval(syncUserDataSilently, 12000);

            // ⏱️ 3분 주기 주가 변동 카운트다운 타이머 & 라이브 갱신
            let stockCountdownSeconds = 180;
            function updateStockCountdown() {
              stockCountdownSeconds--;
              if (stockCountdownSeconds <= 0) {
                stockCountdownSeconds = 180;
                if (typeof window.refreshStockPricesLive === 'function') window.refreshStockPricesLive();
                else refreshStockPricesLive();
              }
              const min = Math.floor(stockCountdownSeconds / 60).toString().padStart(2, '0');
              const sec = (stockCountdownSeconds % 60).toString().padStart(2, '0');
              const cdElem = document.getElementById('price-tick-countdown');
              if (cdElem) cdElem.innerText = min + ':' + sec;
            }
            setInterval(updateStockCountdown, 1000);

            async function refreshStockPricesLive(manual = false) {
              if (window.__liveSocket && window.__liveSocket.connected) {
                window.__liveSocket.emit('market:refresh', {}, function(res) {
                  if (res && res.success && res.data) applyMarketUpdate(res.data);
                  if (manual) showToast('success', '🔄 실시간 갱신 완료', '최신 주가 및 시장 국면이 동기화되었습니다.');
                });
                return;
              }
              const spinBtn = document.querySelector('.btn-quick-refresh');
              if (spinBtn) spinBtn.classList.add('spinning-fast');
              try {
                const res = await fetch('/api/stocks');
                const data = await res.json();
                if (!data.success || !data.stocks) return;

                data.stocks.forEach(s => {
                  const priceElem = document.getElementById('price-' + s.stock_id);
                  if (priceElem) {
                    const priceRaw = String(s.price == null ? '0' : s.price).split('.')[0];
                    const oldRaw = priceElem.getAttribute('data-raw') || (priceElem.innerText || '').replace(/[^\d-]/g, '');
                    priceElem.setAttribute('data-raw', priceRaw);
                    priceElem.innerText = fmtMoneyUi(priceRaw);
                    if (oldRaw !== priceRaw) {
                      let isUp = false;
                      try { isUp = BigInt(priceRaw) > BigInt(oldRaw || '0'); } catch (e) {}
                      priceElem.style.color = isUp ? '#c84a31' : '#1261c4';
                      setTimeout(() => { priceElem.style.color = ''; }, 1500);
                    }
                    if (currentTrade && currentTrade.stockId === s.stock_id) {
                      currentTrade.price = priceRaw;
                      const unitEl = document.getElementById('modal-unit-price');
                      if (unitEl) unitEl.innerText = fmtMoneyUi(priceRaw);
                    }
                  }
                });
                if (manual) showToast('info', '시세 갱신 완료', '8개 전 종목의 최신 실시간 시세를 동기화했습니다.');
              } catch (e) {
                if (manual) showToast('error', '통신 오류', '실시간 시세 갱신 실패');
              } finally {
                if (spinBtn) setTimeout(() => spinBtn.classList.remove('spinning-fast'), 600);
              }
            }

            async function submitTradeOrder() {
              const input = document.getElementById('trade-amount-input');
              const amount = input.value;
              const count = Math.round((parseFloat(amount) || 0) * 10000) / 10000;
              const stockId = currentTrade.stockId;
              const holding = holdingShares(stockId, 0);
              const defaultBtnText = (currentTrade.action === 'buy' ? '🛒 매수 주문 체결' : '💰 매도 주문 체결');
              const btn = document.getElementById('btn-submit-trade');
              const loan = window.__economyLoan || {};

              if (currentTrade.action === 'buy' && loan.overdue) {
                showToast('error', '매수 불가', '대출이 연체되어 매수할 수 없습니다. 은행에서 먼저 갚으세요.');
                return;
              }

              if (!currentTrade.isAll && count < 0.0001) {
                showToast('error', '수량 오류', '0.0001주 이상의 수량을 입력해주세요.');
                return;
              }

              if (!currentTrade.isAll && currentTrade.action === 'sell' && count > (Number(holding) + 0.00001)) {
                showToast('error', '보유 수량 부족', '보유 주식(' + formatShareQty(holding) + '주)보다 많은 수량을 매도할 수 없습니다.');
                return;
              }

              btn.disabled = true;
              btn.innerText = '⏳ 주문 처리 중...';

              try {
                const res = await fetch('/api/stock/trade', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: currentTrade.action,
                    stockId: currentTrade.stockId,
                    amount: currentTrade.isAll ? 'all' : String(amount || count),
                    isAll: !!currentTrade.isAll
                  })
                });
                const data = await res.json();
                
                if (!data.success) {
                  btn.disabled = false;
                  btn.innerText = defaultBtnText;
                  showToast('error', '거래 체결 실패', data.error);
                  const warnBox = document.getElementById('trade-warning-msg');
                  if (warnBox) {
                    warnBox.style.display = 'block';
                    warnBox.style.color = '#ef4444';
                    warnBox.innerText = '⚠️ ' + data.error;
                  }
                  return;
                }

                if (data.holding != null) {
                  userHoldings[stockId] = Number(data.holding) || 0;
                } else if (data.action === 'buy') {
                  addHoldingShares(stockId, data.amount);
                } else if (data.action === 'sell') {
                  addHoldingShares(stockId, -Number(data.amount || 0));
                }
                syncStockHoldingBadges();

                showToast('success', '주식 체결 완료', data.message);
                btn.innerText = '✅ 체결 완료!';
                updateUserCashDisplay(data.newCash);
                syncTradePanelCash();
                const holdingElem = document.getElementById('modal-user-holding-info');
                if (holdingElem) {
                  const left = holdingShares(stockId, 0);
                  holdingElem.innerHTML = left > 0
                    ? ('내 보유: <b style="color: #38bdf8;">' + formatShareQty(left) + '주</b>')
                    : '내 보유: <b style="color: #9ca3af;">0주 (보유 없음)</b>';
                }
                calcTradeTotal();
                setTimeout(() => {
                  closeTradeModal();
                  btn.disabled = false;
                  btn.innerText = defaultBtnText;
                }, 700);
              } catch (e) {
                btn.disabled = false;
                btn.innerText = defaultBtnText;
                showToast('error', '통신 오류', '거래 처리 중 서버 연결 실패');
              }
            }

            // 8. 은행 모달
            function setBankAmount(val) {
              const input = document.getElementById('bank-amount-input');
              if (!input) return;
              input.value = val;
              markAllIn(input, false);
            }

            function setBankAllAmount() {
              const input = document.getElementById('bank-amount-input');
              if (!input) return;
              const amount = currentBankAction === 'withdraw' ? getCurrentUserBankNum() : getCurrentUserCashNum();
              input.value = amount > 0n ? String(amount) : '0';
              markAllIn(input, true);
            }

            function openBankModal() {
              document.getElementById('bank-modal').style.display = 'flex';
            }
            function closeBankModal() {
              document.getElementById('bank-modal').style.display = 'none';
            }
            function selectBankAction(act) {
              currentBankAction = act;
              document.getElementById('bank-act-deposit').classList.toggle('selected', act === 'deposit');
              document.getElementById('bank-act-withdraw').classList.toggle('selected', act === 'withdraw');
              const input = document.getElementById('bank-amount-input');
              if (isAllInInput(input)) setBankAllAmount();
            }
            async function submitBankTransfer() {
              const input = document.getElementById('bank-amount-input');
              const amount = getBetPayload(input);
              try {
                const res = await fetch('/api/economy/bank', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: currentBankAction, amount })
                });
                const data = await res.json();
                if (!data.success) {
                  showToast('error', '은행 업무 실패', data.error);
                  return;
                }
                showToast('success', '은행 업무 완료', data.message);
                closeBankModal();
                markAllIn(input, false);
                if (typeof window.applyUserLiveSnapshot === 'function') {
                  window.applyUserLiveSnapshot({ cash: data.cash, bank: data.bank });
                } else {
                  updateUserCashDisplay(data.cash);
                  const bankElem = document.getElementById('my-bank');
                  if (bankElem && data.bank !== undefined) {
                    bankElem.innerText = fmtMoneyUi(data.bank);
                    bankElem.setAttribute('data-raw', String(data.bank).split('.')[0]);
                  }
                }
              } catch (e) { showToast('error', '통신 오류', '은행 서버 연결 실패'); }
            }

            // 💸 실시간 유저 송금 클라이언트 스크립트
            let selectedTransferUserId = '';
            let selectedTransferUserName = '';
            let transferSearchTimer = null;
            let transferQuoteTimer = null;

            function openTransferModal() {
              const modal = document.getElementById('transfer-modal');
              if (modal) modal.style.display = 'flex';
              calcTransferQuote();
            }

            function closeTransferModal() {
              const modal = document.getElementById('transfer-modal');
              if (modal) modal.style.display = 'none';
            }

            function setTransferAmount(val) {
              const input = document.getElementById('transfer-amount-input');
              if (input) {
                input.value = String(val);
                markAllIn(input, false);
                calcTransferQuote();
              }
            }

            function setTransferAllAmount() {
              const input = document.getElementById('transfer-amount-input');
              if (input) {
                const cash = getCurrentUserCashNum();
                input.value = cash > 0n ? String(cash) : '0';
                markAllIn(input, true);
                calcTransferQuote();
              }
            }

            function debounceSearchTransferUser(val) {
              clearTimeout(transferSearchTimer);
              const dropdown = document.getElementById('transfer-user-dropdown');
              if (!val || val.trim().length < 1) {
                if (dropdown) dropdown.style.display = 'none';
                return;
              }
              transferSearchTimer = setTimeout(() => searchTransferUsers(val.trim()), 250);
            }

            async function searchTransferUsers(q) {
              const dropdown = document.getElementById('transfer-user-dropdown');
              if (!dropdown) return;
              try {
                const res = await fetch('/api/economy/users/search?q=' + encodeURIComponent(q));
                const data = await res.json();
                if (!data.success || !data.users || data.users.length === 0) {
                  dropdown.innerHTML = '<div style="padding:10px; color:#94a3b8; font-size:0.8rem; text-align:center;">일치하는 유저가 없습니다.</div>';
                  dropdown.style.display = 'block';
                  return;
                }
                dropdown.innerHTML = '';
                data.users.forEach(function(u) {
                  const item = document.createElement('div');
                  item.style.padding = '8px 12px';
                  item.style.cursor = 'pointer';
                  item.style.display = 'flex';
                  item.style.alignItems = 'center';
                  item.style.gap = '8px';
                  item.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
                  item.onmouseover = function() { item.style.background = '#1e293b'; };
                  item.onmouseout = function() { item.style.background = 'transparent'; };
                  item.onclick = function() { selectTransferUser(u.id, u.username); };

                  const nameSpan = document.createElement('span');
                  nameSpan.style.color = '#fff';
                  nameSpan.style.fontWeight = '700';
                  nameSpan.style.fontSize = '0.85rem';
                  nameSpan.textContent = '@' + u.username;

                  const idSpan = document.createElement('span');
                  idSpan.style.color = '#64748b';
                  idSpan.style.fontSize = '0.75rem';
                  idSpan.style.fontFamily = 'monospace';
                  idSpan.textContent = '(' + u.id + ')';

                  item.appendChild(nameSpan);
                  item.appendChild(idSpan);
                  dropdown.appendChild(item);
                });
                dropdown.style.display = 'block';
              } catch (e) {
                dropdown.style.display = 'none';
              }
            }

            function selectTransferUser(id, name) {
              selectedTransferUserId = id;
              selectedTransferUserName = name;
              const input = document.getElementById('transfer-target-input');
              const dropdown = document.getElementById('transfer-user-dropdown');
              const selBox = document.getElementById('transfer-selected-user');
              const selLabel = document.getElementById('transfer-selected-label');

              if (input) {
                input.style.display = 'none';
                input.value = id;
              }
              if (dropdown) dropdown.style.display = 'none';
              if (selBox) selBox.style.display = 'flex';
              if (selLabel) selLabel.textContent = '🎯 대상: @' + name + ' (' + id + ')';

              calcTransferQuote();
            }

            function clearSelectedTransferUser() {
              selectedTransferUserId = '';
              selectedTransferUserName = '';
              const input = document.getElementById('transfer-target-input');
              const selBox = document.getElementById('transfer-selected-user');
              if (input) {
                input.style.display = 'block';
                input.value = '';
                input.focus();
              }
              if (selBox) selBox.style.display = 'none';
              calcTransferQuote();
            }

            function debounceCalcTransferQuote() {
              clearTimeout(transferQuoteTimer);
              transferQuoteTimer = setTimeout(calcTransferQuote, 250);
            }

            async function calcTransferQuote() {
              const amountInput = document.getElementById('transfer-amount-input');
              const targetInput = document.getElementById('transfer-target-input');
              const rawAmt = amountInput ? (isAllInInput(amountInput) ? 'ALL' : amountInput.value.trim()) : '0';
              const targetUserId = selectedTransferUserId || (targetInput ? targetInput.value.trim() : '');

              try {
                const res = await fetch('/api/economy/transfer/quote', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ targetUserId, amount: rawAmt })
                });
                const data = await res.json();
                if (data.success) {
                  const amtEl = document.getElementById('tq-amount');
                  const taxEl = document.getElementById('tq-tax');
                  const totEl = document.getElementById('tq-total');
                  if (amtEl) amtEl.textContent = data.amountFormatted;
                  if (taxEl) taxEl.textContent = data.taxFormatted + ' (' + data.rateText + ')';
                  if (totEl) totEl.textContent = data.totalDebitFormatted;
                }
              } catch (e) {}
            }

            async function submitTransferMoney() {
              const amountInput = document.getElementById('transfer-amount-input');
              const targetInput = document.getElementById('transfer-target-input');
              const memoInput = document.getElementById('transfer-memo-input');
              const btn = document.getElementById('btn-submit-transfer');

              const amount = amountInput ? (isAllInInput(amountInput) ? 'ALL' : amountInput.value.trim()) : '';
              const targetUserId = selectedTransferUserId || (targetInput ? targetInput.value.trim() : '');
              const memo = memoInput ? memoInput.value.trim() : '';

              if (!targetUserId) {
                showToast('error', '송금 실패', '받는 상대방을 선택하거나 Discord ID를 입력하세요.');
                return;
              }
              if (!amount) {
                showToast('error', '송금 실패', '송금할 금액을 입력하세요.');
                return;
              }

              if (btn) {
                btn.disabled = true;
                btn.textContent = '⏳ 송금 처리 중...';
              }

              try {
                const res = await fetch('/api/economy/transfer', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ targetUserId, amount, memo })
                });
                const data = await res.json();
                if (!data.success) {
                  showToast('error', '송금 실패', data.error || '송금 처리 중 오류가 발생했습니다.');
                  return;
                }

                showToast('success', '송금 완료! 💸', data.message);
                closeTransferModal();
                clearSelectedTransferUser();
                if (amountInput) amountInput.value = '';
                if (memoInput) memoInput.value = '';

                if (typeof window.applyUserLiveSnapshot === 'function') {
                  window.applyUserLiveSnapshot({ cash: data.newSenderCash });
                } else {
                  updateUserCashDisplay(data.newSenderCash);
                }
              } catch (e) {
                showToast('error', '통신 오류', '송금 서버와의 통신에 실패했습니다.');
              } finally {
                if (btn) {
                  btn.disabled = false;
                  btn.textContent = '💸 송금 실행하기';
                }
              }
            }

            ['slot-bet', 'coin-bet', 'dice-bet', 'lottery-bet', 'horse-bet-input', 'roulette-bet', 'bj-bet', 'hl-bet', 'toto-bet', 'crash-bet', 'mines-bet', 'plinko-bet', 'bank-amount-input', 'loan-amount-input', 'transfer-amount-input'].forEach(function(id) {
              const el = document.getElementById(id);
              if (!el) return;
              el.addEventListener('input', function() { markAllIn(el, false); });
            });

            // 9. 👤 프로필 & 1:1 고객센터 문의 인터랙션
            function openProfileModal(initialTab = 'profile') {
              if (initialTab === 'settings') {
                if (typeof openUserSettings === 'function') openUserSettings('interface');
                return;
              }
              document.getElementById('profile-modal').style.display = 'flex';
              switchProfileTab(initialTab);
              loadMyInquiries();
            }

            function closeProfileModal() {
              document.getElementById('profile-modal').style.display = 'none';
            }

            function switchProfileTab(tabName) {
              if (tabName === 'settings') {
                closeProfileModal();
                if (typeof openUserSettings === 'function') openUserSettings('interface');
                return;
              }
              const isProfile = tabName === 'profile';
              const btnProf = document.getElementById('btn-subtab-profile');
              const btnInq = document.getElementById('btn-subtab-inquiries');
              const paneProf = document.getElementById('subtab-pane-profile');
              const paneInq = document.getElementById('subtab-pane-inquiries');
              if (btnProf) btnProf.classList.toggle('active', isProfile);
              if (btnInq) btnInq.classList.toggle('active', !isProfile);
              if (paneProf) paneProf.style.display = isProfile ? 'block' : 'none';
              if (paneInq) paneInq.style.display = isProfile ? 'none' : 'block';
              if (!isProfile) loadMyInquiries();
            }

            function openInquiryModal() {
              document.getElementById('inquiry-modal').style.display = 'flex';
            }

            function closeInquiryModal() {
              document.getElementById('inquiry-modal').style.display = 'none';
            }

            let inquirySelectedImageBase64 = null;

            function handleInquiryImageSelect(e) {
              const file = e.target.files && e.target.files[0];
              if (!file) return;
              if (file.size > 1.5 * 1024 * 1024) {
                showToast('error', '용량 초과', '이미지 파일 크기는 최대 1.5MB까지 업로드 가능합니다.');
                clearInquiryImage();
                return;
              }
              if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
                showToast('error', '형식 오류', 'PNG 또는 JPEG 이미지만 첨부할 수 있습니다.');
                clearInquiryImage();
                return;
              }
              const reader = new FileReader();
              reader.onload = function(evt) {
                inquirySelectedImageBase64 = evt.target.result;
                const previewImg = document.getElementById('inquiry-img-preview');
                const previewBox = document.getElementById('inquiry-img-preview-box');
                const clearBtn = document.getElementById('btn-clear-img');
                if (previewImg) previewImg.src = inquirySelectedImageBase64;
                if (previewBox) previewBox.style.display = 'block';
                if (clearBtn) clearBtn.style.display = 'inline-block';
              };
              reader.readAsDataURL(file);
            }

            function clearInquiryImage() {
              inquirySelectedImageBase64 = null;
              const fileInput = document.getElementById('inquiry-image-file');
              if (fileInput) fileInput.value = '';
              const previewBox = document.getElementById('inquiry-img-preview-box');
              const clearBtn = document.getElementById('btn-clear-img');
              if (previewBox) previewBox.style.display = 'none';
              if (clearBtn) clearBtn.style.display = 'none';
            }

            async function submitInquiryForm() {
              const category = document.getElementById('inquiry-category-select').value;
              const title = document.getElementById('inquiry-title-input').value;
              const content = document.getElementById('inquiry-content-input').value;
              const btn = document.getElementById('btn-submit-inquiry');

              if (!title || title.trim().length < 2) {
                showToast('error', '입력 오류', '문의 제목을 2글자 이상 입력해주세요.');
                return;
              }
              if (!content || content.trim().length < 5) {
                showToast('error', '입력 오류', '문의 내용을 5글자 이상 상세히 적어주세요.');
                return;
              }

              btn.disabled = true;
              btn.innerText = '⏳ 관리자에게 전송 중...';

              try {
                const res = await fetch('/api/support/inquiry', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ category, title, content, image: inquirySelectedImageBase64 })
                });
                const data = await res.json();
                btn.disabled = false;
                btn.innerText = '📨 관리자에게 1:1 문의 전송 (DM 알림)';

                if (!data.success) {
                  showToast('error', '문의 접수 실패', data.error);
                  return;
                }

                showToast('success', '문의 접수 완료', data.message);
                document.getElementById('inquiry-title-input').value = '';
                document.getElementById('inquiry-content-input').value = '';
                clearInquiryImage();
                closeInquiryModal();
                openProfileModal('inquiries');
              } catch (e) {
                btn.disabled = false;
                btn.innerText = '📨 관리자에게 1:1 문의 전송 (DM 알림)';
                showToast('error', '통신 오류', '문의 전송 실패');
              }
            }

            async function loadMyInquiries() {
              const box = document.getElementById('my-inquiries-list-box');
              if (!box) return;

              try {
                const res = await fetch('/api/support/my-inquiries');
                const data = await res.json();
                if (!data.success || !data.inquiries) {
                  box.innerHTML = '<p style="color: #9ca3af; text-align: center; padding: 20px;">로그인 후 문의 내역을 확인할 수 있습니다.</p>';
                  return;
                }

                const countElem = document.getElementById('inquiry-count-badge');
                if (countElem) countElem.innerText = data.inquiries.length;

                if (data.inquiries.length === 0) {
                  box.innerHTML = '<div style="text-align: center; color: #9ca3af; padding: 30px 10px;">' +
                    '<p style="font-size: 1.1rem; margin-bottom: 8px;">📭 아직 등록된 1:1 문의가 없습니다.</p>' +
                    '<p style="font-size: 0.82rem; color: #6b7280;">버그 신고나 계정 복구, 기능 건의가 있으시면 [새 문의]를 작성해보세요!</p>' +
                    '</div>';
                  return;
                }

                box.innerHTML = data.inquiries.map(inq => {
                  const isAnswered = inq.status === 'ANSWERED';
                  const statusHtml = isAnswered
                    ? '<span class="inquiry-status-badge status-answered">🟢 답변 완료</span>'
                    : '<span class="inquiry-status-badge status-waiting">🟡 답변 대기 중</span>';
                  
                  const createdDate = new Date(inq.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
                  const answeredDate = inq.answered_at ? new Date(inq.answered_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';

                  const imageUrl = (function(raw) {
                    const v = String(raw || '');
                    const prefix = '/uploads/inquiries/';
                    if (v.indexOf(prefix) === 0 && v.indexOf('..') === -1) {
                      const name = v.slice(prefix.length).toLowerCase();
                      const extOk = name.slice(-4) === '.jpg' || name.slice(-4) === '.png' || name.slice(-5) === '.jpeg';
                      let safeName = true;
                      for (let i = 0; i < name.length; i++) {
                        const ch = name.charAt(i);
                        const ok = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '.' || ch === '_' || ch === '-';
                        if (!ok) { safeName = false; break; }
                      }
                      if (extOk && safeName && name.indexOf('/') === -1) return v;
                    }
                    try {
                      const u = new URL(v);
                      const host = u.hostname.toLowerCase();
                      if (u.protocol === 'https:' && (host === 'cdn.discordapp.com' || host === 'media.discordapp.net')) return u.href;
                    } catch (e) {}
                    return '';
                  })(inq.image_url);
                  const imageBlock = imageUrl
                    ? '<div style="margin: 10px 0;">' +
                        '<a href="' + escapeHtml(imageUrl) + '" target="_blank" rel="noopener noreferrer" style="display:inline-block; text-decoration:none;">' +
                          '<img src="' + escapeHtml(imageUrl) + '" style="max-height: 140px; max-width: 100%; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); object-fit: cover;" alt="첨부 사진">' +
                          '<span style="display:block; font-size:0.72rem; color:#818cf8; margin-top:3px;">🖼️ 첨부 이미지 원본 확대 보기</span>' +
                        '</a>' +
                      '</div>'
                    : '';

                  const answerBlock = isAnswered && inq.answer
                    ? '<div class="inquiry-answer-box">' +
                        '<div class="inquiry-answer-header">' +
                          '<span>💬 관리자(@' + escapeHtml(inq.answered_by || '관리자') + ') 공식 답변</span>' +
                          '<span style="font-size: 0.72rem; color: #9ca3af;">' + answeredDate + '</span>' +
                        '</div>' +
                        '<div class="inquiry-answer-text">' + escapeHtml(inq.answer) + '</div>' +
                      '</div>'
                    : '';

                  return '<div class="inquiry-item-card">' +
                    '<div class="inquiry-item-top">' +
                      '<span class="inquiry-category-badge">' + escapeHtml(inq.category || '일반 문의') + ' #' + escapeHtml(inq.id) + '</span>' +
                      statusHtml +
                    '</div>' +
                    '<div class="inquiry-title-text">' + escapeHtml(inq.title) + '</div>' +
                    '<div class="inquiry-content-text">' + escapeHtml(inq.content) + '</div>' +
                    imageBlock +
                    '<div style="font-size: 0.72rem; color: #64748b; text-align: right;">작성일시: ' + createdDate + '</div>' +
                    answerBlock +
                  '</div>';
                }).join('');
              } catch (e) {
                box.innerHTML = '<p style="color: #f87171; text-align: center; padding: 20px;">문의 내역을 불러오지 못했습니다.</p>';
              }
            }

            function updateUserCashDisplay(cashVal) {
              if (cashVal === undefined || cashVal === null) return;
              if (typeof window.applyUserLiveSnapshot === 'function') {
                window.applyUserLiveSnapshot({ cash: cashVal });
                return;
              }
              const cashElem = document.getElementById('my-cash');
              if (cashElem) {
                cashElem.innerText = fmtMoneyUi(cashVal);
                cashElem.setAttribute('data-raw', String(cashVal).split('.')[0]);
                cashElem.style.color = '#34d399';
                setTimeout(() => { cashElem.style.color = '#fff'; }, 1000);
              }
            }

            // 🖱️ 모달 바깥 배경 클릭 및 ESC 키 입력 시 팝업 닫기
            window.addEventListener('click', (e) => {
              if (e.target.classList && e.target.classList.contains('modal-overlay')) {
                e.target.style.display = 'none';
              }
            });
            window.addEventListener('keydown', (e) => {
              if (e.key === 'Escape') {
                document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
              }
            });

            // 🚫 웹사이트 무단 복사, 우클릭, 텍스트 드래그 및 단축키 차단
            document.addEventListener('contextmenu', function(e) { e.preventDefault(); return false; });
            document.addEventListener('selectstart', function(e) { if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return true; e.preventDefault(); return false; });
            document.addEventListener('copy', function(e) { if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return true; e.preventDefault(); return false; });
            document.addEventListener('cut', function(e) { if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return true; e.preventDefault(); return false; });
            document.addEventListener('keydown', function(e) {
              const isInput = ['INPUT', 'TEXTAREA'].includes(e.target.tagName);
              if (e.keyCode === 123) { e.preventDefault(); return false; } // F12
              if (e.ctrlKey || e.metaKey) {
                const k = (e.key || '').toLowerCase();
                if (!isInput && (k === 'c' || k === 'a')) { e.preventDefault(); return false; } // Ctrl+C, Ctrl+A
                if (k === 'u' || k === 's') { e.preventDefault(); return false; } // Ctrl+U, Ctrl+S
                if (e.shiftKey && (k === 'i' || k === 'j' || k === 'c')) { e.preventDefault(); return false; } // Ctrl+Shift+I/J/C
              }
            });
          </script>

          <!-- 📡 실시간 주가 자동 업데이트 (SSE) -->
          <script>
          (function() {
            // ── 숫자 포맷 헬퍼 ─────────────────────────
            function fmtMoney(n) {
              const num = Math.trunc(Number(n) || 0);
              return num.toLocaleString('ko-KR') + '원';
            }

            // ── 숫자 튀어오르는 플립 애니메이션 ────────
            function flashEl(el, isUp) {
              el.style.transition = 'color 0.3s, transform 0.25s';
              el.style.color    = isUp ? '#00e676' : '#ff5252';
              el.style.transform = 'scale(1.12)';
              setTimeout(() => {
                el.style.color    = '';
                el.style.transform = '';
              }, 800);
            }

            // ── 실시간 인디케이터 배지 (좌측 하단) ─────────────────
            const liveBadge = document.createElement('div');
            liveBadge.id = 'live-indicator';
            liveBadge.style.cssText = [
              'position:fixed','bottom:20px','left:20px','z-index:999','pointer-events:none',
              'background:rgba(0,230,118,0.15)','border:1px solid #00e676',
              'color:#00e676','padding:6px 14px','border-radius:999px',
              'font-size:12px','font-weight:700','letter-spacing:0.5px',
              'display:flex','align-items:center','gap:6px',
              'backdrop-filter:blur(10px)','box-shadow:0 2px 16px rgba(0,230,118,0.2)',
              'transition:all 0.3s ease',
            ].join(';');
            liveBadge.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#00e676;display:inline-block;animation:pulse-dot 1.4s infinite"></span> LIVE';
            document.body.appendChild(liveBadge);

            // 펄스 애니메이션 CSS
            const styleTag = document.createElement('style');
            styleTag.textContent = '@keyframes pulse-dot { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.5;transform:scale(0.7)} } ' +
              '@keyframes price-flash-up { 0%{background:rgba(0,230,118,0.3)} 100%{background:transparent} } ' +
              '@keyframes price-flash-down { 0%{background:rgba(255,82,82,0.3)} 100%{background:transparent} } ' +
              '.flash-up { animation: price-flash-up 0.9s ease-out; } ' +
              '.flash-down { animation: price-flash-down 0.9s ease-out; } ' +
              '#live-indicator.disconnected { border-color:#ff5252; color:#ff5252; background:rgba(255,82,82,0.12); }';
            document.head.appendChild(styleTag);

            function setLive(connected) {
              if (connected) {
                liveBadge.classList.remove('disconnected');
                liveBadge.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#00e676;display:inline-block;animation:pulse-dot 1.4s infinite"></span> LIVE';
              } else {
                liveBadge.classList.add('disconnected');
                liveBadge.innerHTML = '<span style="width:7px;height:7px;border-radius:50%;background:#ff5252;display:inline-block"></span> 재연결 중...';
              }
            }

            // ── 메인 업데이트 함수 ──────────────────────
            window.applyMarketUpdate = applyMarketUpdate;
            function applyMarketUpdate(data) {
              if (!data || !data.stocks) return;

              let upCnt = 0;
              let downCnt = 0;
              let sumRate = 0;

              data.stocks.forEach(s => {
                const priceRaw = String(s.price == null ? '0' : s.price).split('.')[0];
                const prevRaw = String(s.prev_price == null ? '0' : s.prev_price).split('.')[0];
                const rate = Number(s.rate || 0);
                const isUp = rate >= 0;
                const arrow = isUp ? '▲' : '▼';
                const sign = isUp ? '+' : '';

                if (rate > 0) upCnt++;
                else if (rate < 0) downCnt++;
                sumRate += rate;

                // 1. 현재가 요소 갱신 & 실시간 플래시 효과
                const priceEl = document.getElementById('price-' + s.stock_id);
                if (priceEl) {
                  priceEl.classList.toggle('text-up', isUp);
                  priceEl.classList.toggle('text-down', !isUp);
                  const oldTxt = priceEl.textContent;
                  const newTxt = fmtMoneyUi(priceRaw);
                  priceEl.setAttribute('data-raw', priceRaw);
                  if (oldTxt !== newTxt) {
                    priceEl.textContent = newTxt;
                    priceEl.title = newTxt;
                    flashEl(priceEl, isUp);
                    const card = document.getElementById('stock-' + s.stock_id);
                    if (card) {
                      card.setAttribute('data-price', priceRaw);
                      card.querySelectorAll('.btn-trade').forEach(b => b.setAttribute('data-price', priceRaw));
                      card.classList.remove('flash-up', 'flash-down');
                      void card.offsetWidth;
                      card.classList.add(isUp ? 'flash-up' : 'flash-down');
                    }
                  }
                }

                // 2. 모달 열려있는 경우 주문창 단가 동기화
                if (currentTrade && currentTrade.stockId === s.stock_id) {
                  currentTrade.price = priceRaw;
                  const unitEl = document.getElementById('modal-unit-price');
                  if (unitEl) unitEl.innerText = fmtMoneyUi(priceRaw);
                  const modal = document.getElementById('trade-modal');
                  if (modal && modal.style.display === 'flex') calcTradeTotal();
                }

                // 3. 등락률 배지 실시간 업데이트 (▲ +X.XX%)
                const card = document.getElementById('stock-' + s.stock_id);
                if (card) {
                  const badgeEl = card.querySelector('.badge');
                  if (badgeEl) {
                    badgeEl.textContent = arrow + ' ' + sign + Math.abs(rate).toFixed(2) + '%';
                    badgeEl.className = 'badge ' + (isUp ? 'badge-up' : 'badge-down');
                  }
                  const footerEls = card.querySelectorAll('.stock-footer span');
                  if (footerEls[0]) footerEls[0].textContent = '이전가: ' + fmtMoneyUi(prevRaw);
                  if (footerEls[1]) {
                    footerEls[1].textContent = isUp ? '상승' : '하락';
                    footerEls[1].className = 'trend-text ' + (isUp ? 'text-up' : 'text-down');
                  }
                }
              });

              // 4. 상단 툴바 통계 실시간 반영
              const upEl = document.querySelector('.mt-stats .text-up');
              const downEl = document.querySelector('.mt-stats .text-down');
              if (upEl) upEl.textContent = upCnt;
              if (downEl) downEl.textContent = downCnt;

              // 5. 시장 국면 업데이트
              if (data.regime) {
                const regimeEls = document.querySelectorAll('.mt-regime, [data-regime]');
                regimeEls.forEach(el => { el.textContent = data.regime.name; });
              }

              // 6. 공시 뉴스 업데이트
              if (data.news && data.news.text) {
                const flashEl = document.querySelector('.market-flash');
                if (flashEl) flashEl.textContent = data.news.text;
              }
            }

            // ── ⚡ Socket.IO 실시간 양방향 웹소켓 연결 & SSE 폴백 ────────────
            let socket = null;
            if (typeof io !== 'undefined') {
              try {
                socket = io({
                  withCredentials: true,
                  reconnectionAttempts: 15,
                  reconnectionDelay: 1500,
                  timeout: 8000
                });

                window.__liveSocket = socket;

                socket.on('connect', function() {
                  setLive(true);
                  socket.emit('user:sync', {});
                  if (es) {
                    try { es.close(); } catch (e) {}
                    es = null;
                  }
                });

                socket.on('disconnect', function() {
                  setLive(false);
                  if (typeof EventSource !== 'undefined') connectSSE();
                });

                socket.on('user:balance', function(data) {
                  window.__lastUserBalance = data;
                  if (typeof window.applyUserLiveSnapshot === 'function') {
                    window.applyUserLiveSnapshot(data);
                  }
                });

                socket.on('market:snapshot', function(data) {
                  applyMarketUpdate(data);
                });

                socket.on('market:update', function(data) {
                  applyMarketUpdate(data);
                });

                socket.on('stock:split', function(data) {
                  if (data && data.stockId && data.ratio) {
                    // 1. 주식 카드의 보유 수량 및 데이터 속성 N배 실시간 갱신
                    const card = document.getElementById('stock-' + data.stockId);
                    if (card) {
                      const curHolding = parseFloat(card.getAttribute('data-holding') || '0');
                      if (curHolding > 0) {
                        const newHolding = curHolding * Number(data.ratio);
                        card.setAttribute('data-holding', String(newHolding));
                        card.querySelectorAll('.btn-trade').forEach(b => b.setAttribute('data-holding', String(newHolding)));
                        const holdEl = card.querySelector('.sr-hold');
                        if (holdEl) holdEl.textContent = newHolding.toLocaleString() + '주';
                      }
                    }
                    // 2. 유저 전체 자산 및 포트폴리오 즉시 재동기화
                    socket.emit('user:sync', {});
                    if (typeof window.__refreshMarketData === 'function') window.__refreshMarketData(false);
                    if (typeof showToast === 'function') {
                      showToast('info', '⚡ 액면분할 공시', '[' + data.stockId + '] 1:' + data.ratio + ' 액면분할로 보유 주식 수가 ' + data.ratio + '배 배정되었습니다.');
                    }
                  }
                });

                socket.on('chat:message', function(msg) {
                  appendLiveChatMessage(msg, true);
                });

                socket.on('chat:deleted', function(data) {
                  if (data && data.id) {
                    const el = document.getElementById('chat-msg-' + data.id);
                    if (el) el.remove();
                    const fEl = document.getElementById('fchat-msg-' + data.id);
                    if (fEl) fEl.remove();
                  }
                });
              } catch (e) {
                console.warn('Socket.IO 초기화 실패, SSE 폴백으로 전환합니다.');
              }
            }

            // ── SSE 연결 (보조 폴백) ────────────
            let es = null;
            let retryDelay = 3000;

            function connectSSE() {
              if (socket && socket.connected) return;
              if (es) {
                try { es.close(); } catch (e) {}
                es = null;
              }
              es = new EventSource('/api/stream');

              es.onmessage = function(e) {
                try {
                  const data = JSON.parse(e.data);
                  if (data.type === 'MARKET_UPDATE') {
                    applyMarketUpdate(data);
                  } else if (data.type === 'CHAT_MESSAGE' && data.message) {
                    appendLiveChatMessage(data.message, true);
                  }
                  retryDelay = 3000;
                  setLive(true);
                } catch (err) {}
              };

              es.onerror = function() {
                if (socket && socket.connected) {
                  try { es.close(); } catch (e) {}
                  es = null;
                  return;
                }
                setLive(false);
                try { es.close(); } catch (e) {}
                es = null;
                setTimeout(connectSSE, retryDelay);
                retryDelay = Math.min(retryDelay * 1.5, 30000);
              };

              es.onopen = function() { setLive(true); };
            }

            // 🔄 실시간 주가 & 시장 데이터 원터치 갱신 함수
            window.refreshStockPricesLive = function(isManual = false) {
              if (socket && socket.connected) {
                socket.emit('market:refresh', {}, function(res) {
                  if (res && res.success && res.data) {
                    applyMarketUpdate(res.data);
                    if (isManual) showToast('success', '🔄 실시간 갱신 완료', '최신 주가 및 시장 국면이 동기화되었습니다.');
                  }
                });
              } else {
                fetch('/api/stocks')
                  .then(r => r.json())
                  .then(d => {
                    if (d.success) {
                      applyMarketUpdate({ stocks: d.stocks });
                      if (isManual) showToast('success', '🔄 실시간 갱신 완료', '최신 주가가 갱신되었습니다.');
                    }
                  }).catch(() => {});
              }
              loadChatMessages();
            };

            // 소켓이 없거나 2.5초 안에 못 붙으면 SSE 폴백
            if (typeof EventSource !== 'undefined') {
              if (!socket) {
                connectSSE();
              } else {
                setTimeout(function() {
                  if (!socket.connected) connectSSE();
                }, 2500);
              }
            }
            loadChatMessages();

            // ⚡ 10초 주기 실시간 주가 백그라운드 자동 동기화
            setInterval(function() {
              if (typeof window.__refreshMarketData === 'function') {
                window.__refreshMarketData(false);
              }
            }, 10000);
          })();

          // 💬 실시간 광장 채팅 & 전역 플로팅 독 스크립트
          let currentChatUserId = ${JSON.stringify(isDiscordUser && currentUser ? String(currentUser.id) : '')};
          let currentIsAdmin = ${isAdminUser ? true : false};
          window.currentChatUserId = currentChatUserId;
          window.currentIsAdmin = currentIsAdmin;
          window.__economyTax = ${safeJsonForHtml(pageTax)};
          window.__economyLoan = ${safeJsonForHtml(pageLoan)};
          if (typeof window.applyEconomyTax === 'function') window.applyEconomyTax(window.__economyTax);
          if (typeof window.applyEconomyLoan === 'function') window.applyEconomyLoan(window.__economyLoan);
          let isFloatingChatOpen = false;

          function toggleFloatingChat() {
            const drawer = document.getElementById('floating-chat-drawer');
            const badge = document.getElementById('floating-chat-badge');
            if (!drawer) return;
            isFloatingChatOpen = !isFloatingChatOpen;
            drawer.style.display = isFloatingChatOpen ? 'flex' : 'none';
            if (isFloatingChatOpen) {
              if (badge) badge.style.display = 'none';
              const input = document.getElementById('floating-chat-input');
              if (input) setTimeout(() => input.focus(), 100);
              const fContainer = document.getElementById('floating-chat-messages-container');
              if (fContainer) fContainer.scrollTop = fContainer.scrollHeight;
            }
          }

          async function loadChatMessages() {
            const container = document.getElementById('chat-messages-container');
            const fContainer = document.getElementById('floating-chat-messages-container');
            try {
              const res = await fetch('/api/chat/messages');
              const data = await res.json();
              if (data.success && Array.isArray(data.messages)) {
                if (data.messages.length === 0) {
                  const emptyHtml = '<div style="text-align: center; color: #64748b; font-size: 0.85rem; padding: 40px 0;">아직 작성된 채팅이 없습니다. 첫 메시지를 남겨보세요! 💬</div>';
                  if (container) container.innerHTML = emptyHtml;
                  if (fContainer) fContainer.innerHTML = emptyHtml;
                  return;
                }
                if (container) container.innerHTML = '';
                if (fContainer) fContainer.innerHTML = '';
                data.messages.forEach(msg => appendLiveChatMessage(msg, false));
                if (container) container.scrollTop = container.scrollHeight;
                if (fContainer) fContainer.scrollTop = fContainer.scrollHeight;
              }
            } catch (e) {
              const errHtml = '<div style="text-align: center; color: #ef4444; font-size: 0.85rem;">채팅 메시지를 불러오지 못했습니다.</div>';
              if (container) container.innerHTML = errHtml;
              if (fContainer) fContainer.innerHTML = errHtml;
            }
          }

          function appendLiveChatMessage(msg, shouldScroll = true) {
            const container = document.getElementById('chat-messages-container');
            const fContainer = document.getElementById('floating-chat-messages-container');

            const isMine = currentChatUserId && String(msg.user_id) === String(currentChatUserId);
            const isAdmin = msg.is_admin === 1 || msg.is_admin === true;
            const timeStr = msg.created_at ? new Date(msg.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '';
            const avatarUrl = (function(userId, avatar) {
              const av = String(avatar || '');
              if (!av) return 'https://cdn.discordapp.com/embed/avatars/0.png';
              try {
                const parsed = new URL(av);
                const host = parsed.hostname.toLowerCase();
                if (parsed.protocol === 'https:' && (host === 'cdn.discordapp.com' || host === 'media.discordapp.net')) return parsed.href;
              } catch (e) {}
              const id = String(userId || '');
              if (/^\\d{5,32}$/.test(id) && /^[a-zA-Z0-9_-]+$/.test(av)) {
                return 'https://cdn.discordapp.com/avatars/' + id + '/' + av + '.png';
              }
              return 'https://cdn.discordapp.com/embed/avatars/0.png';
            })(msg.user_id, msg.avatar);
            const delBtn = (currentIsAdmin || isMine) ? '<button class="btn-del-msg" onclick="deleteChatMessage(' + Number(msg.id) + ')" title="메시지 삭제">🗑️</button>' : '';
            const adminBadge = isAdmin ? '<span class="badge-admin-chat">👑 <span>관리자</span></span>' : '<span class="badge-member-chat">💬 <span>시민</span></span>';

            const bubbleInnerHtml = 
              '<div class="chat-avatar-wrap">' +
                '<img src="' + escapeHtml(avatarUrl) + '" class="chat-avatar" data-fallback="https://cdn.discordapp.com/embed/avatars/0.png" onerror="this.onerror=null;this.src=this.dataset.fallback">' +
                '<span class="chat-online-dot" title="온라인"></span>' +
              '</div>' +
              '<div class="chat-content">' +
                '<div class="chat-meta">' +
                  '<b class="chat-user-btn" style="color:' + (function(id){var c=['#ed4245','#fee75c','#57f287','#5865f2','#eb459e','#00a8fc','#f47b67','#45ddc0'];var n=0;String(id||'').split('').forEach(function(ch){n=(n+ch.charCodeAt(0))%c.length;});return c[n];})(msg.user_id) + '"><span class="user-at">@</span>' + escapeHtml(msg.username || '익명') + '</b> ' +
                  adminBadge + ' ' +
                  '<span class="chat-time-tag">⏱️ ' + timeStr + '</span> ' +
                  delBtn +
                '</div>' +
                '<div class="chat-text-body">' + escapeHtml(String(msg.message || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&')) + '</div>' +
              '</div>';

            // 1. 메인 탭 컨테이너에 추가
            if (container && !document.getElementById('chat-msg-' + msg.id)) {
              const bubble = document.createElement('div');
              bubble.id = 'chat-msg-' + msg.id;
              bubble.className = 'chat-bubble ' + (isMine ? 'mine' : '') + ' ' + (isAdmin ? 'admin' : '');
              bubble.innerHTML = bubbleInnerHtml;
              container.appendChild(bubble);
              if (shouldScroll) container.scrollTop = container.scrollHeight;
            }

            // 2. 플로팅 드로어 컨테이너에 추가
            if (fContainer && !document.getElementById('fchat-msg-' + msg.id)) {
              const fBubble = document.createElement('div');
              fBubble.id = 'fchat-msg-' + msg.id;
              fBubble.className = 'chat-bubble ' + (isMine ? 'mine' : '') + ' ' + (isAdmin ? 'admin' : '');
              fBubble.innerHTML = bubbleInnerHtml;
              fContainer.appendChild(fBubble);
              if (shouldScroll && isFloatingChatOpen) fContainer.scrollTop = fContainer.scrollHeight;
            }

            // 플로팅 창이 닫혀 있고 남이 보낸 메시지면 알림 뱃지 표시
            if (!isFloatingChatOpen && !isMine && shouldScroll) {
              const badge = document.getElementById('floating-chat-badge');
              if (badge) badge.style.display = 'inline-block';
            }
          }

          function insertEmoji(emoji) {
            const input = document.getElementById('chat-input');
            if (input) {
              input.value += emoji;
              input.focus();
            }
          }

          function insertFloatingEmoji(emoji) {
            const input = document.getElementById('floating-chat-input');
            if (input) {
              input.value += emoji;
              input.focus();
            }
          }

          async function handleSendChat(e) {
            if (e) e.preventDefault();
            const input = document.getElementById('chat-input');
            const btn = document.getElementById('chat-submit-btn');
            if (!input) return;
            const text = input.value.trim();
            if (!text) {
              input.focus();
              return;
            }

            if (btn) btn.disabled = true;
            try {
              const res = await fetch('/api/chat/send', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text })
              });
              const data = await res.json();
              if (!data.success) {
                showToast('error', '채팅 실패', data.error || '채팅 전송에 실패했습니다. (Discord 로그인이 필요할 수 있습니다)');
              } else {
                input.value = '';
                if (data.message) {
                  appendLiveChatMessage(data.message, true);
                }
              }
            } catch (err) {
              showToast('error', '통신 오류', '채팅 서버와 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
            } finally {
              if (btn) btn.disabled = false;
              input.focus();
            }
          }

          async function handleSendFloatingChat(e) {
            if (e) e.preventDefault();
            const input = document.getElementById('floating-chat-input');
            const btn = document.getElementById('floating-chat-submit-btn');
            if (!input) return;
            const text = input.value.trim();
            if (!text) {
              input.focus();
              return;
            }

            if (btn) btn.disabled = true;
            try {
              const res = await fetch('/api/chat/send', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text })
              });
              const data = await res.json();
              if (!data.success) {
                showToast('error', '채팅 실패', data.error || '채팅 전송에 실패했습니다. (Discord 로그인이 필요할 수 있습니다)');
              } else {
                input.value = '';
                if (data.message) {
                  appendLiveChatMessage(data.message, true);
                }
              }
            } catch (err) {
              showToast('error', '통신 오류', '채팅 서버와 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
            } finally {
              if (btn) btn.disabled = false;
              input.focus();
            }
          }

          async function deleteChatMessage(msgId) {
            if (!confirm('이 메시지를 삭제하시겠습니까?')) return;
            try {
              const res = await fetch('/api/chat/message/' + msgId, { method: 'DELETE' });
              const data = await res.json();
              if (data.success) {
                const el = document.getElementById('chat-msg-' + msgId);
                if (el) el.remove();
                const fEl = document.getElementById('fchat-msg-' + msgId);
                if (fEl) fEl.remove();
              } else {
                showToast('error', '삭제 실패', data.error || '삭제 권한이 없습니다.');
              }
            } catch (e) {}
          }

          // ── 🏦 P2P 사채/대부업 & 법원 강제집행 웹 스크립트 ───────────────────
          function toggleP2PColInputs(val) {
            const stockG = document.getElementById('p2p-col-stock-group');
            const bankG = document.getElementById('p2p-col-bank-group');
            if (stockG) stockG.style.display = val === 'stock' ? 'flex' : 'none';
            if (bankG) bankG.style.display = val === 'bank' ? 'block' : 'none';
          }

          async function loadP2PState() {
            try {
              const res = await fetch('/api/p2p/state', { credentials: 'same-origin' });
              const json = await res.json();
              if (!json.success || !json.data) return;

              const data = json.data;
              const lic = data.lenderLicense;
              const licTitle = document.getElementById('p2p-lic-title');
              const licDesc = document.getElementById('p2p-lic-desc');
              const licAction = document.getElementById('p2p-lic-action');

              if (lic && lic.is_active) {
                if (licTitle) licTitle.innerHTML = '🏢 공인 대부업 면허: <span style="color:#10b981;">✅ 정상 영업 중 (' + lic.business_name + ')</span>';
                if (licDesc) licDesc.innerHTML = '누적 대출액: <b>' + (typeof formatMoneyCompact === 'function' ? formatMoneyCompact(lic.total_lent) : lic.total_lent) + '</b> | 납부 세금: <b>' + (typeof formatMoneyCompact === 'function' ? formatMoneyCompact(lic.total_tax_paid) : lic.total_tax_paid) + '</b> (국고 기여)';
                if (licAction) licAction.innerHTML = '<span style="background:rgba(16,185,129,0.15); border:1px solid #10b981; color:#10b981; padding:6px 14px; border-radius:999px; font-weight:700; font-size:0.85rem;">🛡️ 금융감독원 공인 면허 보유</span>';
              } else {
                if (licTitle) licTitle.innerHTML = '🏢 공인 대부업 면허: <span style="color:#f87171;">❌ 미보유</span>';
                if (licDesc) licDesc.innerText = '대부업 면허(50만원 면허세 국고 납부)가 있어야 다른 유저에게 대출을 제안할 수 있습니다.';
                if (licAction) licAction.innerHTML = '<button type="button" class="btn-play-game" onclick="claimWebP2PLicense()" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">🏛️ 대부업 면허 발급 (50만원)</button>';
              }

              // 빌려준 목록
              const lentTbody = document.getElementById('p2p-lent-tbody');
              if (lentTbody) {
                lentTbody.innerHTML = '';
                const lentList = data.lentList || [];
                if (!lentList.length) {
                  lentTbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:#9ca3af; padding:12px;">내가 빌려준 대출 내역이 없습니다.</td></tr>';
                } else {
                  lentList.forEach(function(l) {
                    const tr = document.createElement('tr');
                    const isOverdue = new Date() >= new Date(l.due_at);
                    const canForeclose = (l.status === 'active' || l.status === 'overdue') && isOverdue;
                    let stHtml = '<span style="color:#fbbf24;">대기중</span>';
                    if (l.status === 'active') stHtml = isOverdue ? '<span style="color:#f87171;font-weight:700;">🚨 연체중</span>' : '<span style="color:#34d399;">진행중</span>';
                    if (l.status === 'repaid') stHtml = '<span style="color:#38bdf8;">상환완료</span>';
                    if (l.status === 'foreclosed') stHtml = '<span style="color:#ef4444;font-weight:700;">⚖️ 강제집행완료</span>';

                    let colStr = '무담보';
                    if (l.collateral_type === 'stock') colStr = '📈 ' + l.collateral_stock_id + ' ' + l.collateral_stock_amount + '주';
                    if (l.collateral_type === 'bank') colStr = '🏦 ' + (typeof formatMoneyCompact === 'function' ? formatMoneyCompact(l.collateral_bank_amount) : l.collateral_bank_amount);

                    tr.innerHTML = '<td><b>#' + l.id + '</b></td>' +
                      '<td><code>' + l.borrower_id + '</code></td>' +
                      '<td style="text-align:right;">' + (typeof formatMoneyCompact === 'function' ? formatMoneyCompact(l.principal) : l.principal) + '</td>' +
                      '<td style="text-align:right; font-weight:700; color:#fbbf24;">' + (typeof formatMoneyCompact === 'function' ? formatMoneyCompact(l.total_due) : l.total_due) + '</td>' +
                      '<td>' + l.interest_rate + '%</td>' +
                      '<td><small>' + colStr + '</small></td>' +
                      '<td>' + stHtml + '</td>' +
                      '<td><small>' + new Date(l.due_at).toLocaleDateString() + '</small></td>' +
                      '<td>' + (canForeclose ? '<button type="button" class="btn-chip" onclick="forecloseWebP2P(' + l.id + ')" style="background:#ef4444;color:#fff;">⚖️ 법원 강제징수</button>' : '-') + '</td>';
                    lentTbody.appendChild(tr);
                  });
                }
              }

              // 빌린 목록
              const borrowedTbody = document.getElementById('p2p-borrowed-tbody');
              if (borrowedTbody) {
                borrowedTbody.innerHTML = '';
                const bList = data.borrowedList || [];
                if (!bList.length) {
                  borrowedTbody.innerHTML = '<tr><td colspan="9" style="text-align:center; color:#9ca3af; padding:12px;">내가 빌린 대출 내역이 없습니다.</td></tr>';
                } else {
                  bList.forEach(function(l) {
                    const tr = document.createElement('tr');
                    const isOverdue = new Date() >= new Date(l.due_at);
                    let stHtml = '<span style="color:#fbbf24;">대기중</span>';
                    if (l.status === 'active') stHtml = isOverdue ? '<span style="color:#f87171;font-weight:700;">🚨 연체중</span>' : '<span style="color:#34d399;">진행중</span>';
                    if (l.status === 'repaid') stHtml = '<span style="color:#38bdf8;">상환완료</span>';
                    if (l.status === 'foreclosed') stHtml = '<span style="color:#ef4444;font-weight:700;">⚖️ 압류집행됨</span>';

                    let colStr = '무담보';
                    if (l.collateral_type === 'stock') colStr = '📈 ' + l.collateral_stock_id + ' ' + l.collateral_stock_amount + '주';
                    if (l.collateral_type === 'bank') colStr = '🏦 ' + (typeof formatMoneyCompact === 'function' ? formatMoneyCompact(l.collateral_bank_amount) : l.collateral_bank_amount);

                    let actHtml = '-';
                    if (l.status === 'pending') {
                      actHtml = '<button type="button" class="btn-chip" onclick="acceptWebP2P(' + l.id + ')" style="background:#10b981;color:#fff;">🤝 계약 수락</button>';
                    } else if (l.status === 'active' || l.status === 'overdue') {
                      actHtml = '<button type="button" class="btn-chip" onclick="repayWebP2P(' + l.id + ')" style="background:#6366f1;color:#fff;">💸 즉시 상환</button>';
                    }

                    tr.innerHTML = '<td><b>#' + l.id + '</b></td>' +
                      '<td><code>' + l.lender_id + '</code></td>' +
                      '<td style="text-align:right;">' + (typeof formatMoneyCompact === 'function' ? formatMoneyCompact(l.principal) : l.principal) + '</td>' +
                      '<td style="text-align:right; font-weight:700; color:#fbbf24;">' + (typeof formatMoneyCompact === 'function' ? formatMoneyCompact(l.total_due) : l.total_due) + '</td>' +
                      '<td>' + l.interest_rate + '%</td>' +
                      '<td><small>' + colStr + '</small></td>' +
                      '<td>' + stHtml + '</td>' +
                      '<td><small>' + new Date(l.due_at).toLocaleDateString() + '</small></td>' +
                      '<td>' + actHtml + '</td>';
                    borrowedTbody.appendChild(tr);
                  });
                }
              }

            } catch (err) {
              console.error('P2P 상태 로드 오류:', err);
            }
          }

          async function claimWebP2PLicense() {
            const name = prompt('등록할 대부업 상호명을 입력하세요 (예: 황금오리 캐피탈):', '황금오리 캐피탈');
            if (name === null) return;
            if (!confirm('🏛️ 대부업 면허세 500,000원이 국고로 징수됩니다. 면허를 발급하시겠습니까?')) return;
            try {
              const res = await fetch('/api/p2p/license', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ businessName: name })
              });
              const data = await res.json();
              if (!data.success) return showToast('error', '면허 발급 실패', data.error);
              showToast('success', '대부업 면허 취득 완료!', data.message);
              loadP2PState();
            } catch (e) {
              showToast('error', '오류', '처리 중 오류가 발생했습니다.');
            }
          }

          async function submitWebP2POffer() {
            const target = (document.getElementById('p2p-input-target') || {}).value;
            const principal = (document.getElementById('p2p-input-principal') || {}).value;
            const rate = (document.getElementById('p2p-input-rate') || {}).value;
            const hours = (document.getElementById('p2p-input-hours') || {}).value;
            const colType = (document.getElementById('p2p-input-coltype') || {}).value;
            const stockId = (document.getElementById('p2p-input-stockid') || {}).value;
            const stockAmt = (document.getElementById('p2p-input-stockamt') || {}).value;
            const bankAmt = (document.getElementById('p2p-input-bankamt') || {}).value;

            if (!target || !principal) return showToast('error', '입력 오류', '차입자와 대출 원금을 입력하세요.');

            try {
              const res = await fetch('/api/p2p/offer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                  targetInput: target,
                  principal,
                  interestRate: rate,
                  durationHours: hours,
                  collateralType: colType,
                  collateralStockId: stockId,
                  collateralStockAmt: stockAmt,
                  collateralBankAmt: bankAmt
                })
              });
              const data = await res.json();
              if (!data.success) return showToast('error', '제안 등록 실패', data.error);
              showToast('success', '대출 제안 등록 완료', data.message);
              loadP2PState();
            } catch (e) {
              showToast('error', '오류', '처리 중 오류가 발생했습니다.');
            }
          }

          async function acceptWebP2P(loanId) {
            if (!confirm('대출 #' + loanId + ' 계약을 수락하시겠습니까? 설정된 담보가 동결되고 대출금이 지급됩니다.')) return;
            try {
              const res = await fetch('/api/p2p/accept', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ loanId })
              });
              const data = await res.json();
              if (!data.success) return showToast('error', '수락 실패', data.error);
              showToast('success', '계약 체결 완료!', data.message);
              loadP2PState();
            } catch (e) {
              showToast('error', '오류', '처리 중 오류가 발생했습니다.');
            }
          }

          async function repayWebP2P(loanId) {
            if (!confirm('대출 #' + loanId + ' 원리금을 상환하시겠습니까? 담보가 반환되며 이자의 15%는 국고 세금으로 납부됩니다.')) return;
            try {
              const res = await fetch('/api/p2p/repay', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ loanId })
              });
              const data = await res.json();
              if (!data.success) return showToast('error', '상환 실패', data.error);
              showToast('success', '상환 완료!', data.message);
              loadP2PState();
            } catch (e) {
              showToast('error', '오류', '처리 중 오류가 발생했습니다.');
            }
          }

          async function forecloseWebP2P(loanId) {
            if (!confirm('⚖️ 법원에 대출 #' + loanId + ' 건에 대한 강제 징수(추심 및 담보 몰수)를 신청하시겠습니까?')) return;
            try {
              const res = await fetch('/api/p2p/foreclose', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ loanId })
              });
              const data = await res.json();
              if (!data.success) return showToast('error', '강제 집행 실패', data.error);
              showToast('success', '⚖️ 법원 강제 집행 완료!', data.message);
              loadP2PState();
            } catch (e) {
              showToast('error', '오류', '처리 중 오류가 발생했습니다.');
            }
          }

          let rouletteColor = 'RED';
          function selectRoulette(color) {
            rouletteColor = color;
            ['RED','BLACK','GREEN'].forEach(function(c) {
              const el = document.getElementById('roulette-' + c.toLowerCase());
              if (el) el.classList.toggle('selected', c === color);
            });
          }
          function setNamedBet(id, val) {
            addNumericBet(id, val);
          }
          async function playNamedGame(url, body, btnId, resultId, onOk) {
            const btn = document.getElementById(btnId);
            const box = document.getElementById(resultId);
            if (btn) btn.disabled = true;
            try {
              const res = await fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
              });
              const data = await res.json();
              if (!data.success) {
                showToast('error', '실패', data.error || '실패');
                if (box) box.textContent = data.error || '실패';
                if (btn) btn.disabled = false;
                return data;
              }
              if (data.newCash) updateUserCashDisplay(data.newCash);
              if (box) box.textContent = data.message || '완료';
              if (window.CasinoUX) window.CasinoUX.onGameResult(data);
              if (onOk) onOk(data);
              else if (btn) btn.disabled = false;
              return data;
            } catch (e) {
              showToast('error', '통신 오류', '서버에 연결하지 못했습니다.');
              if (btn) btn.disabled = false;
            }
          }
          async function playRoulette() {
            if (isGameInProgress) return;
            const fx = window.GameFx;
            if (window.CasinoAudio) window.CasinoAudio.play('roulette', '룰렛');
            setGameLock(true);
            const bet = getBetPayload(document.getElementById('roulette-bet'));
            const wheel = document.getElementById('roulette-wheel');
            const hub = document.getElementById('roulette-hub');
            const btn = document.getElementById('btn-spin-roulette');
            if (btn) btn.disabled = true;
            if (wheel) {
              wheel.classList.remove('land-red', 'land-black', 'land-green');
              wheel.classList.add('spinning');
            }
            if (hub) hub.textContent = '🎡';
            if (fx) fx.setCall('roulette-call', '구슬이 휠을 타고 돕니다...', '#fbbf24');
            try {
              const res = await fetch('/api/game/roulette', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bet: bet, color: rouletteColor })
              });
              const data = await res.json();
              if (!data.success) {
                if (wheel) wheel.classList.remove('spinning');
                setGameLock(false);
                if (btn) btn.disabled = false;
                showToast('error', '룰렛', data.error || '실패');
                const box = document.getElementById('roulette-result');
                if (box) box.textContent = data.error || '실패';
                return;
              }
              await (fx ? fx.sleep(1100) : new Promise(function(r){ setTimeout(r, 1100); }));
              if (wheel) {
                wheel.classList.remove('spinning');
                const land = String(data.result || '').toLowerCase();
                wheel.classList.add('land-' + land);
              }
              if (hub) hub.textContent = data.emoji || data.result || '?';
              if (fx) fx.setCall('roulette-call', data.flavor || data.message, data.isWin ? '#34d399' : '#94a3b8');
              if (fx) fx.paintResult('roulette-result', data.isWin, data.isWin ? '적중' : '빗나감', data.message, data.flavor);
              else {
                const box = document.getElementById('roulette-result');
                if (box) box.textContent = data.message || '완료';
              }
              if (data.newCash) updateUserCashDisplay(data.newCash);
              if (window.CasinoUX) window.CasinoUX.onGameResult(data);
              showToast(data.isWin ? 'success' : 'info', '🎡 룰렛', data.message);
            } catch (e) {
              if (wheel) wheel.classList.remove('spinning');
              showToast('error', '통신 오류', '서버에 연결하지 못했습니다.');
            }
            setGameLock(false);
            if (btn) btn.disabled = false;
          }
          async function playHighLow() {
            if (isGameInProgress) return;
            const fx = window.GameFx;
            if (window.CasinoAudio) window.CasinoAudio.play('dice', '하이로우');
            setGameLock(true);
            const bet = getBetPayload(document.getElementById('hl-bet'));
            const btn = document.getElementById('btn-hl');
            const rollEl = document.getElementById('hl-roll');
            const fill = document.getElementById('hl-fill');
            if (btn) btn.disabled = true;
            if (rollEl) {
              rollEl.classList.remove('hl-hot', 'hl-jack');
              rollEl.textContent = '0';
            }
            if (fill) fill.style.width = '0%';
            if (fx) fx.setCall('hl-call', '바늘이 올라갑니다...', '#fbbf24');
            try {
              const res = await fetch('/api/game/highlow', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bet: bet })
              });
              const data = await res.json();
              if (!data.success) {
                setGameLock(false);
                if (btn) btn.disabled = false;
                showToast('error', '하이로우', data.error || '실패');
                return data;
              }
              const n = Number(data.roll) || 0;
              if (fx) await fx.countUp(rollEl, n, 920);
              else if (rollEl) rollEl.textContent = String(n);
              if (fill) fill.style.width = Math.min(100, n) + '%';
              if (rollEl) {
                if (n >= 90) rollEl.classList.add('hl-jack');
                else if (n >= 60) rollEl.classList.add('hl-hot');
              }
              if (fx) fx.setCall('hl-call', data.flavor || data.message, data.isWin ? '#34d399' : '#94a3b8');
              if (fx) fx.paintResult('hl-result', data.isWin, n + '점', data.message, data.flavor);
              else {
                const box = document.getElementById('hl-result');
                if (box) box.textContent = data.message || '완료';
              }
              if (data.newCash) updateUserCashDisplay(data.newCash);
              if (window.CasinoUX) window.CasinoUX.onGameResult(data);
              showToast(data.isWin ? 'success' : 'info', '🎯 하이로우', data.message);
            } catch (e) {
              showToast('error', '통신 오류', '서버에 연결하지 못했습니다.');
            }
            setGameLock(false);
            if (btn) btn.disabled = false;
          }
          function renderBjCards(el, cards) {
            if (!el) return;
            const list = Array.isArray(cards) ? cards : [];
            el.innerHTML = list.map(function(c) {
              const hidden = c === '🂠';
              return '<span class="bj-card' + (hidden ? ' hidden' : '') + '">' + (window.GameFx ? window.GameFx.escapeHtml(c) : c) + '</span>';
            }).join('');
          }
          function renderBj(data) {
            renderBjCards(document.getElementById('bj-dealer'), data.dealer);
            renderBjCards(document.getElementById('bj-player'), data.player);
            const d = document.getElementById('bj-dealer');
            const p = document.getElementById('bj-player');
            if (d && data.dealerScore) d.insertAdjacentHTML('beforeend', '<span class="bj-score"> ' + data.dealerScore + '</span>');
            if (p && data.playerScore) p.insertAdjacentHTML('beforeend', '<span class="bj-score"> ' + data.playerScore + '</span>');
            const hit = document.getElementById('btn-bj-hit');
            const stand = document.getElementById('btn-bj-stand');
            const start = document.getElementById('btn-bj-start');
            const settled = data.payout !== undefined;
            const playing = data.status === 'playing' || (!settled && data.player);
            if (hit) hit.disabled = !playing;
            if (stand) stand.disabled = !playing;
            if (start) start.disabled = !!playing;
            const call = document.getElementById('bj-call');
            if (call) {
              if (data.status === 'playing') call.textContent = '히트 또는 스탠드. 내 점수 ' + (data.playerScore || '') + '점.';
              else if (settled) call.textContent = data.message || '핸드 종료';
              else call.textContent = '히트 또는 스탠드. 딜러는 16에서 히트합니다.';
            }
          }
          function startBlackjack() {
            const bet = getBetPayload(document.getElementById('bj-bet'));
            return playNamedGame('/api/game/blackjack/start', { bet: bet }, 'btn-bj-start', 'bj-result', renderBj);
          }
          function hitBlackjack() {
            return playNamedGame('/api/game/blackjack/hit', {}, 'btn-bj-hit', 'bj-result', renderBj);
          }
          function standBlackjack() {
            return playNamedGame('/api/game/blackjack/stand', {}, 'btn-bj-stand', 'bj-result', renderBj);
          }
          function pkMoney(v) {
            if (typeof window.formatMoneyCompact === 'function') return window.formatMoneyCompact(v);
            try { return Number(v || 0).toLocaleString('ko-KR') + '원'; } catch (e) { return String(v) + '원'; }
          }
          function renderPkCards(el, views, winKeys) {
            if (!el) return;
            const wins = {};
            (winKeys || []).forEach(function(k) { wins[k] = true; });
            const list = Array.isArray(views) ? views : [];
            if (!list.length) {
              el.textContent = '—';
              return;
            }
            el.innerHTML = list.map(function(v, i) {
              const t = (v && v.t) || '🂠';
              const red = v && v.c === 'red';
              const empty = v && v.empty;
              const hid = !empty && t === '🂠';
              const win = !hid && !empty && v && v.k && wins[v.k];
              const down = v && v.d;
              const safe = window.GameFx ? window.GameFx.escapeHtml(t) : t;
              return '<span class="pk-card' + (empty ? ' empty' : '') + (hid ? ' hidden' : '') + (red ? ' red' : '') + (win ? ' win' : '') + (down && !hid && !empty ? ' down' : '') + '" style="animation-delay:' + (i * 0.05) + 's">' + safe + '</span>';
            }).join('');
          }
          function paintPokerHistory() {
            const box = document.getElementById('pk-history');
            if (!box) return;
            let list = [];
            try { list = JSON.parse(localStorage.getItem('duck_poker_history') || '[]'); } catch (e) { list = []; }
            if (!list.length) {
              box.textContent = '';
              return;
            }
            box.innerHTML = '<div class="pk-history-title">최근 핸드</div>' + list.slice(0, 5).map(function(h) {
              const tag = h.outcome === 'win' ? '승' : (h.outcome === 'tie' ? '스플릿' : '패');
              const hand = h.hand ? ' · ' + h.hand : '';
              return '<div class="pk-history-row">' + tag + hand + ' · 팟 ' + pkMoney(h.pot) + '</div>';
            }).join('');
          }
          function pushPokerHistory(data) {
            if (!data || data.status === 'playing') return;
            const entry = {
              outcome: data.outcome || (data.isWin ? 'win' : (data.isTie ? 'tie' : 'lose')),
              hand: data.playerHand || '',
              pot: data.pot || '0',
              t: Date.now()
            };
            let list = [];
            try { list = JSON.parse(localStorage.getItem('duck_poker_history') || '[]'); } catch (e) { list = []; }
            list.unshift(entry);
            try { localStorage.setItem('duck_poker_history', JSON.stringify(list.slice(0, 5))); } catch (e) {}
            paintPokerHistory();
          }
          function setPkBtn(id, on, label) {
            const el = document.getElementById(id);
            if (!el) return;
            el.disabled = !on;
            if (label) el.textContent = label;
          }
          function renderPoker(data) {
            if (!data) return;
            const felt = document.getElementById('pk-felt');
            if (felt) felt.classList.toggle('pk-royal', !!data.royal);
            renderPkCards(document.getElementById('pk-dealer'), data.dealerViews, data.winKeys);
            renderPkCards(document.getElementById('pk-board'), data.boardViews, data.winKeys);
            renderPkCards(document.getElementById('pk-player'), data.playerViews, data.winKeys);
            const mood = document.getElementById('pk-mood');
            if (mood) mood.textContent = data.mood ? '(' + data.mood + ')' : '';
            const dh = document.getElementById('pk-dealer-hand');
            if (dh) dh.textContent = data.dealerHand || '';
            const ph = document.getElementById('pk-player-hand');
            if (ph) ph.textContent = data.playerHand || '';
            const street = document.getElementById('pk-street');
            if (street) street.textContent = data.streetName || '대기';
            const pot = document.getElementById('pk-pot');
            if (pot) pot.textContent = '팟 ' + pkMoney(data.pot || 0);
            const playing = data.status === 'playing';
            const can = data.can || {};
            setPkBtn('btn-pk-start', !playing);
            setPkBtn('btn-pk-fold', !!can.fold);
            setPkBtn('btn-pk-check', !!can.check);
            setPkBtn('btn-pk-call', !!can.call, can.call ? ('콜 ' + pkMoney(data.callAmount || 0)) : '콜');
            setPkBtn('btn-pk-bet', !!can.bet, can.bet ? ('벳 ' + pkMoney(data.betAmount || 0)) : '벳');
            setPkBtn('btn-pk-allin', !!can.allin);
            const call = document.getElementById('pk-call');
            if (call) call.textContent = data.message || (playing ? '액션을 고르세요.' : '유닛을 정한 뒤 딜을 누르세요.');
            if (data.status && data.status !== 'playing') pushPokerHistory(data);
          }
          function startPoker() {
            if (window.CasinoAudio) window.CasinoAudio.play('dice', '포커');
            const bet = getBetPayload(document.getElementById('pk-bet'));
            return playNamedGame('/api/game/poker/start', { bet: bet }, 'btn-pk-start', 'pk-result', renderPoker);
          }
          function pokerAct(action) {
            return playNamedGame('/api/game/poker/act', { action: action }, 'btn-pk-' + action, 'pk-result', renderPoker);
          }
          function paintSevenPokerHistory() {
            const box = document.getElementById('sp-history');
            if (!box) return;
            let list = [];
            try { list = JSON.parse(localStorage.getItem('duck_seven_poker_history') || '[]'); } catch (e) { list = []; }
            if (!list.length) {
              box.textContent = '';
              return;
            }
            box.innerHTML = '<div class="pk-history-title">최근 핸드</div>' + list.slice(0, 5).map(function(h) {
              const tag = h.outcome === 'win' ? '승' : (h.outcome === 'tie' ? '스플릿' : '패');
              const hand = h.hand ? ' · ' + h.hand : '';
              return '<div class="pk-history-row">' + tag + hand + ' · 팟 ' + pkMoney(h.pot) + '</div>';
            }).join('');
          }
          function pushSevenPokerHistory(data) {
            if (!data || data.status === 'playing') return;
            const entry = {
              outcome: data.outcome || (data.isWin ? 'win' : (data.isTie ? 'tie' : 'lose')),
              hand: data.playerHand || '',
              pot: data.pot || '0',
              t: Date.now()
            };
            let list = [];
            try { list = JSON.parse(localStorage.getItem('duck_seven_poker_history') || '[]'); } catch (e) { list = []; }
            list.unshift(entry);
            try { localStorage.setItem('duck_seven_poker_history', JSON.stringify(list.slice(0, 5))); } catch (e) {}
            paintSevenPokerHistory();
          }
          function renderSevenPoker(data) {
            if (!data) return;
            const felt = document.getElementById('sp-felt');
            if (felt) felt.classList.toggle('pk-royal', !!data.royal);
            renderPkCards(document.getElementById('sp-dealer'), data.dealerViews, data.winKeys);
            renderPkCards(document.getElementById('sp-player'), data.playerViews, data.winKeys);
            const mood = document.getElementById('sp-mood');
            if (mood) mood.textContent = data.mood ? '(' + data.mood + ')' : '';
            const dh = document.getElementById('sp-dealer-hand');
            if (dh) dh.textContent = data.dealerHand || '';
            const ph = document.getElementById('sp-player-hand');
            if (ph) ph.textContent = data.playerHand || '';
            const street = document.getElementById('sp-street');
            if (street) street.textContent = data.streetName || '대기';
            const pot = document.getElementById('sp-pot');
            if (pot) pot.textContent = '팟 ' + pkMoney(data.pot || 0);
            const playing = data.status === 'playing';
            const can = data.can || {};
            setPkBtn('btn-sp-start', !playing);
            setPkBtn('btn-sp-fold', !!can.fold);
            setPkBtn('btn-sp-check', !!can.check);
            setPkBtn('btn-sp-call', !!can.call, can.call ? ('콜 ' + pkMoney(data.callAmount || 0)) : '콜');
            setPkBtn('btn-sp-bet', !!can.bet, can.bet ? ('벳 ' + pkMoney(data.betAmount || 0)) : '벳');
            setPkBtn('btn-sp-allin', !!can.allin);
            const call = document.getElementById('sp-call');
            if (call) call.textContent = data.message || (playing ? '액션을 고르세요.' : '유닛을 정한 뒤 딜을 누르세요.');
            if (data.status && data.status !== 'playing') pushSevenPokerHistory(data);
          }
          function startSevenPoker() {
            if (window.CasinoAudio) window.CasinoAudio.play('dice', '세븐포커');
            const bet = getBetPayload(document.getElementById('sp-bet'));
            return playNamedGame('/api/game/seven-poker/start', { bet: bet }, 'btn-sp-start', 'sp-result', renderSevenPoker);
          }
          function sevenPokerAct(action) {
            return playNamedGame('/api/game/seven-poker/act', { action: action }, 'btn-sp-' + action, 'sp-result', renderSevenPoker);
          }

          window.toggleFloatingChat = toggleFloatingChat;
          window.handleSendChat = handleSendChat;
          window.handleSendFloatingChat = handleSendFloatingChat;
          window.insertEmoji = insertEmoji;
          window.insertFloatingEmoji = insertFloatingEmoji;
          window.deleteChatMessage = deleteChatMessage;
          window.startPoker = startPoker;
          window.pokerAct = pokerAct;
          window.startSevenPoker = startSevenPoker;
          window.sevenPokerAct = sevenPokerAct;

          document.addEventListener('DOMContentLoaded', function() {
            if (typeof initBetChipStep === 'function') initBetChipStep();
            if (typeof loadBusinesses === 'function') loadBusinesses();
            if (typeof paintPokerHistory === 'function') paintPokerHistory();
            if (typeof paintSevenPokerHistory === 'function') paintSevenPokerHistory();
            const toggleBtn = document.getElementById('btn-floating-chat-toggle');
            if (toggleBtn) {
              toggleBtn.onclick = function(e) {
                e.stopPropagation();
                toggleFloatingChat();
              };
            }
            try {
              const params = new URLSearchParams(window.location.search);
              const hash = (window.location.hash || '').replace(/^#/, '');
              if (params.get('open') === 'inquiry' || hash === 'support' || hash === 'inquiry') {
                if (typeof openInquiryModal === 'function') openInquiryModal();
              }
            } catch (e) {}
          });
          </script>
          ${appearanceClientScript()}
          ${jsTag('js/plaza-chat.js', 'defer')}
          ${jsTag('js/casino-audio.js')}
          ${jsTag('js/casino-ux.js')}
          ${jsTag('js/arcade.js')}
          ${jsTag('js/mine-genres.js')}
          <script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.4/dist/htmx.min.js"></script>
          <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
          <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.8/dist/cdn.min.js"></script>
          ${jsTag('js/help-popup.js')}
          ${jsTag('js/bank-loan.js')}
          
          <!-- 📱 모바일 전용 반응형 하단 네비게이션 바 -->
          <nav class="mobile-bottom-nav">
            <button type="button" class="mob-nav-btn active" data-tab="tab-plaza" onclick="switchTab('tab-plaza')">
              <span class="mob-icon">🌐</span>
              <span class="mob-label">광장</span>
            </button>
            <button type="button" class="mob-nav-btn" data-tab="tab-stocks" onclick="switchTab('tab-stocks')">
              <span class="mob-icon">📈</span>
              <span class="mob-label">주식</span>
            </button>
            <button type="button" class="mob-nav-btn" data-tab="tab-shop" onclick="window.location.href='/shop'">
              <span class="mob-icon">🛍️</span>
              <span class="mob-label">상점</span>
            </button>
            <button type="button" class="mob-nav-btn" data-tab="tab-casino" onclick="switchTab('tab-casino')">
              <span class="mob-icon">🎰</span>
              <span class="mob-label">게임</span>
            </button>
            <button type="button" class="mob-nav-btn" data-tab="tab-clicker" onclick="switchTab('tab-clicker')">
              <span class="mob-icon">⛏️</span>
              <span class="mob-label">채굴</span>
            </button>
            <button type="button" class="mob-nav-btn" onclick="toggleMobileSidebar()">
              <span class="mob-icon">☰</span>
              <span class="mob-label">메뉴</span>
            </button>
          </nav>
          ${jsTag('js/metaversePlaza.js')}
          ${getAutoRefreshClient()}
        </body>
        </html>
      `);
    } catch (err) {
      res.status(500).send('서버 오류가 발생했습니다.');
    }
  });

  // ============================================================
  // 👑 관리자 전용 멀티페이지 EJS 라우트 시스템 (/admin/*)
  // ============================================================
  const requireAdminWeb = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const currentUser = getSessionUser(req);
    if (!currentUser || !config.isAdmin(currentUser.id)) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head><meta charset="UTF-8"><title>403 Forbidden</title><style>body{background:#0b0f19;color:#f87171;text-align:center;padding-top:100px;font-family:sans-serif;}.box{background:#161b22;border:1px solid #ef4444;display:inline-block;padding:40px;border-radius:16px;}a{color:#818cf8;text-decoration:none;font-weight:bold;}</style></head>
        <body><div class="box"><h1>🚫 접근 권한 없음</h1><p style="color:#9ca3af;margin:15px 0;">봇 관리자(@관리자) 전용 페이지입니다.</p><a href="/">← 메인으로 돌아가기</a></div></body>
        </html>
      `);
    }
    req.adminUser = currentUser;
    next();
  };

  // 🔌 모듈화된 관리자 HTML 페이지 라우터 마운트
  createAdminPageRoutes({
    pool, config, requireAdminWeb,
    escapeHtml, escapeJsStr, formatMoney, formatMoneyCompact,
    formatKstDateTime, safeBigInt, amountToUnits, mulPriceAmount,
    NET_WORTH_SQL,
    getBannedIpsList, lookupIp, getFlagEmoji
  })(app);

  // 🔌 관리자 JSON API 라우터 마운트 (HTML 페이지 라우터 뒤에 위치)
  const adminApiRouter = createAdminRoutes(getSessionUser);
  const adminMgmtRouter = createAdminManagementRoutes();
  app.use('/api/admin/admin-mgmt', adminMgmtRouter);
  app.use('/admin/admin-mgmt', adminMgmtRouter);
  app.use('/api/admin', adminApiRouter);
  app.use('/admin', adminApiRouter);
  app.use('/api/admin', adminMgmtRouter);
  app.use('/admin', adminMgmtRouter);




  // 라우트 등록
  app.get('/inquiry', (req, res) => {
    res.redirect(302, '/?open=inquiry');
  });
  // 정적 페이지 라우트 (모듈화된 staticPages.js 사용)
  const _renderPrivacy = (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderPrivacyPolicy(getDynamicBaseUrl(req)));
  };
  const _renderTerms = (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(renderTermsOfService(getDynamicBaseUrl(req)));
  };
  app.get('/privacy', _renderPrivacy);
  app.get('/policy', _renderPrivacy);
  app.get('/privacy-policy', _renderPrivacy);
  app.get('/terms', _renderTerms);
  app.get('/terms-of-service', _renderTerms);


  server.listen(PORT, () => {
    console.log(`🌐 디스코드 경제 & OAuth2 웹 서버 + Socket.IO가 실행되었습니다 (포트: ${PORT})`);
    console.log(`🔗 메인 웹사이트: http://localhost:${PORT}`);
    console.log(`🔗 관리자 관제 패널: http://localhost:${PORT}/admin`);
    console.log(`🔗 Discord OAuth2 Redirect URI: ${config.discord.redirectUri}`);
  });
}

module.exports = { startWebServer };
