const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const config = require('../config/config');
const { pool, getOrCreateUser } = require('../config/database');
const { formatMoney, formatPercent, formatNumber } = require('../utils/formatters');
const { getCurrentMarketRegime, getLastNews, getRecentNewsFeed } = require('../utils/stockEngine');
const { logWebAccess, logAdminAction } = require('../utils/logger');
const { createSecurityMiddleware, getSecurityStats, banIp, unbanIp } = require('./security');
const { createChatRoutes } = require('./routes/chatRoutes');
const { createGameRoutes } = require('./routes/gameRoutes');
const { createEconomyRoutes } = require('./routes/economyRoutes');
const { createStockRoutes } = require('./routes/stockRoutes');
const { createAdminRoutes } = require('./routes/adminRoutes');

// 📁 문의 첨부 이미지 업로드 저장 디렉토리
const UPLOAD_DIR = path.join(__dirname, '../../uploads/inquiries');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 스파크라인 SVG 미니 차트 생성 헬퍼
function generateSparklineSvg(prices, isUp) {
  if (!prices || prices.length < 2) {
    return `<svg width="110" height="32" viewBox="0 0 110 32" class="sparkline-svg"><line x1="4" y1="16" x2="106" y2="16" stroke="${isUp ? '#10b981' : '#ef4444'}" stroke-width="2" stroke-dasharray="3,3"/></svg>`;
  }
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const width = 110;
  const height = 32;
  const padding = 3;

  const points = prices.map((p, i) => {
    const x = padding + (i / (prices.length - 1)) * (width - padding * 2);
    const y = height - padding - ((p - min) / range) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const strokeColor = isUp ? '#10b981' : '#ef4444';
  const fillColor = isUp ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)';

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

// 백엔드 게임 중복/스팸 실행 방지 락 (User In-flight Action Lock)
const activeGameUsers = new Set();

function startWebServer(client) {
  const app = express();
  const PORT = config.port || 8080;

  // 🚀 서버 성능 및 보안 최적화
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // 🎨 EJS 템플릿 엔진 설정
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');

  // 🛡️ 웹 보안 시스템 - 가장 먼저 적용 (악성 경로/IP 차단)
  app.use(createSecurityMiddleware(client));

  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));
  app.use(cookieParser());

  // ⚡ 정적 자원 캐싱 최적화 (7일 브라우저 캐시)
  app.use('/uploads', express.static(path.join(__dirname, '../../uploads'), { maxAge: '7d' }));
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

  // 🤖 모든 검색엔진/크롤러/스크래퍼 봇 접근 완전 차단 (robots.txt)
  app.get('/robots.txt', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send('User-agent: *\nDisallow: /\n');
  });

  function getDynamicBaseUrl(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'easy-scraping.com';
    return `${proto}://${host}`;
  }

  function getDynamicRedirectUri(req) {
    if (config.discord.redirectUri && !config.discord.redirectUri.includes('localhost')) {
      return config.discord.redirectUri;
    }
    return `${getDynamicBaseUrl(req)}/auth/discord/callback`;
  }

  function getSessionUser(req) {
    if (req.cookies && req.cookies.discord_user) {
      try {
        return JSON.parse(req.cookies.discord_user);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  // 모든 HTTP 요청 로깅 미들웨어
  app.use((req, res, next) => {
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
    const adminIds = config.adminIds && config.adminIds.length > 0 ? config.adminIds : ['0'];
    const [rows] = await pool.query(`
      SELECT 
        u.discord_id, 
        u.username,
        u.avatar,
        u.cash,
        u.bank,
        CAST(ROUND(u.cash + u.bank + COALESCE(SUM(us.amount * s.price), 0)) AS SIGNED) AS net
      FROM users u
      LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
      LEFT JOIN stocks s ON us.stock_id = s.stock_id
      WHERE u.discord_id NOT IN (?)
      GROUP BY u.discord_id, u.username, u.avatar, u.cash, u.bank
      ORDER BY net DESC
      LIMIT 10
    `, [adminIds]);
    leaderboardCache = { data: rows, timestamp: now };
    return rows;
  }

  // ========================================  // 1. 현재 로그인 유저 상세 정보 API
  app.get('/api/user/me', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const userData = await getOrCreateUser(session.id, session.username, session.avatar);

      const [userStocks] = await pool.query(`
        SELECT us.stock_id, us.amount, us.total_spent, s.name, s.price
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.user_id = ? AND us.amount > 0
      `, [session.id]);

      let stockVal = 0n;
      const formattedStocks = userStocks.map(us => {
        const amtNum = Number(us.amount);
        const curPrice = BigInt(us.price);
        const spent = BigInt(us.total_spent || 0);
        const evalVal = BigInt(Math.floor(amtNum * Number(curPrice)));
        stockVal += evalVal;
        return {
          stock_id: us.stock_id,
          name: us.name,
          amount: amtNum.toString(),
          price: curPrice.toString(),
          spent: spent.toString(),
          evalVal: evalVal.toString(),
          profit: (evalVal - spent).toString()
        };
      });

      const cash = BigInt(userData.cash || 0);
      const bank = BigInt(userData.bank || 0);
      const netWorth = cash + bank + stockVal;

      const now = new Date();
      const lastDaily = userData.last_daily ? new Date(userData.last_daily) : null;
      const canDaily = !lastDaily || (now.getTime() - lastDaily.getTime() >= 24 * 60 * 60 * 1000);
      const canSubsidy = netWorth < 50000n;

      res.json({
        success: true,
        user: {
          id: session.id,
          username: userData.username || session.username,
          avatar: userData.avatar || session.avatar,
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
          isAdmin: config.isAdmin(session.id)
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── 📦 분리된 모듈형 라우터 마운트 ────────────────────────
  app.use('/api/chat', createChatRoutes(getSessionUser, sseClients));
  app.use('/api/game', createGameRoutes(getSessionUser));
  app.use('/api', createEconomyRoutes(getSessionUser));
  app.use('/api', createStockRoutes(getSessionUser));
  app.use('/api/admin', createAdminRoutes(getSessionUser));
  app.post('/api/clicker/click', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    let { count } = req.body;
    const clicks = Math.min(Math.max(parseInt(count, 10) || 1, 1), 20);

    try {
      const userData = await getOrCreateUser(session.id);
      const level = userData.clicker_level || 1;
      const basePerClick = level * 10;
      
      let earnedCash = 0;
      let critCount = 0;

      for (let i = 0; i < clicks; i++) {
        const isCrit = Math.random() < 0.10;
        const clickReward = isCrit ? (basePerClick * 3) : basePerClick;
        if (isCrit) critCount++;
        earnedCash += clickReward;
      }

      const newCash = BigInt(userData.cash || 0) + BigInt(earnedCash);
      const totalClicks = BigInt(userData.total_clicks || 0) + BigInt(clicks);

      await pool.query(
        'UPDATE users SET cash = ?, total_clicks = ? WHERE discord_id = ?',
        [newCash.toString(), totalClicks.toString(), session.id]
      );

      res.json({
        success: true,
        earnedCash,
        critCount,
        newCash: newCash.toString(),
        totalClicks: totalClicks.toString()
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. 🔨 클리커 업그레이드 상점 API (경제 밸런스 조정)
  app.post('/api/clicker/upgrade', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { type } = req.body;
    try {
      const userData = await getOrCreateUser(session.id);
      let userCash = BigInt(userData.cash || 0);
      let clickerLevel = userData.clicker_level || 1;
      let autoLevel = userData.auto_miner_level || 0;

      if (type === 'power') {
        const cost = BigInt(clickerLevel * 4500);
        if (userCash < cost) return res.status(400).json({ success: false, error: `현금이 부족합니다! (필요: ${formatMoney(cost)})` });

        userCash -= cost;
        clickerLevel += 1;
        await pool.query('UPDATE users SET cash = ?, clicker_level = ? WHERE discord_id = ?', [userCash.toString(), clickerLevel, session.id]);
        return res.json({
          success: true,
          message: `🔨 클릭 파워 Lv.${clickerLevel} 강화 완료! (클릭당 +${formatMoney(clickerLevel * 10)})`,
          newCash: userCash.toString(),
          clickerLevel
        });
      } else if (type === 'auto') {
        const cost = BigInt((autoLevel + 1) * 12000);
        if (userCash < cost) return res.status(400).json({ success: false, error: `현금이 부족합니다! (필요: ${formatMoney(cost)})` });

        userCash -= cost;
        autoLevel += 1;
        await pool.query('UPDATE users SET cash = ?, auto_miner_level = ? WHERE discord_id = ?', [userCash.toString(), autoLevel, session.id]);
        return res.json({
          success: true,
          message: `🤖 자동 채굴 봇 Lv.${autoLevel} 가동! (초당 +${formatMoney(autoLevel * 15)})`,
          newCash: userCash.toString(),
          autoLevel
        });
      } else {
        return res.status(400).json({ success: false, error: '유효하지 않은 업그레이드입니다.' });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4. 🎰 웹 슬롯머신 게임 API (경제 밸런스 및 현실적 카지노 승률 적용)
  app.post('/api/game/slot', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    if (activeGameUsers.has(session.id)) {
      return res.status(429).json({ success: false, error: '⚠️ 슬롯머신이 이미 회전 중입니다. 결과가 나온 후 다시 시도해 주세요.' });
    }
    activeGameUsers.add(session.id);

    let { bet } = req.body;
    try {
      const userData = await getOrCreateUser(session.id);
      const userCash = BigInt(userData.cash || 0);

      let betAmount = 0n;
      if (bet === 'all' || bet === '올인' || bet === '전액') {
        betAmount = userCash;
      } else {
        betAmount = BigInt(parseInt(bet, 10) || 0);
      }

      if (betAmount < 1000n) {
        return res.status(400).json({ success: false, error: `최소 배팅금액은 1,000원입니다. (보유 현금: ${formatMoney(userCash)})` });
      }
      if (userCash < betAmount) {
        return res.status(400).json({ success: false, error: `보유 현금이 부족합니다! (필요: ${formatMoney(betAmount)}, 보유: ${formatMoney(userCash)})` });
      }

      const SYMBOLS = ['🍒', '🍋', '🍇', '🔔', '7️⃣', '💎'];
      const reel1 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      const reel2 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      const reel3 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];

      let multiplier = 0;
      let resultText = '';

      if (reel1 === '💎' && reel2 === '💎' && reel3 === '💎') {
        multiplier = 25; resultText = '🎉 초호화 다이아몬드 잭팟 (25배 당첨)!';
      } else if (reel1 === '7️⃣' && reel2 === '7️⃣' && reel3 === '7️⃣') {
        multiplier = 15; resultText = '🔥 럭키 세븐 잭팟 (15배 당첨)!';
      } else if (reel1 === '🔔' && reel2 === '🔔' && reel3 === '🔔') {
        multiplier = 8; resultText = '🔔 골든벨 3개 일치 (8배 당첨)!';
      } else if (reel1 === '🍇' && reel2 === '🍇' && reel3 === '🍇') {
        multiplier = 4; resultText = '🍇 포도 3개 일치 (4배 당첨)!';
      } else if (reel1 === '🍋' && reel2 === '🍋' && reel3 === '🍋') {
        multiplier = 2.5; resultText = '🍋 레몬 3개 일치 (2.5배 획득)!';
      } else if (reel1 === '🍒' && reel2 === '🍒' && reel3 === '🍒') {
        multiplier = 2; resultText = '🍒 체리 3개 일치 (2배 획득)!';
      } else if ([reel1, reel2, reel3].filter(r => r === '🍒').length >= 2) {
        multiplier = 1.2; resultText = '🍒 체리 2개 적중! (1.2배 본전 보존)!';
      } else {
        multiplier = 0; resultText = '😢 아쉽게도 빗나갔습니다. 다음 기회에!';
      }

      const isWin = multiplier > 0;
      const payout = BigInt(Math.floor(Number(betAmount) * multiplier));
      const profit = payout - betAmount;
      const balanceBefore = userCash;
      const balanceAfter = userCash + profit;

      await pool.query(
        'UPDATE users SET cash = ? WHERE discord_id = ?',
        [balanceAfter.toString(), session.id]
      );

      const [insertRes] = await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        session.id, 'WEB_SLOT', betAmount.toString(), payout.toString(), profit.toString(),
        balanceBefore.toString(), balanceAfter.toString(),
        JSON.stringify({ reels: [reel1, reel2, reel3], multiplier, isAllIn: (betAmount === userCash) })
      ]);

      res.json({
        success: true,
        logId: insertRes.insertId,
        reels: [reel1, reel2, reel3],
        isWin,
        multiplier,
        bet: betAmount.toString(),
        payout: payout.toString(),
        profit: profit.toString(),
        newCash: balanceAfter.toString(),
        balanceBefore: balanceBefore.toString(),
        message: resultText
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      activeGameUsers.delete(session.id);
    }
  });

  // 5. 🪙 웹 동전 던지기 게임 API
  app.post('/api/game/coinflip', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    if (activeGameUsers.has(session.id)) {
      return res.status(429).json({ success: false, error: '⚠️ 동전이 회전 중입니다. 잠시만 기다려 주세요.' });
    }
    activeGameUsers.add(session.id);

    let { bet, choice } = req.body;
    try {
      const userData = await getOrCreateUser(session.id);
      const userCash = BigInt(userData.cash || 0);

      let betAmount = 0n;
      if (bet === 'all' || bet === '올인' || bet === '전액') {
        betAmount = userCash;
      } else {
        betAmount = BigInt(parseInt(bet, 10) || 0);
      }

      if (betAmount < 1000n) return res.status(400).json({ success: false, error: '최소 배팅금액은 1,000원입니다.' });
      if (userCash < betAmount) return res.status(400).json({ success: false, error: '보유 현금이 부족합니다.' });

      const outcomes = ['앞면', '뒷면'];
      const result = outcomes[Math.floor(Math.random() * outcomes.length)];
      const isWin = (choice === result);

      const multiplier = isWin ? 1.95 : 0;
      const payout = isWin ? BigInt(Math.floor(Number(betAmount) * multiplier)) : 0n;
      const profit = payout - betAmount;
      const balanceBefore = userCash;
      const balanceAfter = userCash + profit;

      await pool.query(
        'UPDATE users SET cash = ? WHERE discord_id = ?',
        [balanceAfter.toString(), session.id]
      );

      const [insertRes] = await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        session.id, 'WEB_COINFLIP', betAmount.toString(), payout.toString(), profit.toString(),
        balanceBefore.toString(), balanceAfter.toString(),
        JSON.stringify({ userChoice: choice, coinResult: result, multiplier, isAllIn: (betAmount === userCash) })
      ]);

      res.json({
        success: true,
        logId: insertRes.insertId,
        coinResult: result,
        userChoice: choice,
        isWin,
        payout: payout.toString(),
        profit: profit.toString(),
        newCash: balanceAfter.toString(),
        balanceBefore: balanceBefore.toString(),
        message: isWin ? `🎉 적중! 동전 결과는 [${result}] 입니다 (+${formatMoney(profit)})` : `💀 실패! 동전 결과는 [${result}] 입니다 (-${formatMoney(betAmount)})`
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      activeGameUsers.delete(session.id);
    }
  });

  // 6. 🎲 웹 주사위 대결 API
  app.post('/api/game/dice', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    if (activeGameUsers.has(session.id)) {
      return res.status(429).json({ success: false, error: '⚠️ 주사위 대결이 이미 진행 중입니다.' });
    }
    activeGameUsers.add(session.id);

    let { bet } = req.body;
    try {
      const userData = await getOrCreateUser(session.id);
      const userCash = BigInt(userData.cash || 0);

      let betAmount = 0n;
      if (bet === 'all' || bet === '올인' || bet === '전액') {
        betAmount = userCash;
      } else {
        betAmount = BigInt(parseInt(bet, 10) || 0);
      }

      if (betAmount < 1000n) return res.status(400).json({ success: false, error: '최소 배팅금액은 1,000원입니다.' });
      if (userCash < betAmount) return res.status(400).json({ success: false, error: '보유 현금이 부족합니다.' });

      const userDice1 = Math.floor(Math.random() * 6) + 1;
      const userDice2 = Math.floor(Math.random() * 6) + 1;
      const userTotal = userDice1 + userDice2;

      const botDice1 = Math.floor(Math.random() * 6) + 1;
      const botDice2 = Math.floor(Math.random() * 6) + 1;
      const botTotal = botDice1 + botDice2;

      let multiplier = 0;
      let resultText = '';
      if (userTotal > botTotal) {
        multiplier = 1.95; resultText = `🎉 승리! 나(${userTotal}) vs 딜러(${botTotal}) (+${formatMoney(BigInt(Math.floor(Number(betAmount) * 0.95)))})`;
      } else if (userTotal === botTotal) {
        multiplier = 1.0; resultText = `🤝 무승부! 나(${userTotal}) vs 딜러(${botTotal}) (배팅금 전액 환불)`;
      } else {
        multiplier = 0; resultText = `💀 패배! 나(${userTotal}) vs 딜러(${botTotal}) (-${formatMoney(betAmount)})`;
      }

      const payout = BigInt(Math.floor(Number(betAmount) * multiplier));
      const profit = payout - betAmount;
      const balanceBefore = userCash;
      const balanceAfter = userCash + profit;

      await pool.query(
        'UPDATE users SET cash = ? WHERE discord_id = ?',
        [balanceAfter.toString(), session.id]
      );

      const [insertRes] = await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        session.id, 'WEB_DICE', betAmount.toString(), payout.toString(), profit.toString(),
        balanceBefore.toString(), balanceAfter.toString(),
        JSON.stringify({ userDice: [userDice1, userDice2, userTotal], botDice: [botDice1, botDice2, botTotal], isAllIn: (betAmount === userCash) })
      ]);

      res.json({
        success: true,
        logId: insertRes.insertId,
        userDice: [userDice1, userDice2, userTotal],
        botDice: [botDice1, botDice2, botTotal],
        isWin: userTotal > botTotal,
        isTie: userTotal === botTotal,
        payout: payout.toString(),
        profit: profit.toString(),
        newCash: balanceAfter.toString(),
        balanceBefore: balanceBefore.toString(),
        message: resultText
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      activeGameUsers.delete(session.id);
    }
  });

  // 6.5 🎫 럭키세븐 즉석 스크래치 복권 API (도박 로그 기록 & 롤백 지원)
  app.post('/api/game/lottery', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    if (activeGameUsers.has(session.id)) {
      return res.status(429).json({ success: false, error: '이전 복권 추첨이 아직 진행 중입니다. 잠시 후 다시 시도하세요.' });
    }
    activeGameUsers.add(session.id);

    try {
      const { bet = 1000 } = req.body;
      const userData = await getOrCreateUser(session.id);
      const userCash = BigInt(userData.cash || 0);

      let betAmount = 0n;
      if (bet === 'all' || bet === '올인') {
        betAmount = userCash;
      } else {
        betAmount = BigInt(parseInt(bet, 10) || 1000);
      }

      if (betAmount < 1000n) {
        return res.status(400).json({ success: false, error: '최소 복권 구매 금액은 1,000원입니다.' });
      }
      if (userCash < betAmount) {
        return res.status(400).json({ success: false, error: `보유 현금이 부족합니다! (필요: ${formatMoney(betAmount)}, 보유: ${formatMoney(userCash)})` });
      }

      // 복권 심볼 풀: 💎 다이아몬드(50x), 7️⃣ 럭키세븐(15x), 🔔 골든벨(8x), 🍇 포도(4x), 🍋 레몬(2.5x), 🍒 체리(1.5x), 💀 꽝
      const symbols = ['💎', '7️⃣', '🔔', '🍇', '🍋', '🍒', '💀'];
      const weights = [0.01, 0.03, 0.07, 0.14, 0.20, 0.25, 0.30];

      function pickRandomSymbol() {
        const r = Math.random();
        let acc = 0;
        for (let i = 0; i < symbols.length; i++) {
          acc += weights[i];
          if (r <= acc) return symbols[i];
        }
        return '💀';
      }

      const s1 = pickRandomSymbol();
      const s2 = pickRandomSymbol();
      const s3 = pickRandomSymbol();

      let multiplier = 0;
      let winDesc = '';

      if (s1 === '💎' && s2 === '💎' && s3 === '💎') {
        multiplier = 50.0; winDesc = '💎💎💎 초호화 다이아몬드 잭팟! 50배 대박!';
      } else if (s1 === '7️⃣' && s2 === '7️⃣' && s3 === '7️⃣') {
        multiplier = 15.0; winDesc = '7️⃣7️⃣7️⃣ 럭키세븐 잭팟! 15배 당첨!';
      } else if (s1 === '🔔' && s2 === '🔔' && s3 === '🔔') {
        multiplier = 8.0; winDesc = '🔔🔔🔔 골든벨 3개 일치! 8배 당첨!';
      } else if (s1 === '🍇' && s2 === '🍇' && s3 === '🍇') {
        multiplier = 4.0; winDesc = '🍇🍇🍇 달콤한 포도 3개! 4배 당첨!';
      } else if (s1 === '🍋' && s2 === '🍋' && s3 === '🍋') {
        multiplier = 2.5; winDesc = '🍋🍋🍋 상큼한 레몬 3개! 2.5배 당첨!';
      } else if ([s1, s2, s3].filter(s => s === '🍒').length >= 2) {
        multiplier = 1.5; winDesc = '🍒🍒 체리 2개 이상 일치! 1.5배 당첨!';
      } else {
        multiplier = 0; winDesc = '💀 아쉽게도 꽝입니다! 다음 복권에 도전하세요.';
      }

      const payout = BigInt(Math.floor(Number(betAmount) * multiplier));
      const profit = payout - betAmount;
      const balanceBefore = userCash;
      const balanceAfter = userCash + profit;

      await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [balanceAfter.toString(), session.id]);

      const [insertRes] = await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, 'WEB_LOTTERY', ?, ?, ?, ?, ?, ?)
      `, [
        session.id, betAmount.toString(), payout.toString(), profit.toString(),
        balanceBefore.toString(), balanceAfter.toString(),
        JSON.stringify({ symbols: [s1, s2, s3], multiplier, winDesc, isAllIn: (betAmount === userCash) })
      ]);

      res.json({
        success: true,
        logId: insertRes.insertId,
        symbols: [s1, s2, s3],
        multiplier,
        bet: betAmount.toString(),
        payout: payout.toString(),
        profit: profit.toString(),
        newCash: balanceAfter.toString(),
        balanceBefore: balanceBefore.toString(),
        isWin: multiplier > 0,
        message: winDesc
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      activeGameUsers.delete(session.id);
    }
  });

  // 6-2. 🏇 웹 실시간 경마 도박 API (/api/game/horse-race)
  app.post('/api/game/horse-race', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    if (activeGameUsers.has(session.id)) {
      return res.status(429).json({ success: false, error: '이전 레이스가 아직 진행 중입니다.' });
    }
    activeGameUsers.add(session.id);

    try {
      const { horseId, amount, isAll } = req.body;
      const parsedHorseId = parseInt(horseId, 10);
      if (![1, 2, 3, 4, 5].includes(parsedHorseId)) {
        return res.status(400).json({ success: false, error: '1번부터 5번 사이의 말을 선택하세요.' });
      }

      const HORSES_DATA = [
        { id: 1, name: '황금번개', emoji: '⚡', odds: 2.0, weight: 45 },
        { id: 2, name: '질풍노도', emoji: '🌪️', odds: 3.0, weight: 30 },
        { id: 3, name: '다크호스', emoji: '🖤', odds: 5.0, weight: 18 },
        { id: 4, name: '월덕스피릿', emoji: '🦆', odds: 8.0, weight: 10 },
        { id: 5, name: '로또잭팟', emoji: '💎', odds: 15.0, weight: 5 }
      ];

      const chosenHorse = HORSES_DATA.find(h => h.id === parsedHorseId);

      const userData = await getOrCreateUser(session.id);
      const userCash = BigInt(userData.cash || 0);

      let betAmount = 0n;
      if (isAll === true || amount === 'all' || amount === '올인') {
        betAmount = userCash;
      } else {
        const parsed = parseInt(String(amount).replace(/[^0-9]/g, ''), 10);
        if (isNaN(parsed) || parsed <= 0) {
          return res.status(400).json({ success: false, error: '배팅 금액은 1,000원 이상이어야 합니다.' });
        }
        betAmount = BigInt(parsed);
      }

      if (betAmount < 1000n) {
        return res.status(400).json({ success: false, error: '최소 배팅 금액은 1,000원입니다.' });
      }
      if (userCash < betAmount) {
        return res.status(400).json({ success: false, error: `보유 현금(${formatMoney(userCash)})이 부족합니다.` });
      }

      // 우승마 결정 (가중치 랜덤)
      const totalWeight = HORSES_DATA.reduce((a, b) => a + b.weight, 0);
      let rand = Math.random() * totalWeight;
      let winner = HORSES_DATA[0];
      for (const h of HORSES_DATA) {
        if (rand < h.weight) { winner = h; break; }
        rand -= h.weight;
      }

      // 자동 경제 조절 배율 적용
      let dynMult = 1.0;
      try {
        const { getDynamicSettings } = require('../utils/economyBalancer');
        const dyn = getDynamicSettings();
        if (dyn && dyn.gamblingPayoutMultiplier) dynMult = dyn.gamblingPayoutMultiplier;
      } catch (e) {}

      const isWin = (winner.id === chosenHorse.id);
      const finalOdds = chosenHorse.odds * dynMult;
      const payout = isWin ? BigInt(Math.round(Number(betAmount) * finalOdds)) : 0n;
      const profit = payout - betAmount;
      const balanceBefore = userCash;
      const balanceAfter = userCash + profit;

      await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [balanceAfter.toString(), session.id]);

      const [insertRes] = await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, 'WEB_HORSE_RACE', ?, ?, ?, ?, ?, ?)
      `, [
        session.id, betAmount.toString(), payout.toString(), profit.toString(),
        balanceBefore.toString(), balanceAfter.toString(),
        JSON.stringify({ chosenHorse: chosenHorse.name, winner: winner.name, odds: finalOdds, isWin })
      ]);

      res.json({
        success: true,
        logId: insertRes.insertId,
        chosenHorse,
        winner,
        odds: finalOdds,
        isWin,
        bet: betAmount.toString(),
        payout: payout.toString(),
        profit: profit.toString(),
        balanceBefore: balanceBefore.toString(),
        newCash: balanceAfter.toString(),
        horses: HORSES_DATA
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      activeGameUsers.delete(session.id);
    }
  });

  // 7. 🎁 일일 출석체크 API (경제 로그 기록)
  app.post('/api/economy/daily', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const userData = await getOrCreateUser(session.id);
      const now = new Date();
      const lastDaily = userData.last_daily ? new Date(userData.last_daily) : null;
      const cooldownMs = 24 * 60 * 60 * 1000;
      const streakResetMs = 48 * 60 * 60 * 1000;

      if (lastDaily && (now.getTime() - lastDaily.getTime() < cooldownMs)) {
        const remainHours = Math.ceil((cooldownMs - (now.getTime() - lastDaily.getTime())) / (1000 * 60 * 60));
        return res.status(400).json({ success: false, error: `이미 오늘 출석을 완료했습니다! (다음 출석까지 약 ${remainHours}시간 남음)` });
      }

      let streak = userData.daily_streak || 0;
      if (lastDaily && (now.getTime() - lastDaily.getTime() > streakResetMs)) streak = 0;
      streak += 1;

      const cappedStreak = Math.min(streak, 10);
      const streakBonus = (cappedStreak - 1) * (config.dailyStreakBonus || 500);
      const totalReward = (config.dailyReward || 3000) + streakBonus;

      const beforeCash = BigInt(userData.cash || 0);
      const newCash = beforeCash + BigInt(totalReward);

      await pool.query(
        'UPDATE users SET cash = ?, last_daily = NOW(), daily_streak = ? WHERE discord_id = ?',
        [newCash.toString(), streak, session.id]
      );

      // 경제 활동 로그 기록
      try {
        await pool.query(`
          INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
          VALUES (?, ?, 'DAILY_REWARD', ?, ?, ?, ?)
        `, [session.id, session.username, totalReward, beforeCash.toString(), newCash.toString(), `일일 출석체크 (+${streak}일 연속 보너스)`]);
      } catch (e) {}

      res.json({
        success: true,
        reward: totalReward,
        streak,
        newCash: newCash.toString(),
        message: `🎉 출석체크 성공! +${formatMoney(totalReward)} 지급 완료!`
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 8. 💸 정부 기본소득 지원금 API (돈이 없을 때는 쿨타임 없이 무제한 즉시 지급, 경제 밸런스 조정)
  app.post('/api/economy/subsidy', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const userData = await getOrCreateUser(session.id);
      const userCash = BigInt(userData.cash || 0);
      const userBank = BigInt(userData.bank || 0);
      const isBroke = (userCash + userBank <= 0n || userCash < 1000n);

      const now = new Date();
      const lastSubsidy = userData.last_subsidy ? new Date(userData.last_subsidy) : null;
      const cooldownMs = (config.subsidyCooldownMinutes || 10) * 60 * 1000; // 10분

      // 돈이 있을 때만 10분 쿨타임 및 상한선 체크 (돈이 없거나 파산 상태면 무제한 즉시 지급)
      if (!isBroke) {
        if (lastSubsidy) {
          const diffMs = now.getTime() - lastSubsidy.getTime();
          if (diffMs < cooldownMs) {
            const remainingSec = Math.ceil((cooldownMs - diffMs) / 1000);
            const remainMin = Math.floor(remainingSec / 60);
            const remainSec = remainingSec % 60;
            return res.status(400).json({
              success: false,
              error: `지원금 신청 쿨타임 대기 중입니다! (다음 신청까지 약 ${remainMin}분 ${remainSec}초 남음)\n💡 현금이 0원(무일푼)일 때는 쿨타임 없이 언제든 즉시 지원금을 받으실 수 있습니다.`
            });
          }
        }

        if (userCash + userBank >= 50000n) {
          return res.status(400).json({ success: false, error: '자산이 50,000원 미만일 때만 정기 기본소득을 신청할 수 있습니다.' });
        }
      }

      const subsidyAmount = isBroke ? 3000 : (config.subsidyAmount || 2000);
      const newCash = userCash + BigInt(subsidyAmount);

      await pool.query('UPDATE users SET cash = ?, last_subsidy = NOW() WHERE discord_id = ?', [newCash.toString(), session.id]);

      try {
        await pool.query(`
          INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
          VALUES (?, ?, 'SUBSIDY', ?, ?, ?, ?)
        `, [session.id, session.username, subsidyAmount, userCash.toString(), newCash.toString(), isBroke ? '무일푼 무제한 긴급 구제 지원금' : '정부 긴급 기본소득 구제 지원금']);
      } catch (e) {}

      const msg = isBroke
        ? `🚨 무일푼 긴급 구제 지원금 +${formatMoney(subsidyAmount)} 즉시 지급 완료! (돈이 없을 때 언제든 계속 받을 수 있습니다)`
        : `🏛️ 정부 긴급 기본소득 +${formatMoney(subsidyAmount)} 지급 완료! (10분 후 재신청 가능)`;

      res.json({
        success: true,
        subsidyAmount,
        newCash: newCash.toString(),
        message: msg
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 9. 🏦 은행 입금 / 출금 API (경제 로그 기록)
  app.post('/api/economy/bank', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { action, amount } = req.body;
    try {
      const userData = await getOrCreateUser(session.id);
      let cash = BigInt(userData.cash || 0);
      let bank = BigInt(userData.bank || 0);
      const beforeCash = cash;

      let amt = (amount === 'all' || amount === '전액') ? (action === 'deposit' ? cash : bank) : BigInt(parseInt(amount, 10) || 0);
      if (amt <= 0n) return res.status(400).json({ success: false, error: '올바른 금액을 입력하세요.' });

      if (action === 'deposit') {
        if (cash < amt) return res.status(400).json({ success: false, error: '보유 현금이 부족합니다.' });
        cash -= amt;
        bank += amt;
      } else if (action === 'withdraw') {
        if (bank < amt) return res.status(400).json({ success: false, error: '은행 예금이 부족합니다.' });
        bank -= amt;
        cash += amt;
      } else {
        return res.status(400).json({ success: false, error: '유효하지 않은 은행 동작입니다.' });
      }

      await pool.query('UPDATE users SET cash = ?, bank = ? WHERE discord_id = ?', [cash.toString(), bank.toString(), session.id]);

      try {
        await pool.query(`
          INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          session.id, session.username, action === 'deposit' ? 'BANK_DEPOSIT' : 'BANK_WITHDRAW',
          amt.toString(), beforeCash.toString(), cash.toString(),
          action === 'deposit' ? `은행에 ${formatMoney(amt)} 입금` : `은행에서 ${formatMoney(amt)} 출금`
        ]);
      } catch (e) {}

      res.json({
        success: true,
        cash: cash.toString(),
        bank: bank.toString(),
        message: action === 'deposit' ? `🏦 은행에 ${formatMoney(amt)} 입금 완료!` : `💵 은행에서 ${formatMoney(amt)} 출금 완료!`
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 10. 📈 실시간 주식 매수 / 매도 웹 트레이딩 API (체결 로그 stock_transactions 기록)
  app.post('/api/stock/trade', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { action, stockId, amount } = req.body;
    let count = 0;

    try {
      const [stockRows] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
      if (stockRows.length === 0) return res.status(404).json({ success: false, error: '존재하지 않는 종목입니다.' });

      const stock = stockRows[0];
      const stockPrice = BigInt(stock.price);
      const userData = await getOrCreateUser(session.id);
      let userCash = BigInt(userData.cash || 0);

      const isAll = (typeof amount === 'string' && ['all', 'max', '전량', '올인', '최대', '전체'].includes(amount.trim().toLowerCase())) || req.body.isAll === true;
      if (isAll) {
        if (action === 'sell') {
          const [holdingRows] = await pool.query('SELECT amount FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
          if (holdingRows.length === 0 || Number(holdingRows[0].amount) <= 0) {
            return res.status(400).json({ success: false, error: '매도할 수 있는 주식을 보유하고 있지 않습니다.' });
          }
          count = Number(holdingRows[0].amount);
        } else if (action === 'buy') {
          const maxCanBuy = stockPrice > 0n ? (Number(userCash) / Number(stockPrice)) : 0;
          if (maxCanBuy <= 0.0001) {
            return res.status(400).json({ success: false, error: '현재 보유 현금으로 매수할 수 없습니다.' });
          }
          count = Math.floor(maxCanBuy * 10000) / 10000;
        }
      } else {
        count = parseFloat(amount);
        // 만약 매수 시 가용 현금보다 미세하게 초과된 경우 가능한 최대치로 자동 보정
        if (action === 'buy') {
          const neededCash = BigInt(Math.floor(Number(stockPrice) * count));
          if (userCash < neededCash && userCash > 0n) {
            const adjustedMax = Math.floor((Number(userCash) / Number(stockPrice)) * 10000) / 10000;
            if (adjustedMax > 0.0001 && Math.abs(adjustedMax - count) <= 1.0) {
              count = adjustedMax;
            }
          }
        }
      }

      if (isNaN(count) || count < 0.0001) {
        return res.status(400).json({ success: false, error: '거래 수량은 최소 0.0001주 이상이어야 합니다.' });
      }

      // 소수점 4자리로 정밀 라운딩
      count = Math.round(count * 10000) / 10000;
      const countDecStr = count.toFixed(4);
      const totalTradePrice = BigInt(Math.floor(Number(stockPrice) * count));

      if (action === 'buy') {
        if (userCash < totalTradePrice) {
          return res.status(400).json({ success: false, error: `현금이 부족합니다! (필요: ${formatMoney(totalTradePrice)}, 보유: ${formatMoney(userCash)})` });
        }

        userCash -= totalTradePrice;
        await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [userCash.toString(), session.id]);

        await pool.query(`
          INSERT INTO user_stocks (user_id, stock_id, amount, total_spent)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            amount = amount + VALUES(amount),
            total_spent = total_spent + VALUES(total_spent)
        `, [session.id, stockId, countDecStr, totalTradePrice.toString()]);

        // 체결 로그 영구 기록
        try {
          await pool.query(`
            INSERT INTO stock_transactions (user_id, username, stock_id, stock_name, action, amount, price, total_price)
            VALUES (?, ?, ?, ?, 'BUY', ?, ?, ?)
          `, [session.id, session.username, stockId, stock.name, countDecStr, stockPrice.toString(), totalTradePrice.toString()]);
        } catch (e) {}

        const displayCount = (count % 1 === 0) ? count.toLocaleString() : count.toFixed(4);
        return res.json({
          success: true,
          action: 'buy',
          stockId,
          stockName: stock.name,
          amount: count,
          price: stockPrice.toString(),
          totalPrice: totalTradePrice.toString(),
          newCash: userCash.toString(),
          message: `🛒 [${stock.name}] ${displayCount}주 매수 완료 (-${formatMoney(totalTradePrice)})`
        });
      } else if (action === 'sell') {
        const [holdingRows] = await pool.query('SELECT * FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        const currentHoldingNum = holdingRows.length > 0 ? Number(holdingRows[0].amount) : 0;

        if (holdingRows.length === 0 || currentHoldingNum < (count - 0.00001)) {
          const displayHolding = (currentHoldingNum % 1 === 0) ? currentHoldingNum.toLocaleString() : currentHoldingNum.toFixed(4);
          return res.status(400).json({ success: false, error: `보유 주식이 부족합니다! (현재 보유: ${displayHolding}주)` });
        }

        const holding = holdingRows[0];
        const holdingSpent = BigInt(holding.total_spent || 0);
        const ratio = Math.min(1.0, count / (currentHoldingNum || 1));
        const spentDeduction = BigInt(Math.floor(Number(holdingSpent) * ratio));
        const newHoldingAmountNum = Math.max(0, Math.round((currentHoldingNum - count) * 10000) / 10000);
        const newHoldingSpent = holdingSpent > spentDeduction ? holdingSpent - spentDeduction : 0n;

        userCash += totalTradePrice;
        await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [userCash.toString(), session.id]);

        if (newHoldingAmountNum <= 0.00001) {
          await pool.query('DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        } else {
          await pool.query('UPDATE user_stocks SET amount = ?, total_spent = ? WHERE user_id = ? AND stock_id = ?', [
            newHoldingAmountNum.toFixed(4), newHoldingSpent.toString(), session.id, stockId
          ]);
        }

        // 체결 로그 영구 기록
        try {
          await pool.query(`
            INSERT INTO stock_transactions (user_id, username, stock_id, stock_name, action, amount, price, total_price)
            VALUES (?, ?, ?, ?, 'SELL', ?, ?, ?)
          `, [session.id, session.username, stockId, stock.name, countDecStr, stockPrice.toString(), totalTradePrice.toString()]);
        } catch (e) {}

        const displayCount = (count % 1 === 0) ? count.toLocaleString() : count.toFixed(4);
        return res.json({
          success: true,
          action: 'sell',
          stockId,
          stockName: stock.name,
          amount: count,
          price: stockPrice.toString(),
          totalPrice: totalTradePrice.toString(),
          newCash: userCash.toString(),
          message: `💰 [${stock.name}] ${displayCount}주 매도 완료 (+${formatMoney(totalTradePrice)})`
        });
      } else {
        return res.status(400).json({ success: false, error: '유효하지 않은 거래 유형입니다.' });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 10.5 📊 전체 실시간 주식 시세 목록 API (3분 주기 라이브 갱신용)
  app.get('/api/stocks', async (req, res) => {
    try {
      const [stocks] = await pool.query('SELECT * FROM stocks ORDER BY market_cap DESC');
      const formatted = stocks.map(s => {
        const price = Number(s.price);
        const prevPrice = Number(s.prev_price);
        const diff = price - prevPrice;
        const rate = prevPrice > 0 ? ((diff / prevPrice) * 100) : 0;
        return {
          stock_id: s.stock_id,
          name: s.name,
          price,
          prev_price: prevPrice,
          diff,
          rate: Number(rate.toFixed(2)),
          isUp: diff >= 0,
          sector: s.sector,
          market_cap: Number(s.market_cap || 0)
        };
      });
      res.json({ success: true, count: formatted.length, stocks: formatted });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 11. 🔍 종목 상세 분석 및 고해상도 차트 히스토리 API
  app.get('/api/stock/:stockId', async (req, res) => {
    const { stockId } = req.params;
    try {
      const [stockRows] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
      if (stockRows.length === 0) return res.status(404).json({ success: false, error: '종목을 찾을 수 없습니다.' });

      const stock = stockRows[0];
      const [historyRows] = await pool.query('SELECT price, recorded_at FROM stock_history WHERE stock_id = ? ORDER BY id DESC LIMIT 50', [stockId]);
      const history = historyRows.reverse().map(h => ({ price: Number(h.price), time: h.recorded_at }));

      let userHolding = 0;
      let userAvgPrice = 0;
      let userCash = '0';
      const session = getSessionUser(req);
      if (session) {
        const [userStock] = await pool.query('SELECT amount, total_spent FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        if (userStock.length > 0) {
          userHolding = parseInt(userStock[0].amount, 10) || 0;
          const totalSpent = BigInt(userStock[0].total_spent || 0);
          userAvgPrice = userHolding > 0 ? Number(totalSpent / BigInt(userHolding)) : 0;
        }
        const [userDataRows] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [session.id]);
        if (userDataRows.length > 0) {
          userCash = (userDataRows[0].cash || 0).toString();
        }
      }

      res.json({
        success: true,
        stock: {
          stock_id: stock.stock_id,
          name: stock.name,
          price: Number(stock.price),
          prev_price: Number(stock.prev_price),
          sector: stock.sector || 'IT/기술',
          description: stock.description || '혁신 기술 기업입니다.',
          high_24h: Number(stock.high_24h || stock.price),
          low_24h: Number(stock.low_24h || stock.price),
          volume_24h: Number(stock.volume_24h || 0),
          market_cap: Number(stock.market_cap || 0),
          pe_ratio: Number(stock.pe_ratio || 15),
          dividend_yield: Number(stock.dividend_yield || 0),
          volatility: Number(stock.volatility),
          userHolding,
          userAvgPrice,
          userCash
        },
        history
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 12. 📰 실시간 증시 뉴스 & 공시 피드 API
  app.get('/api/market/news', async (req, res) => {
    const { category, search, limit } = req.query;
    try {
      let query = 'SELECT * FROM market_news_feed';
      const params = [];
      const conditions = [];

      if (category && category !== 'ALL') {
        conditions.push('event_type = ?');
        params.push(category);
      }
      if (search) {
        conditions.push('(title LIKE ? OR content LIKE ? OR related_stock LIKE ? OR impact_sector LIKE ?)');
        const s = `%${search}%`;
        params.push(s, s, s, s);
      }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
      query += ' ORDER BY id DESC LIMIT ?';
      params.push(parseInt(limit, 10) || 30);

      const [rows] = await pool.query(query, params);
      res.json({ success: true, count: rows.length, news: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
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
          const profit = BigInt(g.profit);
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
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 13.5 🔄 실시간 유저 자산/경제 상태 요약 API (비동기 실시간 자동 동기화용)
  app.get('/api/user/summary', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.json({ success: false, loggedIn: false });

    try {
      const [userRows] = await pool.query('SELECT cash, bank, clicker_level, auto_miner_level, daily_streak FROM users WHERE discord_id = ?', [session.id]);
      if (userRows.length === 0) return res.json({ success: false, loggedIn: false });

      const u = userRows[0];
      const [stockRows] = await pool.query(`
        SELECT us.stock_id, us.amount, s.price
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.user_id = ?
      `, [session.id]);

      let totalStockVal = 0n;
      const holdings = {};
      stockRows.forEach(sr => {
        const amt = Number(sr.amount);
        const pr = BigInt(sr.price);
        totalStockVal += BigInt(Math.floor(Number(pr) * amt));
        holdings[sr.stock_id] = amt;
      });

      const cash = BigInt(u.cash || 0);
      const bank = BigInt(u.bank || 0);
      const netWorth = cash + bank + totalStockVal;

      return res.json({
        success: true,
        loggedIn: true,
        cash: cash.toString(),
        bank: bank.toString(),
        stockVal: totalStockVal.toString(),
        netWorth: netWorth.toString(),
        clickerLevel: u.clicker_level || 1,
        autoLevel: u.auto_miner_level || 0,
        streak: u.daily_streak || 0,
        holdings
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 14. 🔄 [관리자 전용] 도박 이력 롤백 API
  app.post('/api/admin/rollback/gambling/:logId', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자 권한이 필요합니다.' });
    }

    const { logId } = req.params;
    const connection = await pool.getConnection();
    try {
      const [logs] = await connection.query('SELECT * FROM gambling_logs WHERE id = ?', [logId]);
      if (logs.length === 0) return res.status(404).json({ success: false, error: '해당 도박 이력을 찾을 수 없습니다.' });

      const log = logs[0];
      if (log.is_rolled_back) {
        return res.status(400).json({ success: false, error: '이미 롤백/복구 처리된 도박 건입니다.' });
      }

      const targetUserId = log.user_id;
      const balanceBefore = BigInt(log.balance_before);

      await connection.beginTransaction();
      await connection.query('UPDATE users SET cash = ? WHERE discord_id = ?', [balanceBefore.toString(), targetUserId]);
      await connection.query('UPDATE gambling_logs SET is_rolled_back = 1, rolled_back_at = NOW() WHERE id = ?', [logId]);
      await connection.commit();

      await logAdminAction(session.id, session.username, 'WEB_ROLLBACK_GAMBLE', targetUserId, {
        logId,
        game: log.game,
        profit: log.profit,
        restoredBalance: balanceBefore.toString()
      });

      res.json({
        success: true,
        message: `✅ 도박 이력 #${logId} (${log.game}) 롤백 완료! 유저 잔고가 ${formatMoney(balanceBefore)}로 복구되었습니다.`,
        restoredBalance: balanceBefore.toString(),
        targetUserId
      });
    } catch (err) {
      await connection.rollback().catch(() => {});
      res.status(500).json({ success: false, error: err.message });
    } finally {
      connection.release();
    }
  });

  // API - 관리자 전용 JSON 로그들
  app.get('/api/admin/logs/gambling', async (req, res) => {
    const currentUser = getSessionUser(req);
    if (!currentUser || !config.isAdmin(currentUser.id)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    try {
      const [rows] = await pool.query(`SELECT g.*, u.username FROM gambling_logs g LEFT JOIN users u ON g.user_id = u.discord_id ORDER BY g.id DESC LIMIT 100`);
      res.json({ success: true, count: rows.length, logs: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/logs/access', async (req, res) => {
    const currentUser = getSessionUser(req);
    if (!currentUser || !config.isAdmin(currentUser.id)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    try {
      const [rows] = await pool.query('SELECT * FROM web_access_logs ORDER BY id DESC LIMIT 100');
      res.json({ success: true, count: rows.length, logs: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/admin/logs/commands', async (req, res) => {
    const currentUser = getSessionUser(req);
    if (!currentUser || !config.isAdmin(currentUser.id)) return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    try {
      const [rows] = await pool.query('SELECT * FROM command_logs ORDER BY id DESC LIMIT 100');
      res.json({ success: true, count: rows.length, logs: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 📩 유저 1:1 고객센터 문의 접수 API (관리자 Discord DM 실시간 알림 발송)
  app.post('/api/support/inquiry', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { category, title, content, image } = req.body;
    if (!title || title.trim().length < 2) {
      return res.status(400).json({ success: false, error: '문의 제목을 2글자 이상 입력해주세요.' });
    }
    if (!content || content.trim().length < 5) {
      return res.status(400).json({ success: false, error: '문의 내용을 5글자 이상 상세히 입력해주세요.' });
    }

    try {
      const userData = await getOrCreateUser(session.id, session.username, session.avatar);
      const userCash = BigInt(userData.cash || 0);
      const userBank = BigInt(userData.bank || 0);

      // 📷 첨부 이미지 처리 (Base64 파일 저장 또는 URL)
      let finalImageUrl = null;
      let localAttachmentPath = null;
      let localAttachmentFilename = null;

      if (image && typeof image === 'string') {
        const trimmedImg = image.trim();
        if (trimmedImg.startsWith('data:image/')) {
          try {
            const matches = trimmedImg.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
            if (matches) {
              const rawExt = matches[1].toLowerCase();
              const ext = (rawExt === 'jpeg' || rawExt === 'jpg') ? 'jpg' : (rawExt === 'png' ? 'png' : 'jpg');
              const base64Data = matches[2];
              const filename = `inquiry_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${ext}`;
              const filePath = path.join(UPLOAD_DIR, filename);
              fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
              finalImageUrl = `${getDynamicBaseUrl(req)}/uploads/inquiries/${filename}`;
              localAttachmentPath = filePath;
              localAttachmentFilename = filename;
            }
          } catch (imgErr) {
            console.error('Image Save Error:', imgErr);
          }
        } else if (trimmedImg.startsWith('http://') || trimmedImg.startsWith('https://')) {
          finalImageUrl = trimmedImg;
        }
      }

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
          stockVal += BigInt(Math.floor(Number(h.amount) * Number(h.price)));
        }
      } catch (e) {}

      const netWorth = userCash + userBank + stockVal;

      const [result] = await pool.query(`
        INSERT INTO inquiries (user_id, username, avatar, category, title, content, image_url, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING')
      `, [session.id, session.username, session.avatar, category || '일반 문의', title.trim(), content.trim(), finalImageUrl]);

      const ticketId = result.insertId;

      // 🔔 모든 봇 관리자에게 디스코드 DM으로 실시간 문의 알림 전송
      if (client && client.users) {
        for (const adminId of config.adminIds) {
          try {
            const adminUser = await client.users.fetch(adminId);
            if (adminUser) {
              const dmEmbed = new EmbedBuilder()
                .setTitle(`📩 [새 1:1 고객센터 문의 접수] Ticket #${ticketId}`)
                .setColor(0xf59e0b)
                .setThumbnail(session.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png')
                .setDescription(
                  `**작성 유저:** <@${session.id}> (\`${session.username}\` / ID: \`${session.id}\`)\n` +
                  `**문의 분류:** \`${category || '일반 문의'}\`\n` +
                  `**접수 일시:** <t:${Math.floor(Date.now() / 1000)}:F>`
                )
                .addFields(
                  { name: '📌 문의 제목', value: title.trim(), inline: false },
                  { name: '📝 상세 문의 내용', value: content.trim().length > 1000 ? content.trim().slice(0, 1000) + '...' : content.trim(), inline: false },
                  { 
                    name: '💳 유저 자산 현황', 
                    value: `💵 현금: **${formatMoney(userCash)}** | 🏦 예금: **${formatMoney(userBank)}** | 💎 순자산: **${formatMoney(netWorth)}**`, 
                    inline: false 
                  }
                );

              if (finalImageUrl) {
                dmEmbed.setImage(finalImageUrl);
                dmEmbed.addFields({ name: '🖼️ 첨부 이미지/스크린샷', value: `[클릭하여 첨부 사진 원본 보기](${finalImageUrl})`, inline: false });
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
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 📋 내 1:1 문의 내역 및 답변 조회 API
  app.get('/api/support/my-inquiries', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const [rows] = await pool.query(`
        SELECT id, category, title, content, status, answer, answered_by, answered_at, created_at
        FROM inquiries
        WHERE user_id = ?
        ORDER BY id DESC LIMIT 50
      `, [session.id]);

      res.json({ success: true, count: rows.length, inquiries: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 💬 [관리자] 1:1 문의 답변 등록 API (유저에게 Discord DM 알림 발송)
  app.post('/api/admin/inquiry/reply', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자 권한이 필요합니다.' });
    }

    const { ticketId, answer } = req.body;
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
      res.status(500).json({ success: false, error: err.message });
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
      res.json({ success: true, count: rows.length, inquiries: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
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
        stocks,
        gainers,
        marketSummary: { upCount, downCount, flatCount, avgRate: avgRate.toFixed(2), isMarketBull: avgRate >= 0 },
        regime,
        news
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

  // 💬 최근 채팅 메시지 목록 조회 API (최근 60건)
  app.get('/api/chat/messages', async (req, res) => {
    try {
      const [messages] = await pool.query(`
        SELECT id, user_id, username, avatar, message, is_admin, created_at
        FROM chat_messages
        ORDER BY id DESC
        LIMIT 60
      `);
      res.json({ success: true, messages: messages.reverse() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 💬 실시간 채팅 메시지 전송 API (XSS 방어 + 쿨다운 + 개인정보 보호)
  const chatCooldownMap = new Map();

  app.post('/api/chat/send', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const userId = session.id;
    const now = Date.now();
    const lastChatTime = chatCooldownMap.get(userId) || 0;

    // 도배 방지: 1.5초 쿨다운
    if (now - lastChatTime < 1500) {
      return res.status(429).json({ success: false, error: '메시지를 너무 빠르게 전송하고 있습니다. 잠시 후 다시 시도하세요.' });
    }

    let { message } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: '메시지를 입력하세요.' });
    }

    message = message.trim();
    if (message.length === 0) return res.status(400).json({ success: false, error: '메시지를 입력하세요.' });
    if (message.length > 200) return res.status(400).json({ success: false, error: '메시지는 최대 200자까지 입력 가능합니다.' });

    // 🛡️ XSS 방어: HTML 태그 이스케이프
    const sanitized = message
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

    chatCooldownMap.set(userId, now);
    const isAdmin = config.isAdmin(userId) ? 1 : 0;

    try {
      const [result] = await pool.query(`
        INSERT INTO chat_messages (user_id, username, avatar, message, is_admin)
        VALUES (?, ?, ?, ?, ?)
      `, [userId, session.username || '익명 유저', session.avatar || '', sanitized, isAdmin]);

      const chatObj = {
        id: result.insertId,
        user_id: userId,
        username: session.username || '익명 유저',
        avatar: session.avatar || '',
        message: sanitized,
        is_admin: isAdmin,
        created_at: new Date().toISOString()
      };

      // 모든 실시간 접속자에게 SSE 푸시
      if (typeof global.__broadcastChatMessage === 'function') {
        global.__broadcastChatMessage(chatObj);
      }

      res.json({ success: true, message: chatObj });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // 💬 관리자 불량 메시지 삭제 API
  app.delete('/api/chat/message/:id', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자 전용' });
    }
    const msgId = parseInt(req.params.id, 10);
    try {
      await pool.query('DELETE FROM chat_messages WHERE id = ?', [msgId]);
      res.json({ success: true, message: '메시지가 삭제되었습니다.' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/leaderboard', async (req, res) => {
    try {
      const rows = await getCachedLeaderboard();
      res.json({ leaderboard: rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 메인 웹사이트 대시보드 및 게임 허브
  app.get('/', async (req, res) => {
    try {
      const stocks = await getCachedMarketStocks();
      const leaderboardRows = await getCachedLeaderboard();
      const regime = getCurrentMarketRegime();
      const news = getLastNews();
      const recentNewsList = await getRecentNewsFeed(15);

      const redirectUri = getDynamicRedirectUri(req);
      const clientId = config.discord.clientId;
      const hasOauthConfig = Boolean(clientId);

      const discordLoginUrl = hasOauthConfig
        ? `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`
        : `/auth/guide`;

      let currentUser = null;
      let userAssets = null;
      let isAdminUser = false;
      let userTurnsInfo = { turns: 50, maxTurns: 50 };
      let portfolioSectionHtml = '';
      let userHoldingsMap = {};

      if (req.cookies && req.cookies.discord_user) {
        try {
          currentUser = JSON.parse(req.cookies.discord_user);
          isAdminUser = config.isAdmin(currentUser.id);
          const userData = await getOrCreateUser(currentUser.id, currentUser.username, currentUser.avatar);

          const [stocksRows] = await pool.query(`
            SELECT us.amount, s.price
            FROM user_stocks us
            JOIN stocks s ON us.stock_id = s.stock_id
            WHERE us.user_id = ? AND us.amount > 0
          `, [currentUser.id]);

          let stockVal = 0n;
          for (const item of stocksRows) {
            stockVal += BigInt(Math.floor(Number(item.amount) * Number(item.price)));
          }

          const cash = BigInt(userData.cash || 0);
          const bank = BigInt(userData.bank || 0);
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

          // 📊 내 보유 주식 포트폴리오 상세 분석
          const [portfolioRows] = await pool.query(`
            SELECT us.stock_id, us.amount, us.total_spent, s.name, s.price, s.prev_price, s.sector
            FROM user_stocks us
            JOIN stocks s ON us.stock_id = s.stock_id
            WHERE us.user_id = ? AND us.amount > 0
            ORDER BY (us.amount * s.price) DESC
          `, [currentUser.id]);

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
            const val = BigInt(Math.floor(amountNum * Number(currentPrice)));
            const avg = amountNum > 0 ? BigInt(Math.round(Number(spent) / amountNum)) : 0n;
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
                    <h4 class="stock-name" onclick="openDetailModal('${item.stock_id}')" style="cursor: pointer; font-size: 1.05rem; margin-top: 2px;">${item.name}</h4>
                  </div>
                  <span class="badge ${isProfit ? 'badge-up' : 'badge-down'}">${isProfit ? '▲ +' : '▼ '}${profitRate}%</span>
                </div>
                <div class="portfolio-grid-stats">
                  <div class="port-stat"><span>보유 수량</span><b>${displayHolding}주</b></div>
                  <div class="port-stat"><span>매수 평단가</span><b>${formatMoney(avg)}</b></div>
                  <div class="port-stat"><span>현재 평가액</span><b style="color: #38bdf8;">${formatMoney(val)}</b></div>
                  <div class="port-stat"><span>평가 손익</span><b class="${isProfit ? 'text-up' : 'text-down'}">${isProfit ? '+' : ''}${formatMoney(profit)}</b></div>
                </div>
                <div class="stock-trade-actions" style="margin-top: 10px;">
                  <button class="btn-trade btn-detail" onclick="openDetailModal('${item.stock_id}')">🔍 분석</button>
                  <button class="btn-trade btn-buy" onclick="openTradeModal('${item.stock_id}', '${item.name}', ${item.price}, 'buy', ${userHolding})">🛒 추가 매수</button>
                  <button class="btn-trade btn-sell" onclick="openTradeModal('${item.stock_id}', '${item.name}', ${item.price}, 'sell', ${userHolding})">💰 전량 매도</button>
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
                  📊 내 보유 주식 포트폴리오 (실시간 손익 현황)
                </div>
                <div class="portfolio-summary-pill">
                  <span>총 투자금: <b>${formatMoney(totalPortfolioInvested)}</b></span>
                  <span>총 평가액: <b style="color:#38bdf8;">${formatMoney(totalPortfolioCurrent)}</b></span>
                  <span class="${isTotalProfit ? 'text-up' : 'text-down'}">총 손익: <b>${isTotalProfit ? '+' : ''}${formatMoney(totalProfit)} (${isTotalProfit ? '+' : ''}${totalProfitRate}%)</b></span>
                </div>
              </div>
              <div class="portfolio-cards-grid">
                ${portfolioItemsHtml}
              </div>
            </div>
          ` : `
            <div class="portfolio-panel" style="text-align: center; padding: 24px;">
              <p style="color: #9ca3af; font-size: 0.95rem; margin-bottom: 6px;">현재 보유 중인 주식이 없습니다.</p>
              <p style="color: #64748b; font-size: 0.82rem;">아래 종목 시세 카드에서 <b>[🛒 매수]</b> 버튼을 눌러 첫 주식에 투자해보세요!</p>
            </div>
          `;
        } catch (e) {
          currentUser = null;
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
        const medal = idx === 0 ? '🔥 1위' : idx === 1 ? '⚡ 2위' : '✨ 3위';
        const isUp = g.rate >= 0;
        const colorClass = isUp ? 'text-up' : 'text-down';
        const sign = isUp ? '+' : '';
        topGainersHtml += `
          <div class="gainer-card" onclick="openDetailModal('${g.stock_id}')" style="cursor: pointer;">
            <div class="gainer-rank">${medal}</div>
            <div class="gainer-info">
              <span class="gainer-name">${g.name}</span>
              <span class="gainer-symbol">[${g.stock_id}] · ${g.sector || '성장주'}</span>
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

        const tradeButtons = currentUser
          ? `
            <div class="stock-trade-actions">
              <button class="btn-trade btn-detail" onclick="openDetailModal('${s.stock_id}')">🔍 상세/차트</button>
              <button class="btn-trade btn-buy" onclick="openTradeModal('${s.stock_id}', '${s.name}', ${s.price}, 'buy', ${userHolding})">🛒 매수</button>
              <button class="btn-trade btn-sell" onclick="openTradeModal('${s.stock_id}', '${s.name}', ${s.price}, 'sell', ${userHolding})">💰 매도</button>
            </div>
          `
          : `
            <div class="stock-trade-actions">
              <button class="btn-trade btn-detail" onclick="openDetailModal('${s.stock_id}')">🔍 상세/차트</button>
              <a href="${discordLoginUrl}" class="btn-trade-login">로그인 후 거래</a>
            </div>
          `;

        const holdingStackStr = userHolding > 0 ? (userHolding / 10).toFixed(1) + '스택' : '0스택';

        stockCardsHtml += `
          <div class="stock-card" id="stock-${s.stock_id}">
            <div class="stock-header">
              <div>
                <span class="stock-symbol">[${s.stock_id}] · ${s.sector || 'IT/기술'}</span>
                <h3 class="stock-name" onclick="openDetailModal('${s.stock_id}')" style="cursor: pointer;">${s.name} ↗</h3>
              </div>
              <span class="badge ${pillClass}">${arrow} ${sign}${Math.abs(rate).toFixed(2)}%</span>
            </div>
            
            <div class="stock-mid-row" onclick="openDetailModal('${s.stock_id}')" style="cursor: pointer;">
              <div class="stock-price" id="price-${s.stock_id}">${formatMoney(price)}</div>
              <div class="sparkline-box">${sparklineSvg}</div>
            </div>

            <!-- 📊 주식 재무 스펙 & 보유 스택 바 -->
            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 8px; padding: 6px 10px; margin: 8px 0; font-size: 0.76rem; display: flex; justify-content: space-between; align-items: center;">
              <span style="color: #9ca3af;">PER <b>${s.pe_ratio || 15.0}x</b> · 배당 <b>${s.dividend_yield || 3.5}%</b></span>
              <span style="color: #38bdf8; font-weight: 700;">보유: ${userHolding.toLocaleString()}주 <small style="color:#a5b4fc;">(${holdingStackStr})</small></span>
            </div>

            <div class="stock-footer">
              <span>이전가: ${formatMoney(prevPrice)}</span>
              <span class="trend-text ${isUp ? 'text-up' : 'text-down'}">${isUp ? '📈 상승세' : '📉 하락세'}</span>
            </div>

            ${tradeButtons}
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
          ? `<button class="btn-news-stock" onclick="openDetailModal('${n.related_stock}')">📈 [${n.related_stock}] 차트보기</button>`
          : `<span class="news-market-badge">🌐 전 종목 영향</span>`;

        return `
          <div class="news-item" data-category="${n.event_type || 'ALL'}" data-stock="${n.related_stock || 'ALL'}">
            <div class="news-meta">
              <div style="display: flex; gap: 6px; align-items: center;">
                <span class="news-tag">${n.event_type || '증시공시'}</span>
                ${sentimentTag}
              </div>
              <span class="news-time">⏱️ ${timeStr}</span>
            </div>
            <div class="news-headline">${n.title}</div>
            <div class="news-desc">${n.content}</div>
            <div class="news-footer-row">
              <span class="news-sector-pill">🏢 ${n.impact_sector || '시장 전반'}</span>
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
        const avatarSrc = row.avatar || (client && client.users?.cache.get(row.discord_id)?.displayAvatarURL()) || 'https://cdn.discordapp.com/embed/avatars/0.png';

        leaderboardRowsHtml += `
          <tr>
            <td class="rank-cell">${emoji} ${i + 1}위</td>
            <td>
              <div class="user-info-box">
                <img src="${avatarSrc}" class="rank-avatar" alt="Avatar" onError="this.src='https://cdn.discordapp.com/embed/avatars/0.png';">
                <div class="user-text-col">
                  <span class="user-nickname-title">${displayName} ${adminBadge}</span>
                  <span class="user-id-sub">ID: ${row.discord_id}</span>
                </div>
              </div>
            </td>
            <td class="net-cell">${formatMoney(net)}</td>
          </tr>
        `;
      }

      const adminNavButton = isAdminUser ? `<a href="/admin" class="btn-admin-nav" onclick="event.stopPropagation()">👑 관리자 패널</a>` : '';
      const navbarRightHtml = currentUser
        ? `
          <div class="nav-profile-group clickable" onclick="openProfileModal()" title="👤 내 프로필 & 📩 1:1 고객센터 문의">
            ${adminNavButton}
            <img src="${currentUser.avatar}" class="nav-avatar-img" alt="Avatar" onError="this.src='https://cdn.discordapp.com/embed/avatars/0.png';">
            <span class="nav-username-text">@${currentUser.username} ${isAdminUser ? '<span class="admin-tag">👑</span>' : ''}</span>
            <span class="btn-profile-badge">👤 프로필 / 📩 문의</span>
            <a href="/auth/logout" class="btn-logout" onclick="event.stopPropagation()">🚪 로그아웃</a>
          </div>
        `
        : `<a href="${discordLoginUrl}" class="btn-discord">🎮 Discord OAuth 로그인</a>`;

      const totalAssetNum = userAssets ? (Number(userAssets.netWorth) || 1) : 1;
      const cashPct = userAssets ? Math.min(100, Math.max(0, Math.round((Number(userAssets.cash) / totalAssetNum) * 100))) : 0;
      const bankPct = userAssets ? Math.min(100 - cashPct, Math.max(0, Math.round((Number(userAssets.bank) / totalAssetNum) * 100))) : 0;
      const stockPct = userAssets ? Math.max(0, 100 - cashPct - bankPct) : 0;

      const heroSectionHtml = currentUser && userAssets
        ? `
          <div class="hero logged-in-hero">
            <div class="status-badge logged-in-badge">🟢 Discord 인증 완료 (@${currentUser.username}) ${isAdminUser ? '👑 관리자' : ''}</div>
            <h1>👋 환영합니다, @${currentUser.username}님!</h1>
            <p>실시간 <b>상세 주식 차트, 커뮤니티 기업 생태계, 골드 채굴 클리커, 웹 카지노, 증시 속보</b>를 웹에서 직접 이용하세요.</p>
            
            <div class="personal-asset-grid">
              <div class="asset-card">
                <span class="asset-lbl">💵 보유 현금</span>
                <span class="asset-val" id="my-cash">${formatMoney(userAssets.cash)}</span>
              </div>
              <div class="asset-card">
                <span class="asset-lbl">🏦 은행 예금 <small style="color: #a5b4fc; font-size: 0.72rem; font-weight: 700;">(복리 0.5%/시간)</small></span>
                <span class="asset-val" id="my-bank">${formatMoney(userAssets.bank)}</span>
              </div>
              <div class="asset-card">
                <span class="asset-lbl">📈 보유 주식 평가액</span>
                <span class="asset-val" id="my-stock-val" style="color: #38bdf8;">${formatMoney(userAssets.stockVal)}</span>
              </div>
              <div class="asset-card highlight">
                <span class="asset-lbl">💎 총 순자산</span>
                <span class="asset-val" id="my-net-worth">${formatMoney(userAssets.netWorth)}</span>
              </div>
            </div>

            <!-- 📊 포트폴리오 자산 배분 비중 바 -->
            <div class="asset-ratio-container">
              <div class="asset-ratio-header">
                <span>📊 내 포트폴리오 자산 배분 비중</span>
                <span>💵 현금 <b style="color:#34d399;">${cashPct}%</b> | 🏦 예금 <b style="color:#818cf8;">${bankPct}%</b> | 📈 주식 <b style="color:#38bdf8;">${stockPct}%</b></span>
              </div>
              <div class="asset-ratio-bar">
                <div class="ratio-segment ratio-cash" style="width: ${cashPct}%;" title="현금 ${cashPct}%"></div>
                <div class="ratio-segment ratio-bank" style="width: ${bankPct}%;" title="예금 ${bankPct}%"></div>
                <div class="ratio-segment ratio-stock" style="width: ${stockPct}%;" title="주식 ${stockPct}%"></div>
              </div>
            </div>
            
            <div class="hero-quick-actions">
              <button class="btn-quick" onclick="claimDailyReward()">🎁 출석체크 (+보너스)</button>
              <button class="btn-quick" onclick="claimSubsidyReward()">🏛️ 기본소득 지원금</button>
              <button class="btn-quick" onclick="openBankModal()">🏦 은행 입출금</button>
              <button class="btn-quick" style="background: rgba(99, 102, 241, 0.3); border-color: #818cf8;" onclick="switchTab('tab-clicker')">⛏️ 클리커 채굴</button>
              ${isAdminUser ? '<button class="btn-quick" style="background: rgba(245, 158, 11, 0.2); border-color: #fbbf24; color: #fbbf24;" onclick="switchTab(\'tab-feed\')">⚡ 실시간 모든 로그 (관리자)</button>' : ''}
            </div>
          </div>
        `
        : `
          <div class="hero">
            <div class="status-badge logged-out-badge">🔴 미인증 상태 (로그인 필요)</div>
            <h1>실시간 디스코드 주식 차트 & 클리커 & 카지노</h1>
            <p>디스코드 계정으로 로그인하면 웹에서 실시간으로 <b>종목별 상세 차트 분석, 골드 채굴 클리커, 웹 카지노, 증시 공시 속보</b>를 바로 이용할 수 있습니다.</p>
            <a href="${discordLoginUrl}" class="btn-discord btn-hero">
              ⚡ Discord 계정으로 로그인하고 시작하기
            </a>
          </div>
        `;

      const breakingNewsTicker = news 
        ? `📢 [실시간 속보] ${news.title || news.text}` 
        : `📢 [실시간 속보] 시장 호조세 속에 활발한 거래가 이어지고 있습니다.`;

      const currentClickerLevel = userAssets ? userAssets.clickerLevel : 1;
      const currentAutoLevel = userAssets ? userAssets.autoLevel : 0;
      const powerCost = currentClickerLevel * 4500;
      const autoCost = (currentAutoLevel + 1) * 12000;
      const powerVal = currentClickerLevel * 10;
      const autoVal = currentAutoLevel * 15;
      const userHoldingsJson = JSON.stringify(userHoldingsMap || {});

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
          </div>
        </div>
      ` : '';

      const profileHeaderHtml = currentUser && userAssets
        ? `
          <div class="profile-user-header">
            <img src="${currentUser.avatar}" class="profile-avatar-big" alt="Avatar" onError="this.src='https://cdn.discordapp.com/embed/avatars/0.png';">
            <div>
              <h3 style="font-size: 1.25rem; font-weight: 800; color: #fff;">@${currentUser.username} ${isAdminUser ? '<span class="admin-tag" style="font-size:0.85rem; vertical-align:middle;">👑 관리자</span>' : ''}</h3>
              <p style="color: #9ca3af; font-size: 0.8rem; margin-top: 2px;">Discord ID: <code>${currentUser.id}</code></p>
            </div>
          </div>
        `
        : '';

      const profileStatsHtml = currentUser && userAssets
        ? `
          <div class="profile-stats-grid">
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">💵 보유 현금</span>
              <span class="profile-stat-val" style="color: #34d399;">${formatMoney(userAssets.cash)}</span>
            </div>
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">🏦 은행 예금</span>
              <span class="profile-stat-val" style="color: #818cf8;">${formatMoney(userAssets.bank)}</span>
            </div>
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">📈 보유 주식 평가액</span>
              <span class="profile-stat-val" style="color: #60a5fa;">${formatMoney(userAssets.stockVal)}</span>
            </div>
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">💎 총 순자산</span>
              <span class="profile-stat-val" style="color: #fbbf24;">${formatMoney(userAssets.netWorth)}</span>
            </div>
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">🔥 출석 연속 기록</span>
              <span class="profile-stat-val" style="color: #f43f5e;">${userAssets.streak || 0}일 연속</span>
            </div>
            <div class="profile-stat-box">
              <span class="profile-stat-lbl">⛏️ 채굴기 / 자동봇 레벨</span>
              <span class="profile-stat-val" style="color: #a855f7;">Lv.${currentClickerLevel} / Lv.${currentAutoLevel}</span>
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

      const chatInputHtml = currentUser
        ? `
          <form id="chat-send-form" onsubmit="handleSendChat(event)" style="display: flex; gap: 10px; align-items: center;">
            <input type="text" id="chat-input" placeholder="메시지를 입력하세요 (최대 200자)..." maxlength="200" autocomplete="off" style="flex: 1; background: #1e293b; border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 12px 16px; border-radius: 12px; font-size: 0.95rem; outline: none; transition: border-color 0.2s;">
            <button type="submit" id="chat-submit-btn" style="background: linear-gradient(135deg, #0284c7, #38bdf8); border: none; color: #fff; font-weight: 700; padding: 12px 20px; border-radius: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 0.95rem;">
              <span>전송</span> <span>➤</span>
            </button>
          </form>
        `
        : `
          <div style="background: rgba(30, 41, 59, 0.7); border: 1px dashed rgba(255,255,255,0.15); border-radius: 12px; padding: 16px; text-align: center;">
            <p style="font-size: 0.9rem; color: #94a3b8; margin-bottom: 10px;">채팅에 참여하려면 Discord 로그인이 필요합니다.</p>
            <a href="${discordLoginUrl}" class="btn-discord" style="display: inline-block; padding: 8px 18px; font-size: 0.9rem;">🎮 Discord 로그인 후 채팅하기</a>
          </div>
        `;

      const floatingChatInputHtml = currentUser
        ? `
          <form id="floating-chat-send-form" onsubmit="handleSendFloatingChat(event)" style="display: flex; gap: 8px; align-items: center;">
            <input type="text" id="floating-chat-input" placeholder="실시간 메시지 입력..." maxlength="200" autocomplete="off" style="flex: 1; background: #0f172a; border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 0.88rem; outline: none;">
            <button type="submit" id="floating-chat-submit-btn" style="background: linear-gradient(135deg, #0284c7, #38bdf8); border: none; color: #fff; font-weight: 700; padding: 10px 14px; border-radius: 10px; cursor: pointer; white-space: nowrap; font-size: 0.88rem;">
              전송
            </button>
          </form>
        `
        : `
          <div style="text-align: center; padding: 6px;">
            <a href="${discordLoginUrl}" class="btn-discord" style="display: block; padding: 8px 12px; font-size: 0.82rem;">🎮 Discord 로그인 후 채팅</a>
          </div>
        `;

      res.send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover">
          <meta name="theme-color" content="#0b0f19">
          <meta name="mobile-web-app-capable" content="yes">
          <meta name="apple-mobile-web-app-capable" content="yes">
          <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
          <title>💎 월덕 주식 차트 & 클리커 카지노</title>
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
            /* 🚫 웹사이트 복사 및 텍스트 드래그 방지 */
            body, div, p, span, h1, h2, h3, h4, h5, h6, table, tr, td, th, a, button, section, header, footer {
              -webkit-user-select: none !important;
              -moz-user-select: none !important;
              -ms-user-select: none !important;
              user-select: none !important;
              -webkit-touch-callout: none !important;
            }
            input, textarea {
              -webkit-user-select: text !important;
              -moz-user-select: text !important;
              -ms-user-select: text !important;
              user-select: text !important;
            }

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

            /* 🌌 다크 테마 커스텀 스크롤바 (OS 기본 흰색 스크롤바 제거) */
            ::-webkit-scrollbar {
              width: 6px;
              height: 6px;
            }
            ::-webkit-scrollbar-track {
              background: rgba(11, 15, 25, 0.6);
            }
            ::-webkit-scrollbar-thumb {
              background: rgba(99, 102, 241, 0.35);
              border-radius: 6px;
            }
            ::-webkit-scrollbar-thumb:hover {
              background: rgba(99, 102, 241, 0.7);
            }

            /* 토스트 알림 컨테이너 */
            #toast-container {
              position: fixed;
              top: 24px;
              right: 24px;
              z-index: 9999;
              display: flex;
              flex-direction: column;
              gap: 10px;
              pointer-events: none;
            }
            .toast {
              pointer-events: auto;
              min-width: 280px;
              max-width: 380px;
              background: rgba(17, 24, 39, 0.95);
              border: 1px solid rgba(255, 255, 255, 0.15);
              backdrop-filter: blur(12px);
              padding: 14px 18px;
              border-radius: 14px;
              box-shadow: 0 10px 30px rgba(0,0,0,0.6);
              display: flex;
              align-items: center;
              gap: 12px;
              animation: toastSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
              transition: all 0.3s;
            }
            .toast.toast-hide { opacity: 0; transform: translateX(50px); }
            @keyframes toastSlideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
            .toast-icon { font-size: 1.4rem; }
            .toast-title { font-weight: 700; font-size: 0.9rem; color: #fff; margin-bottom: 2px; }
            .toast-msg { font-size: 0.82rem; color: #cbd5e1; }

            /* 실시간 전광판 롤링 티커 */
            .news-ticker-bar {
              background: linear-gradient(90deg, #1e1b4b, #31104b);
              border-bottom: 1px solid rgba(99, 102, 241, 0.3);
              padding: 8px 24px;
              font-size: 0.85rem;
              font-weight: 600;
              color: #fef08a;
              display: flex;
              align-items: center;
              gap: 12px;
              overflow: hidden;
              white-space: nowrap;
            }
            .news-ticker-bar:hover .ticker-content { animation-play-state: paused; }
            .ticker-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 8px #ef4444; animation: pulse 1s infinite; flex-shrink: 0; }
            .ticker-content { display: inline-block; animation: marquee 25s linear infinite; }
            @keyframes marquee { 0% { transform: translateX(50%); } 100% { transform: translateX(-100%); } }

            .navbar {
              display: flex;
              justify-content: space-between;
              align-items: center;
              padding: 16px 36px;
              background: rgba(11, 15, 25, 0.85);
              backdrop-filter: blur(12px);
              border-bottom: 1px solid var(--card-border);
              position: sticky;
              top: 0;
              z-index: 100;
            }
            .logo {
              font-family: 'Outfit', sans-serif;
              font-size: 1.4rem;
              font-weight: 800;
              background: linear-gradient(135deg, #818cf8 0%, #c084fc 100%);
              -webkit-background-clip: text;
              -webkit-text-fill-color: transparent;
              display: flex;
              align-items: center;
              gap: 10px;
              text-decoration: none;
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
            .turn-badge-nav {
              background: rgba(245, 158, 11, 0.2);
              border: 1px solid rgba(245, 158, 11, 0.4);
              color: #fbbf24;
              font-weight: 800;
              font-size: 0.82rem;
              padding: 3px 10px;
              border-radius: 12px;
              font-family: 'Outfit', sans-serif;
            }
            .nav-avatar-img { width: 34px; height: 34px; border-radius: 50%; border: 2px solid var(--primary); }
            .nav-username-text { font-weight: 700; color: #e0e7ff; font-size: 0.95rem; }
            .admin-tag { color: #fbbf24; font-size: 0.9rem; }
            .btn-admin-nav {
              background: linear-gradient(135deg, #f59e0b, #d97706);
              color: #fff;
              font-size: 0.82rem;
              font-weight: 700;
              text-decoration: none;
              padding: 5px 12px;
              border-radius: 20px;
              transition: transform 0.15s;
            }
            .btn-admin-nav:hover { transform: scale(1.05); }
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
            .btn-logout:hover { background: rgba(239, 68, 68, 0.25); }
            .btn-discord {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              background: #5865F2;
              color: #fff;
              text-decoration: none;
              padding: 10px 20px;
              border-radius: 12px;
              font-weight: 600;
              transition: transform 0.2s;
              box-shadow: 0 4px 14px rgba(88, 101, 242, 0.35);
            }
            .btn-discord:hover { background: #4752c4; transform: translateY(-2px); }
            .container { max-width: 1200px; margin: 0 auto; padding: 30px 20px 80px; }
            
            /* 히어로 섹션 */
            .hero {
              text-align: center;
              margin-bottom: 35px;
              padding: 35px 30px;
              background: var(--card-bg);
              border: 1px solid var(--card-border);
              border-radius: 24px;
              backdrop-filter: blur(8px);
            }
            .hero h1 {
              font-family: 'Outfit', sans-serif;
              font-size: 2.3rem;
              font-weight: 800;
              margin-bottom: 10px;
              letter-spacing: -0.5px;
            }
            .hero p { color: var(--text-muted); font-size: 1.05rem; max-width: 650px; margin: 0 auto 20px; }
            .status-badge { display: inline-block; padding: 6px 14px; border-radius: 30px; font-size: 0.85rem; font-weight: 600; margin-bottom: 16px; }
            .logged-in-badge { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
            .logged-out-badge { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }
            .personal-asset-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-top: 20px; }
            .personal-asset-grid .asset-card { background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); padding: 18px; border-radius: 16px; text-align: left; }
            .personal-asset-grid .asset-card.highlight { background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(168, 85, 247, 0.2)); border-color: rgba(99, 102, 241, 0.4); }
            .asset-lbl { display: block; font-size: 0.82rem; color: var(--text-muted); margin-bottom: 4px; }
            .asset-val { font-size: 1.3rem; font-weight: 700; font-family: 'Outfit', sans-serif; color: #fff; }
            
            .hero-quick-actions { display: flex; justify-content: center; gap: 12px; margin-top: 22px; flex-wrap: wrap; }
            .btn-quick {
              background: rgba(255, 255, 255, 0.08);
              border: 1px solid var(--card-border);
              color: #e0e7ff;
              font-weight: 600;
              padding: 8px 16px;
              border-radius: 12px;
              cursor: pointer;
              transition: all 0.2s;
            }
            .btn-quick:hover { background: rgba(99, 102, 241, 0.3); border-color: var(--primary); transform: translateY(-2px); }

            /* 탭 메뉴 (가로 스크롤바 없이 자연스럽게 래핑) */
            .tabs-nav {
              display: flex;
              gap: 8px;
              margin-bottom: 25px;
              border-bottom: 1px solid var(--card-border);
              padding-bottom: 12px;
              flex-wrap: wrap;
              overflow: visible;
              scrollbar-width: none;
              -ms-overflow-style: none;
            }
            .tabs-nav::-webkit-scrollbar {
              display: none;
              width: 0;
              height: 0;
            }
            .tab-btn {
              background: rgba(255, 255, 255, 0.03);
              border: 1px solid var(--card-border);
              color: var(--text-muted);
              font-size: 0.92rem;
              font-weight: 700;
              padding: 8px 14px;
              border-radius: 12px;
              cursor: pointer;
              transition: all 0.2s;
              display: flex;
              align-items: center;
              gap: 6px;
              white-space: nowrap;
            }
            .tab-btn.active {
              background: linear-gradient(135deg, rgba(99, 102, 241, 0.28), rgba(168, 85, 247, 0.28));
              color: #fff;
              border-color: rgba(99, 102, 241, 0.5);
              box-shadow: 0 4px 14px rgba(99, 102, 241, 0.2);
            }
            .tab-btn:hover:not(.active) { background: rgba(255, 255, 255, 0.08); color: #fff; transform: translateY(-1px); }

            .tab-pane { display: none; }
            .tab-pane.active { display: block; animation: fadeIn 0.3s ease; }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

            /* ⚡ 통합 라이브 피드 & 모든 로그 전용 스타일 */
            .feed-container {
              background: var(--card-bg);
              border: 1px solid var(--card-border);
              border-radius: 24px;
              padding: 26px;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
            }
            .feed-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 20px;
              flex-wrap: wrap;
              gap: 12px;
            }
            .feed-title {
              font-family: 'Outfit', sans-serif;
              font-size: 1.35rem;
              font-weight: 800;
              color: #fbbf24;
              display: flex;
              align-items: center;
              gap: 10px;
            }
            .feed-status-badge {
              display: flex;
              align-items: center;
              gap: 8px;
              font-size: 0.8rem;
              font-weight: 700;
              color: #34d399;
              background: rgba(16, 185, 129, 0.15);
              padding: 4px 12px;
              border-radius: 20px;
              border: 1px solid rgba(16, 185, 129, 0.3);
            }
            .feed-filter-bar {
              display: flex;
              gap: 8px;
              margin-bottom: 20px;
              flex-wrap: wrap;
            }
            .btn-feed-filter {
              background: rgba(255, 255, 255, 0.04);
              border: 1px solid var(--card-border);
              color: var(--text-muted);
              font-size: 0.82rem;
              font-weight: 700;
              padding: 6px 14px;
              border-radius: 12px;
              cursor: pointer;
              transition: all 0.2s;
            }
            .btn-feed-filter.active {
              background: #6366f1;
              color: #fff;
              border-color: #818cf8;
            }
            .feed-search-input {
              flex: 1;
              min-width: 240px;
              background: #111827;
              border: 1px solid var(--card-border);
              color: #fff;
              padding: 8px 14px;
              border-radius: 10px;
              font-size: 0.85rem;
            }
            
            .feed-stream-list {
              display: flex;
              flex-direction: column;
              gap: 12px;
              max-height: 650px;
              overflow-y: auto;
              padding-right: 6px;
            }
            .feed-card {
              background: rgba(255, 255, 255, 0.02);
              border: 1px solid var(--card-border);
              border-radius: 16px;
              padding: 16px 20px;
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 16px;
              transition: all 0.2s;
            }
            .feed-card:hover {
              background: rgba(255, 255, 255, 0.04);
              border-color: rgba(99, 102, 241, 0.3);
              transform: translateX(4px);
            }
            .feed-card-left {
              display: flex;
              align-items: center;
              gap: 14px;
              flex: 1;
            }
            .feed-badge {
              font-size: 0.75rem;
              font-weight: 800;
              padding: 4px 10px;
              border-radius: 8px;
              white-space: nowrap;
            }
            .badge-up { background: rgba(16, 185, 129, 0.15); color: #34d399; }
            .badge-down { background: rgba(239, 68, 68, 0.15); color: #f87171; }
            .badge-buy { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }
            .badge-sell { background: rgba(251, 146, 60, 0.15); color: #fb923c; }
            .badge-win { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
            .badge-lose { background: rgba(156, 163, 175, 0.15); color: #9ca3af; }
            .badge-eco { background: rgba(168, 85, 247, 0.15); color: #c084fc; }
            .badge-bull { background: rgba(16, 185, 129, 0.15); color: #34d399; }
            .badge-bear { background: rgba(239, 68, 68, 0.15); color: #f87171; }
            
            .feed-info-col h4 { font-size: 0.95rem; font-weight: 700; color: #fff; margin-bottom: 2px; }
            .feed-info-col p { font-size: 0.82rem; color: #94a3b8; }
            .feed-time-col { text-align: right; white-space: nowrap; }
            .feed-time-text { font-size: 0.75rem; color: #64748b; font-family: 'Outfit', monospace; }
            .feed-actor-tag { font-size: 0.78rem; font-weight: 700; color: #a5b4fc; display: block; margin-top: 2px; }

            /* 📊 자산 포트폴리오 비중 바 */
            .asset-ratio-container {
              background: rgba(255, 255, 255, 0.03);
              border: 1px solid var(--card-border);
              border-radius: 14px;
              padding: 12px 18px;
              margin-top: 16px;
              margin-bottom: 6px;
            }
            .asset-ratio-header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              font-size: 0.82rem;
              color: var(--text-muted);
              margin-bottom: 8px;
              font-weight: 600;
              flex-wrap: wrap;
              gap: 8px;
            }
            .asset-ratio-bar {
              width: 100%;
              height: 10px;
              background: rgba(255, 255, 255, 0.08);
              border-radius: 6px;
              overflow: hidden;
              display: flex;
            }
            .ratio-segment {
              height: 100%;
              transition: width 0.4s ease;
            }
            .ratio-cash { background: #10b981; }
            .ratio-bank { background: #6366f1; }
            .ratio-stock { background: #38bdf8; }

            /* ⛏️ 클리커 채굴기 전용 스타일 */
            .clicker-container {
              display: grid;
              grid-template-columns: 1fr 1.2fr;
              gap: 24px;
              margin-bottom: 40px;
            }
            @media (max-width: 850px) { .clicker-container { grid-template-columns: 1fr; } }
            
            .clicker-box {
              background: var(--card-bg);
              border: 1px solid var(--card-border);
              border-radius: 24px;
              padding: 30px 20px;
              text-align: center;
              position: relative;
              overflow: hidden;
            }
            .big-click-gem {
              width: 150px;
              height: 150px;
              margin: 20px auto;
              background: radial-gradient(circle at 35% 35%, #a5b4fc 15%, #6366f1 55%, #312e81 100%);
              border: 3px solid rgba(255, 255, 255, 0.25);
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 4.8rem;
              cursor: pointer;
              user-select: none;
              box-shadow: 0 10px 40px rgba(99, 102, 241, 0.5), inset 0 0 20px rgba(255, 255, 255, 0.3);
              transition: transform 0.08s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            }
            .big-click-gem:hover { transform: scale(1.05); }
            .big-click-gem:active, .big-click-gem.gem-hit { transform: scale(0.90) rotate(-3deg); }
            
            .floating-coin {
              position: absolute;
              font-weight: 800;
              font-family: 'Outfit', sans-serif;
              color: #34d399;
              font-size: 1.15rem;
              pointer-events: none;
              animation: floatUp 0.7s ease-out forwards;
              z-index: 10;
            }
            .floating-coin.crit {
              color: #fbbf24;
              font-size: 1.35rem;
              text-shadow: 0 0 12px rgba(245, 158, 11, 0.8);
            }
            @keyframes floatUp {
              0% { opacity: 1; transform: translateY(0) scale(1); }
              100% { opacity: 0; transform: translateY(-60px) scale(1.25); }
            }

            .shop-box {
              background: var(--card-bg);
              border: 1px solid var(--card-border);
              border-radius: 24px;
              padding: 26px;
            }
            .shop-item {
              background: rgba(255, 255, 255, 0.03);
              border: 1px solid var(--card-border);
              padding: 16px;
              border-radius: 16px;
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 14px;
            }
            .shop-item-info h4 { font-size: 1rem; font-weight: 700; color: #fff; margin-bottom: 4px; }
            .shop-item-info p { font-size: 0.8rem; color: var(--text-muted); }
            .btn-upgrade {
              background: linear-gradient(135deg, #6366f1, #8b5cf6);
              border: none;
              color: #fff;
              font-weight: 700;
              padding: 8px 16px;
              border-radius: 10px;
              cursor: pointer;
              font-size: 0.85rem;
              transition: transform 0.15s;
            }
            .btn-upgrade:hover { transform: scale(1.05); }

            /* 주식 시장 & 차트 */
            .market-trends-panel {
              background: rgba(17, 24, 39, 0.85);
              border: 1px solid rgba(99, 102, 241, 0.3);
              border-radius: 20px;
              padding: 24px;
              margin-bottom: 30px;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            }
            .trends-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
            .trends-title { font-family: 'Outfit', sans-serif; font-size: 1.3rem; font-weight: 700; color: #e0e7ff; display: flex; align-items: center; gap: 8px; }
            /* GPU 하드웨어 가속 및 부드러운 렌더링 최적화 */
            .stock-card, .casino-card, .gainer-card, .portfolio-item-card, .clicker-box, .shop-box {
              transform: translateZ(0);
              will-change: transform;
              backface-visibility: hidden;
            }
            .stock-price {
              transition: color 0.4s ease;
            }

            .btn-quick-refresh {
              background: rgba(255, 255, 255, 0.12);
              border: 1px solid rgba(255, 255, 255, 0.25);
              color: #fbbf24;
              border-radius: 50%;
              width: 22px;
              height: 22px;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              font-size: 0.72rem;
              transition: transform 0.2s, background 0.2s;
              padding: 0;
              line-height: 1;
            }
            .btn-quick-refresh:hover { background: rgba(255, 255, 255, 0.3); transform: rotate(180deg); }
            .btn-quick-refresh.spinning-fast { animation: spinFast 0.5s linear infinite; }
            @keyframes spinFast { 100% { transform: rotate(360deg); } }

            .next-tick-badge {
              display: flex;
              align-items: center;
              gap: 8px;
              background: rgba(245, 158, 11, 0.15);
              border: 1px solid rgba(245, 158, 11, 0.35);
              padding: 6px 14px;
              border-radius: 20px;
              font-size: 0.85rem;
              font-weight: 700;
              color: #fbbf24;
            }
            .market-sentiment-pill { display: flex; align-items: center; gap: 12px; background: rgba(255, 255, 255, 0.05); padding: 6px 16px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; border: 1px solid var(--card-border); }
            .gainers-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
            .gainer-card {
              background: linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(99, 102, 241, 0.08) 100%);
              border: 1px solid rgba(16, 185, 129, 0.25);
              padding: 16px 20px;
              border-radius: 16px;
              display: flex;
              align-items: center;
              justify-content: space-between;
              transition: transform 0.2s;
            }
            .gainer-card:hover { transform: translateY(-3px); }
            .gainer-rank { font-size: 0.95rem; font-weight: 800; color: #f59e0b; font-family: 'Outfit', sans-serif; }
            .gainer-info { display: flex; flex-direction: column; }
            .gainer-name { font-weight: 700; color: #fff; font-size: 1rem; }
            .gainer-symbol { font-size: 0.75rem; color: #818cf8; }
            .gainer-rate { font-family: 'Outfit', sans-serif; font-size: 1.25rem; font-weight: 800; }
            .text-up { color: #34d399; }
            /* 📊 포트폴리오 패널 스타일 */
            .portfolio-panel {
              background: linear-gradient(135deg, rgba(30, 27, 75, 0.7) 0%, rgba(17, 24, 39, 0.9) 100%);
              border: 1px solid rgba(129, 140, 248, 0.35);
              border-radius: 20px;
              padding: 24px;
              margin-bottom: 30px;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
            }
            .portfolio-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; flex-wrap: wrap; gap: 12px; }
            .portfolio-title { font-family: 'Outfit', sans-serif; font-size: 1.3rem; font-weight: 800; color: #818cf8; display: flex; align-items: center; gap: 8px; }
            .portfolio-summary-pill { display: flex; align-items: center; gap: 14px; background: rgba(255, 255, 255, 0.05); padding: 8px 18px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; border: 1px solid var(--card-border); flex-wrap: wrap; }
            .portfolio-cards-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
            .portfolio-item-card { background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); border-radius: 16px; padding: 18px; transition: all 0.2s; }
            .portfolio-item-card:hover { transform: translateY(-3px); border-color: rgba(99, 102, 241, 0.4); background: rgba(255, 255, 255, 0.05); }
            .portfolio-item-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
            .portfolio-grid-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.82rem; margin-bottom: 10px; }
            .port-stat { display: flex; flex-direction: column; }
            .port-stat span { color: var(--text-muted); font-size: 0.75rem; }
            .port-stat b { font-family: 'Outfit', sans-serif; font-size: 0.95rem; margin-top: 2px; }

            .macro-news-banner {
              background: linear-gradient(90deg, rgba(99, 102, 241, 0.1), rgba(168, 85, 247, 0.1));
              border: 1px solid rgba(99, 102, 241, 0.3);
              padding: 16px 24px;
              border-radius: 16px;
              margin-bottom: 30px;
              display: flex;
              align-items: center;
              justify-content: space-between;
              flex-wrap: wrap;
              gap: 12px;
            }
            .macro-badge { background: rgba(99, 102, 241, 0.25); padding: 6px 14px; border-radius: 20px; font-weight: 700; font-size: 0.9rem; color: #a5b4fc; }
            .news-text { font-size: 0.95rem; color: #e2e8f0; font-weight: 500; }
            .section-title { font-family: 'Outfit', sans-serif; font-size: 1.4rem; font-weight: 700; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
            
            .stocks-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 20px; margin-bottom: 40px; }
            .stock-card { background: var(--card-bg); border: 1px solid var(--card-border); padding: 22px; border-radius: 20px; transition: transform 0.2s, border-color 0.2s; position: relative; }
            .stock-card:hover { transform: translateY(-4px); border-color: rgba(99, 102, 241, 0.4); }
            .stock-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
            .stock-symbol { font-size: 0.8rem; font-weight: 700; color: #818cf8; }
            .stock-name { font-size: 1.1rem; font-weight: 700; margin-top: 2px; }
            .stock-mid-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
            .stock-price { font-family: 'Outfit', sans-serif; font-size: 1.6rem; font-weight: 800; color: #fff; }
            .sparkline-box { width: 110px; height: 32px; display: flex; align-items: center; }
            .stock-footer { font-size: 0.82rem; color: var(--text-muted); display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.05); padding-top: 10px; margin-bottom: 14px; }
            .trend-text { font-weight: 700; font-size: 0.8rem; }
            .badge { padding: 4px 10px; border-radius: 8px; font-size: 0.8rem; font-weight: 700; }

            .stock-trade-actions { display: flex; gap: 6px; flex-wrap: wrap; }
            .btn-trade { flex: 1; min-width: 60px; padding: 8px; border-radius: 8px; border: none; font-weight: 700; font-size: 0.85rem; cursor: pointer; transition: all 0.2s; }
            .btn-detail { background: rgba(99, 102, 241, 0.15); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.3); }
            .btn-detail:hover { background: rgba(99, 102, 241, 0.35); color: #fff; }
            .btn-buy { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
            .btn-buy:hover { background: #10b981; color: #fff; }
            .btn-sell { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }
            .btn-sell:hover { background: #ef4444; color: #fff; }
            .btn-trade-login { flex: 1; text-align: center; background: rgba(255, 255, 255, 0.05); color: var(--text-muted); text-decoration: none; padding: 8px; border-radius: 8px; font-size: 0.82rem; }

            /* 📰 뉴스 피드 스타일 & 검색 바 */
            .news-control-bar {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 12px;
              margin-bottom: 20px;
              flex-wrap: wrap;
            }
            .news-search-box { flex: 1; min-width: 250px; display: flex; gap: 8px; }
            .news-search-input { width: 100%; background: #111827; border: 1px solid var(--card-border); color: #fff; padding: 10px 16px; border-radius: 12px; font-size: 0.9rem; }
            .news-category-filters {
              display: flex;
              gap: 6px;
              flex-wrap: wrap;
              padding-bottom: 4px;
              scrollbar-width: none;
              -ms-overflow-style: none;
            }
            .news-category-filters::-webkit-scrollbar {
              display: none;
              width: 0;
              height: 0;
            }
            .btn-filter {
              background: rgba(255, 255, 255, 0.04);
              border: 1px solid var(--card-border);
              color: var(--text-muted);
              padding: 6px 14px;
              border-radius: 20px;
              font-size: 0.8rem;
              font-weight: 700;
              cursor: pointer;
              transition: all 0.2s;
              white-space: nowrap;
            }
            .btn-filter.active { background: #6366f1; color: #fff; border-color: #818cf8; box-shadow: 0 2px 8px rgba(99, 102, 241, 0.3); }
            .btn-filter:hover:not(.active) { background: rgba(255, 255, 255, 0.08); color: #fff; transform: translateY(-1px); }

            .news-feed-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 18px; margin-bottom: 40px; }
            .news-item { background: var(--card-bg); border: 1px solid var(--card-border); padding: 22px; border-radius: 20px; transition: transform 0.2s, border-color 0.2s; display: flex; flex-direction: column; justify-content: space-between; }
            .news-item:hover { transform: translateY(-3px); border-color: rgba(99, 102, 241, 0.4); }
            .news-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
            .news-tag { background: rgba(99, 102, 241, 0.2); color: #818cf8; font-size: 0.75rem; font-weight: 700; padding: 4px 8px; border-radius: 6px; }
            .news-sentiment-badge { font-size: 0.75rem; font-weight: 700; padding: 4px 8px; border-radius: 6px; }
            .sentiment-bull { background: rgba(16, 185, 129, 0.15); color: #34d399; }
            .sentiment-bear { background: rgba(239, 68, 68, 0.15); color: #f87171; }
            .news-time { font-size: 0.75rem; color: var(--text-muted); }
            .news-headline { font-weight: 800; color: #fff; font-size: 1.1rem; margin-bottom: 8px; line-height: 1.4; }
            .news-desc { font-size: 0.88rem; color: #cbd5e1; line-height: 1.5; margin-bottom: 16px; }
            .news-footer-row { display: flex; justify-content: space-between; align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.05); padding-top: 12px; }
            .news-sector-pill { font-size: 0.75rem; color: #9ca3af; }
            .btn-news-stock { background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.3); color: #a5b4fc; padding: 4px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 700; cursor: pointer; }
            .btn-news-stock:hover { background: #6366f1; color: #fff; }
            .news-market-badge { font-size: 0.75rem; color: #94a3b8; }

            /* 🎰 웹 카지노 */
            .casino-hub-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 24px; margin-bottom: 40px; }
            .casino-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 24px; padding: 26px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); position: relative; }
            .casino-title { font-family: 'Outfit', sans-serif; font-size: 1.35rem; font-weight: 800; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; color: #fbbf24; }
            .casino-desc { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 20px; }
            .turn-cost-tag { position: absolute; top: 22px; right: 22px; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24; font-size: 0.75rem; font-weight: 700; padding: 3px 8px; border-radius: 10px; }
            .slot-display { background: #060911; border: 2px solid #374151; border-radius: 16px; padding: 24px 16px; display: flex; justify-content: center; gap: 16px; margin-bottom: 20px; box-shadow: inset 0 0 20px rgba(0,0,0,0.8); }
            .slot-reel { width: 72px; height: 72px; background: #111827; border: 1px solid #4b5563; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 2.2rem; box-shadow: 0 4px 12px rgba(0,0,0,0.5); transition: transform 0.1s; }
            .slot-reel.spinning { animation: reelSpin 0.15s infinite; }
            @keyframes reelSpin { 0% { transform: translateY(-4px); } 50% { transform: translateY(4px); } 100% { transform: translateY(-4px); } }
            .bet-input-group { margin-bottom: 16px; }
            .bet-input-group label { display: block; font-size: 0.82rem; color: var(--text-muted); margin-bottom: 6px; }
            .bet-input-row { display: flex; gap: 8px; }
            .bet-input { flex: 1; background: #1f2937; border: 1px solid var(--card-border); color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 1rem; font-weight: 700; font-family: 'Outfit', sans-serif; }
            .btn-chip-grid { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
            .btn-chip { background: rgba(255, 255, 255, 0.05); border: 1px solid var(--card-border); color: #c7d2fe; font-size: 0.75rem; font-weight: 600; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
            .btn-chip:hover { background: rgba(99, 102, 241, 0.2); color: #fff; }
            .btn-play-game { width: 100%; background: linear-gradient(135deg, #f59e0b 0%, #ef4444 100%); border: none; color: #fff; font-family: 'Outfit', sans-serif; font-size: 1.15rem; font-weight: 800; padding: 14px; border-radius: 14px; cursor: pointer; transition: all 0.2s; box-shadow: 0 4px 16px rgba(245, 158, 11, 0.35); }
            .btn-play-game:hover:not(:disabled) { transform: translateY(-2px); filter: brightness(1.1); }
            .btn-play-game:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
            .game-result-box { margin-top: 16px; padding: 12px; border-radius: 10px; font-size: 0.9rem; font-weight: 600; text-align: center; min-height: 44px; display: flex; align-items: center; justify-content: center; }

            .coin-box { width: 90px; height: 90px; border-radius: 50%; background: radial-gradient(circle, #fbbf24 60%, #d97706 100%); border: 4px solid #fef08a; display: flex; align-items: center; justify-content: center; font-size: 2.2rem; margin: 15px auto 25px; box-shadow: 0 8px 24px rgba(245, 158, 11, 0.4); transition: transform 0.6s ease; }
            .coin-box.flipping { animation: coinFlipAnim 0.6s ease-in-out infinite; }
            @keyframes coinFlipAnim { 0% { transform: rotateY(0deg) scale(1); } 50% { transform: rotateY(180deg) scale(1.15); } 100% { transform: rotateY(360deg) scale(1); } }
            .choice-btn-group { display: flex; gap: 10px; margin-bottom: 16px; }
            .btn-choice { flex: 1; padding: 10px; border-radius: 10px; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--card-border); color: #e0e7ff; font-weight: 700; cursor: pointer; transition: all 0.2s; }
            .btn-choice.selected { background: #6366f1; border-color: #818cf8; color: #fff; }

            /* 순위표 */
            .leaderboard-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 24px; overflow: hidden; }
            table { width: 100%; border-collapse: collapse; text-align: left; }
            th { background: rgba(255, 255, 255, 0.02); padding: 16px 24px; color: var(--text-muted); font-size: 0.85rem; font-weight: 600; border-bottom: 1px solid var(--card-border); }
            td { padding: 18px 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.04); }
            .rank-cell { font-weight: 700; font-size: 1.1rem; width: 100px; }
            .user-info-box { display: flex; align-items: center; gap: 12px; }
            .rank-avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; }
            .user-text-col { display: flex; flex-direction: column; }
            .user-nickname-title { font-weight: 700; color: #fff; font-size: 1rem; }
            .user-id-sub { font-size: 0.75rem; color: var(--text-muted); }
            .admin-badge-mini { font-size: 0.75rem; background: rgba(245, 158, 11, 0.2); color: #f59e0b; padding: 2px 6px; border-radius: 6px; margin-left: 4px; }
            .net-cell { font-family: 'Outfit', sans-serif; font-weight: 700; font-size: 1.1rem; color: #818cf8; text-align: right; }
            
            /* 🔍 모달 윈도우 & 슬라이드업 애니메이션 */
            .modal-overlay {
              position: fixed;
              top: 0; left: 0; right: 0; bottom: 0;
              background: rgba(0, 0, 0, 0.82);
              backdrop-filter: blur(10px);
              display: none;
              align-items: center;
              justify-content: center;
              z-index: 1000;
              padding: 20px;
              animation: overlayFadeIn 0.25s ease;
            }
            @keyframes overlayFadeIn { from { opacity: 0; } to { opacity: 1; } }
            .modal-box {
              background: #111827;
              border: 1px solid rgba(99, 102, 241, 0.45);
              border-radius: 24px;
              padding: 28px;
              max-width: 520px;
              width: 100%;
              box-shadow: 0 25px 60px rgba(0, 0, 0, 0.85);
              max-height: 90vh;
              overflow-y: auto;
              animation: modalSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            }
            @keyframes modalSlideUp { from { transform: translateY(30px) scale(0.96); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
            .modal-title { font-family: 'Outfit', sans-serif; font-size: 1.35rem; font-weight: 800; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
            .btn-close-modal { background: transparent; border: none; color: #9ca3af; font-size: 1.6rem; cursor: pointer; transition: color 0.2s; }
            .btn-close-modal:hover { color: #fff; }
            
            .chart-view-box { background: #070b14; border: 1px solid #1f2937; border-radius: 16px; padding: 18px; margin: 16px 0; text-align: center; }
            .chart-stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px; }
            .stat-tile { background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); padding: 10px 14px; border-radius: 10px; text-align: left; }
            .stat-lbl { font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 2px; }
            .stat-val { font-size: 0.95rem; font-weight: 700; color: #e0e7ff; font-family: 'Outfit', sans-serif; }

            .pulse-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: #10b981; box-shadow: 0 0 8px #10b981; animation: pulse 1.5s infinite; }
            @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } 100% { opacity: 1; transform: scale(1); } }

            /* 💬 실시간 광장 채팅 스타일 */
            .chat-emoji-btn {
              background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1);
              color: #fff; padding: 4px 10px; border-radius: 8px; cursor: pointer; font-size: 1rem;
              transition: all 0.15s; flex-shrink: 0;
            }
            .chat-emoji-btn:hover { background: rgba(255, 255, 255, 0.18); transform: translateY(-1px); }
            .chat-bubble {
              display: flex; gap: 10px; align-items: flex-start;
              animation: chatFadeIn 0.25s ease-out;
            }
            @keyframes chatFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
            .chat-bubble.mine { flex-direction: row-reverse; }
            .chat-bubble.mine .chat-content { background: linear-gradient(135deg, #1e3a8a, #2563eb); color: #fff; border-top-right-radius: 4px; border: none; }
            .chat-bubble.admin .chat-content { border: 1px solid rgba(245, 158, 11, 0.5); background: rgba(245, 158, 11, 0.15); }
            .chat-avatar { width: 34px; height: 34px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.15); object-fit: cover; flex-shrink: 0; }
            .chat-content {
              background: #1e293b; border: 1px solid rgba(255, 255, 255, 0.08);
              padding: 8px 12px; border-radius: 14px; max-width: 75%; word-break: break-word; font-size: 0.9rem;
            }
            .chat-meta { font-size: 0.72rem; color: #94a3b8; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
            .chat-bubble.mine .chat-meta { justify-content: flex-end; }
            .badge-admin-chat { background: #d97706; color: #fff; font-size: 0.65rem; padding: 1px 5px; border-radius: 4px; font-weight: bold; }
            .btn-del-msg { background: transparent; border: none; color: #f87171; cursor: pointer; font-size: 0.75rem; padding: 0 4px; opacity: 0.7; }
            .btn-del-msg:hover { opacity: 1; }

            /* 💬 플로팅 전역 실시간 채팅 위젯 (Floating Global Chat Dock) */
            #floating-chat-container {
              position: fixed;
              bottom: 24px;
              right: 24px;
              z-index: 9998;
              font-family: 'Inter', sans-serif;
            }
            #btn-floating-chat-toggle {
              background: linear-gradient(135deg, #0284c7, #0369a1);
              border: 1px solid rgba(56, 189, 248, 0.5);
              color: #fff;
              padding: 10px 18px;
              border-radius: 999px;
              font-weight: 700;
              font-size: 0.92rem;
              cursor: pointer;
              display: flex;
              align-items: center;
              gap: 8px;
              box-shadow: 0 8px 24px rgba(2, 132, 199, 0.45), 0 2px 8px rgba(0, 0, 0, 0.3);
              transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
            }
            #btn-floating-chat-toggle:hover {
              transform: translateY(-3px) scale(1.03);
              box-shadow: 0 12px 30px rgba(2, 132, 199, 0.6);
            }
            .chat-unread-badge {
              background: #ef4444;
              color: #fff;
              font-size: 0.7rem;
              font-weight: 800;
              padding: 2px 6px;
              border-radius: 999px;
              animation: pulse-dot 1.2s infinite;
            }
            #floating-chat-drawer {
              position: fixed;
              bottom: 80px;
              right: 24px;
              width: 380px;
              max-width: calc(100vw - 32px);
              height: 520px;
              max-height: calc(100vh - 120px);
              background: #0f172a;
              border: 1px solid rgba(56, 189, 248, 0.35);
              border-radius: 20px;
              box-shadow: 0 20px 45px rgba(0, 0, 0, 0.6), 0 0 20px rgba(2, 132, 199, 0.2);
              display: flex;
              flex-direction: column;
              overflow: hidden;
              z-index: 9999;
              animation: slideUpChat 0.25s ease-out;
            }
            @keyframes slideUpChat {
              from { opacity: 0; transform: translateY(20px) scale(0.96); }
              to { opacity: 1; transform: translateY(0) scale(1); }
            }
            .floating-chat-header {
              background: linear-gradient(135deg, #1e293b, #0f172a);
              padding: 12px 16px;
              border-bottom: 1px solid rgba(255, 255, 255, 0.08);
              display: flex;
              justify-content: space-between;
              align-items: center;
            }
            .floating-chat-body {
              flex: 1;
              overflow-y: auto;
              padding: 12px 14px;
              display: flex;
              flex-direction: column;
              gap: 8px;
              background: rgba(15, 23, 42, 0.95);
            }
            .floating-chat-footer {
              padding: 10px 12px;
              background: #1e293b;
              border-top: 1px solid rgba(255, 255, 255, 0.08);
            }
            .btn-chat-min {
              background: rgba(255, 255, 255, 0.1);
              border: none;
              color: #94a3b8;
              width: 26px;
              height: 26px;
              border-radius: 50%;
              cursor: pointer;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 0.85rem;
              transition: all 0.15s;
            }
            .btn-chat-min:hover { background: rgba(239, 68, 68, 0.25); color: #f87171; }
            @media (max-width: 480px) {
              #floating-chat-drawer {
                right: 12px;
                left: 12px;
                width: auto;
                bottom: 75px;
                height: 480px;
              }
              #floating-chat-container {
                right: 16px;
                bottom: 16px;
              }
            }

            /* 💬 하단 24시 고객센터 문의 바 */
            .support-footer-banner {
              background: linear-gradient(135deg, rgba(30, 27, 75, 0.85) 0%, rgba(17, 24, 39, 0.95) 100%);
              border: 1px solid rgba(99, 102, 241, 0.35);
              border-radius: 20px;
              padding: 24px 30px;
              margin-top: 50px;
              margin-bottom: 30px;
              display: flex;
              justify-content: space-between;
              align-items: center;
              flex-wrap: wrap;
              gap: 20px;
              box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
            }
            .support-banner-left { display: flex; align-items: center; gap: 16px; }
            .support-avatar-badge {
              width: 50px; height: 50px; border-radius: 14px;
              background: linear-gradient(135deg, #6366f1, #8b5cf6);
              display: flex; align-items: center; justify-content: center;
              font-size: 1.6rem; flex-shrink: 0;
              box-shadow: 0 6px 16px rgba(99, 102, 241, 0.4);
            }
            .support-title { font-family: 'Outfit', sans-serif; font-size: 1.25rem; font-weight: 800; color: #fff; margin-bottom: 4px; }
            .support-subtitle { font-size: 0.85rem; color: #9ca3af; max-width: 550px; line-height: 1.4; }
            .support-banner-right { display: flex; gap: 10px; flex-wrap: wrap; }
            .btn-support-action {
              padding: 10px 20px; border-radius: 12px; font-weight: 700; font-size: 0.9rem; cursor: pointer; transition: all 0.2s;
            }
            .btn-support-write {
              background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none;
              box-shadow: 0 4px 14px rgba(99, 102, 241, 0.35);
            }
            .btn-support-write:hover { transform: translateY(-2px); filter: brightness(1.1); }
            .btn-support-view {
              background: rgba(255, 255, 255, 0.05); border: 1px solid var(--card-border); color: #c7d2fe;
            }
            .btn-support-view:hover { background: rgba(99, 102, 241, 0.2); color: #fff; }

            /* 👤 프로필 & 마이페이지 모달 */
            .nav-profile-group.clickable { cursor: pointer; transition: all 0.2s; }
            .nav-profile-group.clickable:hover { background: rgba(255, 255, 255, 0.1); border-color: var(--primary); transform: translateY(-1px); }
            .btn-profile-badge { background: rgba(99, 102, 241, 0.25); border: 1px solid rgba(99, 102, 241, 0.4); color: #c7d2fe; font-size: 0.75rem; font-weight: 700; padding: 3px 8px; border-radius: 12px; }
            
            .profile-user-header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; padding-bottom: 18px; border-bottom: 1px solid var(--card-border); }
            .profile-avatar-big { width: 64px; height: 64px; border-radius: 50%; border: 3px solid var(--primary); box-shadow: 0 4px 14px rgba(99, 102, 241, 0.35); }
            .profile-subtabs-nav { display: flex; gap: 8px; margin-bottom: 18px; border-bottom: 1px solid var(--card-border); padding-bottom: 10px; }
            .profile-subtab-btn { background: transparent; border: 1px solid transparent; color: var(--text-muted); font-size: 0.85rem; font-weight: 700; padding: 6px 14px; border-radius: 10px; cursor: pointer; transition: all 0.2s; }
            .profile-subtab-btn.active { background: rgba(99, 102, 241, 0.25); color: #fff; border-color: rgba(99, 102, 241, 0.4); }
            .profile-stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 20px; }
            .profile-stat-box { background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); padding: 12px 14px; border-radius: 12px; }
            .profile-stat-lbl { font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 2px; }
            .profile-stat-val { font-family: 'Outfit', sans-serif; font-size: 1.1rem; font-weight: 700; color: #fff; }

            /* 📩 1:1 문의 리스트 & 답변 박스 */
            .inquiry-item-card { background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); border-radius: 14px; padding: 16px; margin-bottom: 12px; transition: border-color 0.2s; }
            .inquiry-item-card:hover { border-color: rgba(99, 102, 241, 0.4); }
            .inquiry-item-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
            .inquiry-category-badge { font-size: 0.75rem; background: rgba(99, 102, 241, 0.2); color: #818cf8; padding: 3px 8px; border-radius: 6px; font-weight: 700; }
            .inquiry-status-badge { font-size: 0.75rem; font-weight: 700; padding: 3px 8px; border-radius: 6px; }
            .status-waiting { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.35); }
            .status-answered { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); }
            .inquiry-title-text { font-weight: 700; font-size: 0.95rem; color: #fff; margin-bottom: 6px; }
            .inquiry-content-text { font-size: 0.85rem; color: #cbd5e1; line-height: 1.5; white-space: pre-wrap; margin-bottom: 8px; background: rgba(0, 0, 0, 0.25); padding: 10px 12px; border-radius: 8px; }
            .inquiry-answer-box { background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.3); border-left: 4px solid #10b981; padding: 12px 14px; border-radius: 8px; margin-top: 10px; }
            .inquiry-answer-header { font-size: 0.8rem; font-weight: 700; color: #34d399; margin-bottom: 4px; display: flex; justify-content: space-between; }
            .inquiry-answer-text { font-size: 0.85rem; color: #e2e8f0; line-height: 1.5; white-space: pre-wrap; }

            /* ✍️ 새 문의 작성 폼 */
            .inquiry-form-group { margin-bottom: 16px; }
            .inquiry-form-group label { display: block; font-size: 0.82rem; color: var(--text-muted); margin-bottom: 6px; font-weight: 600; }
            .inquiry-input, .inquiry-select, .inquiry-textarea {
              width: 100%; background: #1f2937; border: 1px solid var(--card-border); color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 0.9rem; font-family: inherit; box-sizing: border-box;
            }
            .inquiry-textarea { min-height: 110px; resize: vertical; }
            .btn-submit-inquiry {
              width: 100%; background: linear-gradient(135deg, #6366f1, #8b5cf6); border: none; color: #fff; font-weight: 800; font-size: 1rem; padding: 12px; border-radius: 12px; cursor: pointer; transition: all 0.2s;
            }
            .btn-submit-inquiry:hover { filter: brightness(1.1); transform: translateY(-1px); }

            /* 📱💻🖥️ 모든 기기 자동 화면 조절 반응형 최적화 */
            @media (min-width: 1200px) {
              .container { max-width: 1280px; margin: 0 auto; }
            }

            @media (max-width: 1024px) {
              .stocks-grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
              .casino-hub-grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
              .portfolio-cards-grid { grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
            }

            @media (max-width: 768px) {
              .navbar { padding: 10px 14px; flex-direction: column; gap: 8px; align-items: stretch; text-align: center; }
              .logo { font-size: 1.1rem; justify-content: center; }
              .container { padding: 12px 8px 60px; }
              .hero { padding: 18px 12px; margin-bottom: 16px; border-radius: 16px; }
              .hero h1 { font-size: 1.45rem; line-height: 1.3; }
              .personal-asset-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
              .personal-asset-grid .asset-card { padding: 10px; }
              .asset-val { font-size: 0.95rem; }
              .tabs-nav { 
                gap: 6px; padding-bottom: 8px; overflow-x: auto; 
                flex-wrap: nowrap; -webkit-overflow-scrolling: touch;
                scrollbar-width: none;
              }
              .tabs-nav::-webkit-scrollbar { display: none; }
              .tab-btn { font-size: 0.8rem; padding: 7px 12px; white-space: nowrap; flex-shrink: 0; }
              .casino-hub-grid, .stocks-grid, .gainers-grid { grid-template-columns: 1fr; gap: 12px; }
              .modal-box { padding: 18px 14px; border-radius: 16px; max-width: 95vw; }
              .market-trends-panel, .portfolio-panel { padding: 14px; }
              .trends-header { flex-direction: column; align-items: flex-start; gap: 8px; }
              .hero-quick-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
              .hero-quick-actions .btn-quick { width: 100%; font-size: 0.78rem; padding: 8px 4px; text-align: center; justify-content: center; }
              table { font-size: 0.75rem; }
              th, td { padding: 8px 6px; }
            }

            @media (max-width: 480px) {
              .navbar { padding: 8px 10px; }
              .logo { font-size: 0.95rem; }
              .hero h1 { font-size: 1.25rem; }
              .personal-asset-grid { grid-template-columns: 1fr 1fr; gap: 6px; }
              .personal-asset-grid .asset-card { padding: 8px; }
              .asset-lbl { font-size: 0.72rem; }
              .asset-val { font-size: 0.88rem; }
              .btn-chip-grid { grid-template-columns: repeat(3, 1fr); gap: 4px; }
              .btn-chip { padding: 6px 4px; font-size: 0.72rem; }
              .hero-quick-actions { grid-template-columns: 1fr; }
              .modal-box { padding: 14px 10px; }
              .slot-reel { font-size: 2.2rem; width: 60px; height: 60px; }
            }

            /* 🌐 사이트 푸터 & 정책 링크 */
            .app-site-footer {
              margin-top: 50px;
              padding-top: 30px;
              border-top: 1px solid var(--card-border);
              color: var(--text-muted);
              font-size: 0.85rem;
            }
            .footer-content {
              display: flex;
              justify-content: space-between;
              align-items: center;
              flex-wrap: wrap;
              gap: 20px;
              margin-bottom: 20px;
            }
            .footer-brand { max-width: 480px; }
            .footer-logo { font-family: 'Outfit', sans-serif; font-size: 1.1rem; font-weight: 800; color: #fff; margin-bottom: 6px; }
            .footer-desc { font-size: 0.8rem; color: #9ca3af; line-height: 1.5; }
            .footer-links { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
            .footer-link { color: #cbd5e1; text-decoration: none; font-weight: 600; font-size: 0.85rem; transition: color 0.2s; }
            .footer-link:hover { color: #818cf8; }
            .footer-link.highlight { color: #818cf8; background: rgba(99, 102, 241, 0.15); padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(99, 102, 241, 0.3); }
            .footer-link.highlight:hover { background: rgba(99, 102, 241, 0.3); color: #fff; }
            .footer-bottom { font-size: 0.75rem; color: #64748b; line-height: 1.4; }
          </style>
        </head>
        <body>
          <!-- 플로팅 토스트 알림 컨테이너 -->
          <div id="toast-container"></div>

          <!-- 롤링 증시 속보 티커 바 -->
          <div class="news-ticker-bar">
            <span class="ticker-live-dot"></span>
            <span class="ticker-content" id="breaking-ticker-text">${breakingNewsTicker}</span>
          </div>

          <nav class="navbar">
            <a href="/" class="logo">💎 월덕 주식 & 클리커 카지노</a>
            <div>${navbarRightHtml}</div>
          </nav>

          <div class="container">
            ${heroSectionHtml}

            <!-- 탭 네비게이션 (시작 메뉴 허브) -->
            <div class="tabs-nav">
              <button class="tab-btn active" onclick="switchTab('tab-stocks')">📈 주식 시장 & 차트</button>
              <button class="tab-btn" style="border-color: rgba(56, 189, 248, 0.4); color: #38bdf8;" onclick="switchTab('tab-chat')">💬 실시간 광장 채팅</button>
              <button class="tab-btn" style="border-color: rgba(245, 158, 11, 0.4); color: #fbbf24;" onclick="switchTab('tab-horse')">🏇 월덕 그랑프리 경마</button>
              <button class="tab-btn" onclick="switchTab('tab-casino')">🎰 웹 카지노 & 미니게임</button>
              <button class="tab-btn" onclick="switchTab('tab-news')">📰 시장 뉴스 & 경제 공시</button>
              <button class="tab-btn" onclick="switchTab('tab-clicker')">⛏️ 골드 채굴 & 클리커</button>
              <button class="tab-btn" onclick="switchTab('tab-ranking')">🏆 자산가 순위표</button>
              ${isAdminUser ? '<button class="tab-btn" style="border-color: rgba(239, 68, 68, 0.4); color: #f87171;" onclick="switchTab(\'tab-feed\')">⚡ 실시간 모든 로그 (관리자)</button>' : ''}
            </div>

            <!-- 탭 1: 주식 시장 & 차트 -->
            <div id="tab-stocks" class="tab-pane active">
              <div class="market-trends-panel">
                <div class="trends-header">
                  <div class="trends-title">
                    <span class="pulse-dot"></span>
                    🔥 실시간 시장 상승세 & 급등 종목 랭킹
                  </div>
                  <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                    <div class="next-tick-badge">
                      <span class="pulse-dot"></span>
                      ⏱️ 다음 갱신: <b id="price-tick-countdown" style="color: #fbbf24; font-family: 'Outfit', sans-serif;">03:00</b>
                      <button class="btn-quick-refresh" onclick="refreshStockPricesLive(true)" title="실시간 시세 즉시 갱신">🔄</button>
                    </div>
                    <div class="market-sentiment-pill">
                      <span>상승 🟢 <b>${upCount}개</b></span>
                      <span>하락 🔴 <b>${downCount}개</b></span>
                      <span class="${isMarketPositive ? 'text-up' : 'text-down'}">평균 ${isMarketPositive ? '+' : ''}${avgRate}%</span>
                    </div>
                  </div>
                </div>
                <div class="gainers-grid">
                  ${topGainersHtml}
                </div>
              </div>

              <div class="macro-news-banner">
                <span class="macro-badge">${regime ? regime.name : '시장 안정세'}</span>
                <span class="news-text">${news ? news.text : '실시간 시장 거래가 활발하게 이루어지고 있습니다.'}</span>
              </div>

              ${currentUser ? portfolioSectionHtml : ''}

              <h2 class="section-title">📊 실시간 가상 주식 시세 & 차트 분석</h2>
              <div class="stocks-grid">
                ${stockCardsHtml}
              </div>
            </div>

            <!-- 💬 탭: 실시간 광장 채팅 (Real-time Live Community Chat) -->
            <div id="tab-chat" class="tab-pane">
              <div class="card" style="border: 1px solid rgba(56, 189, 248, 0.3); background: rgba(15, 23, 42, 0.95); padding: 22px; border-radius: 18px; max-width: 900px; margin: 0 auto;">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 14px; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
                  <div>
                    <h2 style="font-size: 1.3rem; color: #38bdf8; display: flex; align-items: center; gap: 8px;">
                      💬 월덕 실시간 광장 채팅
                      <span style="font-size: 0.75rem; background: rgba(16, 185, 129, 0.2); color: #34d399; padding: 2px 8px; border-radius: 12px; border: 1px solid rgba(16, 185, 129, 0.4);">● 실시간 LIVE</span>
                    </h2>
                    <p style="font-size: 0.82rem; color: #9ca3af; margin-top: 2px;">🔒 HTTPS 보안 암호화 및 24시간 후 자동 파기 개인정보 보호 정책이 적용됩니다.</p>
                  </div>
                  <button onclick="loadChatMessages()" style="background: rgba(255,255,255,0.06); border: 1px solid var(--card-border); color: #94a3b8; font-size: 0.8rem; padding: 6px 12px; border-radius: 8px; cursor: pointer;">🔄 새로고침</button>
                </div>

                <!-- 메시지 스크롤 영역 -->
                <div id="chat-messages-container" style="height: 420px; overflow-y: auto; padding: 12px; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; scroll-behavior: smooth;">
                  <div style="text-align: center; color: #64748b; font-size: 0.85rem; padding: 40px 0;">💬 채팅 메시지를 불러오는 중...</div>
                </div>

                <!-- 이모지 퀵 입력 바 -->
                <div style="display: flex; gap: 6px; margin-bottom: 10px; overflow-x: auto; padding-bottom: 4px;">
                  <button type="button" class="chat-emoji-btn" onclick="insertEmoji('🦆')">🦆</button>
                  <button type="button" class="chat-emoji-btn" onclick="insertEmoji('💎')">💎</button>
                  <button type="button" class="chat-emoji-btn" onclick="insertEmoji('📈')">📈</button>
                  <button type="button" class="chat-emoji-btn" onclick="insertEmoji('🚀')">🚀</button>
                  <button type="button" class="chat-emoji-btn" onclick="insertEmoji('💰')">💰</button>
                  <button type="button" class="chat-emoji-btn" onclick="insertEmoji('🔥')">🔥</button>
                  <button type="button" class="chat-emoji-btn" onclick="insertEmoji('🎰')">🎰</button>
                  <button type="button" class="chat-emoji-btn" onclick="insertEmoji('🏆')">🏆</button>
                </div>

                <!-- 입력 폼 -->
                ${chatInputHtml}
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
                  <button class="btn-filter" onclick="selectNewsCategory('WTRD_UPDATE')">🦆 월덕 지주</button>
                  <button class="btn-filter" onclick="selectNewsCategory('MINING_BOOM')">⛏️ 광산 채굴</button>
                  <button class="btn-filter" onclick="selectNewsCategory('CASINO_JACKPOT')">🎰 카지노 엔터</button>
                  <button class="btn-filter" onclick="selectNewsCategory('BANK_POLICY')">🏦 중앙은행</button>
                  <button class="btn-filter" onclick="selectNewsCategory('NEKO_QUANTUM')">🐱 냥코 양자</button>
                  <button class="btn-filter" onclick="selectNewsCategory('FOOD_SURPRISE')">🍗 치킨 푸드</button>
                  <button class="btn-filter" onclick="selectNewsCategory('LOTTERY_FEVER')">⚡ 다이아 복권</button>
                  <button class="btn-filter" onclick="selectNewsCategory('TECH_INFRA')">🌐 데이터 테크</button>
                </div>
              </div>

              <div class="news-feed-grid" id="news-feed-container">
                ${newsFeedHtml || '<p style="color:#9ca3af;">등록된 시장 뉴스가 없습니다.</p>'}
              </div>
            </div>

            <!-- 탭 3: ⛏️ 골드 채굴 클리커 게임 -->
            <div id="tab-clicker" class="tab-pane">
              <div class="clicker-container">
                
                <!-- 클리커 채굴 영역 -->
                <div class="clicker-box" id="clicker-zone">
                  <h2 style="font-family: 'Outfit', sans-serif; font-size: 1.4rem; font-weight: 800; color: #fbbf24; margin-bottom: 4px;">⛏️ 골드 마이닝 클리커</h2>
                  <p style="color: #9ca3af; font-size: 0.85rem; margin-bottom: 12px;">보석을 마구 클릭하여 현금을 채굴하세요!</p>

                  <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--card-border); padding: 12px; border-radius: 14px; margin-bottom: 16px; display: flex; justify-content: space-around;">
                    <div>
                      <span style="font-size: 0.75rem; color: #9ca3af; display: block;">클릭당 채굴량</span>
                      <b id="clicker-power-val" style="color: #34d399; font-size: 1.1rem; font-family: 'Outfit', sans-serif;">+${powerVal.toLocaleString()}원</b>
                    </div>
                    <div>
                      <span style="font-size: 0.75rem; color: #9ca3af; display: block;">누적 클릭수</span>
                      <b id="clicker-clicks-val" style="color: #fbbf24; font-size: 1.1rem; font-family: 'Outfit', sans-serif;">${userAssets ? Number(userAssets.totalClicks).toLocaleString() : 0}회</b>
                    </div>
                    <div>
                      <span style="font-size: 0.75rem; color: #9ca3af; display: block;">자동 초당 채굴</span>
                      <b id="clicker-auto-val" style="color: #818cf8; font-size: 1.1rem; font-family: 'Outfit', sans-serif;">+${autoVal.toLocaleString()}원/s</b>
                    </div>
                  </div>

                  <div class="big-click-gem" id="gem-clicker" onclick="handleClickMining(event)">💎</div>
                  
                  <div style="font-size: 0.85rem; font-weight: 600; color: #cbd5e1; margin-top: 10px;" id="click-feedback-msg">
                    광석을 클릭하면 10% 확률로 3배 크리티컬 대박이 터집니다!
                  </div>
                </div>

                <!-- 업그레이드 상점 -->
                <div class="shop-box">
                  <h3 style="font-family: 'Outfit', sans-serif; font-size: 1.25rem; font-weight: 800; color: #e0e7ff; margin-bottom: 16px;">🛒 채굴기 업그레이드 상점</h3>

                  <div class="shop-item">
                    <div class="shop-item-info">
                      <h4>🔨 클릭 파워 강화 (Lv.<span id="shop-power-lv">${currentClickerLevel}</span>)</h4>
                      <p>클릭당 현금 획득량 +10원 증가</p>
                    </div>
                    <button class="btn-upgrade" onclick="buyUpgrade('power')"><span id="shop-power-cost">${powerCost.toLocaleString()}원</span> 강화</button>
                  </div>

                  <div class="shop-item">
                    <div class="shop-item-info">
                      <h4>🤖 자동 채굴 봇 (Lv.<span id="shop-auto-lv">${currentAutoLevel}</span>)</h4>
                      <p>아무것도 안 해도 초당 현금 +15원 자동 채굴</p>
                    </div>
                    <button class="btn-upgrade" onclick="buyUpgrade('auto')"><span id="shop-auto-cost">${autoCost.toLocaleString()}원</span> 구매</button>
                  </div>
                </div>

              </div>
            </div>

            <!-- 탭 4: 웹 카지노 & 도박 -->
            <div id="tab-casino" class="tab-pane">
              <div class="casino-hub-grid">
                
                <!-- 슬롯머신 -->
                <div class="casino-card">
                  <span class="turn-cost-tag">🎰 정통 카지노</span>
                  <div class="casino-title">🎰 3릴 슬롯머신</div>
                  <p class="casino-desc">💎다이아(25배), 7️⃣세븐(15배), 🔔골든벨(8배), 🍇포도(4배), 🍋레몬(2.5배), 🍒체리(2배), 🍒🍒(1.2배)</p>
                  
                  <div class="slot-display">
                    <div class="slot-reel" id="reel-1">🍒</div>
                    <div class="slot-reel" id="reel-2">7️⃣</div>
                    <div class="slot-reel" id="reel-3">💎</div>
                  </div>

                  <div class="bet-input-group">
                    <label>배팅 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="number" id="slot-bet" class="bet-input" value="5000" min="1000" step="1000">
                    </div>
                    <div class="btn-chip-grid">
                      <button class="btn-chip" onclick="setSlotBet(1000)">1천원</button>
                      <button class="btn-chip" onclick="setSlotBet(5000)">5천원</button>
                      <button class="btn-chip" onclick="setSlotBet(10000)">1만원</button>
                      <button class="btn-chip" onclick="setSlotBet(50000)">5만원</button>
                      <button class="btn-chip" style="background: rgba(239, 68, 68, 0.2); border-color: #ef4444; color: #fca5a5;" onclick="setSlotBet('all')">🔥 올인 (ALL-IN)</button>
                    </div>
                  </div>

                  <button class="btn-play-game" id="btn-spin-slot" onclick="playSlotMachine()">🎰 슬롯머신 레버 당기기</button>
                  <div class="game-result-box" id="slot-result">배팅금을 정하고 레버를 당겨보세요!</div>
                </div>

                <!-- 동전 던지기 -->
                <div class="casino-card">
                  <span class="turn-cost-tag">🪙 승률 50%</span>
                  <div class="casino-title">🪙 동전 던지기 (1.95배)</div>
                  <p class="casino-desc">앞면 또는 뒷면을 선택하고 동전을 던져 1.95배의 보상을 획득하세요!</p>
                  
                  <div class="coin-box" id="coin-element">🦅</div>

                  <div class="choice-btn-group">
                    <button class="btn-choice selected" id="choice-front" onclick="selectCoinChoice('앞면')">🦅 앞면</button>
                    <button class="btn-choice" id="choice-back" onclick="selectCoinChoice('뒷면')">👑 뒷면</button>
                  </div>

                  <div class="bet-input-group">
                    <label>배팅 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="number" id="coin-bet" class="bet-input" value="5000" min="1000" step="1000">
                    </div>
                    <div class="btn-chip-grid">
                      <button class="btn-chip" onclick="setCoinBet(1000)">1천원</button>
                      <button class="btn-chip" onclick="setCoinBet(5000)">5천원</button>
                      <button class="btn-chip" onclick="setCoinBet(10000)">1만원</button>
                      <button class="btn-chip" onclick="setCoinBet(50000)">5만원</button>
                      <button class="btn-chip" style="background: rgba(239, 68, 68, 0.2); border-color: #ef4444; color: #fca5a5;" onclick="setCoinBet('all')">🔥 올인 (ALL-IN)</button>
                    </div>
                  </div>

                  <button class="btn-play-game" id="btn-flip-coin" onclick="playCoinFlip()">🪙 동전 던지기</button>
                  <div class="game-result-box" id="coin-result">앞면/뒷면을 고르고 동전을 던져보세요!</div>
                </div>

                <!-- 주사위 대결 -->
                <div class="casino-card">
                  <span class="turn-cost-tag">🎲 1.95배 / 무승부 환불</span>
                  <div class="casino-title">🎲 주사위 대결 (1.95배)</div>
                  <p class="casino-desc">나와 딜러가 각각 2개의 주사위를 굴려 더 높은 숫자가 나오면 1.95배 승리!</p>
                  
                  <div class="slot-display" style="gap: 25px;">
                    <div style="text-align: center;">
                      <span style="font-size: 0.75rem; color: #9ca3af;">나의 주사위</span>
                      <div class="slot-reel" id="user-dice-box" style="margin-top: 4px;">🎲</div>
                    </div>
                    <div style="align-self: center; font-weight: 800; color: #fbbf24;">VS</div>
                    <div style="text-align: center;">
                      <span style="font-size: 0.75rem; color: #9ca3af;">딜러 주사위</span>
                      <div class="slot-reel" id="bot-dice-box" style="margin-top: 4px;">🤖</div>
                    </div>
                  </div>

                  <div class="bet-input-group">
                    <label>배팅 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="number" id="dice-bet" class="bet-input" value="5000" min="1000" step="1000">
                    </div>
                    <div class="btn-chip-grid">
                      <button class="btn-chip" onclick="setDiceBet(1000)">1천원</button>
                      <button class="btn-chip" onclick="setDiceBet(5000)">5천원</button>
                      <button class="btn-chip" onclick="setDiceBet(10000)">1만원</button>
                      <button class="btn-chip" onclick="setDiceBet(50000)">5만원</button>
                      <button class="btn-chip" style="background: rgba(239, 68, 68, 0.2); border-color: #ef4444; color: #fca5a5;" onclick="setDiceBet('all')">🔥 올인 (ALL-IN)</button>
                    </div>
                  </div>

                  <button class="btn-play-game" id="btn-roll-dice" onclick="playDice()">🎲 주사위 굴리기</button>
                  <div class="game-result-box" id="dice-result">딜러와의 한판 승부! 주사위를 굴려보세요.</div>
                </div>

                <!-- 🎫 럭키세븐 즉석 복권 -->
                <div class="casino-card">
                  <span class="turn-cost-tag" style="background: rgba(168, 85, 247, 0.2); border-color: #c084fc; color: #c084fc;">🎫 럭키세븐 복권</span>
                  <div class="casino-title" style="color: #c084fc;">🎫 럭키세븐 즉석 복권</div>
                  <p class="casino-desc">💎다이아(50배), 7️⃣럭키세븐(15배), 🔔골든벨(8배), 🍇포도(4배), 🍋레몬(2.5배), 🍒체리2개(1.5배)</p>
                  
                  <div class="slot-display" style="background: #1e1035; border-color: #8b5cf6;">
                    <div class="slot-reel" id="lottery-slot-1" style="background: #2e1065; border-color: #a855f7;">🎫</div>
                    <div class="slot-reel" id="lottery-slot-2" style="background: #2e1065; border-color: #a855f7;">🎫</div>
                    <div class="slot-reel" id="lottery-slot-3" style="background: #2e1065; border-color: #a855f7;">🎫</div>
                  </div>

                  <div class="bet-input-group">
                    <label>복권 구매 금액 (원)</label>
                    <div class="bet-input-row">
                      <input type="number" id="lottery-bet" class="bet-input" value="1000" min="1000" step="1000">
                    </div>
                    <div class="btn-chip-grid">
                      <button class="btn-chip" onclick="setLotteryBet(1000)">1장(1천원)</button>
                      <button class="btn-chip" onclick="setLotteryBet(5000)">5장(5천원)</button>
                      <button class="btn-chip" onclick="setLotteryBet(10000)">10장(1만원)</button>
                      <button class="btn-chip" onclick="setLotteryBet(50000)">50장(5만원)</button>
                      <button class="btn-chip" style="background: rgba(239, 68, 68, 0.2); border-color: #ef4444; color: #fca5a5;" onclick="setLotteryBet('all')">🔥 올인 (ALL-IN)</button>
                    </div>
                  </div>

                  <button class="btn-play-game" id="btn-scratch-lottery" style="background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%); box-shadow: 0 4px 16px rgba(168, 85, 247, 0.4);" onclick="playInstantLottery()">🎫 즉석 복권 긁기</button>
                  <div class="game-result-box" id="lottery-result">복권 장수를 정하고 즉석 복권을 긁어보세요!</div>
                </div>

              </div>
            </div>

            <!-- 탭: 🏇 월덕 그랑프리 실시간 경마장 -->
            <div id="tab-horse" class="tab-pane">
              <div style="background: rgba(17, 24, 39, 0.85); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 20px; padding: 24px; margin-bottom: 30px; backdrop-filter: blur(12px);">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; border-bottom: 1px solid var(--card-border); padding-bottom: 14px;">
                  <div>
                    <h2 style="font-family: 'Outfit', sans-serif; font-size: 1.6rem; color: #fbbf24; display: flex; align-items: center; gap: 8px;">
                      🏇 월덕 그랑프리 실시간 경마장
                    </h2>
                    <p style="color: #9ca3af; font-size: 0.85rem; margin-top: 4px;">출전마를 선택하고 배팅하세요! 출발 총성과 함께 실시간으로 결승선을 향해 질주합니다.</p>
                  </div>
                  <span style="background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.4); color: #fbbf24; padding: 6px 14px; border-radius: 999px; font-weight: 700; font-size: 0.8rem;">
                    🏆 최대 배당 15.0배 잭팟
                  </span>
                </div>

                <!-- 1. 출전마 선택 카드 그리드 -->
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px;">
                  <div class="horse-card selected" id="horse-card-1" onclick="selectHorse(1)" style="cursor: pointer; background: rgba(0,0,0,0.4); border: 2px solid #fbbf24; border-radius: 12px; padding: 14px; text-align: center; transition: all 0.2s;">
                    <div style="font-size: 1.8rem;">⚡</div>
                    <div style="font-weight: 800; color: #fff; font-size: 1rem; margin-top: 4px;">1번 황금번개</div>
                    <div style="color: #fbbf24; font-weight: 800; font-size: 1.1rem; margin: 4px 0;">2.0배</div>
                    <div style="font-size: 0.72rem; color: #9ca3af;">정배당 / 우승 확률 45%</div>
                  </div>

                  <div class="horse-card" id="horse-card-2" onclick="selectHorse(2)" style="cursor: pointer; background: rgba(0,0,0,0.4); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px; text-align: center; transition: all 0.2s;">
                    <div style="font-size: 1.8rem;">🌪️</div>
                    <div style="font-weight: 800; color: #fff; font-size: 1rem; margin-top: 4px;">2번 질풍노도</div>
                    <div style="color: #38bdf8; font-weight: 800; font-size: 1.1rem; margin: 4px 0;">3.0배</div>
                    <div style="font-size: 0.72rem; color: #9ca3af;">균형형 / 우승 확률 30%</div>
                  </div>

                  <div class="horse-card" id="horse-card-3" onclick="selectHorse(3)" style="cursor: pointer; background: rgba(0,0,0,0.4); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px; text-align: center; transition: all 0.2s;">
                    <div style="font-size: 1.8rem;">🖤</div>
                    <div style="font-weight: 800; color: #fff; font-size: 1rem; margin-top: 4px;">3번 다크호스</div>
                    <div style="color: #a855f7; font-weight: 800; font-size: 1.1rem; margin: 4px 0;">5.0배</div>
                    <div style="font-size: 0.72rem; color: #9ca3af;">복병마 / 우승 확률 18%</div>
                  </div>

                  <div class="horse-card" id="horse-card-4" onclick="selectHorse(4)" style="cursor: pointer; background: rgba(0,0,0,0.4); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px; text-align: center; transition: all 0.2s;">
                    <div style="font-size: 1.8rem;">🦆</div>
                    <div style="font-weight: 800; color: #fff; font-size: 1rem; margin-top: 4px;">4번 월덕스피릿</div>
                    <div style="color: #f43f5e; font-weight: 800; font-size: 1.1rem; margin: 4px 0;">8.0배</div>
                    <div style="font-size: 0.72rem; color: #9ca3af;">커뮤니티 대표마 / 10%</div>
                  </div>

                  <div class="horse-card" id="horse-card-5" onclick="selectHorse(5)" style="cursor: pointer; background: rgba(0,0,0,0.4); border: 1px solid var(--card-border); border-radius: 12px; padding: 14px; text-align: center; transition: all 0.2s;">
                    <div style="font-size: 1.8rem;">💎</div>
                    <div style="font-weight: 800; color: #fff; font-size: 1rem; margin-top: 4px;">5번 로또잭팟</div>
                    <div style="color: #ec4899; font-weight: 800; font-size: 1.1rem; margin: 4px 0;">15.0배</div>
                    <div style="font-size: 0.72rem; color: #9ca3af;">인생역전 잭팟 / 5%</div>
                  </div>
                </div>

                <!-- 2. 배팅 금액 입력 & 칩 버튼 -->
                <div style="background: rgba(0,0,0,0.25); border: 1px solid var(--card-border); border-radius: 12px; padding: 16px; margin-bottom: 20px;">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <label style="font-size: 0.85rem; color: #9ca3af; font-weight: 600;">배팅 금액 (원)</label>
                    <span style="font-size: 0.8rem; color: #34d399;">선택한 말: <b id="selected-horse-txt" style="color: #fbbf24;">1번 황금번개 (2.0배)</b></span>
                  </div>
                  <div style="display: flex; gap: 8px; margin-bottom: 10px;">
                    <input type="number" id="horse-bet-input" value="5000" min="1000" step="1000" style="flex: 1; background: #111827; border: 1px solid var(--card-border); color: #fff; padding: 10px 14px; border-radius: 8px; font-size: 1rem; font-family: inherit;">
                    <button id="btn-start-race" onclick="startWebHorseRace()" style="background: linear-gradient(135deg, #f59e0b, #d97706); border: none; color: #000; font-weight: 800; font-size: 1rem; padding: 10px 24px; border-radius: 8px; cursor: pointer; white-space: nowrap; box-shadow: 0 4px 14px rgba(245, 158, 11, 0.4);">
                      🏇 경주 시작하기!
                    </button>
                  </div>
                  <div class="btn-chip-grid">
                    <button class="btn-chip" onclick="setHorseBet(1000)">1천원</button>
                    <button class="btn-chip" onclick="setHorseBet(5000)">5천원</button>
                    <button class="btn-chip" onclick="setHorseBet(10000)">1만원</button>
                    <button class="btn-chip" onclick="setHorseBet(50000)">5만원</button>
                    <button class="btn-chip" onclick="setHorseBet(100000)">10만원</button>
                    <button class="btn-chip" style="background: rgba(239, 68, 68, 0.2); border-color: #ef4444; color: #fca5a5;" onclick="setHorseBet('all')">🔥 올인 (ALL-IN)</button>
                  </div>
                </div>

                <!-- 3. 실시간 그래픽 경주장 트랙 (5개 레인) -->
                <div style="background: #090d16; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; position: relative; overflow: hidden;">
                  <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: #64748b; margin-bottom: 12px; border-bottom: 1px dashed rgba(255,255,255,0.1); padding-bottom: 6px;">
                    <span>🚩 출발선 (START)</span>
                    <span id="race-status-banner" style="font-weight: 700; color: #fbbf24;">🏇 레이스 대기 중</span>
                    <span>🏁 결승선 (FINISH)</span>
                  </div>

                  <div style="display: flex; flex-direction: column; gap: 12px;" id="race-lanes-box">
                    <!-- 레인 1 -->
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 0.8rem; font-weight: 700; color: #fbbf24; width: 85px;">1. 황금번개</span>
                      <div style="flex: 1; background: rgba(255,255,255,0.05); height: 26px; border-radius: 6px; position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div id="horse-runner-1" style="position: absolute; left: 0%; top: 2px; font-size: 1.1rem; transition: left 0.3s ease-out;">⚡🏇</div>
                      </div>
                    </div>
                    <!-- 레인 2 -->
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 0.8rem; font-weight: 700; color: #38bdf8; width: 85px;">2. 질풍노도</span>
                      <div style="flex: 1; background: rgba(255,255,255,0.05); height: 26px; border-radius: 6px; position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div id="horse-runner-2" style="position: absolute; left: 0%; top: 2px; font-size: 1.1rem; transition: left 0.3s ease-out;">🌪️🏇</div>
                      </div>
                    </div>
                    <!-- 레인 3 -->
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 0.8rem; font-weight: 700; color: #a855f7; width: 85px;">3. 다크호스</span>
                      <div style="flex: 1; background: rgba(255,255,255,0.05); height: 26px; border-radius: 6px; position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div id="horse-runner-3" style="position: absolute; left: 0%; top: 2px; font-size: 1.1rem; transition: left 0.3s ease-out;">🖤🏇</div>
                      </div>
                    </div>
                    <!-- 레인 4 -->
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 0.8rem; font-weight: 700; color: #f43f5e; width: 85px;">4. 월덕스피릿</span>
                      <div style="flex: 1; background: rgba(255,255,255,0.05); height: 26px; border-radius: 6px; position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div id="horse-runner-4" style="position: absolute; left: 0%; top: 2px; font-size: 1.1rem; transition: left 0.3s ease-out;">🦆🏇</div>
                      </div>
                    </div>
                    <!-- 레인 5 -->
                    <div style="display: flex; align-items: center; gap: 10px;">
                      <span style="font-size: 0.8rem; font-weight: 700; color: #ec4899; width: 85px;">5. 로또잭팟</span>
                      <div style="flex: 1; background: rgba(255,255,255,0.05); height: 26px; border-radius: 6px; position: relative; overflow: hidden; border: 1px solid rgba(255,255,255,0.05);">
                        <div id="horse-runner-5" style="position: absolute; left: 0%; top: 2px; font-size: 1.1rem; transition: left 0.3s ease-out;">💎🏇</div>
                      </div>
                    </div>
                  </div>

                  <!-- 결과 박스 -->
                  <div id="horse-race-result-box" style="margin-top: 16px; padding: 12px; background: rgba(0,0,0,0.5); border-radius: 8px; text-align: center; font-size: 0.95rem; font-weight: 700; color: #9ca3af;">
                    말을 선택하고 배팅 후 [경주 시작하기] 버튼을 누르세요!
                  </div>
                </div>

              </div>
            </div>

            <!-- 탭 6: 순위표 -->
            <div id="tab-ranking" class="tab-pane">
              <h2 class="section-title">🏆 실시간 자산가 랭킹 TOP 10</h2>
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

            <!-- 💬 24시간 1:1 고객센터 & 관리자 문의창구 배너 -->
            <div class="support-footer-banner">
              <div class="support-banner-left">
                <div class="support-avatar-badge">🎧</div>
                <div>
                  <h3 class="support-title">24시간 1:1 고객센터 & 관리자 문의창구</h3>
                  <p class="support-subtitle">이용 중 오류/버그 제보, 계정/자산 복구 문의, 건의사항이 있으시면 언제든 1:1 문의를 남겨주세요. 관리자에게 실시간 알림이 전송되며 빠른 답변을 확인하실 수 있습니다.</p>
                </div>
              </div>
              <div class="support-banner-right">
                <button class="btn-support-action btn-support-write" onclick="openInquiryModal()">✍️ 1:1 문의하기</button>
                <button class="btn-support-action btn-support-view" onclick="openProfileModal('inquiries')">📋 내 문의 내역 & 답변</button>
              </div>
            </div>

            <!-- 🌐 사이트 푸터 & 개인정보처리방침 링크 -->
            <footer class="app-site-footer">
              <div class="footer-content">
                <div class="footer-brand">
                  <div class="footer-logo">🦆 월덕 (Duck Economy Bot & Web)</div>
                  <p class="footer-desc">실시간 가상 주식 거래 차트, 골드 채굴 클리커, 미니 카지노 게임 및 24시간 1:1 고객센터 지원 시스템</p>
                </div>
                <div class="footer-links">
                  <a href="/privacy" class="footer-link highlight">🔒 개인정보처리방침</a>
                  <a href="/terms" class="footer-link">📜 서비스 이용약관</a>
                  <a href="javascript:void(0)" onclick="openInquiryModal()" class="footer-link">✍️ 1:1 고객센터</a>
                  <a href="/auth/guide" class="footer-link">⚙️ OAuth 안내</a>
                </div>
              </div>
              <div class="footer-bottom">
                <span>© 2026 Duck Economy Project. All rights reserved. 본 웹 애플리케이션의 모든 가상 화폐 및 주식은 Discord 봇 게임용 가상 데이터입니다.</span>
              </div>
            </footer>

          </div>

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
                  <span id="detail-price" style="font-family: 'Outfit', sans-serif; font-size: 1.5rem; font-weight: 800; color: #fff;">0원</span>
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
                <div style="display: flex; justify-content: space-between; font-size: 0.85rem; color: #9ca3af;">
                  <span>보유 현금</span>
                  <span id="modal-user-cash-info" style="color: #34d399; font-weight: 700;">0원</span>
                </div>
              </div>
              
              <div class="bet-input-group">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <label style="margin: 0;">주문 수량 (소수점 거래 가능)</label>
                  <span style="font-size: 0.75rem; color: #818cf8;">소수점(0.1주~) 및 전량 지원</span>
                </div>
                <input type="number" id="trade-amount-input" class="bet-input" value="1" min="0.0001" step="0.01" oninput="calcTradeTotal()">
                
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
              <div class="choice-btn-group">
                <button class="btn-choice selected" id="bank-act-deposit" onclick="selectBankAction('deposit')">💵 입금 (현금 ➔ 예금)</button>
                <button class="btn-choice" id="bank-act-withdraw" onclick="selectBankAction('withdraw')">🏧 출금 (예금 ➔ 현금)</button>
              </div>

              <div class="bet-input-group">
                <label>이체 금액 (원)</label>
                <input type="number" id="bank-amount-input" class="bet-input" value="10000" min="1000" step="1000">
                <div class="btn-chip-grid" style="margin-top: 8px;">
                  <button class="btn-chip" onclick="document.getElementById('bank-amount-input').value = 10000">1만원</button>
                  <button class="btn-chip" onclick="document.getElementById('bank-amount-input').value = 50000">5만원</button>
                  <button class="btn-chip" onclick="document.getElementById('bank-amount-input').value = 100000">10만원</button>
                  <button class="btn-chip" onclick="document.getElementById('bank-amount-input').value = 500000">50만원</button>
                  <button class="btn-chip" style="background: rgba(99, 102, 241, 0.25); border-color: #818cf8; color: #fff;" onclick="document.getElementById('bank-amount-input').value = 'all'">🔥 전액(ALL)</button>
                </div>
              </div>

              <button class="btn-play-game" onclick="submitBankTransfer()">이체 실행</button>
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
                  <input type="file" id="inquiry-image-file" accept="image/*" class="inquiry-input" style="padding: 6px 10px; font-size: 0.82rem;" onchange="handleInquiryImageSelect(event)">
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
            <button id="btn-floating-chat-toggle" onclick="toggleFloatingChat()" title="💬 실시간 광장 채팅 열기/닫기">
              <span>💬</span>
              <span>실시간 채팅</span>
              <span id="floating-chat-badge" class="chat-unread-badge" style="display:none;">NEW</span>
            </button>

            <!-- 플로팅 채팅 드로어 창 -->
            <div id="floating-chat-drawer" style="display: none;">
              <div class="floating-chat-header">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span class="pulse-dot"></span>
                  <span style="font-weight: 800; font-size: 0.95rem; color: #fff;">💬 광장 실시간 채팅</span>
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
          <script>
            let userHoldings = {};
            try {
              userHoldings = JSON.parse(document.getElementById('user-holdings-data').textContent || '{}');
            } catch(e) {}
            let selectedCoin = '앞면';
            let currentTrade = { stockId: '', name: '', price: 0, action: 'buy' };
            let currentDetailStock = null;
            let currentBankAction = 'deposit';
            let clickCountBuffer = 0;
            let clickFlushTimer = null;
            let currentNewsCategory = 'ALL';
            let currentFeedType = 'ALL';
            let feedItemsCache = [];
            let isGameInProgress = false;

            // 🌟 사용자 친화적 플로팅 토스트 알림 함수
            function showToast(type, title, message) {
              const container = document.getElementById('toast-container');
              const toast = document.createElement('div');
              toast.className = 'toast';
              const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : (type === 'warn' ? '⚠️' : 'ℹ️'));
              const borderCol = type === 'success' ? '#10b981' : (type === 'error' ? '#ef4444' : (type === 'warn' ? '#f59e0b' : '#6366f1'));
              toast.style.borderColor = borderCol;

              toast.innerHTML = 
                '<span class="toast-icon">' + icon + '</span>' +
                '<div>' +
                  '<div class="toast-title">' + title + '</div>' +
                  '<div class="toast-msg">' + message + '</div>' +
                '</div>';

              container.appendChild(toast);
              setTimeout(() => {
                toast.classList.add('toast-hide');
                setTimeout(() => toast.remove(), 300);
              }, 3200);
            }

            function getCurrentUserCashNum() {
              const text = document.getElementById('my-cash')?.innerText || '0';
              return parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
            }

            function setGameLock(inProgress) {
              isGameInProgress = inProgress;
              const buttons = [
                document.getElementById('btn-spin-slot'),
                document.getElementById('btn-flip-coin'),
                document.getElementById('btn-roll-dice')
              ];
              buttons.forEach(btn => {
                if (btn) {
                  btn.disabled = inProgress;
                  btn.style.opacity = inProgress ? '0.6' : '1';
                  btn.style.cursor = inProgress ? 'not-allowed' : 'pointer';
                }
              });
            }

            function switchTab(tabId) {
              if (!tabId || !document.getElementById(tabId)) return;

              document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
              document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
              
              const targetBtn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick')?.includes(tabId));
              if (targetBtn) targetBtn.classList.add('active');

              const targetPane = document.getElementById(tabId);
              if (targetPane) targetPane.classList.add('active');

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
              }
            }

            // 🚀 페이지 로드 시 이전에 열어둔 탭 복원
            function restoreActiveTabOnLoad() {
              try {
                const hash = window.location.hash ? window.location.hash.replace('#', '') : '';
                const savedTab = hash || localStorage.getItem('duck_active_tab');
                if (savedTab && document.getElementById(savedTab)) {
                  switchTab(savedTab);
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
                        '<h4>' + item.title + '</h4>' +
                        '<p>' + item.desc + '</p>' +
                      '</div>' +
                    '</div>' +
                    '<div class="feed-time-col">' +
                      '<span class="feed-time-text">⏱️ ' + timeStr + '</span>' +
                      '<span class="feed-actor-tag">' + item.actor + '</span>' +
                    '</div>' +
                  '</div>';
              });
              container.innerHTML = html;
            }

            // 3초 주기 라이브 피드 자동 새로고침
            setInterval(() => {
              if (document.getElementById('tab-feed').classList.contains('active')) {
                fetchLiveActivityFeed();
              }
            }, 3000);

            function selectCoinChoice(choice) {
              if (isGameInProgress) return;
              selectedCoin = choice;
              document.getElementById('choice-front').classList.toggle('selected', choice === '앞면');
              document.getElementById('choice-back').classList.toggle('selected', choice === '뒷면');
            }

            function setSlotBet(val) {
              if (isGameInProgress) return;
              if (val === 'all') {
                const cash = getCurrentUserCashNum();
                document.getElementById('slot-bet').value = cash > 0 ? cash : 'all';
              } else {
                document.getElementById('slot-bet').value = val;
              }
            }

            function setCoinBet(val) {
              if (isGameInProgress) return;
              if (val === 'all') {
                const cash = getCurrentUserCashNum();
                document.getElementById('coin-bet').value = cash > 0 ? cash : 'all';
              } else {
                document.getElementById('coin-bet').value = val;
              }
            }

            function setDiceBet(val) {
              if (isGameInProgress) return;
              if (val === 'all') {
                const cash = getCurrentUserCashNum();
                document.getElementById('dice-bet').value = cash > 0 ? cash : 'all';
              } else {
                document.getElementById('dice-bet').value = val;
              }
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

            // 1. ⛏️ 클리커 채굴 클릭 핸들러
            function handleClickMining(e) {
              const gem = document.getElementById('gem-clicker');
              gem.classList.remove('gem-hit');
              void gem.offsetWidth; // reflow
              gem.classList.add('gem-hit');

              const isCrit = Math.random() < 0.10;
              const powerValStr = document.getElementById('clicker-power-val')?.innerText || '10';
              const powerVal = parseInt(powerValStr.replace(/[^0-9]/g, ''), 10) || 10;
              const gain = isCrit ? (powerVal * 3) : powerVal;
              const text = isCrit ? ('🔥 3X 대박! +' + gain.toLocaleString() + '원') : ('+' + gain.toLocaleString() + '원');

              const floatElem = document.createElement('div');
              floatElem.className = 'floating-coin' + (isCrit ? ' crit' : '');
              floatElem.innerText = text;
              
              const zone = document.getElementById('clicker-zone');
              const zoneRect = zone.getBoundingClientRect();
              const clickX = (e && e.clientX) ? (e.clientX - zoneRect.left) : (zoneRect.width / 2);
              const clickY = (e && e.clientY) ? (e.clientY - zoneRect.top) : (zoneRect.height / 2);
              floatElem.style.left = Math.max(10, Math.min(zoneRect.width - 120, clickX - 30)) + 'px';
              floatElem.style.top = Math.max(10, clickY - 20) + 'px';
              zone.appendChild(floatElem);
              setTimeout(() => floatElem.remove(), 700);

              clickCountBuffer++;
              if (clickFlushTimer) clearTimeout(clickFlushTimer);
              clickFlushTimer = setTimeout(flushClickBuffer, 200);
            }

            async function flushClickBuffer() {
              if (clickCountBuffer <= 0) return;
              const count = clickCountBuffer;
              clickCountBuffer = 0;

              try {
                const res = await fetch('/api/clicker/click', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ count })
                });
                const data = await res.json();
                if (data.success) {
                  updateUserCashDisplay(data.newCash);
                  const clicksValElem = document.getElementById('clicker-clicks-val');
                  if (clicksValElem && data.totalClicks) {
                    clicksValElem.innerText = Number(data.totalClicks).toLocaleString() + '회';
                  }
                }
              } catch (e) {}
            }

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
                if (data.clickerLevel !== undefined) {
                  document.getElementById('clicker-power-val').innerText = '+' + (data.clickerLevel * 10).toLocaleString() + '원';
                  document.getElementById('shop-power-lv').innerText = data.clickerLevel;
                  document.getElementById('shop-power-cost').innerText = (data.clickerLevel * 4500).toLocaleString() + '원';
                }
                if (data.autoLevel !== undefined) {
                  document.getElementById('clicker-auto-val').innerText = '+' + (data.autoLevel * 15).toLocaleString() + '원/s';
                  document.getElementById('shop-auto-lv').innerText = data.autoLevel;
                  document.getElementById('shop-auto-cost').innerText = ((data.autoLevel + 1) * 12000).toLocaleString() + '원';
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
                document.getElementById('detail-price').innerText = s.price.toLocaleString() + '원';
                
                const rateElem = document.getElementById('detail-rate');
                rateElem.innerText = (isUp ? '▲ +' : '▼ ') + rate + '%';
                rateElem.style.color = isUp ? '#34d399' : '#f87171';

                document.getElementById('detail-high').innerText = s.high_24h.toLocaleString() + '원';
                document.getElementById('detail-low').innerText = s.low_24h.toLocaleString() + '원';
                document.getElementById('detail-cap').innerText = formatCap(s.market_cap);
                document.getElementById('detail-pe-div').innerText = s.pe_ratio + '배 / ' + s.dividend_yield + '%';
                
                const userHoldNum = Number(s.userHolding || 0);
                const stackStr = userHoldNum > 0 ? (userHoldNum / 10).toFixed(1) + '스택' : '0스택';
                const holdingElem = document.getElementById('detail-my-holding');
                if (holdingElem) holdingElem.innerText = userHoldNum.toLocaleString() + '주 (' + stackStr + ')';
                const avgElem = document.getElementById('detail-my-avg');
                if (avgElem) avgElem.innerText = (s.userAvgPrice ? Number(s.userAvgPrice).toLocaleString() : '0') + '원';

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
              setGameLock(true);

              const bet = document.getElementById('slot-bet').value;
              const resultBox = document.getElementById('slot-result');
              const btn = document.getElementById('btn-spin-slot');
              const reel1 = document.getElementById('reel-1');
              const reel2 = document.getElementById('reel-2');
              const reel3 = document.getElementById('reel-3');

              reel1.classList.add('spinning');
              reel2.classList.add('spinning');
              reel3.classList.add('spinning');
              btn.innerText = '⏳ 슬롯머신 회전 중...';
              resultBox.innerText = '🎰 릴이 회전하고 있습니다...';
              resultBox.style.color = '#fbbf24';

              try {
                const res = await fetch('/api/game/slot', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bet })
                });
                const data = await res.json();
                
                setTimeout(() => {
                  reel1.classList.remove('spinning');
                  reel2.classList.remove('spinning');
                  reel3.classList.remove('spinning');
                  setGameLock(false);
                  btn.innerText = '🎰 슬롯머신 레버 당기기';

                  if (!data.success) {
                    resultBox.innerText = '❌ ' + (data.error || '오류 발생');
                    resultBox.style.color = '#ef4444';
                    showToast('error', '슬롯 오류', data.error);
                    return;
                  }

                  reel1.innerText = data.reels[0];
                  reel2.innerText = data.reels[1];
                  reel3.innerText = data.reels[2];

                  resultBox.innerText = data.message;
                  resultBox.style.color = data.isWin ? '#34d399' : '#f87171';
                  updateUserCashDisplay(data.newCash);
                  showToast(data.isWin ? 'success' : 'info', '🎰 슬롯머신 결과', data.message);
                }, 1000);
              } catch (e) {
                setGameLock(false);
                btn.innerText = '🎰 슬롯머신 레버 당기기';
                reel1.classList.remove('spinning');
                reel2.classList.remove('spinning');
                reel3.classList.remove('spinning');
                resultBox.innerText = '서버 통신 실패';
                showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
              }
            }

            // 4. 🪙 동전 던지기 실행
            async function playCoinFlip() {
              if (isGameInProgress) return;
              setGameLock(true);

              const bet = document.getElementById('coin-bet').value;
              const coin = document.getElementById('coin-element');
              const resultBox = document.getElementById('coin-result');
              const btn = document.getElementById('btn-flip-coin');

              coin.classList.add('flipping');
              btn.innerText = '⏳ 동전 던지는 중...';
              resultBox.innerText = '🪙 동전이 회전하고 있습니다...';

              try {
                const res = await fetch('/api/game/coinflip', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bet, choice: selectedCoin })
                });
                const data = await res.json();

                setTimeout(() => {
                  coin.classList.remove('flipping');
                  setGameLock(false);
                  btn.innerText = '🪙 동전 던지기';

                  if (!data.success) {
                    resultBox.innerText = '❌ ' + (data.error || '오류 발생');
                    resultBox.style.color = '#ef4444';
                    showToast('error', '동전 던지기 오류', data.error);
                    return;
                  }

                  coin.innerText = data.coinResult === '앞면' ? '🦅' : '👑';
                  resultBox.innerText = data.message;
                  resultBox.style.color = data.isWin ? '#34d399' : '#f87171';
                  updateUserCashDisplay(data.newCash);
                  showToast(data.isWin ? 'success' : 'info', '🪙 동전 결과', data.message);
                }, 900);
              } catch (e) {
                setGameLock(false);
                btn.innerText = '🪙 동전 던지기';
                coin.classList.remove('flipping');
                resultBox.innerText = '서버 통신 실패';
                showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
              }
            }

            // 5. 🎲 주사위 대결
            async function playDice() {
              if (isGameInProgress) return;
              setGameLock(true);

              const bet = document.getElementById('dice-bet').value;
              const userBox = document.getElementById('user-dice-box');
              const botBox = document.getElementById('bot-dice-box');
              const resultBox = document.getElementById('dice-result');
              const btn = document.getElementById('btn-roll-dice');

              btn.innerText = '⏳ 주사위 굴리는 중...';
              userBox.innerText = '🎲';
              botBox.innerText = '🎲';
              resultBox.innerText = '🎲 주사위를 굴리고 있습니다...';

              try {
                const res = await fetch('/api/game/dice', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bet })
                });
                const data = await res.json();

                setTimeout(() => {
                  setGameLock(false);
                  btn.innerText = '🎲 주사위 굴리기';

                  if (!data.success) {
                    resultBox.innerText = '❌ ' + (data.error || '오류 발생');
                    resultBox.style.color = '#ef4444';
                    showToast('error', '주사위 오류', data.error);
                    return;
                  }

                  userBox.innerText = data.userDice[2];
                  botBox.innerText = data.botDice[2];
                  resultBox.innerText = data.message;
                  resultBox.style.color = data.isWin ? '#34d399' : (data.isTie ? '#fbbf24' : '#f87171');
                  updateUserCashDisplay(data.newCash);
                  showToast(data.isWin ? 'success' : (data.isTie ? 'warn' : 'info'), '🎲 주사위 결과', data.message);
                }, 800);
              } catch (e) {
                setGameLock(false);
                btn.innerText = '🎲 주사위 굴리기';
                resultBox.innerText = '서버 통신 실패';
                showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
              }
            }

            // 5.5 🎫 럭키세븐 즉석 복권 게임
            function setLotteryBet(amount) {
              const input = document.getElementById('lottery-bet');
              if (amount === 'all') {
                input.value = getCurrentUserCashNum();
              } else {
                input.value = amount;
              }
            }

            async function playInstantLottery() {
              if (isGameInProgress) return;
              setGameLock(true);

              const bet = document.getElementById('lottery-bet').value;
              const r1 = document.getElementById('lottery-slot-1');
              const r2 = document.getElementById('lottery-slot-2');
              const r3 = document.getElementById('lottery-slot-3');
              const resultBox = document.getElementById('lottery-result');
              const btn = document.getElementById('btn-scratch-lottery');

              r1.classList.add('spinning');
              r2.classList.add('spinning');
              r3.classList.add('spinning');
              btn.innerText = '⏳ 복권 긁는 중...';
              resultBox.innerText = '🎫 즉석 복권을 긁고 있습니다...';
              resultBox.style.color = '#c084fc';

              try {
                const res = await fetch('/api/game/lottery', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ bet })
                });
                const data = await res.json();

                setTimeout(() => {
                  r1.classList.remove('spinning');
                  r2.classList.remove('spinning');
                  r3.classList.remove('spinning');
                  setGameLock(false);
                  btn.innerText = '🎫 즉석 복권 긁기';

                  if (!data.success) {
                    resultBox.innerText = '❌ ' + (data.error || '오류 발생');
                    resultBox.style.color = '#ef4444';
                    showToast('error', '복권 오류', data.error);
                    return;
                  }

                  r1.innerText = data.symbols[0];
                  r2.innerText = data.symbols[1];
                  r3.innerText = data.symbols[2];

                  resultBox.innerText = data.message;
                  resultBox.style.color = data.isWin ? '#34d399' : '#f87171';
                  updateUserCashDisplay(data.newCash);
                  showToast(data.isWin ? 'success' : 'info', '🎫 복권 결과', data.message);
                }, 800);
              } catch (e) {
                setGameLock(false);
                btn.innerText = '🎫 즉석 복권 긁기';
                r1.classList.remove('spinning');
                r2.classList.remove('spinning');
                r3.classList.remove('spinning');
                resultBox.innerText = '서버 통신 실패';
                showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
              }
            }

            // 5.6 🏇 월덕 그랑프리 실시간 경마 스크립트
            let selectedHorseId = 1;
            const HORSES_INFO = {
              1: { name: '1번 황금번개', odds: '2.0배', color: '#fbbf24' },
              2: { name: '2번 질풍노도', odds: '3.0배', color: '#38bdf8' },
              3: { name: '3번 다크호스', odds: '5.0배', color: '#a855f7' },
              4: { name: '4번 월덕스피릿', odds: '8.0배', color: '#f43f5e' },
              5: { name: '5번 로또잭팟', odds: '15.0배', color: '#ec4899' }
            };

            function selectHorse(id) {
              selectedHorseId = id;
              document.querySelectorAll('.horse-card').forEach((el, idx) => {
                if (idx + 1 === id) {
                  el.style.border = '2px solid #fbbf24';
                  el.style.transform = 'scale(1.03)';
                } else {
                  el.style.border = '1px solid var(--card-border)';
                  el.style.transform = 'scale(1)';
                }
              });
              const info = HORSES_INFO[id];
              const txt = document.getElementById('selected-horse-txt');
              if (txt && info) {
                txt.innerText = info.name + ' (' + info.odds + ')';
                txt.style.color = info.color;
              }
            }

            function setHorseBet(amount) {
              const input = document.getElementById('horse-bet-input');
              if (amount === 'all') {
                input.value = getCurrentUserCashNum();
              } else {
                input.value = amount;
              }
            }

            async function startWebHorseRace() {
              if (isGameInProgress) return;
              setGameLock(true);

              const betInput = document.getElementById('horse-bet-input');
              const bet = betInput.value;
              const btn = document.getElementById('btn-start-race');
              const banner = document.getElementById('race-status-banner');
              const resultBox = document.getElementById('horse-race-result-box');

              // 러너 초기화
              for (let i = 1; i <= 5; i++) {
                const el = document.getElementById('horse-runner-' + i);
                if (el) el.style.left = '0%';
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
                  body: JSON.stringify({ horseId: selectedHorseId, amount: bet })
                });
                const data = await res.json();

                if (!data.success) {
                  setGameLock(false);
                  btn.innerText = '🏇 경주 시작하기!';
                  banner.innerText = '⚠️ 오류 발생';
                  resultBox.innerText = '❌ ' + (data.error || '오류 발생');
                  resultBox.style.color = '#ef4444';
                  showToast('error', '경마 오류', data.error);
                  return;
                }

                // 1단계: 스타트 질주 애니메이션 (1.0초)
                setTimeout(() => {
                  banner.innerText = '🔥 200m 통과! 선두권 쟁탈전 치열!';
                  for (let i = 1; i <= 5; i++) {
                    const el = document.getElementById('horse-runner-' + i);
                    if (el) el.style.left = (Math.random() * 25 + 15) + '%';
                  }
                }, 800);

                // 2단계: 코너 라스트 스퍼트 (2.0초)
                setTimeout(() => {
                  banner.innerText = '⚡ 마지막 직선 주로 진입! 라스트 스퍼트!';
                  for (let i = 1; i <= 5; i++) {
                    const el = document.getElementById('horse-runner-' + i);
                    const isWinner = (i === data.winner.id);
                    if (el) el.style.left = isWinner ? (Math.random() * 15 + 65) + '%' : (Math.random() * 20 + 45) + '%';
                  }
                }, 1800);

                // 3단계: 결승선 골인 및 결과 발표 (3.0초)
                setTimeout(() => {
                  setGameLock(false);
                  btn.innerText = '🏇 경주 시작하기!';
                  banner.innerText = '🏁 결승선 통과 완료!';

                  for (let i = 1; i <= 5; i++) {
                    const el = document.getElementById('horse-runner-' + i);
                    if (el) {
                      if (i === data.winner.id) {
                        el.style.left = '88%';
                        el.innerText = '🏆🏇';
                      } else {
                        el.style.left = (Math.random() * 15 + 60) + '%';
                        el.innerText = (HORSES_INFO[i]?.name.slice(2, 3) || '') + '🏇';
                      }
                    }
                  }

                  if (data.isWin) {
                    resultBox.innerHTML = '🎉 <b style="color:#10b981;">우승 적중!</b> 1위 우승마: <b>' + data.winner.name + '</b> (' + data.odds.toFixed(1) + '배) | 상금: <b>+' + Number(data.payout).toLocaleString() + '원</b>';
                    resultBox.style.color = '#10b981';
                    showToast('success', '🏇 경마 대박!', '1위 [' + data.winner.name + '] 적중! +' + Number(data.payout).toLocaleString() + '원 획득!');
                  } else {
                    resultBox.innerHTML = '💀 <b style="color:#f87171;">탈락!</b> 1위 우승마: <b>' + data.winner.name + '</b> (내 선택: ' + data.chosenHorse.name + ') | 손실: -' + Number(data.bet).toLocaleString() + '원';
                    resultBox.style.color = '#f87171';
                    showToast('info', '🏇 경마 결과', '1위는 [' + data.winner.name + '] 입니다. 다음 레이스에 도전하세요!');
                  }

                  updateUserCashDisplay(data.newCash);
                }, 3000);

              } catch (e) {
                setGameLock(false);
                btn.innerText = '🏇 경주 시작하기!';
                resultBox.innerText = '서버 통신 실패';
                showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
              }
            }

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
            function openTradeModal(stockId, name, price, action, directHolding) {
              currentTrade = { stockId, name, price, action, isAll: false };
              document.getElementById('modal-trade-title').innerText = (action === 'buy' ? '🛒 주식 매수: ' : '💰 주식 매도: ') + name;
              document.getElementById('modal-stock-info').innerText = '종목코드: [' + stockId + ']';
              document.getElementById('modal-unit-price').innerText = Number(price).toLocaleString() + '원';
              
              const holding = (typeof directHolding === 'number') 
                ? directHolding 
                : (userHoldings[stockId] || (currentDetailStock && currentDetailStock.stock_id === stockId ? (currentDetailStock.userHolding || 0) : 0));

              // userHoldings 캐시 동기화
              userHoldings[stockId] = holding;

              const holdingElem = document.getElementById('modal-user-holding-info');
              if (holdingElem) {
                if (holding > 0) {
                  holdingElem.innerHTML = '내 보유: <b style="color: #38bdf8;">' + holding.toLocaleString() + '주</b>';
                } else {
                  holdingElem.innerHTML = '내 보유: <b style="color: #9ca3af;">0주 (보유 없음)</b>';
                }
              }

              const cashElem = document.getElementById('modal-user-cash-info');
              if (cashElem) cashElem.innerText = getCurrentUserCashNum().toLocaleString() + '원';

              const input = document.getElementById('trade-amount-input');
              if (action === 'sell') {
                input.value = holding > 0 ? holding : 0;
                currentTrade.isAll = (holding > 0);
              } else {
                input.value = 1;
                currentTrade.isAll = false;
              }

              const submitBtn = document.getElementById('btn-submit-trade');
              submitBtn.disabled = false;
              submitBtn.innerText = (action === 'buy' ? '🛒 매수 주문 체결' : '💰 매도 주문 체결');
              submitBtn.style.background = (action === 'buy' ? 'linear-gradient(135deg, #10b981, #059669)' : 'linear-gradient(135deg, #ef4444, #dc2626)');

              calcTradeTotal();
              document.getElementById('trade-modal').style.display = 'flex';
            }

            function setTradePercent(pct) {
              const input = document.getElementById('trade-amount-input');
              const stockId = currentTrade.stockId;
              const holding = Number(userHoldings[stockId] || 0);
              const price = Number(currentTrade.price) || 1;
              const userCash = getCurrentUserCashNum();

              if (pct === 100) {
                currentTrade.isAll = true;
              } else {
                currentTrade.isAll = false;
              }

              if (currentTrade.action === 'buy') {
                const maxCanBuy = (userCash / price);
                if (maxCanBuy < 0.0001) {
                  input.value = 0;
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
                  showToast('info', '보유량 없음', '매도할 수 있는 주식을 보유하고 있지 않습니다.');
                } else {
                  if (pct === 100) {
                    input.value = holding; // 🔥 100% 전량 매도
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
              currentTrade.isAll = false;
              const input = document.getElementById('trade-amount-input');
              const current = parseFloat(input.value) || 0;
              const stockId = currentTrade.stockId;
              const holding = Number(userHoldings[stockId] || 0);
              
              let nextVal = Math.round((current + qty) * 10000) / 10000;
              if (nextVal < 0.0001) nextVal = 0.0001;
              if (currentTrade.action === 'sell' && holding > 0 && nextVal > holding) {
                nextVal = holding;
              }
              input.value = nextVal;
              calcTradeTotal();
            }

            function resetTradeAmount() {
              currentTrade.isAll = false;
              const input = document.getElementById('trade-amount-input');
              input.value = 1;
              calcTradeTotal();
            }

            function closeTradeModal() {
              document.getElementById('trade-modal').style.display = 'none';
            }

            function calcTradeTotal() {
              const input = document.getElementById('trade-amount-input');
              const count = parseFloat(input.value) || 0;
              const price = Number(currentTrade.price || 0);
              const total = Math.floor(count * price);
              const stockId = currentTrade.stockId;
              const holding = Number(userHoldings[stockId] || 0);
              const userCash = getCurrentUserCashNum();

              document.getElementById('modal-total-price').innerText = total.toLocaleString() + '원';

              const warnBox = document.getElementById('trade-warning-msg');
              const submitBtn = document.getElementById('btn-submit-trade');

              if (!warnBox) return;

              if (count < 0.0001) {
                warnBox.style.display = 'block';
                warnBox.style.color = '#fbbf24';
                warnBox.innerText = '⚠️ 주문 수량은 최소 0.0001주 이상이어야 합니다.';
                if (submitBtn) submitBtn.disabled = true;
              } else if (currentTrade.action === 'sell' && count > (holding + 0.00001)) {
                warnBox.style.display = 'block';
                warnBox.style.color = '#ef4444';
                warnBox.innerText = '⚠️ 보유 수량(' + holding.toLocaleString() + '주)을 초과하여 매도할 수 없습니다.';
                if (submitBtn) submitBtn.disabled = true;
              } else if (currentTrade.action === 'buy' && total > userCash) {
                warnBox.style.display = 'block';
                warnBox.style.color = '#ef4444';
                warnBox.innerText = '⚠️ 보유 현금(' + userCash.toLocaleString() + '원)이 부족합니다.';
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
                const res = await fetch('/api/user/summary');
                const data = await res.json();
                if (!data.success || !data.loggedIn) return;

                const newCashNum = Number(data.cash || 0);
                const newBankNum = Number(data.bank || 0);
                const newNetNum = Number(data.netWorth || 0);
                const newStockValNum = Number(data.stockVal || 0);

                if (data.holdings) {
                  userHoldings = data.holdings;
                }

                // 현금 변경 감지 시 실시간 플립 애니메이션 및 숫자 갱신
                if (lastSyncedCash !== null && lastSyncedCash !== newCashNum) {
                  updateUserCashDisplay(data.cash);
                  const isUp = newCashNum > lastSyncedCash;
                  const cashElem = document.getElementById('my-cash');
                  if (cashElem) {
                    cashElem.style.color = isUp ? '#34d399' : '#f87171';
                    setTimeout(() => { cashElem.style.color = '#34d399'; }, 1500);
                  }
                }
                lastSyncedCash = newCashNum;

                // 은행 예금 변경 감지 시 갱신
                if (lastSyncedBank !== null && lastSyncedBank !== newBankNum) {
                  const bankElem = document.getElementById('my-bank');
                  if (bankElem) {
                    bankElem.innerText = newBankNum.toLocaleString() + '원';
                    bankElem.style.color = '#a5b4fc';
                    setTimeout(() => { bankElem.style.color = '#818cf8'; }, 1500);
                  }
                }
                lastSyncedBank = newBankNum;
                lastSyncedNet = newNetNum;

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
                refreshStockPricesLive();
              }
              const min = Math.floor(stockCountdownSeconds / 60).toString().padStart(2, '0');
              const sec = (stockCountdownSeconds % 60).toString().padStart(2, '0');
              const cdElem = document.getElementById('price-tick-countdown');
              if (cdElem) cdElem.innerText = min + ':' + sec;
            }
            setInterval(updateStockCountdown, 1000);

            async function refreshStockPricesLive(manual = false) {
              const spinBtn = document.querySelector('.btn-quick-refresh');
              if (spinBtn) spinBtn.classList.add('spinning-fast');
              try {
                const res = await fetch('/api/stocks');
                const data = await res.json();
                if (!data.success || !data.stocks) return;

                data.stocks.forEach(s => {
                  const priceElem = document.getElementById('price-' + s.stock_id);
                  if (priceElem) {
                    const oldPrice = parseInt(priceElem.innerText.replace(/[^0-9]/g, ''), 10) || 0;
                    const newPrice = Number(s.price);
                    priceElem.innerText = newPrice.toLocaleString() + '원';
                    if (newPrice !== oldPrice) {
                      priceElem.style.color = newPrice > oldPrice ? '#34d399' : '#f87171';
                      setTimeout(() => { priceElem.style.color = '#fff'; }, 1500);
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
              const count = parseInt(amount, 10) || 0;
              const stockId = currentTrade.stockId;
              const holding = userHoldings[stockId] || 0;
              const userCash = getCurrentUserCashNum();
              const price = Number(currentTrade.price) || 0;
              const total = count * price;
              const defaultBtnText = (currentTrade.action === 'buy' ? '🛒 매수 주문 체결' : '💰 매도 주문 체결');
              const btn = document.getElementById('btn-submit-trade');

              if (count <= 0) {
                showToast('error', '수량 오류', '1주 이상의 수량을 입력해주세요.');
                return;
              }

              if (currentTrade.action === 'sell' && count > holding) {
                showToast('error', '보유 수량 부족', '보유 주식(' + holding.toLocaleString() + '주)보다 많은 수량을 매도할 수 없습니다.');
                return;
              }

              if (currentTrade.action === 'buy' && total > userCash) {
                showToast('error', '현금 부족', '보유 현금(' + userCash.toLocaleString() + '원)이 부족합니다.');
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
                    amount: count,
                    isAll: currentTrade.isAll || (currentTrade.action === 'sell' && count === holding) || (currentTrade.action === 'buy' && (userCash - total) < price)
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

                // 로컬 보유 수량 및 현금 즉시 동기화
                if (data.action === 'buy') {
                  userHoldings[stockId] = (userHoldings[stockId] || 0) + Number(data.amount);
                } else if (data.action === 'sell') {
                  userHoldings[stockId] = Math.max(0, (userHoldings[stockId] || 0) - Number(data.amount));
                }

                showToast('success', '주식 체결 완료', data.message);
                btn.innerText = '✅ 체결 완료!';
                updateUserCashDisplay(data.newCash);
                setTimeout(() => {
                  closeTradeModal();
                  location.reload();
                }, 700);
              } catch (e) {
                btn.disabled = false;
                btn.innerText = defaultBtnText;
                showToast('error', '통신 오류', '거래 처리 중 서버 연결 실패');
              }
            }

            // 8. 은행 모달
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
            }
            async function submitBankTransfer() {
              const amount = document.getElementById('bank-amount-input').value;
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
                updateUserCashDisplay(data.cash);
                const bankElem = document.getElementById('my-bank');
                if (bankElem) bankElem.innerText = Number(data.bank).toLocaleString() + '원';
              } catch (e) { showToast('error', '통신 오류', '은행 서버 연결 실패'); }
            }

            // 9. 👤 프로필 & 1:1 고객센터 문의 인터랙션
            function openProfileModal(initialTab = 'profile') {
              document.getElementById('profile-modal').style.display = 'flex';
              switchProfileTab(initialTab);
              loadMyInquiries();
            }

            function closeProfileModal() {
              document.getElementById('profile-modal').style.display = 'none';
            }

            function switchProfileTab(tabName) {
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
              if (file.size > 8 * 1024 * 1024) {
                showToast('error', '용량 초과', '이미지 파일 크기는 최대 8MB까지 업로드 가능합니다.');
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

                  const imageBlock = inq.image_url
                    ? '<div style="margin: 10px 0;">' +
                        '<a href="' + inq.image_url + '" target="_blank" style="display:inline-block; text-decoration:none;">' +
                          '<img src="' + inq.image_url + '" style="max-height: 140px; max-width: 100%; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); object-fit: cover;" alt="첨부 사진">' +
                          '<span style="display:block; font-size:0.72rem; color:#818cf8; margin-top:3px;">🖼️ 첨부 이미지 원본 확대 보기</span>' +
                        '</a>' +
                      '</div>'
                    : '';

                  const answerBlock = isAnswered && inq.answer
                    ? '<div class="inquiry-answer-box">' +
                        '<div class="inquiry-answer-header">' +
                          '<span>💬 관리자(@' + (inq.answered_by || '관리자') + ') 공식 답변</span>' +
                          '<span style="font-size: 0.72rem; color: #9ca3af;">' + answeredDate + '</span>' +
                        '</div>' +
                        '<div class="inquiry-answer-text">' + inq.answer.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
                      '</div>'
                    : '';

                  return '<div class="inquiry-item-card">' +
                    '<div class="inquiry-item-top">' +
                      '<span class="inquiry-category-badge">' + (inq.category || '일반 문의') + ' #' + inq.id + '</span>' +
                      statusHtml +
                    '</div>' +
                    '<div class="inquiry-title-text">' + inq.title.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
                    '<div class="inquiry-content-text">' + inq.content.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' +
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
              const cashElem = document.getElementById('my-cash');
              if (cashElem && cashVal) {
                cashElem.innerText = Number(cashVal).toLocaleString() + '원';
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
              const abs = Math.abs(Number(n));
              if (abs >= 1e8)  return (n/1e8).toFixed(1)  + '억원';
              if (abs >= 1e4)  return (n/1e4).toFixed(1)  + '만원';
              return Number(n).toLocaleString('ko-KR') + '원';
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

            // ── 실시간 인디케이터 배지 ─────────────────
            const liveBadge = document.createElement('div');
            liveBadge.id = 'live-indicator';
            liveBadge.style.cssText = [
              'position:fixed','bottom:20px','right:20px','z-index:9999',
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
            function applyMarketUpdate(data) {
              if (!data.stocks) return;

              data.stocks.forEach(s => {
                const price    = Number(s.price);
                const prevPrice = Number(s.prev_price);
                const rate     = s.rate || 0;
                const isUp     = rate >= 0;
                const arrow    = isUp ? '▲' : '▼';
                const sign     = isUp ? '+' : '';

                // 가격 요소 업데이트
                const priceEl = document.getElementById('price-' + s.stock_id);
                if (priceEl) {
                  const oldTxt = priceEl.textContent;
                  const newTxt = fmtMoney(price);
                  if (oldTxt !== newTxt) {
                    priceEl.textContent = newTxt;
                    flashEl(priceEl, isUp);
                    // 카드 전체 플래시
                    const card = document.getElementById('stock-' + s.stock_id);
                    if (card) {
                      card.classList.remove('flash-up', 'flash-down');
                      void card.offsetWidth; // reflow
                      card.classList.add(isUp ? 'flash-up' : 'flash-down');
                    }
                  }
                }

                // 배지(등락률) 업데이트
                const badgeEl = document.querySelector('#stock-' + s.stock_id + ' .badge');
                if (badgeEl) {
                  badgeEl.textContent = arrow + ' ' + sign + Math.abs(rate).toFixed(2) + '%';
                  badgeEl.className   = 'badge ' + (isUp ? 'badge-up' : 'badge-down');
                }

                // 이전가 업데이트
                const footerEls = document.querySelectorAll('#stock-' + s.stock_id + ' .stock-footer span');
                if (footerEls[0]) footerEls[0].textContent = '이전가: ' + fmtMoney(prevPrice);
                if (footerEls[1]) {
                  footerEls[1].textContent = isUp ? '📈 상승세' : '📉 하락세';
                  footerEls[1].className   = 'trend-text ' + (isUp ? 'text-up' : 'text-down');
                }
              });

              // 시장 국면 업데이트
              if (data.regime) {
                const regimeEls = document.querySelectorAll('[data-regime]');
                regimeEls.forEach(el => el.textContent = data.regime.name);
              }

              // 마지막 업데이트 시각 표시
              const updatedEls = document.querySelectorAll('[data-last-updated]');
              updatedEls.forEach(el => {
                el.textContent = '업데이트: ' + new Date().toLocaleTimeString('ko-KR');
              });
            }

            // ── SSE 연결 (자동 재연결 포함) ────────────
            let es;
            let retryDelay = 3000;

            function connect() {
              es = new EventSource('/api/stream');

              es.onmessage = function(e) {
                try {
                  const data = JSON.parse(e.data);
                  if (data.type === 'MARKET_UPDATE') {
                    applyMarketUpdate(data);
                  } else if (data.type === 'CHAT_MESSAGE' && data.message) {
                    appendLiveChatMessage(data.message, true);
                  }
                  retryDelay = 3000; // 성공 시 재시도 간격 초기화
                  setLive(true);
                } catch (err) {}
              };

              es.onerror = function() {
                setLive(false);
                es.close();
                setTimeout(connect, retryDelay);
                retryDelay = Math.min(retryDelay * 1.5, 30000); // 최대 30초
              };

              es.onopen = function() { setLive(true); };
            }

            // 페이지 로드 후 바로 연결 및 채팅 로드
            if (typeof EventSource !== 'undefined') {
              connect();
            }
            loadChatMessages();
          })();

          // 💬 실시간 광장 채팅 & 전역 플로팅 독 스크립트
          let currentChatUserId = ${JSON.stringify(currentUser ? String(currentUser.id) : '')};
          let currentIsAdmin = ${isAdminUser ? true : false};
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
            const avatarUrl = msg.avatar ? ('https://cdn.discordapp.com/avatars/' + msg.user_id + '/' + msg.avatar + '.png') : 'https://cdn.discordapp.com/embed/avatars/0.png';
            const delBtn = (currentIsAdmin || isMine) ? '<button class="btn-del-msg" onclick="deleteChatMessage(' + msg.id + ')" title="메시지 삭제">✕</button>' : '';
            const adminBadge = isAdmin ? '<span class="badge-admin-chat">👑 관리자</span>' : '';

            const bubbleInnerHtml = 
              '<img src="' + avatarUrl + '" class="chat-avatar" onerror="this.src=\'https://cdn.discordapp.com/embed/avatars/0.png\'">' +
              '<div class="chat-content">' +
                '<div class="chat-meta">' +
                  '<b>@' + (msg.username || '익명') + '</b> ' +
                  adminBadge + ' ' +
                  '<span>' + timeStr + '</span> ' +
                  delBtn +
                '</div>' +
                '<div>' + msg.message + '</div>' +
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text })
              });
              const data = await res.json();
              if (!data.success) {
                showToast('error', '채팅 실패', data.error || '채팅 전송에 실패했습니다.');
              } else {
                input.value = '';
                if (data.message) {
                  appendLiveChatMessage(data.message, true);
                }
              }
            } catch (err) {
              showToast('error', '통신 오류', '채팅 서버와 연결할 수 없습니다.');
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text })
              });
              const data = await res.json();
              if (!data.success) {
                showToast('error', '채팅 실패', data.error || '채팅 전송에 실패했습니다.');
              } else {
                input.value = '';
                if (data.message) {
                  appendLiveChatMessage(data.message, true);
                }
              }
            } catch (err) {
              showToast('error', '통신 오류', '채팅 서버와 연결할 수 없습니다.');
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
                alert(data.error || '삭제 권한이 없습니다.');
              }
            } catch (e) {}
          }
          </script>
        </body>
        </html>
      `);
    } catch (err) {
      res.status(500).send(`Server Error: ${err.message}`);
    }
  });

  // 👑 관리자 전용 대시보드 페이지 (/admin)
  app.get('/admin', async (req, res) => {
    const currentUser = getSessionUser(req);
    if (!currentUser || !config.isAdmin(currentUser.id)) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <title>접근 권한 없음 (403 Forbidden)</title>
          <style>
            body { font-family: sans-serif; background: #0b0f19; color: #f87171; text-align: center; padding-top: 100px; }
            .box { background: #161b22; border: 1px solid #ef4444; display: inline-block; padding: 40px; border-radius: 16px; }
            a { color: #818cf8; text-decoration: none; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>🚫 접근 권한 없음</h1>
            <p style="color: #9ca3af; margin: 15px 0;">이 페이지는 봇 관리자(@관리자) 전용입니다.</p>
            <br>
            <a href="/">← 메인 페이지로 돌아가기</a>
          </div>
        </body>
        </html>
      `);
    }

    try {
      const [inquiryLogs] = await pool.query('SELECT * FROM inquiries ORDER BY id DESC LIMIT 50');
      const [priceLogs] = await pool.query('SELECT * FROM stock_price_logs ORDER BY id DESC LIMIT 50');
      const [tradeLogs] = await pool.query('SELECT * FROM stock_transactions ORDER BY id DESC LIMIT 50');
      const [webLogs] = await pool.query('SELECT * FROM web_access_logs ORDER BY id DESC LIMIT 50');
      const [cmdLogs] = await pool.query('SELECT * FROM command_logs ORDER BY id DESC LIMIT 50');
      const [gambleLogs] = await pool.query(`
        SELECT g.*, u.username 
        FROM gambling_logs g
        LEFT JOIN users u ON g.user_id = u.discord_id
        ORDER BY g.id DESC LIMIT 50
      `);
      const [allUsersWealth] = await pool.query(`
        SELECT 
          u.discord_id, 
          u.username, 
          u.cash, 
          u.bank, 
          u.created_at,
          COALESCE(SUM(us.amount * s.price), 0) AS stock_val,
          (u.cash + u.bank + COALESCE(SUM(us.amount * s.price), 0)) AS net_worth
        FROM users u
        LEFT JOIN user_stocks us ON u.discord_id = us.user_id
        LEFT JOIN stocks s ON us.stock_id = s.stock_id
        GROUP BY u.discord_id, u.username, u.cash, u.bank, u.created_at
        ORDER BY net_worth DESC
        LIMIT 100
      `);
      const totalUsers = allUsersWealth.length;

      let userWealthRowsHtml = '';
      for (const u of allUsersWealth) {
        const cash = BigInt(u.cash || 0);
        const bank = BigInt(u.bank || 0);
        const stockVal = BigInt(u.stock_val || 0);
        const netWorth = BigInt(u.net_worth || 0);

        userWealthRowsHtml += `
          <tr class="user-wealth-row" data-name="${(u.username || '').toLowerCase()}" data-id="${u.discord_id}">
            <td><b>@${u.username || '알수없음'}</b></td>
            <td><code>${u.discord_id}</code></td>
            <td style="color:#34d399; font-weight:700;">${formatMoney(cash)}</td>
            <td style="color:#818cf8; font-weight:700;">${formatMoney(bank)}</td>
            <td style="color:#38bdf8; font-weight:700;">${formatMoney(stockVal)}</td>
            <td style="color:#fbbf24; font-weight:800; font-size:0.95rem;">${formatMoney(netWorth)}</td>
            <td>
              <button onclick="fillUserAction('${u.discord_id}')" style="background:#1f2937; border:1px solid var(--border); color:#a5b4fc; padding:3px 8px; border-radius:4px; font-size:0.75rem; cursor:pointer;">⚡ 빠른선택</button>
            </td>
          </tr>
        `;
      }

      let inquiryRowsHtml = '';
      for (const inq of inquiryLogs) {
        const isAnswered = inq.status === 'ANSWERED';
        const statusHtml = isAnswered
          ? `<span style="background:rgba(16,185,129,0.2); color:#34d399; padding:3px 8px; border-radius:6px; font-weight:700;">🟢 답변 완료 (@${inq.answered_by})</span>`
          : `<span style="background:rgba(245,158,11,0.2); color:#fbbf24; padding:3px 8px; border-radius:6px; font-weight:700;">🟡 답변 대기 중</span>`;

        const replyFormOrAnswer = isAnswered
          ? `<div style="background:rgba(16,185,129,0.08); border-left:3px solid #10b981; padding:8px 12px; border-radius:6px; font-size:0.82rem; color:#e2e8f0; white-space:pre-wrap;">${inq.answer || ''}</div>`
          : `
            <div style="display:flex; flex-direction:column; gap:6px;">
              <textarea id="inq-reply-${inq.id}" placeholder="유저에게 전송할 답변을 입력하세요 (제출 시 유저에게 Discord DM이 자동 전송됩니다)" style="width:100%; min-height:60px; background:#111827; border:1px solid var(--border); color:#fff; padding:6px 10px; border-radius:8px; font-size:0.8rem; font-family:inherit;"></textarea>
              <button onclick="replyInquiry(${inq.id})" style="background:linear-gradient(135deg, #6366f1, #8b5cf6); border:none; color:#fff; font-weight:700; font-size:0.8rem; padding:6px 12px; border-radius:6px; cursor:pointer; align-self:flex-start;">💬 답변 등록 & 유저 DM 발송</button>
            </div>
          `;

        inquiryRowsHtml += `
          <tr id="inq-row-${inq.id}">
            <td>#${inq.id}</td>
            <td>${inq.created_at ? new Date(inq.created_at).toISOString().replace('T', ' ').slice(0, 19) : '-'}</td>
            <td><b>@${inq.username}</b><br><code style="font-size:0.7rem;">${inq.user_id}</code></td>
            <td>
              <b>${inq.title}</b><br>
              <span style="font-size:0.8rem; color:#9ca3af; white-space:pre-wrap;">${inq.content}</span>
              ${inq.image_url ? `
                <div style="margin-top:6px;">
                  <a href="${inq.image_url}" target="_blank" style="display:inline-block; text-decoration:none;">
                    <img src="${inq.image_url}" style="max-width:120px; max-height:80px; border-radius:6px; border:1px solid rgba(255,255,255,0.2); object-fit:cover;" alt="첨부 사진">
                  </a>
                  <br><a href="${inq.image_url}" target="_blank" style="font-size:0.7rem; color:#818cf8;">🖼️ 첨부 이미지 원본 확대</a>
                </div>
              ` : ''}
            </td>
            <td>${statusHtml}</td>
            <td style="min-width:280px;">${replyFormOrAnswer}</td>
          </tr>
        `;
      }

      let priceRowsHtml = '';
      for (const p of priceLogs) {
        const isUp = Number(p.diff) >= 0;
        const color = isUp ? '#34d399' : '#f87171';
        priceRowsHtml += `
          <tr>
            <td>#${p.id}</td>
            <td>${p.created_at ? new Date(p.created_at).toISOString().replace('T', ' ').slice(0, 19) : '-'}</td>
            <td><b>[${p.stock_id}] ${p.stock_name}</b></td>
            <td>${formatMoney(p.prev_price)}</td>
            <td style="color:${color}; font-weight:700;"><b>${formatMoney(p.new_price)}</b></td>
            <td style="color:${color}; font-weight:700;">${isUp ? '▲ +' : '▼ '}${p.change_rate}%</td>
            <td>${p.regime}</td>
            <td>${p.reason || '-'}</td>
          </tr>
        `;
      }

      let tradeRowsHtml = '';
      for (const t of tradeLogs) {
        const isBuy = t.action === 'BUY';
        const color = isBuy ? '#38bdf8' : '#fb923c';
        tradeRowsHtml += `
          <tr>
            <td>#${t.id}</td>
            <td>${t.created_at ? new Date(t.created_at).toISOString().replace('T', ' ').slice(0, 19) : '-'}</td>
            <td><b>@${t.username}</b> (<code>${t.user_id}</code>)</td>
            <td><b>${t.stock_name}</b> [${t.stock_id}]</td>
            <td><span style="background:${isBuy ? 'rgba(56,189,248,0.2)' : 'rgba(251,146,60,0.2)'}; color:${color}; padding:2px 6px; border-radius:4px; font-weight:700;">${isBuy ? '🛒 매수' : '💰 매도'}</span></td>
            <td>${formatNumber(t.amount)}주</td>
            <td>${formatMoney(t.price)}</td>
            <td style="color:${color}; font-weight:700;">${formatMoney(t.total_price)}</td>
          </tr>
        `;
      }

      let gambleRowsHtml = '';
      for (const g of gambleLogs) {
        const profit = BigInt(g.profit);
        const isProfit = profit >= 0n;
        const profitClass = isProfit ? 'status-ok' : 'status-err';
        const sign = isProfit ? '+' : '';
        const isRolledBack = Boolean(g.is_rolled_back);

        const rollbackBtn = isRolledBack
          ? `<span style="color:#9ca3af; font-size:0.75rem; font-weight:700;">✅ 롤백완료</span>`
          : `<button onclick="rollbackGamble(${g.id})" class="btn-rollback">⏪ 이전 잔고 복구</button>`;

        gambleRowsHtml += `
          <tr id="gamble-row-${g.id}">
            <td>#${g.id}</td>
            <td>${g.created_at ? new Date(g.created_at).toISOString().replace('T', ' ').slice(0, 19) : '-'}</td>
            <td><b>${g.username || '유저'}</b> (<code>${g.user_id}</code>)</td>
            <td><span class="cmd-tag">${g.game}</span></td>
            <td>${formatMoney(g.bet)}</td>
            <td class="${profitClass}"><b>${sign}${formatMoney(profit)}</b></td>
            <td><code>${formatMoney(g.balance_before)}</code></td>
            <td><code>${formatMoney(g.balance_after)}</code></td>
            <td>${rollbackBtn}</td>
          </tr>
        `;
      }

      let webRowsHtml = '';
      for (const log of webLogs) {
        const flag = log.country === 'LOCAL' ? '🏠' : (log.country ? `🌐 ${log.country}` : '🌐');
        const adminPill = log.is_admin ? `<span class="badge-admin">👑 관리자</span>` : '';
        const userDisplay = log.username ? `${log.username} ${adminPill}` : '비회원';
        const statusClass = log.status_code < 400 ? 'status-ok' : 'status-err';

        webRowsHtml += `
          <tr>
            <td>${log.created_at ? new Date(log.created_at).toISOString().replace('T', ' ').slice(0, 19) : '-'}</td>
            <td><b>${flag} ${log.country_name || log.country || 'Unknown'}</b></td>
            <td><code>${log.ip}</code></td>
            <td>${userDisplay}</td>
            <td><span class="method-tag">${log.method}</span> <code>${log.url}</code></td>
            <td><span class="${statusClass}">${log.status_code}</span></td>
            <td>${log.duration_ms}ms</td>
          </tr>
        `;
      }

      let cmdRowsHtml = '';
      for (const cmd of cmdLogs) {
        const isSuccess = cmd.status === 'SUCCESS';
        cmdRowsHtml += `
          <tr>
            <td>${cmd.created_at ? new Date(cmd.created_at).toISOString().replace('T', ' ').slice(0, 19) : '-'}</td>
            <td><b>${cmd.username}</b> (<code>${cmd.user_id}</code>)</td>
            <td><span class="cmd-tag">/${cmd.command_name}</span></td>
            <td><code class="opt-code">${cmd.options || '{}'}</code></td>
            <td><span class="${isSuccess ? 'status-ok' : 'status-err'}">${cmd.status}</span></td>
            <td>${cmd.execution_time_ms}ms</td>
          </tr>
        `;
      }

      res.send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>👑 관리자 실시간 관제 & 자산 롤백 대시보드</title>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@600;700;800&display=swap" rel="stylesheet">
          <style>
            :root { --bg: #090d16; --card: #111827; --border: rgba(255, 255, 255, 0.08); --primary: #6366f1; }
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: 'Inter', sans-serif; background-color: var(--bg); color: #f3f4f6; padding: 30px; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
            .header h1 { font-family: 'Outfit', sans-serif; font-size: 1.8rem; color: #fbbf24; }
            .header a { color: #818cf8; text-decoration: none; font-weight: 600; }
            .admin-info { background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3); padding: 8px 16px; border-radius: 20px; font-weight: 700; color: #fbbf24; }
            .api-links { margin-bottom: 25px; display: flex; gap: 12px; flex-wrap: wrap; }
            .btn-json { background: #1f2937; border: 1px solid var(--border); color: #93c5fd; padding: 8px 16px; border-radius: 8px; text-decoration: none; font-size: 0.85rem; font-weight: 600; }
            .card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px; margin-bottom: 35px; overflow-x: auto; }
            .card h2 { font-family: 'Outfit', sans-serif; font-size: 1.3rem; margin-bottom: 16px; color: #e0e7ff; }
            table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem; }
            th { padding: 12px 16px; color: #9ca3af; border-bottom: 1px solid var(--border); background: rgba(0,0,0,0.2); }
            td { padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.04); }
            code { background: #1f2937; padding: 2px 6px; border-radius: 4px; color: #a5b4fc; font-family: monospace; font-size: 0.8rem; }
            .opt-code { max-width: 250px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .status-ok { color: #34d399; font-weight: 700; }
            .status-err { color: #f87171; font-weight: 700; }
            .method-tag { background: #374151; padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 0.75rem; color: #93c5fd; }
            .cmd-tag { background: rgba(99, 102, 241, 0.2); color: #818cf8; padding: 3px 8px; border-radius: 6px; font-weight: 700; }
            .badge-admin { background: #d97706; color: #fff; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: bold; }
            .btn-rollback { background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; font-weight: 700; padding: 4px 10px; border-radius: 6px; cursor: pointer; transition: all 0.2s; font-size: 0.75rem; }
            .btn-rollback:hover { background: #ef4444; color: #fff; }

            /* 📱 관리자 패널 모바일/태블릿 자동 반응형 최적화 */
            @media (max-width: 768px) {
              body { padding: 12px 10px; }
              .header { flex-direction: column; align-items: flex-start; gap: 12px; margin-bottom: 20px; }
              .header h1 { font-size: 1.35rem; }
              .card { padding: 14px; margin-bottom: 20px; border-radius: 12px; }
              .api-links { gap: 8px; }
              .btn-json { font-size: 0.75rem; padding: 6px 10px; }
              table { font-size: 0.75rem; }
              th, td { padding: 8px 6px; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <h1>👑 관리자 실시간 관제 & 모든 로그 모니터링 센터</h1>
              <p style="color: #9ca3af; font-size: 0.9rem; margin-top: 4px;">총 가입자: ${totalUsers}명 | 관리자 권한: 활성화</p>
            </div>
            <div style="display: flex; align-items: center; gap: 15px;">
              <span class="admin-info">관리자: @${currentUser.username}</span>
              <a href="/">← 대시보드 홈</a>
            </div>
          </div>

          <div class="api-links">
            <a href="/api/system/activity-feed" target="_blank" class="btn-json">⚡ 실시간 모든 시스템 로그 JSON</a>
            <a href="/api/admin/logs/gambling" target="_blank" class="btn-json">🎰 도박 이력 & 롤백 JSON</a>
            <a href="/api/admin/logs/access" target="_blank" class="btn-json">📥 웹 접속 JSON 로그</a>
            <a href="/api/admin/logs/commands" target="_blank" class="btn-json">🤖 디스코드 명령어 JSON 로그</a>
            <a href="/api/admin/inquiries" target="_blank" class="btn-json">📩 1:1 고객센터 문의 JSON</a>
            <a href="/api/admin/security" target="_blank" class="btn-json">🛡️ 보안 & 차단 현황 JSON</a>
          </div>

          <!-- 👥 전체 사용자 자산 & 은행 예금 실시간 관제 센터 -->
          <div class="card" style="border: 1px solid rgba(56, 189, 248, 0.4); background: rgba(17, 24, 39, 0.95);">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 14px;">
              <div>
                <h2 style="color: #38bdf8; display: flex; align-items: center; gap: 8px;">👥 전체 사용자 자산 & 은행 예금 실시간 관제 센터</h2>
                <p style="font-size: 0.85rem; color: #9ca3af;">모든 유저의 현금, 은행 예금, 주식 평가액, 총 순자산을 실시간으로 모니터링합니다. (1분 복리 이자 적용 중)</p>
              </div>
              <div style="display: flex; gap: 10px; align-items: center;">
                <input type="text" id="user-search-input" placeholder="🔍 유저명 또는 Discord ID 실시간 검색..." oninput="filterUserWealthList()" style="background: #111827; border: 1px solid var(--border); color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 0.85rem; width: 280px;">
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>유저명</th>
                  <th>Discord ID</th>
                  <th>💵 보유 현금</th>
                  <th>🏦 은행 예금 (1분 복리)</th>
                  <th>📈 보유 주식 평가액</th>
                  <th>💎 총 순자산</th>
                  <th>작업</th>
                </tr>
              </thead>
              <tbody id="user-wealth-tbody">
                ${userWealthRowsHtml || '<tr><td colspan="7" style="text-align:center; color:#6b7280;">등록된 유저 데이터가 없습니다.</td></tr>'}
              </tbody>
            </table>
          </div>

          <!-- 👑 관리자 실시간 명령어 제어 센터 (Web Command Console) -->
          <div class="card" style="border: 1px solid rgba(251, 191, 36, 0.4); background: rgba(17, 24, 39, 0.9);">
            <h2 style="color: #fbbf24;">👑 관리자 실시간 명령 컨트롤 센터 (Web Console)</h2>
            <p style="font-size: 0.85rem; color: #9ca3af; margin-bottom: 18px;">디스코드 명령어(/admin_give, /admin_take, /admin_stock, /admin_reset, /아이피)를 웹에서 직접 실행합니다.</p>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px;">
              <!-- 1. 유저 돈 지급 / 회수 -->
              <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 12px; padding: 16px;">
                <h3 style="font-size: 1rem; color: #34d399; margin-bottom: 12px;">💰 유저 자산 지급 & 회수</h3>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                  <input type="text" id="cmd-user-id" placeholder="유저 Discord ID (예: 889085646768078850)" style="background: #111827; border: 1px solid var(--border); color: #fff; padding: 8px 12px; border-radius: 6px; font-size: 0.85rem;">
                  <input type="number" id="cmd-amount" placeholder="금액 (원 단위)" style="background: #111827; border: 1px solid var(--border); color: #fff; padding: 8px 12px; border-radius: 6px; font-size: 0.85rem;">
                  <input type="text" id="cmd-reason" placeholder="사유 (예: 이벤트 당첨, 버그 보상)" style="background: #111827; border: 1px solid var(--border); color: #fff; padding: 8px 12px; border-radius: 6px; font-size: 0.85rem;">
                  <div style="display: flex; gap: 8px; margin-top: 4px;">
                    <button onclick="execGiveMoney()" style="flex: 1; background: #10b981; border: none; color: #fff; font-weight: 700; padding: 8px; border-radius: 6px; cursor: pointer;">➕ 돈 지급</button>
                    <button onclick="execTakeMoney()" style="flex: 1; background: #ef4444; border: none; color: #fff; font-weight: 700; padding: 8px; border-radius: 6px; cursor: pointer;">➖ 돈 회수</button>
                  </div>
                </div>
              </div>

              <!-- 2. 주가 강제 조작 & 국면 변경 -->
              <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 12px; padding: 16px;">
                <h3 style="font-size: 1rem; color: #38bdf8; margin-bottom: 12px;">📈 주식 시세 & 시장 국면 조작</h3>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                  <div style="display: flex; gap: 8px;">
                    <select id="cmd-stock-id" style="flex: 1; background: #111827; border: 1px solid var(--border); color: #fff; padding: 8px; border-radius: 6px; font-size: 0.85rem;">
                      <option value="WTRD">WTRD - 월덕 인터내셔널</option>
                      <option value="MINE">MINE - 월덕 광업 & 제련</option>
                      <option value="CASN">CASN - 황금오리 카지노</option>
                      <option value="BANK">BANK - 덕스 중앙은행</option>
                      <option value="NEKO">NEKO - 네코 에너지</option>
                      <option value="CHKN">CHKN - 황금닭 치킨</option>
                      <option value="SLOT">SLOT - 럭키세븐 복권 (입문주)</option>
                      <option value="SCRP">SCRP - 이지스크랩 테크</option>
                    </select>
                    <input type="number" id="cmd-stock-price" placeholder="새 주가(원)" style="flex: 1; background: #111827; border: 1px solid var(--border); color: #fff; padding: 8px; border-radius: 6px; font-size: 0.85rem;">
                  </div>
                  <button onclick="execSetStockPrice()" style="background: #0ea5e9; border: none; color: #fff; font-weight: 700; padding: 8px; border-radius: 6px; cursor: pointer;">📊 주가 즉시 변경 & SSE 알림</button>
                  <div style="display: flex; gap: 8px; margin-top: 6px;">
                    <select id="cmd-regime-idx" style="flex: 1; background: #111827; border: 1px solid var(--border); color: #fff; padding: 8px; border-radius: 6px; font-size: 0.85rem;">
                      <option value="0">🦆 번영기 (상승 우세)</option>
                      <option value="1">📉 시장 조정기 (하락 완화)</option>
                      <option value="2">⚖️ 박스권 횡보 (안정)</option>
                      <option value="3">🔥 카지노/광산 잭팟 랠리</option>
                      <option value="4">🚀 냥코 양자 폭등</option>
                      <option value="5">🏦 중앙은행 유동성 살포</option>
                      <option value="6">🌟 슈퍼사이클 (대호황)</option>
                    </select>
                    <button onclick="execSetRegime()" style="background: #8b5cf6; border: none; color: #fff; font-weight: 700; padding: 8px 12px; border-radius: 6px; cursor: pointer; white-space: nowrap;">국면 전환</button>
                  </div>
                </div>
              </div>

              <!-- 3. IP 차단 / 해제 & 유저 초기화 -->
              <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 12px; padding: 16px;">
                <h3 style="font-size: 1rem; color: #f87171; margin-bottom: 12px;">🛡️ 보안 IP 관리 & 유저 초기화</h3>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                  <div style="display: flex; gap: 8px;">
                    <input type="text" id="cmd-ip-addr" placeholder="IP 주소 (예: 23.234.116.83)" style="flex: 1; background: #111827; border: 1px solid var(--border); color: #fff; padding: 8px; border-radius: 6px; font-size: 0.85rem;">
                    <input type="number" id="cmd-ip-mins" placeholder="차단(분)" value="1440" style="width: 80px; background: #111827; border: 1px solid var(--border); color: #fff; padding: 8px; border-radius: 6px; font-size: 0.85rem;">
                  </div>
                  <div style="display: flex; gap: 8px;">
                    <button onclick="execBanIp()" style="flex: 1; background: #dc2626; border: none; color: #fff; font-weight: 700; padding: 8px; border-radius: 6px; cursor: pointer;">🔴 IP 수동 차단</button>
                    <button onclick="execUnbanIp()" style="flex: 1; background: #4b5563; border: none; color: #fff; font-weight: 700; padding: 8px; border-radius: 6px; cursor: pointer;">🟢 IP 차단 해제</button>
                  </div>
                  <div style="border-top: 1px solid var(--border); padding-top: 8px; margin-top: 4px; display: flex; gap: 8px;">
                    <input type="text" id="cmd-reset-user-id" placeholder="초기화할 유저 ID" style="flex: 1; background: #111827; border: 1px solid var(--border); color: #fff; padding: 6px 10px; border-radius: 6px; font-size: 0.8rem;">
                    <button onclick="execResetUser()" style="background: #991b1b; border: none; color: #fff; font-weight: 700; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 0.8rem;">⚠️ 유저 초기화</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 📩 1:1 고객센터 문의 & 유저 답변 관리 카드 -->
          <div class="card" style="border: 1px solid rgba(99, 102, 241, 0.4);">
            <h2 style="color: #c7d2fe;">📩 1:1 고객센터 문의 접수 & 실시간 유저 답변 (최근 50건)</h2>
            <p style="font-size: 0.85rem; color: #9ca3af; margin-bottom: 14px;">유저가 웹사이트에서 접수한 1:1 문의입니다. 답변을 입력하고 전송하면 유저에게 <b>Discord DM 알림</b>이 자동 전송됩니다.</p>
            <table>
              <thead>
                <tr>
                  <th>번호</th>
                  <th>접수시간</th>
                  <th>작성유저</th>
                  <th>분류</th>
                  <th>문의제목 및 상세내용</th>
                  <th>처리상태</th>
                  <th>답변 작성 / 완료 답변</th>
                </tr>
              </thead>
              <tbody>
                ${inquiryRowsHtml || '<tr><td colspan="7" style="text-align: center; color: #6b7280;">접수된 1:1 문의가 없습니다.</td></tr>'}
              </tbody>
            </table>
          </div>

          <!-- 실시간 주가 변동 틱 로그 테이블 -->
          <div class="card">
            <h2>📈 실시간 주가 변동 틱 로그 (최근 50건)</h2>
            <table>
              <thead>
                <tr>
                  <th>번호</th>
                  <th>시간</th>
                  <th>종목명</th>
                  <th>이전가</th>
                  <th>변동가</th>
                  <th>등락률</th>
                  <th>시장장세</th>
                  <th>변동 사유</th>
                </tr>
              </thead>
              <tbody>
                ${priceRowsHtml || '<tr><td colspan="8" style="text-align: center; color: #6b7280;">주가 변동 기록이 없습니다.</td></tr>'}
              </tbody>
            </table>
          </div>

          <!-- 주식 매매 체결 로그 테이블 -->
          <div class="card">
            <h2>🛒 실시간 주식 매수/매도 체결 로그 (최근 50건)</h2>
            <table>
              <thead>
                <tr>
                  <th>번호</th>
                  <th>시간</th>
                  <th>체결 유저</th>
                  <th>종목</th>
                  <th>거래 유형</th>
                  <th>체결 수량</th>
                  <th>체결 단가</th>
                  <th>총 거래액</th>
                </tr>
              </thead>
              <tbody>
                ${tradeRowsHtml || '<tr><td colspan="8" style="text-align: center; color: #6b7280;">주식 매매 체결 기록이 없습니다.</td></tr>'}
              </tbody>
            </table>
          </div>

          <!-- 도박 상세 기록 & 원클릭 잔고 롤백 센터 -->
          <div class="card">
            <h2>🎰 실시간 도박 상세 기록 & 원클릭 잔고 롤백 복구 센터 (최근 50건)</h2>
            <table>
              <thead>
                <tr>
                  <th>번호</th>
                  <th>시간</th>
                  <th>유저 (@계정)</th>
                  <th>게임</th>
                  <th>배팅금</th>
                  <th>손익</th>
                  <th>도박 전 잔고</th>
                  <th>도박 후 잔고</th>
                  <th>원클릭 롤백 복구</th>
                </tr>
              </thead>
              <tbody>
                ${gambleRowsHtml || '<tr><td colspan="9" style="text-align: center; color: #6b7280;">도박 기록이 없습니다.</td></tr>'}
              </tbody>
            </table>
          </div>

          <div class="card">
            <h2>🌐 실시간 웹 접속 & IP 국가 기록 (최근 50건)</h2>
            <table>
              <thead>
                <tr>
                  <th>시간</th>
                  <th>국가 / 위치</th>
                  <th>클라이언트 IP</th>
                  <th>유저 (@계정)</th>
                  <th>요청 경로</th>
                  <th>상태코드</th>
                  <th>응답시간</th>
                </tr>
              </thead>
              <tbody>
                ${webRowsHtml || '<tr><td colspan="7" style="text-align: center; color: #6b7280;">접속 기록이 없습니다.</td></tr>'}
              </tbody>
            </table>
          </div>

          <div class="card">
            <h2>🤖 디스코드 슬래시 명령어 실행 기록 (최근 50건)</h2>
            <table>
              <thead>
                <tr>
                  <th>시간</th>
                  <th>실행 유저</th>
                  <th>명령어</th>
                  <th>입력 옵션</th>
                  <th>결과 상태</th>
                  <th>처리 속도</th>
                </tr>
              </thead>
              <tbody>
                ${cmdRowsHtml || '<tr><td colspan="6" style="text-align: center; color: #6b7280;">명령어 실행 기록이 없습니다.</td></tr>'}
              </tbody>
            </table>
          </div>

          <script>
            async function replyInquiry(ticketId) {
              const input = document.getElementById('inq-reply-' + ticketId);
              if (!input || !input.value.trim()) {
                alert('답변 내용을 입력해주세요.');
                return;
              }
              const answer = input.value.trim();
              if (!confirm('Ticket #' + ticketId + '번에 답변을 등록하고 유저에게 Discord DM 알림을 발송하시겠습니까?')) return;

              try {
                const res = await fetch('/api/admin/inquiry/reply', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ticketId, answer })
                });
                const data = await res.json();
                if (!data.success) {
                  alert('❌ 답변 등록 실패: ' + data.error);
                  return;
                }
                alert('✅ ' + data.message);
                location.reload();
              } catch (e) {
                alert('서버 통신 실패');
              }
            }

            async function rollbackGamble(logId) {
              if (!confirm('이 도박 건(#' + logId + ')을 취소하고 유저의 잔고를 [도박 이전 잔고]로 복구하시겠습니까?')) return;
              try {
                const res = await fetch('/api/admin/rollback/gambling/' + logId, { method: 'POST' });
                const data = await res.json();
                if (!data.success) {
                  alert('❌ 롤백 실패: ' + data.error);
                  return;
                }
                alert(data.message);
                location.reload();
              } catch (e) {
                alert('서버 통신 실패');
              }
            }

            // 👑 웹 관리자 명령어 AJAX 함수들
            async function execGiveMoney() {
              const userId = document.getElementById('cmd-user-id').value.trim();
              const amount = document.getElementById('cmd-amount').value.trim();
              const reason = document.getElementById('cmd-reason').value.trim();
              if (!userId || !amount) return alert('유저 ID와 금액을 입력하세요.');

              const res = await fetch('/api/admin/action/give', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, amount, reason })
              });
              const data = await res.json();
              alert(data.message || data.error);
              if (data.success) location.reload();
            }

            async function execTakeMoney() {
              const userId = document.getElementById('cmd-user-id').value.trim();
              const amount = document.getElementById('cmd-amount').value.trim();
              const reason = document.getElementById('cmd-reason').value.trim();
              if (!userId || !amount) return alert('유저 ID와 금액을 입력하세요.');

              const res = await fetch('/api/admin/action/take', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId, amount, reason })
              });
              const data = await res.json();
              alert(data.message || data.error);
              if (data.success) location.reload();
            }

            async function execResetUser() {
              const userId = document.getElementById('cmd-reset-user-id').value.trim();
              if (!userId) return alert('초기화할 유저 Discord ID를 입력하세요.');
              if (!confirm('정말로 유저(' + userId + ')의 모든 경제/주식/클리커 데이터를 초기화하시겠습니까?')) return;

              const res = await fetch('/api/admin/action/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId })
              });
              const data = await res.json();
              alert(data.message || data.error);
              if (data.success) location.reload();
            }

            async function execSetStockPrice() {
              const stockId = document.getElementById('cmd-stock-id').value;
              const price = document.getElementById('cmd-stock-price').value.trim();
              if (!stockId || !price) return alert('종목과 새 주가를 입력하세요.');

              const res = await fetch('/api/admin/action/stock-price', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ stockId, price })
              });
              const data = await res.json();
              alert(data.message || data.error);
              if (data.success) location.reload();
            }

            async function execSetRegime() {
              const regimeIndex = document.getElementById('cmd-regime-idx').value;
              const res = await fetch('/api/admin/action/market-regime', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ regimeIndex })
              });
              const data = await res.json();
              alert(data.message || data.error);
              if (data.success) location.reload();
            }

            async function execBanIp() {
              const ip = document.getElementById('cmd-ip-addr').value.trim();
              const durationMinutes = document.getElementById('cmd-ip-mins').value.trim();
              if (!ip) return alert('차단할 IP를 입력하세요.');

              const res = await fetch('/api/admin/security/ban', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip, durationMinutes })
              });
              const data = await res.json();
              alert(data.message || data.error);
              if (data.success) location.reload();
            }

            async function execUnbanIp() {
              const ip = document.getElementById('cmd-ip-addr').value.trim();
              if (!ip) return alert('차단 해제할 IP를 입력하세요.');

              const res = await fetch('/api/admin/security/unban', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ip })
              });
              const data = await res.json();
              alert(data.message || data.error);
              if (data.success) location.reload();
            }

            // 🔍 유저 자산/예금 실시간 검색 필터
            function filterUserWealthList() {
              const q = (document.getElementById('user-search-input')?.value || '').trim().toLowerCase();
              const rows = document.querySelectorAll('.user-wealth-row');
              rows.forEach(r => {
                const name = r.getAttribute('data-name') || '';
                const id = r.getAttribute('data-id') || '';
                if (!q || name.includes(q) || id.includes(q)) {
                  r.style.display = '';
                } else {
                  r.style.display = 'none';
                }
              });
            }

            // ⚡ 빠른 선택 (유저 ID 자동 입력 및 포커스)
            function fillUserAction(userId) {
              const uInput = document.getElementById('cmd-user-id');
              const resetInput = document.getElementById('cmd-reset-user-id');
              if (uInput) uInput.value = userId;
              if (resetInput) resetInput.value = userId;
              if (uInput) {
                uInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
                uInput.focus();
              }
            }
          </script>
        </body>
        </html>
      `);
    } catch (err) {
      res.status(500).send(`Admin Dashboard Error: ${err.message}`);
    }
  });

  // Discord OAuth2 콜백 핸들러
  app.get('/auth/discord/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('인증 코드가 전달되지 않았습니다.');

    try {
      const redirectUri = getDynamicRedirectUri(req);
      const params = new URLSearchParams();
      params.append('client_id', config.discord.clientId);
      params.append('client_secret', config.discord.clientSecret);
      params.append('grant_type', 'authorization_code');
      params.append('code', code);
      params.append('redirect_uri', redirectUri);
      params.append('scope', 'identify');

      const tokenRes = await axios.post('https://discord.com/api/v10/oauth2/token', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });

      const accessToken = tokenRes.data.access_token;
      const userRes = await axios.get('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      const discordUser = userRes.data;
      const username = discordUser.global_name || discordUser.username || discordUser.tag;
      const avatarUrl = discordUser.avatar 
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`;

      await getOrCreateUser(discordUser.id, username, avatarUrl);

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

  app.get('/auth/logout', (req, res) => {
    res.clearCookie('discord_user');
    res.redirect('/');
  });

  app.get('/auth/guide', (req, res) => {
    const redirectUri = getDynamicRedirectUri(req);
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
          <a href="/" style="color:#58a6ff;">← 메인 페이지로 돌아가기</a>
        </div>
      </body>
      </html>
    `);
  });

  // 🔒 개인정보처리방침 페이지 (/privacy)
  const renderPrivacyPolicy = (req, res) => {
    const baseUrl = getDynamicBaseUrl(req);
    res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>🔒 개인정보처리방침 | 월덕 (Duck Economy)</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@600;700;800&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg: #090d16;
            --card-bg: #111827;
            --card-border: rgba(255, 255, 255, 0.08);
            --primary: #6366f1;
            --primary-hover: #4f46e5;
            --accent: #38bdf8;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --text-sub: #cbd5e1;
            --badge-bg: rgba(99, 102, 241, 0.15);
            --badge-border: rgba(99, 102, 241, 0.35);
          }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: var(--bg);
            color: var(--text-main);
            line-height: 1.7;
            padding-bottom: 80px;
          }
          a { color: var(--accent); text-decoration: none; transition: color 0.2s; }
          a:hover { color: #818cf8; text-decoration: underline; }

          /* 상단 네비게이션 */
          .nav-header {
            position: sticky;
            top: 0;
            z-index: 100;
            background: rgba(9, 13, 22, 0.85);
            backdrop-filter: blur(14px);
            border-bottom: 1px solid var(--card-border);
            padding: 16px 28px;
            display: flex;
            justify-content: space-between;
            align-items: center;
          }
          .nav-brand {
            font-family: 'Outfit', sans-serif;
            font-size: 1.2rem;
            font-weight: 800;
            color: #fff;
            display: flex;
            align-items: center;
            gap: 10px;
            text-decoration: none !important;
          }
          .nav-actions { display: flex; gap: 10px; align-items: center; }
          .btn-nav {
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid var(--card-border);
            color: #fff;
            padding: 8px 16px;
            border-radius: 10px;
            font-size: 0.85rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            text-decoration: none !important;
          }
          .btn-nav:hover {
            background: var(--primary);
            border-color: var(--primary-hover);
            transform: translateY(-1px);
          }

          /* 본문 컨테이너 */
          .policy-container {
            max-width: 920px;
            margin: 40px auto 0;
            padding: 0 20px;
          }

          /* 히어로 헤더 */
          .policy-hero {
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(17, 24, 39, 0.9) 100%);
            border: 1px solid var(--badge-border);
            border-radius: 20px;
            padding: 36px 32px;
            margin-bottom: 30px;
            position: relative;
            overflow: hidden;
          }
          .policy-tag {
            display: inline-block;
            background: var(--badge-bg);
            border: 1px solid var(--badge-border);
            color: #c7d2fe;
            font-size: 0.8rem;
            font-weight: 700;
            padding: 4px 12px;
            border-radius: 20px;
            margin-bottom: 14px;
          }
          .policy-title {
            font-family: 'Outfit', sans-serif;
            font-size: 2.1rem;
            font-weight: 800;
            color: #fff;
            margin-bottom: 12px;
            letter-spacing: -0.02em;
          }
          .policy-subtitle {
            color: var(--text-sub);
            font-size: 0.95rem;
            max-width: 720px;
            margin-bottom: 18px;
          }
          .policy-meta-row {
            display: flex;
            flex-wrap: wrap;
            gap: 16px;
            font-size: 0.82rem;
            color: var(--text-muted);
            padding-top: 14px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
          }
          .meta-item { display: flex; align-items: center; gap: 6px; }
          .meta-item b { color: #fff; }

          /* 요약 핵심 하이라이트 박스 */
          .summary-card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 16px;
            padding: 24px;
            margin-bottom: 35px;
          }
          .summary-card h3 {
            font-size: 1.05rem;
            color: #fbbf24;
            margin-bottom: 14px;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 14px;
          }
          .summary-box {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.05);
            padding: 14px;
            border-radius: 12px;
          }
          .summary-box-title { font-size: 0.78rem; color: var(--text-muted); margin-bottom: 4px; font-weight: 600; }
          .summary-box-desc { font-size: 0.9rem; color: #fff; font-weight: 700; }

          /* 빠른 이동 목차 (TOC) */
          .toc-nav {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 35px;
            padding: 16px;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--card-border);
            border-radius: 14px;
          }
          .toc-pill {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: var(--text-sub);
            padding: 5px 12px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 600;
            text-decoration: none !important;
            transition: all 0.2s;
          }
          .toc-pill:hover {
            background: rgba(99, 102, 241, 0.25);
            color: #fff;
            border-color: rgba(99, 102, 241, 0.5);
          }

          /* 본문 조항 섹션 */
          .policy-section {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 16px;
            padding: 28px 30px;
            margin-bottom: 24px;
            scroll-margin-top: 90px;
          }
          .section-title {
            font-family: 'Outfit', sans-serif;
            font-size: 1.25rem;
            font-weight: 800;
            color: #fff;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            gap: 10px;
            padding-bottom: 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          }
          .section-title .sec-num {
            background: var(--primary);
            color: #fff;
            font-size: 0.8rem;
            font-weight: 800;
            padding: 2px 8px;
            border-radius: 6px;
          }
          .policy-section p {
            color: var(--text-sub);
            font-size: 0.92rem;
            margin-bottom: 14px;
          }
          .policy-section ul, .policy-section ol {
            color: var(--text-sub);
            font-size: 0.92rem;
            margin-left: 20px;
            margin-bottom: 14px;
          }
          .policy-section li { margin-bottom: 8px; }
          .policy-section strong { color: #fff; font-weight: 700; }

          /* 정보 표 테이블 */
          .policy-table {
            width: 100%;
            border-collapse: collapse;
            margin: 16px 0;
            font-size: 0.85rem;
          }
          .policy-table th {
            background: rgba(0, 0, 0, 0.3);
            color: #94a3b8;
            font-weight: 700;
            text-align: left;
            padding: 12px 14px;
            border-bottom: 1px solid var(--card-border);
          }
          .policy-table td {
            padding: 12px 14px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.04);
            color: var(--text-sub);
            vertical-align: top;
          }
          .policy-table tr:hover td {
            background: rgba(255, 255, 255, 0.02);
          }

          /* 하이라이트 콜아웃 */
          .callout-box {
            background: rgba(99, 102, 241, 0.08);
            border-left: 4px solid var(--primary);
            padding: 14px 18px;
            border-radius: 8px;
            margin: 16px 0;
            font-size: 0.88rem;
            color: #c7d2fe;
          }
          .callout-warn {
            background: rgba(245, 158, 11, 0.08);
            border-left: 4px solid #f59e0b;
            color: #fde68a;
          }
          .callout-success {
            background: rgba(16, 185, 129, 0.08);
            border-left: 4px solid #10b981;
            color: #a7f3d0;
          }

          /* 푸터 및 인쇄 */
          .policy-footer {
            text-align: center;
            margin-top: 50px;
            padding-top: 30px;
            border-top: 1px solid var(--card-border);
            color: var(--text-muted);
            font-size: 0.85rem;
          }
          .btn-print {
            background: transparent;
            border: 1px solid var(--card-border);
            color: var(--text-muted);
            padding: 6px 14px;
            border-radius: 8px;
            font-size: 0.8rem;
            cursor: pointer;
            margin-top: 12px;
            transition: all 0.2s;
          }
          .btn-print:hover { color: #fff; border-color: #fff; }

          @media (max-width: 640px) {
            .policy-hero { padding: 24px 18px; }
            .policy-title { font-size: 1.6rem; }
            .policy-section { padding: 20px 16px; }
            .nav-header { padding: 12px 16px; }
          }
        </style>
      </head>
      <body>
        <!-- 상단 네비게이션 헤더 -->
        <header class="nav-header">
          <a href="/" class="nav-brand">
            <span>🦆</span>
            <span>월덕 경제 시스템</span>
          </a>
          <div class="nav-actions">
            <a href="/" class="btn-nav">🏠 메인 화면</a>
            <a href="/terms" class="btn-nav">📜 서비스 이용약관</a>
          </div>
        </header>

        <main class="policy-container">
          <!-- 히어로 배너 -->
          <div class="policy-hero">
            <span class="policy-tag">Privacy Policy</span>
            <h1 class="policy-title">개인정보처리방침</h1>
            <p class="policy-subtitle">
              '월덕(Duck Economy)' 서비스(이하 '서비스')는 정보주체의 자유와 권리 보호를 위해 「개인정보 보호법」 및 관계 법령이 정한 바를 준수하며, 이용자의 개인정보를 안전하게 처리하고 보호하기 위하여 다음과 같이 개인정보처리방침을 수립·공개합니다.
            </p>
            <div class="policy-meta-row">
              <div class="meta-item">📅 <b>시행일자:</b> 2026년 8월 15일</div>
              <div class="meta-item">🔄 <b>최종 개정일:</b> 2026년 8월 15일</div>
              <div class="meta-item">🌐 <b>적용 대상:</b> 디스코드 봇 및 웹 애플리케이션 전 서비스</div>
            </div>
          </div>

          <!-- 핵심 요약 카드 -->
          <div class="summary-card">
            <h3>📌 개인정보 처리 핵심 요약</h3>
            <div class="summary-grid">
              <div class="summary-box">
                <div class="summary-box-title">수집 항목</div>
                <div class="summary-box-desc">Discord ID, 닉네임, 아바타</div>
              </div>
              <div class="summary-box">
                <div class="summary-box-title">수집 목적</div>
                <div class="summary-box-desc">계정 식별, 게임 자산 저장, 1:1 문의</div>
              </div>
              <div class="summary-box">
                <div class="summary-box-title">보유 기간</div>
                <div class="summary-box-desc">탈퇴 시 즉시 파기 (로그 30일)</div>
              </div>
              <div class="summary-box">
                <div class="summary-box-title">제3자 제공</div>
                <div class="summary-box-desc" style="color: #34d399;">일체 없음 (None)</div>
              </div>
            </div>
          </div>

          <!-- 빠른 목차 (TOC) -->
          <nav class="toc-nav">
            <a href="#sec-1" class="toc-pill">1. 수집 목적</a>
            <a href="#sec-2" class="toc-pill">2. 수집 항목 및 방법</a>
            <a href="#sec-3" class="toc-pill">3. 보유 및 이용기간</a>
            <a href="#sec-4" class="toc-pill">4. 제3자 제공 및 위탁</a>
            <a href="#sec-5" class="toc-pill">5. 이용자의 권리 및 행사</a>
            <a href="#sec-6" class="toc-pill">6. 파기 절차 및 방법</a>
            <a href="#sec-7" class="toc-pill">7. 안전성 확보 조치</a>
            <a href="#sec-8" class="toc-pill">8. 쿠키(Cookie) 운영</a>
            <a href="#sec-9" class="toc-pill">9. 보호책임자 및 문의처</a>
            <a href="#sec-10" class="toc-pill">10. 방침의 변경 및 고지</a>
          </nav>

          <!-- 제1조 -->
          <section id="sec-1" class="policy-section">
            <h2 class="section-title"><span class="sec-num">제1조</span> 개인정보의 수집 및 이용 목적</h2>
            <p>서비스는 다음의 목적을 위하여 최소한의 개인정보를 수집 및 처리합니다. 처리하고 있는 개인정보는 다음의 목적 이외의 용도로는 이용되지 않으며, 이용 목적이 변경되는 경우에는 관련 법령에 따라 별도의 동의를 받는 등 필요한 조치를 이행할 예정입니다.</p>
            <ul>
              <li><strong>1. 디스코드(Discord) 계정 연동 및 본인 식별:</strong> Discord OAuth2 로그인을 통한 고유 회원 식별, 중복 가입 방지, 계정 인증 관리</li>
              <li><strong>2. 게임 및 경제 시스템 데이터 관리:</strong> 가상 현금, 은행 예금, 주식 포트폴리오, 광산 클리커 레벨, 출석체크 및 랭킹 데이터의 안전한 저장 및 유지</li>
              <li><strong>3. 1:1 고객센터 문의 접수 및 답변 처리:</strong> 사용자의 버그 제보, 기능 건의, 계정 복구 문의 접수 및 디스코드 관리자 DM을 통한 신속한 답변 회신</li>
              <li><strong>4. 부정 이용 방지 및 서비스 안정성 감사:</strong> 매크로/어뷰징 방지, 시스템 오류 추적, 접속 트래픽 분석 및 무단 침입 방지</li>
            </ul>
          </section>

          <!-- 제2조 -->
          <section id="sec-2" class="policy-section">
            <h2 class="section-title"><span class="sec-num">제2조</span> 수집하는 개인정보의 항목 및 수집 방법</h2>
            <p>서비스는 회원가입 및 서비스 이용 과정에서 다음과 같은 개인정보를 수집합니다.</p>
            
            <table class="policy-table">
              <thead>
                <tr>
                  <th>구분</th>
                  <th>수집 항목</th>
                  <th>수집 목적 및 방법</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>필수 항목 (기본)</strong></td>
                  <td>Discord 고유 ID (User ID), Discord 사용자명(Username), 프로필 아바타 이미지 URL</td>
                  <td>Discord OAuth2 로그인 시 이용자 동의를 거쳐 디스코드 API를 통해 자동 연동</td>
                </tr>
                <tr>
                  <td><strong>선택 항목 (고객센터)</strong></td>
                  <td>1:1 문의 제목, 문의 내용, 첨부 이미지/스크린샷</td>
                  <td>웹 1:1 문의 폼 또는 디스코드 <code>/문의</code> 명령어 작성 시 이용자가 직접 제출</td>
                </tr>
                <tr>
                  <td><strong>자동 수집 항목</strong></td>
                  <td>접속 IP 주소, 브라우저 User-Agent, 서비스 이용 기록(명령어 실행 및 웹 요청 로그)</td>
                  <td>웹 서버 및 디스코드 봇 상호작용 시 시스템 로그를 통해 자동 생성 및 수집</td>
                </tr>
              </tbody>
            </table>

            <div class="callout-box">
              💡 <strong>민감정보 수집 금지:</strong> 서비스는 이용자의 실명, 주민등록번호, 전화번호, 실제 금융 계좌번호, 결제 정보 등 일체의 민감한 개인정보를 수집하거나 요구하지 않습니다.
            </div>
          </section>

          <!-- 제3조 -->
          <section id="sec-3" class="policy-section">
            <h2 class="section-title"><span class="sec-num">제3조</span> 개인정보의 보유 및 이용 기간</h2>
            <p>서비스는 법령에 따른 개인정보 보유·이용 기간 또는 정보주체로부터 개인정보를 수집 시에 동의받은 개인정보 보유·이용 기간 내에서 개인정보를 처리·보유합니다.</p>
            <ul>
              <li><strong>계정 및 가상 자산 정보:</strong> 서비스 이용 계약(디스코드 봇 사용 또는 웹 연동) 유지 기간 동안 보유하며, 회원 탈퇴 또는 데이터 삭제 요청 시 지체 없이 영구 파기합니다.</li>
              <li><strong>시스템 접속 및 명령어 감사 로그:</strong> 악의적 어뷰징 방지 및 시스템 안정성 관리를 위해 <strong>30일간</strong> 보관 후, 백그라운드 자동 스케줄러를 통해 30일이 초과된 데이터는 영구 자동 파기됩니다.</li>
              <li><strong>1:1 고객센터 상담 내역:</strong> 고객 분쟁 해결 및 상담 이력 확인을 위해 최대 <strong>1년간</strong> 보관 후 안전하게 파기됩니다.</li>
            </ul>
          </section>

          <!-- 제4조 -->
          <section id="sec-4" class="policy-section">
            <h2 class="section-title"><span class="sec-num">제4조</span> 개인정보의 제3자 제공 및 위탁</h2>
            <p>서비스는 정보주체의 개인정보를 제1조(개인정보의 수집 및 이용 목적)에서 명시한 범위 내에서만 처리하며, 정보주체의 동의 없이 본래의 범위를 초과하여 처리하거나 <strong>제3자에게 제공 및 위탁하지 않습니다.</strong></p>
            <div class="callout-box callout-success">
              ✅ <strong>제3자 제공 내역 없음:</strong> 본 서비스는 영리 목적의 타사 광고 제공, 데이터 판매, 외부 마케팅 위탁을 일체 진행하지 않습니다.
            </div>
            <p style="font-size: 0.85rem; color: var(--text-muted);">※ 단, 법률에 특별한 규정이 있거나 법령상 의무를 준수하기 위하여 불가피하게 수사기관 등의 적법한 요청이 있는 경우에는 예외로 합니다.</p>
          </section>

          <!-- 제5조 -->
          <section id="sec-5" class="policy-section">
            <h2 class="section-title"><span class="sec-num">제5조</span> 정보주체 및 법정대리인의 권리·의무 및 행사 방법</h2>
            <p>정보주체는 서비스에 대해 언제든지 다음 각 호의 개인정보 보호 관련 권리를 행사할 수 있습니다.</p>
            <ol>
              <li><strong>개인정보 열람 및 자산 조회:</strong> 메인 웹사이트 상단 프로필 모달 및 디스코드 <code>/지갑</code>, <code>/포트폴리오</code> 명령어를 통해 실시간 데이터 확인 가능</li>
              <li><strong>Discord 연동 해제 (승인 취소):</strong> Discord 앱 설정 ➔ [승인된 앱(Authorized Apps)] 메뉴에서 '월덕' 애플리케이션의 권한을 언제든 직접 즉시 취소 가능</li>
              <li><strong>계정 및 데이터 영구 삭제(탈퇴) 요청:</strong> 1:1 고객센터 문의 창구 또는 디스코드 <code>/문의</code> 명령어를 통해 본인 확인 후 모든 데이터의 즉시 파기를 요청하실 수 있습니다.</li>
            </ol>
          </section>

          <!-- 제6조 -->
          <section id="sec-6" class="policy-section">
            <h2 class="section-title"><span class="sec-num">제6조</span> 개인정보의 파기 절차 및 파기 방법</h2>
            <p>서비스는 개인정보 보유기간의 경과, 처리목적 달성 등 개인정보가 불필요하게 되었을 때에는 지체 없이 해당 개인정보를 파기합니다.</p>
            <ul>
              <li><strong>파기 절차:</strong> 파기 사유가 발생한 개인정보를 선정하고, 관리자의 승인을 거쳐 데이터베이스에서 즉시 삭제 조치합니다.</li>
              <li><strong>파기 방법:</strong> 전자적 파일 형태의 정보는 기록을 재생할 수 없는 기술적 방법(SQL DELETE 및 스토리지 영구 삭제)을 사용하여 파기합니다.</li>
            </ul>
          </section>

          <!-- 제7조 -->
          <section id="sec-7" class="policy-section">
            <h2 class="section-title"><span class="sec-num">제7조</span> 개인정보의 안전성 확보 조치</h2>
            <p>서비스는 개인정보의 안전성 확보를 위해 다음과 같은 기술적·관리적 조치를 취하고 있습니다.</p>
            <ul>
              <li><strong>1. 통신 구간 암호화:</strong> HTTPS(SSL/TLS) 보안 프로토콜을 적용하여 데이터 송수신 시 도청 및 위변조를 방지합니다.</li>
              <li><strong>2. 안전한 세션 쿠키 보호:</strong> 로그인 인증 토큰은 <code>HttpOnly</code> 및 보안 속성이 적용된 쿠키로 격리하여 XSS 공격 및 스크립트 탈취를 원천 차단합니다.</li>
              <li><strong>3. 권한 관리 및 접근 통제:</strong> 데이터베이스 및 관리자 페이지에 대한 접근 권한을 관리자 Discord ID 화이트리스트로 엄격히 제한합니다.</li>
              <li><strong>4. 첨부 파일 격리 및 정제:</strong> 1:1 문의 시 첨부되는 이미지 파일은 확장자 및 Base64 바이너리 검증을 거쳐 독립된 격리 스토리지에 안전하게 보관됩니다.</li>
            </ul>
          </section>

          <!-- 제8조 -->
          <section id="sec-8" class="policy-section">
            <h2 class="section-title"><span class="sec-num">제8조</span> 개인정보 자동 수집 장치의 설치·운영 및 거부에 관한 사항</h2>
            <p>서비스는 이용자에게 개별적인 맞춤 서비스를 제공하기 위해 이용 정보를 저장하고 수시로 불러오는 <strong>'쿠키(Cookie)'</strong>를 사용합니다.</p>
            <ul>
              <li><strong>쿠키의 사용 목적:</strong> Discord 로그인 상태 유지 및 세션 인증 (<code>discord_user</code> 쿠키)</li>
              <li><strong>쿠키 설치 거부 방법:</strong> 웹 브라우저의 옵션 설정을 통해 쿠키 저장을 거부할 수 있습니다. 단, 쿠키 저장을 거부할 경우 웹 애플리케이션 로그인 및 마이페이지 이용에 제한이 있을 수 있습니다.</li>
            </ul>
          </section>

          <!-- 제9조 -->
          <section id="sec-9" class="policy-section">
            <h2 class="section-title"><span class="sec-num">제9조</span> 개인정보 보호책임자 및 1:1 고객센터 창구</h2>
            <p>서비스는 개인정보 처리에 관한 업무를 총괄해서 책임지고, 개인정보 처리와 관련한 정보주체의 불만처리 및 피해구제 등을 위하여 아래와 같이 고객 지원 창구를 운영하고 있습니다.</p>
            
            <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); padding: 18px 20px; border-radius: 12px; margin-top: 12px;">
              <p style="margin-bottom: 6px;"><strong>🛡️ 개인정보 보호 및 고객 지원팀:</strong> 월덕(Duck Economy) 운영진</p>
              <p style="margin-bottom: 6px;"><strong>💬 디스코드 1:1 문의 명령어:</strong> <code>/문의</code></p>
              <p style="margin-bottom: 6px;"><strong>🌐 웹 1:1 고객센터:</strong> <a href="/#support">메인 화면 하단 1:1 문의 창구</a></p>
              <p style="margin-bottom: 0;"><strong>⚡ 관리자 다이렉트 소통:</strong> 문의 접수 시 관리자 디스코드 DM으로 실시간 전송 후 즉시 답변</p>
            </div>
          </section>

          <!-- 제10조 -->
          <section id="sec-10" class="policy-section">
            <h2 class="section-title"><span class="sec-num">제10조</span> 개인정보처리방침의 변경 및 고지 의무</h2>
            <p>본 개인정보처리방침은 <strong>2026년 8월 15일</strong>부터 적용됩니다. 법령 및 방침에 따른 변경내용의 추가, 삭제 및 정정이 있는 경우에는 변경사항의 시행 7일 전부터 웹사이트 공지사항 또는 디스코드 봇 알림을 통하여 고지할 것입니다.</p>
          </section>

          <!-- 푸터 -->
          <footer class="policy-footer">
            <p>© 2026 Duck Economy Project. All rights reserved.</p>
            <p style="margin-top: 4px; font-size: 0.78rem;">공식 웹 주소: <a href="${baseUrl}/privacy">${baseUrl}/privacy</a></p>
            <button type="button" class="btn-print" onclick="window.print()">🖨️ 개인정보처리방침 인쇄하기</button>
          </footer>
        </main>
      </body>
      </html>
    `);
  };

  // 📜 서비스 이용약관 페이지 (/terms)
  const renderTermsOfService = (req, res) => {
    const baseUrl = getDynamicBaseUrl(req);
    res.send(`
      <!DOCTYPE html>
      <html lang="ko">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>📜 서비스 이용약관 | 월덕 (Duck Economy)</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@600;700;800&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg: #090d16;
            --card-bg: #111827;
            --card-border: rgba(255, 255, 255, 0.08);
            --primary: #6366f1;
            --primary-hover: #4f46e5;
            --accent: #38bdf8;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --text-sub: #cbd5e1;
          }
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: 'Inter', sans-serif; background-color: var(--bg); color: var(--text-main); line-height: 1.7; padding-bottom: 80px; }
          a { color: var(--accent); text-decoration: none; }
          .nav-header { position: sticky; top: 0; z-index: 100; background: rgba(9, 13, 22, 0.85); backdrop-filter: blur(14px); border-bottom: 1px solid var(--card-border); padding: 16px 28px; display: flex; justify-content: space-between; align-items: center; }
          .nav-brand { font-family: 'Outfit', sans-serif; font-size: 1.2rem; font-weight: 800; color: #fff; display: flex; align-items: center; gap: 10px; }
          .btn-nav { background: rgba(255, 255, 255, 0.06); border: 1px solid var(--card-border); color: #fff; padding: 8px 16px; border-radius: 10px; font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: all 0.2s; }
          .btn-nav:hover { background: var(--primary); }
          .policy-container { max-width: 920px; margin: 40px auto 0; padding: 0 20px; }
          .policy-hero { background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(17, 24, 39, 0.9) 100%); border: 1px solid rgba(99, 102, 241, 0.35); border-radius: 20px; padding: 36px 32px; margin-bottom: 30px; }
          .policy-title { font-family: 'Outfit', sans-serif; font-size: 2.1rem; font-weight: 800; color: #fff; margin-bottom: 12px; }
          .policy-section { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 16px; padding: 28px 30px; margin-bottom: 24px; }
          .section-title { font-family: 'Outfit', sans-serif; font-size: 1.25rem; font-weight: 800; color: #fff; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
          .policy-section p, .policy-section li { color: var(--text-sub); font-size: 0.92rem; margin-bottom: 8px; }
          .policy-section ul { margin-left: 20px; margin-bottom: 14px; }
          .policy-footer { text-align: center; margin-top: 50px; padding-top: 30px; border-top: 1px solid var(--card-border); color: var(--text-muted); font-size: 0.85rem; }
        </style>
      </head>
      <body>
        <header class="nav-header">
          <a href="/" class="nav-brand"><span>🦆</span><span>월덕 경제 시스템</span></a>
          <div style="display:flex; gap:10px;">
            <a href="/" class="btn-nav">🏠 메인 화면</a>
            <a href="/privacy" class="btn-nav">🔒 개인정보처리방침</a>
          </div>
        </header>

        <main class="policy-container">
          <div class="policy-hero">
            <h1 class="policy-title">서비스 이용약관</h1>
            <p style="color: var(--text-sub);">월덕(Duck Economy) 디스코드 봇 및 웹 애플리케이션 서비스를 이용해 주셔서 감사합니다. 본 약관은 서비스 이용에 관한 권리와 의무를 규정합니다.</p>
            <p style="font-size:0.82rem; color:var(--text-muted); margin-top:10px;">📅 시행일자: 2026년 8월 15일</p>
          </div>

          <section class="policy-section">
            <h2 class="section-title">제1조 (목적 및 서비스 정의)</h2>
            <p>본 약관은 '월덕'(이하 '서비스')이 제공하는 디스코드 가상 경제, 주식 차트 시뮬레이션, 광산 클리커 및 카지노 미니게임 서비스의 이용조건 및 절차를 규정함을 목적으로 합니다.</p>
            <p><strong>⚠️ 가상 데이터 고지:</strong> 본 서비스의 모든 화폐(원), 주식, 채굴 포인트는 Discord 엔터테인먼트용 가상 데이터이며, 실제 현금 가치나 환전성을 갖지 않습니다.</p>
          </section>

          <section class="policy-section">
            <h2 class="section-title">제2조 (이용자의 의무 및 금지행위)</h2>
            <p>이용자는 다음 각 호의 행위를 하여서는 안 됩니다.</p>
            <ul>
              <li>1. 버그나 시스템 취약점을 악용하여 비정상적으로 가상 화폐나 자산을 복제/증식하는 행위</li>
              <li>2. 매크로, 불법 스크립트, 다중 봇 계정을 이용하여 비정상적인 트래픽을 유발하는 행위</li>
              <li>3. 가상 화폐 및 주식을 실제 현금 또는 현물과 거래(현거래)하는 행위</li>
              <li>4. 타인의 디스코드 계정 또는 개인정보를 무단 도용하는 행위</li>
              <li>5. 1:1 고객센터 창구에 음란물, 악성코드, 욕설/비방성 내용을 전송하는 행위</li>
            </ul>
          </section>

          <section class="policy-section">
            <h2 class="section-title">제3조 (서비스의 변경 및 중단)</h2>
            <p>운영진은 서버 점검, 시스템 개선, 보안 조치 등의 필요가 있는 경우 사전 공지 후 서비스의 일부 또는 전부를 변경하거나 중단할 수 있습니다. 긴급 장애 발생 시 사후 공지될 수 있습니다.</p>
          </section>

          <section class="policy-section">
            <h2 class="section-title">제4조 (면책 조항)</h2>
            <p>서비스는 천재지변, 디스코드(Discord) 자체 서버 장애, 통신망 장애 등 불가항력적 사유로 인한 서비스 지연이나 데이터 손실에 대해 책임을 지지 않습니다.</p>
          </section>

          <footer class="policy-footer">
            <p>© 2026 Duck Economy Project. All rights reserved.</p>
            <p style="margin-top: 4px; font-size: 0.78rem;">공식 웹 주소: <a href="${baseUrl}/terms">${baseUrl}/terms</a></p>
          </footer>
        </main>
      </body>
      </html>
    `);
  };

  // 라우트 등록
  app.get('/privacy', renderPrivacyPolicy);
  app.get('/policy', renderPrivacyPolicy);
  app.get('/privacy-policy', renderPrivacyPolicy);
  app.get('/terms', renderTermsOfService);
  app.get('/terms-of-service', renderTermsOfService);

  // ── 🛡️ 보안 현황 관리자 API ──────────────────────────
  // GET /api/admin/security - 보안 현황 조회
  app.get('/api/admin/security', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ error: '관리자 전용' });
    }
    try {
      const stats = getSecurityStats();
      const [recentEvents] = await pool.query(`
        SELECT ip, event_type, path, reason, country, country_name, created_at
        FROM security_events
        ORDER BY created_at DESC
        LIMIT 50
      `);
      return res.json({ success: true, stats, recentEvents });
    } catch (e) {
      return res.json({ success: true, stats: getSecurityStats(), recentEvents: [] });
    }
  });

  // POST /api/admin/security/ban - IP 수동 차단
  app.post('/api/admin/security/ban', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ error: '관리자 전용' });
    }
    const { ip, reason, durationMinutes } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP 필요' });
    banIp(ip, reason || '관리자 수동 차단', Number(durationMinutes) || 1440);
    return res.json({ success: true, message: `${ip} 차단 완료` });
  });

  // POST /api/admin/security/unban - IP 차단 해제
  app.post('/api/admin/security/unban', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ error: '관리자 전용' });
    }
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP 필요' });
    const ok = unbanIp(ip);
    return res.json({ success: ok, message: ok ? `${ip} 차단 해제` : `${ip}는 차단 목록에 없음` });
  });

  // ════════════════════════════════════════════════════════════
  // 👑 웹 관리자 명령어 실행 API (Discord 관리자 명령어 웹 연동)
  // ════════════════════════════════════════════════════════════

  // 유저 ID, 멘션, 닉네임 자동 해석 헬퍼
  async function resolveTargetUser(inputStr) {
    if (!inputStr) return null;
    const cleaned = String(inputStr).trim().replace(/<@!?>/g, '').replace(/[@<>\s]/g, '');
    if (!cleaned) return null;

    // 1. 숫자 ID로 검색
    if (/^\d{16,22}$/.test(cleaned)) {
      return await getOrCreateUser(cleaned);
    }

    // 2. 닉네임 / 유저명으로 DB 검색
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE discord_id = ? OR username = ? OR username LIKE ? ORDER BY id DESC LIMIT 1',
      [cleaned, cleaned, `%${cleaned}%`]
    );
    if (rows && rows.length > 0) return rows[0];

    // 3. 숫자 문자열이면 새 유저로 생성/반환
    if (/^\d+$/.test(cleaned)) {
      return await getOrCreateUser(cleaned);
    }
    return null;
  }

  // 1. 유저 돈 지급 (/admin_give 웹 버전)
  app.post('/api/admin/action/give', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) return res.status(403).json({ success: false, error: '관리자 전용' });

    const { userId, amount, reason } = req.body;
    if (!userId || amount === undefined || amount === null || String(amount).trim() === '') {
      return res.status(400).json({ success: false, error: '유저 ID(또는 닉네임)와 금액을 입력하세요.' });
    }

    const cleanAmtStr = String(amount).replace(/[,원\s]/g, '');
    const parsedAmount = BigInt(cleanAmtStr || '0');
    if (parsedAmount <= 0n) return res.status(400).json({ success: false, error: '금액은 1원 이상이어야 합니다.' });

    try {
      const targetUser = await resolveTargetUser(userId);
      if (!targetUser) return res.status(404).json({ success: false, error: `유저 '${userId}'를 찾을 수 없습니다.` });

      const targetId = targetUser.discord_id;
      const targetName = targetUser.username || `유저_${targetId.slice(-4)}`;
      const beforeCash = BigInt(targetUser.cash || 0);
      const afterCash = beforeCash + parsedAmount;

      await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [afterCash.toString(), targetId]);

      // 경제 로그 및 관리자 감사 로그 기록
      await pool.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'ADMIN_GIVE', ?, ?, ?, ?)
      `, [targetId, targetName, parsedAmount.toString(), beforeCash.toString(), afterCash.toString(), `👑 [웹 관리자 지급] +${formatMoney(parsedAmount)} (사유: ${reason || '관리자 수동 지급'})`]);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_GIVE_MONEY', targetId, { amount: parsedAmount.toString(), targetName, reason: reason || '관리자 수동 지급' }, req);

      return res.json({ success: true, message: `✅ [@${targetName}]님에게 ${formatMoney(parsedAmount)}이 성공적으로 지급되었습니다! (잔액: ${formatMoney(afterCash)})` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 2. 유저 돈 회수 (/admin_take 웹 버전)
  app.post('/api/admin/action/take', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) return res.status(403).json({ success: false, error: '관리자 전용' });

    const { userId, amount, reason } = req.body;
    if (!userId || amount === undefined || amount === null || String(amount).trim() === '') {
      return res.status(400).json({ success: false, error: '유저 ID(또는 닉네임)와 금액을 입력하세요.' });
    }

    const cleanAmtStr = String(amount).replace(/[,원\s]/g, '');
    const parsedAmount = BigInt(cleanAmtStr || '0');
    if (parsedAmount <= 0n) return res.status(400).json({ success: false, error: '금액은 1원 이상이어야 합니다.' });

    try {
      const targetUser = await resolveTargetUser(userId);
      if (!targetUser) return res.status(404).json({ success: false, error: `유저 '${userId}'를 찾을 수 없습니다.` });

      const targetId = targetUser.discord_id;
      const targetName = targetUser.username || `유저_${targetId.slice(-4)}`;
      const beforeCash = BigInt(targetUser.cash || 0);
      const afterCash = beforeCash > parsedAmount ? beforeCash - parsedAmount : 0n;

      await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [afterCash.toString(), targetId]);

      // 경제 로그 및 관리자 감사 로그
      await pool.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'ADMIN_TAKE', ?, ?, ?, ?)
      `, [targetId, targetName, parsedAmount.toString(), beforeCash.toString(), afterCash.toString(), `👑 [웹 관리자 회수] -${formatMoney(parsedAmount)} (사유: ${reason || '관리자 수동 회수'})`]);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_TAKE_MONEY', targetId, { amount: parsedAmount.toString(), targetName, reason: reason || '관리자 수동 회수' }, req);

      return res.json({ success: true, message: `✅ [@${targetName}]님의 자금 ${formatMoney(parsedAmount)}이 회수되었습니다. (잔액: ${formatMoney(afterCash)})` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 3. 유저 데이터 초기화 (/admin_reset 웹 버전)
  app.post('/api/admin/action/reset', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) return res.status(403).json({ success: false, error: '관리자 전용' });

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: '유저 ID(또는 닉네임)를 입력하세요.' });

    try {
      const targetUser = await resolveTargetUser(userId);
      if (!targetUser) return res.status(404).json({ success: false, error: `유저 '${userId}'를 찾을 수 없습니다.` });

      const targetId = targetUser.discord_id;
      const targetName = targetUser.username || `유저_${targetId.slice(-4)}`;

      await pool.query(`
        UPDATE users 
        SET cash = ?, bank = 0, clicker_level = 1, auto_miner_level = 0, total_clicks = 0,
            daily_streak = 0, last_daily = NULL, last_work = NULL, last_subsidy = NULL
        WHERE discord_id = ?
      `, [config.initialBalance || 10000, targetId]);

      await pool.query('DELETE FROM user_stocks WHERE user_id = ?', [targetId]);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_RESET_USER', targetId, { targetName }, req);

      return res.json({ success: true, message: `✅ [@${targetName}]님의 모든 경제/주식 데이터가 초기화되었습니다.` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 4. 주가 강제 조작 (/admin_stock 웹 버전)
  app.post('/api/admin/action/stock-price', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) return res.status(403).json({ success: false, error: '관리자 전용' });

    const { stockId, price } = req.body;
    if (!stockId || !price) return res.status(400).json({ success: false, error: '종목 ID와 가격을 입력하세요.' });

    const newPrice = BigInt(price);
    if (newPrice < 10n) return res.status(400).json({ success: false, error: '주가는 10원 이상이어야 합니다.' });

    try {
      const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
      if (stocks.length === 0) return res.status(404).json({ success: false, error: '존재하지 않는 종목입니다.' });

      const current = stocks[0];
      const prevPrice = BigInt(current.price);
      const diff = newPrice - prevPrice;
      const changeRate = prevPrice > 0n ? ((Number(diff) / Number(prevPrice)) * 100).toFixed(2) : '0.00';

      await pool.query(`
        UPDATE stocks 
        SET prev_price = price, price = ?, updated_at = NOW() 
        WHERE stock_id = ?
      `, [newPrice.toString(), stockId]);

      await pool.query('INSERT INTO stock_history (stock_id, price) VALUES (?, ?)', [stockId, newPrice.toString()]);

      await pool.query(`
        INSERT INTO stock_price_logs (stock_id, stock_name, prev_price, new_price, change_rate, diff, regime, reason)
        VALUES (?, ?, ?, ?, ?, ?, '👑 관리자 수동 조작', '웹 관리자 패널에서 주가 직접 지정')
      `, [stockId, current.name, prevPrice.toString(), newPrice.toString(), changeRate, diff.toString()]);

      if (typeof global.__invalidateMarketCache === 'function') global.__invalidateMarketCache();
      if (typeof global.__broadcastMarketUpdate === 'function') setTimeout(global.__broadcastMarketUpdate, 100);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_SET_STOCK_PRICE', stockId, { prevPrice: prevPrice.toString(), newPrice: newPrice.toString() }, req);

      return res.json({ success: true, message: `✅ [${current.name}] 주가가 ${formatMoney(newPrice)}으로 즉시 변경되었습니다.` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 5. 시장 국면 강제 변경
  app.post('/api/admin/action/market-regime', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) return res.status(403).json({ success: false, error: '관리자 전용' });

    const { regimeIndex } = req.body;
    const idx = parseInt(regimeIndex, 10);
    if (isNaN(idx)) return res.status(400).json({ success: false, error: '국면 인덱스를 지정하세요.' });

    try {
      const { setMarketRegime, getCurrentMarketRegime } = require('../utils/stockEngine');
      setMarketRegime(idx);

      if (typeof global.__invalidateMarketCache === 'function') global.__invalidateMarketCache();
      if (typeof global.__broadcastMarketUpdate === 'function') setTimeout(global.__broadcastMarketUpdate, 100);

      const regime = getCurrentMarketRegime();
      await logAdminAction(session.id, session.username || '관리자', 'WEB_SET_REGIME', String(idx), { regimeName: regime ? regime.name : '' }, req);

      return res.json({ success: true, message: `✅ 시장 국면이 [${regime ? regime.name : idx}] (으)로 변경 예약되었습니다.` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`🌐 디스코드 경제 & OAuth2 웹 서버가 실행되었습니다 (포트: ${PORT})`);
    console.log(`🔗 메인 웹사이트: http://localhost:${PORT}`);
    console.log(`🔗 관리자 관제 패널: http://localhost:${PORT}/admin`);
    console.log(`🔗 Discord OAuth2 Redirect URI: ${config.discord.redirectUri}`);
  });
}

module.exports = { startWebServer };
