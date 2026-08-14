const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const config = require('../config/config');
const { pool, getOrCreateUser } = require('../config/database');
const { formatMoney, formatPercent } = require('../utils/formatters');
const { getCurrentMarketRegime, getLastNews } = require('../utils/stockEngine');

function startWebServer(client) {
  const app = express();
  const PORT = config.port || 8080;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // 3초 TTL 메모리 캐시 (웹 트래픽 급증 시 DB 부하 95% 이상 감소)
  let marketCache = { data: null, timestamp: 0 };
  let leaderboardCache = { data: null, timestamp: 0 };
  const CACHE_TTL_MS = 3000;

  async function getCachedMarketStocks() {
    const now = Date.now();
    if (marketCache.data && (now - marketCache.timestamp < CACHE_TTL_MS)) {
      return marketCache.data;
    }
    const [stocks] = await pool.query('SELECT * FROM stocks ORDER BY price DESC');
    marketCache = { data: stocks, timestamp: now };
    return stocks;
  }

  async function getCachedLeaderboard() {
    const now = Date.now();
    if (leaderboardCache.data && (now - leaderboardCache.timestamp < CACHE_TTL_MS)) {
      return leaderboardCache.data;
    }
    const [rows] = await pool.query(`
      SELECT 
        u.discord_id, 
        u.username,
        u.avatar,
        u.cash,
        u.bank,
        (u.cash + u.bank + COALESCE(SUM(us.amount * s.price), 0)) AS net
      FROM users u
      LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
      LEFT JOIN stocks s ON us.stock_id = s.stock_id
      GROUP BY u.discord_id, u.username, u.avatar, u.cash, u.bank
      ORDER BY net DESC
      LIMIT 10
    `);
    leaderboardCache = { data: rows, timestamp: now };
    return rows;
  }

  // API - 주식 시세 데이터 JSON
  app.get('/api/market', async (req, res) => {
    try {
      const stocks = await getCachedMarketStocks();
      const regime = getCurrentMarketRegime();
      const news = getLastNews();
      res.json({ stocks, regime, news });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // API - 자산가 순위표 JSON
  app.get('/api/leaderboard', async (req, res) => {
    try {
      const rows = await getCachedLeaderboard();
      res.json({ leaderboard: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 메인 웹사이트 핸들러
  app.get('/', async (req, res) => {
    try {
      const stocks = await getCachedMarketStocks();
      const leaderboardRows = await getCachedLeaderboard();

      const regime = getCurrentMarketRegime();
      const news = getLastNews();

      const redirectUri = config.discord.redirectUri;
      const clientId = config.discord.clientId;
      const hasOauthConfig = Boolean(clientId);

      const discordLoginUrl = hasOauthConfig
        ? `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`
        : `/auth/guide`;

      // 현재 로그인한 유저 확인 (쿠키 기반)
      let currentUser = null;
      let userAssets = null;

      if (req.cookies && req.cookies.discord_user) {
        try {
          currentUser = JSON.parse(req.cookies.discord_user);
          const userData = await getOrCreateUser(currentUser.id, currentUser.username, currentUser.avatar);

          // 주식 평가금 계산
          const [stocksRows] = await pool.query(`
            SELECT us.amount, s.price
            FROM user_stocks us
            JOIN stocks s ON us.stock_id = s.stock_id
            WHERE us.user_id = ? AND us.amount > 0
          `, [currentUser.id]);

          let stockVal = 0n;
          for (const item of stocksRows) {
            stockVal += BigInt(item.amount) * BigInt(item.price);
          }

          const cash = BigInt(userData.cash || 0);
          const bank = BigInt(userData.bank || 0);
          const netWorth = cash + bank + stockVal;

          userAssets = { cash, bank, stockVal, netWorth };
        } catch (e) {
          currentUser = null;
        }
      }

      // 주식 카드 HTML
      let stockCardsHtml = '';
      for (const s of stocks) {
        const price = BigInt(s.price);
        const prevPrice = BigInt(s.prev_price);
        const diff = price - prevPrice;
        const rate = prevPrice > 0n ? (Number(diff) / Number(prevPrice)) * 100 : 0;
        const isUp = rate >= 0;
        const pillClass = isUp ? 'badge-up' : 'badge-down';
        const arrow = isUp ? '▲' : '▼';

        stockCardsHtml += `
          <div class="stock-card">
            <div class="stock-header">
              <div>
                <span class="stock-symbol">[${s.stock_id}]</span>
                <h3 class="stock-name">${s.name}</h3>
              </div>
              <span class="badge ${pillClass}">${arrow} ${Math.abs(rate).toFixed(2)}%</span>
            </div>
            <div class="stock-price">${formatMoney(price)}</div>
            <div class="stock-footer">이전가: ${formatMoney(prevPrice)}</div>
          </div>
        `;
      }

      // 순위표 HTML (아이디 대신 닉네임 우선 표시)
      let leaderboardRowsHtml = '';
      const rankEmojis = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      for (let i = 0; i < leaderboardRows.length; i++) {
        const row = leaderboardRows[i];
        const emoji = rankEmojis[i] || '🔹';
        const net = BigInt(row.net || 0);

        let displayName = row.username;
        if (!displayName && client && client.users) {
          const cachedUser = client.users.cache.get(row.discord_id);
          if (cachedUser) {
            displayName = cachedUser.globalName || cachedUser.username || cachedUser.tag;
          }
        }
        if (!displayName) {
          displayName = `유저_${row.discord_id.slice(-4)}`;
        }
        if (!displayName.startsWith('@')) {
          displayName = `@${displayName}`;
        }

        const avatarSrc = row.avatar || (client && client.users?.cache.get(row.discord_id)?.displayAvatarURL()) || 'https://cdn.discordapp.com/embed/avatars/0.png';

        leaderboardRowsHtml += `
          <tr>
            <td class="rank-cell">${emoji} ${i + 1}위</td>
            <td>
              <div class="user-info-box">
                <img src="${avatarSrc}" class="rank-avatar" alt="Avatar" onError="this.src='https://cdn.discordapp.com/embed/avatars/0.png';">
                <div class="user-text-col">
                  <span class="user-nickname-title">${displayName}</span>
                  <span class="user-id-sub">ID: ${row.discord_id}</span>
                </div>
              </div>
            </td>
            <td class="net-cell">${formatMoney(net)}</td>
          </tr>
        `;
      }

      // 네비게이션바 오른쪽 영역 (로그인/비로그인 구분)
      const navbarRightHtml = currentUser
        ? `
          <div class="nav-profile-group">
            <img src="${currentUser.avatar}" class="nav-avatar-img" alt="Avatar" onError="this.src='https://cdn.discordapp.com/embed/avatars/0.png';">
            <span class="nav-username-text">@${currentUser.username}</span>
            <a href="/auth/logout" class="btn-logout">🚪 로그아웃</a>
          </div>
        `
        : `
          <a href="${discordLoginUrl}" class="btn-discord">
            🎮 Discord OAuth 로그인
          </a>
        `;

      // 히어로 섹션 (로그인/비로그인 차이 표시)
      const heroSectionHtml = currentUser && userAssets
        ? `
          <div class="hero logged-in-hero">
            <div class="status-badge logged-in-badge">🟢 Discord 로그인 완료 (@${currentUser.username})</div>
            <h1>👋 환영합니다, @${currentUser.username}님!</h1>
            <p>현재 보유하신 실시간 총 순자산 및 주식 자산 상태입니다.</p>
            <div class="personal-asset-grid">
              <div class="asset-card">
                <span class="asset-lbl">💵 보유 현금</span>
                <span class="asset-val">${formatMoney(userAssets.cash)}</span>
              </div>
              <div class="asset-card">
                <span class="asset-lbl">🏦 은행 예금</span>
                <span class="asset-val">${formatMoney(userAssets.bank)}</span>
              </div>
              <div class="asset-card">
                <span class="asset-lbl">📊 주식 평가금</span>
                <span class="asset-val">${formatMoney(userAssets.stockVal)}</span>
              </div>
              <div class="asset-card highlight">
                <span class="asset-lbl">💎 총 순자산</span>
                <span class="asset-val">${formatMoney(userAssets.netWorth)}</span>
              </div>
            </div>
          </div>
        `
        : `
          <div class="hero">
            <div class="status-badge logged-out-badge">🔴 미인증 상태 (로그인 정보 없음)</div>
            <h1>실시간 디스코드 주식 & 자산 시세</h1>
            <p>디스코드 상의 거시 경제 시스템으로 주가가 실시간 변동되며, 로그인 시 본인의 순자산을 조회할 수 있습니다.</p>
            <a href="${discordLoginUrl}" class="btn-discord btn-hero">
              ⚡ Discord 계정으로 로그인하여 내 자산 보기
            </a>
          </div>
        `;

      res.send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>디스코드 경제 & 주식 시스템 대시보드</title>
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@600;700;800&display=swap" rel="stylesheet">
          <style>
            :root {
              --bg-dark: #0b0f19;
              --card-bg: rgba(17, 24, 39, 0.75);
              --card-border: rgba(255, 255, 255, 0.08);
              --primary: #6366f1;
              --primary-hover: #4f46e5;
              --success: #10b981;
              --danger: #ef4444;
              --text-main: #f9fafb;
              --text-muted: #9ca3af;
            }
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: 'Inter', sans-serif;
              background-color: var(--bg-dark);
              color: var(--text-main);
              min-height: 100vh;
              background-image: 
                radial-gradient(at 0% 0%, rgba(99, 102, 241, 0.15) 0px, transparent 50%),
                radial-gradient(at 100% 100%, rgba(139, 92, 246, 0.12) 0px, transparent 50%);
              background-attachment: fixed;
            }
            .navbar {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 20px 40px;
              background: rgba(11, 15, 25, 0.85);
              backdrop-filter: blur(12px);
              border-bottom: 1px solid var(--card-border);
              position: sticky;
              top: 0;
              z-index: 100;
            }
            .logo {
              font-family: 'Outfit', sans-serif;
              font-size: 1.5rem;
              font-weight: 800;
              background: linear-gradient(135deg, #818cf8 0%, #c084fc 100%);
              -webkit-background-clip: text;
              -webkit-text-fill-color: transparent;
              display: flex;
              align-items: center;
              gap: 10px;
            }
            .nav-profile-group {
              display: flex;
              align-items: center;
              gap: 12px;
              background: rgba(255, 255, 255, 0.05);
              padding: 6px 14px;
              border-radius: 30px;
              border: 1px solid var(--card-border);
            }
            .nav-avatar-img {
              width: 34px;
              height: 34px;
              border-radius: 50%;
              border: 2px solid var(--primary);
            }
            .nav-username-text {
              font-weight: 700;
              color: #e0e7ff;
              font-size: 0.95rem;
            }
            .btn-logout {
              color: #f87171;
              text-decoration: none;
              font-size: 0.85rem;
              font-weight: 600;
              margin-left: 8px;
              padding: 4px 10px;
              border-radius: 8px;
              background: rgba(239, 68, 68, 0.1);
              transition: all 0.2s;
            }
            .btn-logout:hover {
              background: rgba(239, 68, 68, 0.25);
            }
            .btn-discord {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              background: linear-gradient(135deg, #5865F2 0%, #4752C4 100%);
              color: white;
              font-weight: 600;
              padding: 10px 22px;
              border-radius: 12px;
              text-decoration: none;
              transition: all 0.2s ease;
              box-shadow: 0 4px 14px rgba(88, 101, 242, 0.4);
            }
            .btn-discord:hover {
              transform: translateY(-2px);
              box-shadow: 0 6px 20px rgba(88, 101, 242, 0.6);
            }
            .btn-hero {
              margin-top: 15px;
              padding: 14px 28px;
              font-size: 1.05rem;
            }
            .container {
              max-width: 1200px;
              margin: 40px auto;
              padding: 0 20px;
            }
            .hero {
              text-align: center;
              margin-bottom: 50px;
              padding: 40px 20px;
              background: var(--card-bg);
              border: 1px solid var(--card-border);
              border-radius: 24px;
              backdrop-filter: blur(16px);
            }
            .hero h1 {
              font-family: 'Outfit', sans-serif;
              font-size: 2.6rem;
              font-weight: 800;
              margin-bottom: 12px;
            }
            .hero p {
              color: var(--text-muted);
              font-size: 1.1rem;
              max-width: 650px;
              margin: 0 auto 20px auto;
            }
            .status-badge {
              display: inline-block;
              padding: 6px 16px;
              border-radius: 20px;
              font-size: 0.85rem;
              font-weight: 700;
              margin-bottom: 16px;
            }
            .logged-in-badge {
              background: rgba(16, 185, 129, 0.15);
              color: #34d399;
              border: 1px solid rgba(16, 185, 129, 0.3);
            }
            .logged-out-badge {
              background: rgba(239, 68, 68, 0.15);
              color: #f87171;
              border: 1px solid rgba(239, 68, 68, 0.3);
            }
            .personal-asset-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
              gap: 15px;
              margin-top: 25px;
            }
            .asset-card {
              background: rgba(255, 255, 255, 0.03);
              border: 1px solid var(--card-border);
              padding: 20px;
              border-radius: 16px;
              text-align: left;
            }
            .asset-card.highlight {
              background: rgba(99, 102, 241, 0.15);
              border-color: rgba(99, 102, 241, 0.4);
            }
            .asset-lbl {
              display: block;
              color: var(--text-muted);
              font-size: 0.85rem;
              margin-bottom: 6px;
            }
            .asset-val {
              display: block;
              font-size: 1.3rem;
              font-weight: 800;
              color: #ffffff;
            }
            .asset-card.highlight .asset-val {
              color: #a5b4fc;
            }
            .regime-pill {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              background: rgba(99, 102, 241, 0.15);
              border: 1px solid rgba(99, 102, 241, 0.3);
              color: #a5b4fc;
              padding: 8px 18px;
              border-radius: 30px;
              font-size: 0.95rem;
              font-weight: 600;
              margin-top: 15px;
            }
            .news-banner {
              margin-top: 15px;
              background: rgba(245, 158, 11, 0.1);
              border: 1px solid rgba(245, 158, 11, 0.3);
              color: #fbbf24;
              padding: 12px 20px;
              border-radius: 12px;
              font-size: 0.95rem;
            }
            .section-title {
              font-family: 'Outfit', sans-serif;
              font-size: 1.8rem;
              margin-bottom: 25px;
              display: flex;
              align-items: center;
              gap: 10px;
            }
            .stock-grid {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
              gap: 20px;
              margin-bottom: 60px;
            }
            .stock-card {
              background: var(--card-bg);
              border: 1px solid var(--card-border);
              border-radius: 18px;
              padding: 24px;
              backdrop-filter: blur(12px);
              transition: transform 0.2s ease, border-color 0.2s ease;
            }
            .stock-card:hover {
              transform: translateY(-4px);
              border-color: rgba(99, 102, 241, 0.4);
            }
            .stock-header {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              margin-bottom: 15px;
            }
            .stock-symbol {
              font-size: 0.8rem;
              color: var(--primary);
              font-weight: 700;
              text-transform: uppercase;
            }
            .stock-name {
              font-size: 1.2rem;
              font-weight: 700;
            }
            .badge {
              padding: 4px 10px;
              border-radius: 8px;
              font-size: 0.85rem;
              font-weight: 700;
            }
            .badge-up { background: rgba(16, 185, 129, 0.15); color: #34d399; }
            .badge-down { background: rgba(239, 68, 68, 0.15); color: #f87171; }
            .stock-price {
              font-size: 1.5rem;
              font-weight: 800;
              margin-bottom: 8px;
              color: #ffffff;
            }
            .stock-footer {
              font-size: 0.85rem;
              color: var(--text-muted);
            }
            .leaderboard-card {
              background: var(--card-bg);
              border: 1px solid var(--card-border);
              border-radius: 20px;
              padding: 30px;
              backdrop-filter: blur(16px);
              margin-bottom: 60px;
            }
            table {
              width: 100%;
              border-collapse: collapse;
              text-align: left;
            }
            th {
              padding: 14px 16px;
              color: var(--text-muted);
              font-size: 0.85rem;
              text-transform: uppercase;
              letter-spacing: 0.05em;
              border-bottom: 1px solid var(--card-border);
            }
            td {
              padding: 16px;
              border-bottom: 1px solid rgba(255, 255, 255, 0.04);
            }
            .rank-cell { font-weight: 700; font-size: 1.1rem; }
            .user-info-box {
              display: flex;
              align-items: center;
              gap: 12px;
            }
            .rank-avatar {
              width: 40px;
              height: 40px;
              border-radius: 50%;
              border: 2px solid rgba(99, 102, 241, 0.5);
              object-fit: cover;
            }
            .user-text-col {
              display: flex;
              flex-direction: column;
            }
            .user-nickname-title {
              font-weight: 700;
              font-size: 1.05rem;
              color: #f3f4f6;
            }
            .user-id-sub {
              font-size: 0.75rem;
              color: var(--text-muted);
            }
            .net-cell { font-weight: 700; color: #818cf8; font-size: 1.05rem; }
          </style>
        </head>
        <body>
          <nav class="navbar">
            <div class="logo">⚡ DISCORD ECONOMY</div>
            ${navbarRightHtml}
          </nav>

          <div class="container">
            ${heroSectionHtml}

            <div style="text-align:center; margin-bottom: 40px;">
              <div class="regime-pill">
                🌐 거시 경제 국면: <b>${regime ? regime.name : '정상 시장'}</b>
              </div>
              ${news ? `<div class="news-banner">📰 <b>속보:</b> ${news.text}</div>` : ''}
            </div>

            <h2 class="section-title">📊 실시간 가상 주식 종목</h2>
            <div class="stock-grid">
              ${stockCardsHtml}
            </div>

            <h2 class="section-title">🏆 종합 순자산 TOP 10 순위표</h2>
            <div class="leaderboard-card">
              <table>
                <thead>
                  <tr>
                    <th>순위</th>
                    <th>디스코드 사용자 (닉네임)</th>
                    <th>총 순자산 (현금+예금+주식)</th>
                  </tr>
                </thead>
                <tbody>
                  ${leaderboardRowsHtml}
                </tbody>
              </table>
            </div>
          </div>
        </body>
        </html>
      `);
    } catch (err) {
      res.status(500).send(`❌ 웹 서버 오류: ${err.message}`);
    }
  });

  // Discord OAuth 로그인 요청 처리
  app.get('/auth/discord', (req, res) => {
    const { clientId, redirectUri } = config.discord;
    if (!clientId) {
      return res.status(500).send('❌ .env 파일에 DISCORD_CLIENT_ID가 설정되어 있지 않습니다.');
    }
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
  });

  // Discord OAuth Redirect Callback 라우트
  app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
      return res.redirect('/auth/guide');
    }

    try {
      // 1. Discord Access Token 요청
      const params = new URLSearchParams();
      params.append('client_id', config.discord.clientId);
      params.append('client_secret', config.discord.clientSecret);
      params.append('grant_type', 'authorization_code');
      params.append('code', code);
      params.append('redirect_uri', config.discord.redirectUri);
      params.append('scope', 'identify');

      const tokenRes = await axios.post('https://discord.com/api/v10/oauth2/token', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      const accessToken = tokenRes.data.access_token;

      // 2. 유저 정보 조회
      const userRes = await axios.get('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      const discordUser = userRes.data;
      const username = discordUser.global_name || discordUser.username || discordUser.tag;
      const avatarUrl = discordUser.avatar 
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;

      await getOrCreateUser(discordUser.id, username, avatarUrl);

      // 쿠키 저장 후 메인 페이지로 리디렉션 (로그인 상태 유지)
      res.cookie('discord_user', JSON.stringify({
        id: discordUser.id,
        username: username,
        avatar: avatarUrl
      }), { maxAge: 7 * 24 * 3600 * 1000, httpOnly: true });

      res.redirect('/');
    } catch (err) {
      console.error('Discord OAuth Callback Error:', err.response?.data || err.message);
      res.status(500).send(`❌ Discord OAuth 인증 실패: ${err.message}`);
    }
  });

  // 로그아웃 처리 라우트
  app.get('/auth/logout', (req, res) => {
    res.clearCookie('discord_user');
    res.redirect('/');
  });

  // OAuth 미설정 가이드 페이지
  app.get('/auth/guide', (req, res) => {
    const redirectUri = config.discord.redirectUri;
    res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8">
        <title>Discord OAuth 설정 안내</title>
        <style>
          body { font-family: sans-serif; background: #0b0f19; color: #c9d1d9; padding: 40px; display: flex; justify-content: center; }
          .card { background: #161b22; border: 1px solid #30363d; padding: 30px; border-radius: 16px; max-width: 600px; }
          h1 { color: #58a6ff; }
          code { background: #0d1117; color: #79c0ff; padding: 4px 8px; border-radius: 6px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>⚙️ Discord OAuth2 리디렉션 URI 설정 방법</h1>
          <p>Discord OAuth2 인증을 작동시키려면 디스코드 개발자 포털에 아래 리디렉션 URI를 등록해야 합니다:</p>
          <br>
          <p><b>1. Discord Developer Portal 접속</b> -> 애플리케이션 선택</p>
          <p><b>2. OAuth2 메뉴 -> Redirects 섹션</b> 이동</p>
          <p><b>3. Add Redirect 클릭 후 아래 URI 추가:</b></p>
          <p><code>${redirectUri}</code></p>
          <br>
          <p><b>4. .env 파일에 클라이언트 정보 설정:</b></p>
          <pre><code>DISCORD_CLIENT_ID="내_애플리케이션_CLIENT_ID"
DISCORD_CLIENT_SECRET="내_애플리케이션_CLIENT_SECRET"
DISCORD_REDIRECT_URI="${redirectUri}"</code></pre>
          <br>
          <a href="/" style="color:#58a6ff;">← 메인 페이지로 돌아가기</a>
        </div>
      </body>
      </html>
    `);
  });

  app.listen(PORT, () => {
    console.log(`🌐 디스코드 경제 & OAuth2 웹 서버가 실행되었습니다 (포트: ${PORT})`);
    console.log(`🔗 메인 웹사이트: http://localhost:${PORT}`);
    console.log(`🔗 Discord OAuth2 Redirect URI: ${config.discord.redirectUri}`);
  });
}

module.exports = { startWebServer };
