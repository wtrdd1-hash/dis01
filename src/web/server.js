const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const config = require('../config/config');
const { pool, getOrCreateUser } = require('../config/database');
const { formatMoney, formatPercent, formatNumber } = require('../utils/formatters');
const { getCurrentMarketRegime, getLastNews, getRecentNewsFeed } = require('../utils/stockEngine');
const { logWebAccess, logAdminAction } = require('../utils/logger');

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

// 도박 턴(Turn/Energy) 계산 및 자동 회복 헬퍼 (30초당 1턴, 최대 50턴)
function calculateUserTurns(user) {
  const maxTurns = 50;
  let turns = user.gamble_turns ?? 50;
  const lastUpdate = user.last_turn_update ? new Date(user.last_turn_update).getTime() : Date.now();
  const now = Date.now();
  const elapsedSeconds = Math.floor((now - lastUpdate) / 1000);
  const recovered = Math.floor(elapsedSeconds / 30);
  
  if (recovered > 0 && turns < maxTurns) {
    turns = Math.min(maxTurns, turns + recovered);
  }
  const nextSec = turns >= maxTurns ? 0 : (30 - (elapsedSeconds % 30));
  return { turns, maxTurns, nextSec, recovered };
}

// 백엔드 게임 중복/스팸 실행 방지 락 (User In-flight Action Lock)
const activeGameUsers = new Set();

function startWebServer(client) {
  const app = express();
  const PORT = config.port || 8080;

  app.set('trust proxy', true);

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

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

  // 3초 TTL 메모리 캐시
  let marketCache = { data: null, timestamp: 0 };
  let leaderboardCache = { data: null, timestamp: 0 };
  const CACHE_TTL_MS = 2500;

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

  // ==========================================
  // 🎮 웹 카지노 & 클리커 & 경제 API 엔드포인트
  // ==========================================

  // 1. 현재 로그인 유저 상세 정보 API
  app.get('/api/user/me', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const userData = await getOrCreateUser(session.id, session.username, session.avatar);
      const { turns, maxTurns, nextSec, recovered } = calculateUserTurns(userData);

      if (recovered > 0) {
        await pool.query('UPDATE users SET gamble_turns = ?, last_turn_update = NOW() WHERE discord_id = ?', [turns, session.id]);
      }

      const [userStocks] = await pool.query(`
        SELECT us.stock_id, us.amount, us.total_spent, s.name, s.price
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.user_id = ? AND us.amount > 0
      `, [session.id]);

      let stockVal = 0n;
      const formattedStocks = userStocks.map(us => {
        const amt = BigInt(us.amount);
        const curPrice = BigInt(us.price);
        const spent = BigInt(us.total_spent);
        const evalVal = amt * curPrice;
        stockVal += evalVal;
        return {
          stock_id: us.stock_id,
          name: us.name,
          amount: amt.toString(),
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
          gamble_turns: turns,
          max_turns: maxTurns,
          next_turn_sec: nextSec,
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

  // 2. ⛏️ 클리커 클릭 액션 API
  app.post('/api/clicker/click', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    let { count } = req.body;
    const clicks = Math.min(Math.max(parseInt(count, 10) || 1, 1), 20);

    try {
      const userData = await getOrCreateUser(session.id);
      const { turns, maxTurns } = calculateUserTurns(userData);

      const level = userData.clicker_level || 1;
      const basePerClick = level * 100;
      
      let earnedCash = 0;
      let bonusTurns = 0;
      let critCount = 0;

      for (let i = 0; i < clicks; i++) {
        const isCrit = Math.random() < 0.15;
        const clickReward = isCrit ? (basePerClick * 5) : basePerClick;
        if (isCrit) critCount++;
        earnedCash += clickReward;

        if (Math.random() < 0.12 && (turns + bonusTurns < maxTurns)) {
          bonusTurns++;
        }
      }

      const newCash = BigInt(userData.cash || 0) + BigInt(earnedCash);
      const newTurns = Math.min(maxTurns, turns + bonusTurns);
      const totalClicks = BigInt(userData.total_clicks || 0) + BigInt(clicks);

      await pool.query(
        'UPDATE users SET cash = ?, gamble_turns = ?, total_clicks = ? WHERE discord_id = ?',
        [newCash.toString(), newTurns, totalClicks.toString(), session.id]
      );

      res.json({
        success: true,
        earnedCash,
        bonusTurns,
        critCount,
        newCash: newCash.toString(),
        turns: newTurns,
        maxTurns,
        totalClicks: totalClicks.toString()
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. 🔨 클리커 업그레이드 상점 API
  app.post('/api/clicker/upgrade', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { type } = req.body;
    try {
      const userData = await getOrCreateUser(session.id);
      let userCash = BigInt(userData.cash || 0);
      let clickerLevel = userData.clicker_level || 1;
      let autoLevel = userData.auto_miner_level || 0;
      let { turns, maxTurns } = calculateUserTurns(userData);

      if (type === 'power') {
        const cost = BigInt(clickerLevel * 10000);
        if (userCash < cost) return res.status(400).json({ success: false, error: `현금이 부족합니다! (필요: ${formatMoney(cost)})` });

        userCash -= cost;
        clickerLevel += 1;
        await pool.query('UPDATE users SET cash = ?, clicker_level = ? WHERE discord_id = ?', [userCash.toString(), clickerLevel, session.id]);
        return res.json({
          success: true,
          message: `🔨 클릭 파워 Lv.${clickerLevel} 강화 완료! (클릭당 +${formatMoney(clickerLevel * 100)})`,
          newCash: userCash.toString(),
          clickerLevel
        });
      } else if (type === 'auto') {
        const cost = BigInt((autoLevel + 1) * 30000);
        if (userCash < cost) return res.status(400).json({ success: false, error: `현금이 부족합니다! (필요: ${formatMoney(cost)})` });

        userCash -= cost;
        autoLevel += 1;
        await pool.query('UPDATE users SET cash = ?, auto_miner_level = ? WHERE discord_id = ?', [userCash.toString(), autoLevel, session.id]);
        return res.json({
          success: true,
          message: `🤖 자동 채굴기 Lv.${autoLevel} 가동! (초당 +${formatMoney(autoLevel * 300)})`,
          newCash: userCash.toString(),
          autoLevel
        });
      } else if (type === 'recharge') {
        const cost = 20000n;
        if (userCash < cost) return res.status(400).json({ success: false, error: `현금이 부족합니다! (필요: ${formatMoney(cost)})` });
        if (turns >= maxTurns) return res.status(400).json({ success: false, error: '도박 턴이 이미 가득 차 있습니다 (50/50).' });

        userCash -= cost;
        turns = Math.min(maxTurns, turns + 25);
        await pool.query('UPDATE users SET cash = ?, gamble_turns = ?, last_turn_update = NOW() WHERE discord_id = ?', [userCash.toString(), turns, session.id]);
        return res.json({
          success: true,
          message: `⚡ 도박 턴 +25개 긴급 충전 완료! (현재 턴: ${turns}/${maxTurns})`,
          newCash: userCash.toString(),
          turns
        });
      } else {
        return res.status(400).json({ success: false, error: '유효하지 않은 업그레이드입니다.' });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4. 🎰 웹 슬롯머신 게임 API (스냅샷 및 로그 지원)
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

      const { turns, maxTurns } = calculateUserTurns(userData);
      const remainingTurns = Math.max(0, turns - 1);

      const SYMBOLS = ['🍒', '🍋', '🍇', '🔔', '7️⃣', '💎'];
      const reel1 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      const reel2 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      const reel3 = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];

      let multiplier = 0;
      let resultText = '';

      if (reel1 === '💎' && reel2 === '💎' && reel3 === '💎') {
        multiplier = 50; resultText = '🎉 대박! 다이아몬드 잭팟 (50배)!';
      } else if (reel1 === '7️⃣' && reel2 === '7️⃣' && reel3 === '7️⃣') {
        multiplier = 20; resultText = '🔥 럭키 세븐 잭팟 (20배)!';
      } else if (reel1 === '🔔' && reel2 === '🔔' && reel3 === '🔔') {
        multiplier = 10; resultText = '🔔 골든벨 당첨 (10배)!';
      } else if (reel1 === '🍇' && reel2 === '🍇' && reel3 === '🍇') {
        multiplier = 5; resultText = '🍇 포도 3개 일치 (5배)!';
      } else if (reel1 === '🍋' && reel2 === '🍋' && reel3 === '🍋') {
        multiplier = 3; resultText = '🍋 레몬 3개 일치 (3배)!';
      } else if (reel1 === '🍒' && reel2 === '🍒' && reel3 === '🍒') {
        multiplier = 2; resultText = '🍒 체리 3개 일치 (2배)!';
      } else if (reel1 === reel2 || reel2 === reel3 || reel1 === reel3) {
        multiplier = 1.5; resultText = '✨ 2개 일치! 본전 이상 (1.5배)!';
      } else {
        multiplier = 0; resultText = '😢 아쉽게도 빗나갔습니다.';
      }

      const isWin = multiplier > 0;
      const payout = BigInt(Math.floor(Number(betAmount) * multiplier));
      const profit = payout - betAmount;
      const balanceBefore = userCash;
      const balanceAfter = userCash + profit;

      await pool.query(
        'UPDATE users SET cash = ?, gamble_turns = ?, last_turn_update = NOW() WHERE discord_id = ?',
        [balanceAfter.toString(), remainingTurns, session.id]
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
        turns: remainingTurns,
        maxTurns,
        message: resultText
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      activeGameUsers.delete(session.id);
    }
  });

  // 5. 🪙 웹 동전 던지기 게임 API (스냅샷 및 로그 지원)
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

      const { turns, maxTurns } = calculateUserTurns(userData);
      const remainingTurns = Math.max(0, turns - 1);

      const outcomes = ['앞면', '뒷면'];
      const result = outcomes[Math.floor(Math.random() * outcomes.length)];
      const isWin = (choice === result);

      const multiplier = isWin ? 1.95 : 0;
      const payout = isWin ? BigInt(Math.floor(Number(betAmount) * multiplier)) : 0n;
      const profit = payout - betAmount;
      const balanceBefore = userCash;
      const balanceAfter = userCash + profit;

      await pool.query(
        'UPDATE users SET cash = ?, gamble_turns = ?, last_turn_update = NOW() WHERE discord_id = ?',
        [balanceAfter.toString(), remainingTurns, session.id]
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
        turns: remainingTurns,
        maxTurns,
        message: isWin ? `🎉 적중! 동전 결과는 [${result}] 입니다 (+${formatMoney(profit)})` : `💀 실패! 동전 결과는 [${result}] 입니다 (-${formatMoney(betAmount)})`
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    } finally {
      activeGameUsers.delete(session.id);
    }
  });

  // 6. 🎲 웹 주사위 대결 API (스냅샷 및 로그 지원)
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

      const { turns, maxTurns } = calculateUserTurns(userData);
      const remainingTurns = Math.max(0, turns - 1);

      const userDice1 = Math.floor(Math.random() * 6) + 1;
      const userDice2 = Math.floor(Math.random() * 6) + 1;
      const userTotal = userDice1 + userDice2;

      const botDice1 = Math.floor(Math.random() * 6) + 1;
      const botDice2 = Math.floor(Math.random() * 6) + 1;
      const botTotal = botDice1 + botDice2;

      let multiplier = 0;
      let resultText = '';
      if (userTotal > botTotal) {
        multiplier = 2.0; resultText = `🎉 승리! 나(${userTotal}) vs 딜러(${botTotal})`;
      } else if (userTotal === botTotal) {
        multiplier = 1.0; resultText = `🤝 무승부! 나(${userTotal}) vs 딜러(${botTotal}) (배팅금 환불)`;
      } else {
        multiplier = 0; resultText = `💀 패배! 나(${userTotal}) vs 딜러(${botTotal})`;
      }

      const payout = BigInt(Math.floor(Number(betAmount) * multiplier));
      const profit = payout - betAmount;
      const balanceBefore = userCash;
      const balanceAfter = userCash + profit;

      await pool.query(
        'UPDATE users SET cash = ?, gamble_turns = ?, last_turn_update = NOW() WHERE discord_id = ?',
        [balanceAfter.toString(), remainingTurns, session.id]
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
        turns: remainingTurns,
        maxTurns,
        message: resultText
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
      const streakBonus = (cappedStreak - 1) * config.dailyStreakBonus;
      const totalReward = config.dailyReward + streakBonus;

      const beforeCash = BigInt(userData.cash || 0);
      const newCash = beforeCash + BigInt(totalReward);
      const bonusTurns = 15;
      const { turns, maxTurns } = calculateUserTurns(userData);
      const newTurns = Math.min(maxTurns, turns + bonusTurns);

      await pool.query(
        'UPDATE users SET cash = ?, gamble_turns = ?, last_daily = NOW(), daily_streak = ? WHERE discord_id = ?',
        [newCash.toString(), newTurns, streak, session.id]
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
        turns: newTurns,
        message: `🎉 출석체크 성공! +${formatMoney(totalReward)} 및 ⚡도박 턴 +15개 지급 완료!`
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 8. 💸 정부 기본소득 지원금 API (경제 로그 기록)
  app.post('/api/economy/subsidy', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const userData = await getOrCreateUser(session.id);
      const userCash = BigInt(userData.cash || 0);
      const userBank = BigInt(userData.bank || 0);

      if (userCash + userBank >= 50000n) {
        return res.status(400).json({ success: false, error: '자산이 50,000원 미만일 때만 기본소득 지원금을 신청할 수 있습니다.' });
      }

      const subsidyAmount = 50000;
      const newCash = userCash + BigInt(subsidyAmount);
      const { turns, maxTurns } = calculateUserTurns(userData);
      const newTurns = Math.min(maxTurns, turns + 10);

      await pool.query('UPDATE users SET cash = ?, gamble_turns = ?, last_subsidy = NOW() WHERE discord_id = ?', [newCash.toString(), newTurns, session.id]);

      try {
        await pool.query(`
          INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
          VALUES (?, ?, 'SUBSIDY', ?, ?, ?, ?)
        `, [session.id, session.username, subsidyAmount, userCash.toString(), newCash.toString(), '정부 긴급 기본소득 구제 지원금']);
      } catch (e) {}

      res.json({
        success: true,
        subsidyAmount,
        newCash: newCash.toString(),
        turns: newTurns,
        message: `🏛️ 정부 긴급 기본소득 +${formatMoney(subsidyAmount)} 및 ⚡도박 턴 +10개 지급 완료!`
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
    const count = parseInt(amount, 10);
    if (!count || count <= 0) return res.status(400).json({ success: false, error: '거래 수량은 1주 이상이어야 합니다.' });

    try {
      const [stockRows] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
      if (stockRows.length === 0) return res.status(404).json({ success: false, error: '존재하지 않는 종목입니다.' });

      const stock = stockRows[0];
      const stockPrice = BigInt(stock.price);
      const tradeCount = BigInt(count);
      const totalTradePrice = stockPrice * tradeCount;

      const userData = await getOrCreateUser(session.id);
      let userCash = BigInt(userData.cash || 0);

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
        `, [session.id, stockId, tradeCount.toString(), totalTradePrice.toString()]);

        // 체결 로그 영구 기록
        try {
          await pool.query(`
            INSERT INTO stock_transactions (user_id, username, stock_id, stock_name, action, amount, price, total_price)
            VALUES (?, ?, ?, ?, 'BUY', ?, ?, ?)
          `, [session.id, session.username, stockId, stock.name, tradeCount.toString(), stockPrice.toString(), totalTradePrice.toString()]);
        } catch (e) {}

        return res.json({
          success: true,
          action: 'buy',
          stockId,
          stockName: stock.name,
          amount: count,
          price: stockPrice.toString(),
          totalPrice: totalTradePrice.toString(),
          newCash: userCash.toString(),
          message: `🛒 [${stock.name}] ${formatNumber(count)}주 매수 완료 (-${formatMoney(totalTradePrice)})`
        });
      } else if (action === 'sell') {
        const [holdingRows] = await pool.query('SELECT * FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        if (holdingRows.length === 0 || BigInt(holdingRows[0].amount) < tradeCount) {
          const currentHolding = holdingRows[0] ? holdingRows[0].amount : 0;
          return res.status(400).json({ success: false, error: `보유 주식이 부족합니다! (현재 보유: ${currentHolding}주)` });
        }

        const holding = holdingRows[0];
        const holdingAmount = BigInt(holding.amount);
        const holdingSpent = BigInt(holding.total_spent);

        const spentDeduction = (holdingSpent * tradeCount) / holdingAmount;
        const newHoldingAmount = holdingAmount - tradeCount;
        const newHoldingSpent = holdingSpent - spentDeduction;

        userCash += totalTradePrice;
        await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [userCash.toString(), session.id]);

        if (newHoldingAmount === 0n) {
          await pool.query('DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        } else {
          await pool.query('UPDATE user_stocks SET amount = ?, total_spent = ? WHERE user_id = ? AND stock_id = ?', [
            newHoldingAmount.toString(), newHoldingSpent.toString(), session.id, stockId
          ]);
        }

        // 체결 로그 영구 기록
        try {
          await pool.query(`
            INSERT INTO stock_transactions (user_id, username, stock_id, stock_name, action, amount, price, total_price)
            VALUES (?, ?, ?, ?, 'SELL', ?, ?, ?)
          `, [session.id, session.username, stockId, stock.name, tradeCount.toString(), stockPrice.toString(), totalTradePrice.toString()]);
        } catch (e) {}

        return res.json({
          success: true,
          action: 'sell',
          stockId,
          stockName: stock.name,
          amount: count,
          price: stockPrice.toString(),
          totalPrice: totalTradePrice.toString(),
          newCash: userCash.toString(),
          message: `💰 [${stock.name}] ${formatNumber(count)}주 매도 완료 (+${formatMoney(totalTradePrice)})`
        });
      } else {
        return res.status(400).json({ success: false, error: '유효하지 않은 거래 유형입니다.' });
      }
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
          volatility: Number(stock.volatility)
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

  // 13. ⚡ [통합 라이브 피드 & 모든 로그 실시간 스트림 API]
  app.get('/api/system/activity-feed', async (req, res) => {
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

      if (req.cookies && req.cookies.discord_user) {
        try {
          currentUser = JSON.parse(req.cookies.discord_user);
          isAdminUser = config.isAdmin(currentUser.id);
          const userData = await getOrCreateUser(currentUser.id, currentUser.username, currentUser.avatar);
          userTurnsInfo = calculateUserTurns(userData);

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

          userAssets = {
            cash,
            bank,
            stockVal,
            netWorth,
            streak: userData.daily_streak || 0,
            turns: userTurnsInfo.turns,
            clickerLevel: userData.clicker_level || 1,
            autoLevel: userData.auto_miner_level || 0,
            totalClicks: userData.total_clicks || 0
          };
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

        const tradeButtons = currentUser
          ? `
            <div class="stock-trade-actions">
              <button class="btn-trade btn-detail" onclick="openDetailModal('${s.stock_id}')">🔍 상세/차트</button>
              <button class="btn-trade btn-buy" onclick="openTradeModal('${s.stock_id}', '${s.name}', ${s.price}, 'buy')">🛒 매수</button>
              <button class="btn-trade btn-sell" onclick="openTradeModal('${s.stock_id}', '${s.name}', ${s.price}, 'sell')">💰 매도</button>
            </div>
          `
          : `
            <div class="stock-trade-actions">
              <button class="btn-trade btn-detail" onclick="openDetailModal('${s.stock_id}')">🔍 상세/차트</button>
              <a href="${discordLoginUrl}" class="btn-trade-login">로그인 후 거래</a>
            </div>
          `;

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
        const net = BigInt(row.net || 0);

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

      const adminNavButton = isAdminUser ? `<a href="/admin" class="btn-admin-nav">👑 관리자 패널</a>` : '';
      const navbarRightHtml = currentUser
        ? `
          <div class="nav-profile-group">
            ${adminNavButton}
            <div class="turn-badge-nav">⚡ <span id="nav-turns">${userTurnsInfo.turns}</span>/50</div>
            <img src="${currentUser.avatar}" class="nav-avatar-img" alt="Avatar" onError="this.src='https://cdn.discordapp.com/embed/avatars/0.png';">
            <span class="nav-username-text">@${currentUser.username} ${isAdminUser ? '<span class="admin-tag">👑</span>' : ''}</span>
            <a href="/auth/logout" class="btn-logout">🚪 로그아웃</a>
          </div>
        `
        : `<a href="${discordLoginUrl}" class="btn-discord">🎮 Discord OAuth 로그인</a>`;

      const heroSectionHtml = currentUser && userAssets
        ? `
          <div class="hero logged-in-hero">
            <div class="status-badge logged-in-badge">🟢 Discord 인증 완료 (@${currentUser.username}) ${isAdminUser ? '👑 관리자' : ''}</div>
            <h1>👋 환영합니다, @${currentUser.username}님!</h1>
            <p>실시간 <b>상세 주식 차트, 골드 채굴 클리커, 도박 턴 시스템, 실시간 증시 속보</b>를 웹에서 직접 이용하세요.</p>
            
            <div class="personal-asset-grid">
              <div class="asset-card">
                <span class="asset-lbl">💵 보유 현금</span>
                <span class="asset-val" id="my-cash">${formatMoney(userAssets.cash)}</span>
              </div>
              <div class="asset-card">
                <span class="asset-lbl">🏦 은행 예금</span>
                <span class="asset-val" id="my-bank">${formatMoney(userAssets.bank)}</span>
              </div>
              <div class="asset-card">
                <span class="asset-lbl">⚡ 도박 남은 턴</span>
                <span class="asset-val" id="my-turns" style="color: #fbbf24;">${userAssets.turns} / 50</span>
              </div>
              <div class="asset-card highlight">
                <span class="asset-lbl">💎 총 순자산</span>
                <span class="asset-val" id="my-net-worth">${formatMoney(userAssets.netWorth)}</span>
              </div>
            </div>
            
            <div class="hero-quick-actions">
              <button class="btn-quick" onclick="claimDailyReward()">🎁 출석체크 (+15턴)</button>
              <button class="btn-quick" onclick="claimSubsidyReward()">🏛️ 기본소득 지원금</button>
              <button class="btn-quick" onclick="openBankModal()">🏦 은행 입출금</button>
              <button class="btn-quick" style="background: rgba(99, 102, 241, 0.3); border-color: #818cf8;" onclick="switchTab('tab-clicker')">⛏️ 클리커 채굴</button>
              <button class="btn-quick" style="background: rgba(245, 158, 11, 0.2); border-color: #fbbf24; color: #fbbf24;" onclick="switchTab('tab-feed')">⚡ 실시간 모든 로그</button>
            </div>
          </div>
        `
        : `
          <div class="hero">
            <div class="status-badge logged-out-badge">🔴 미인증 상태 (로그인 필요)</div>
            <h1>실시간 디스코드 주식 차트 & 클리커 & 카지노</h1>
            <p>디스코드 계정으로 로그인하면 웹에서 실시간으로 <b>종목별 상세 차트 분석, 골드 채굴 클리커, 도박 턴 충전, 증시 공시 속보</b>를 바로 이용할 수 있습니다.</p>
            <a href="${discordLoginUrl}" class="btn-discord btn-hero">
              ⚡ Discord 계정으로 로그인하고 시작하기
            </a>
          </div>
        `;

      const breakingNewsTicker = news 
        ? `📢 [실시간 속보] ${news.title || news.text}` 
        : `📢 [실시간 속보] 시장 호조세 속에 활발한 거래가 이어지고 있습니다.`;

      res.send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
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

            /* 탭 메뉴 */
            .tabs-nav {
              display: flex;
              gap: 10px;
              margin-bottom: 25px;
              border-bottom: 1px solid var(--card-border);
              padding-bottom: 12px;
              overflow-x: auto;
            }
            .tab-btn {
              background: transparent;
              border: none;
              color: var(--text-muted);
              font-size: 1rem;
              font-weight: 700;
              padding: 10px 18px;
              border-radius: 12px;
              cursor: pointer;
              transition: all 0.2s;
              display: flex;
              align-items: center;
              gap: 8px;
              white-space: nowrap;
            }
            .tab-btn.active {
              background: linear-gradient(135deg, rgba(99, 102, 241, 0.25), rgba(168, 85, 247, 0.25));
              color: #fff;
              border: 1px solid rgba(99, 102, 241, 0.4);
            }
            .tab-btn:hover:not(.active) { background: rgba(255, 255, 255, 0.05); color: #fff; }

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
              width: 140px;
              height: 140px;
              margin: 20px auto;
              background: radial-gradient(circle, #818cf8 30%, #4f46e5 100%);
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 4.5rem;
              cursor: pointer;
              user-select: none;
              box-shadow: 0 10px 35px rgba(99, 102, 241, 0.5);
              transition: transform 0.05s ease;
            }
            .big-click-gem:active { transform: scale(0.92); }
            
            .floating-coin {
              position: absolute;
              font-weight: 800;
              font-family: 'Outfit', sans-serif;
              color: #34d399;
              font-size: 1.2rem;
              pointer-events: none;
              animation: floatUp 0.7s ease-out forwards;
            }
            @keyframes floatUp {
              0% { opacity: 1; transform: translateY(0) scale(1); }
              100% { opacity: 0; transform: translateY(-60px) scale(1.3); }
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
            .text-down { color: #f87171; }

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
            .news-category-filters { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
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
            .btn-filter.active { background: #6366f1; color: #fff; border-color: #818cf8; }
            .btn-filter:hover:not(.active) { background: rgba(255, 255, 255, 0.08); color: #fff; }

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
            
            /* 모달 */
            .modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.8); backdrop-filter: blur(8px); display: none; align-items: center; justify-content: center; z-index: 1000; padding: 20px; }
            .modal-box { background: #111827; border: 1px solid rgba(99, 102, 241, 0.4); border-radius: 24px; padding: 28px; max-width: 520px; width: 100%; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.7); max-height: 90vh; overflow-y: auto; }
            .modal-title { font-family: 'Outfit', sans-serif; font-size: 1.35rem; font-weight: 800; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
            .btn-close-modal { background: transparent; border: none; color: #9ca3af; font-size: 1.6rem; cursor: pointer; }
            
            .chart-view-box { background: #070b14; border: 1px solid #1f2937; border-radius: 16px; padding: 18px; margin: 16px 0; text-align: center; }
            .chart-stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px; }
            .stat-tile { background: rgba(255, 255, 255, 0.03); border: 1px solid var(--card-border); padding: 10px 14px; border-radius: 10px; text-align: left; }
            .stat-lbl { font-size: 0.75rem; color: var(--text-muted); display: block; margin-bottom: 2px; }
            .stat-val { font-size: 0.95rem; font-weight: 700; color: #e0e7ff; font-family: 'Outfit', sans-serif; }

            .pulse-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background-color: #10b981; box-shadow: 0 0 8px #10b981; animation: pulse 1.5s infinite; }
            @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } 100% { opacity: 1; transform: scale(1); } }
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

            <!-- 탭 네비게이션 -->
            <div class="tabs-nav">
              <button class="tab-btn active" onclick="switchTab('tab-stocks')">📈 주식 시장 & 차트</button>
              <button class="tab-btn" onclick="switchTab('tab-feed')">⚡ 실시간 모든 로그 (라이브)</button>
              <button class="tab-btn" onclick="switchTab('tab-news')">📰 시장 뉴스 & 경제 공시</button>
              <button class="tab-btn" onclick="switchTab('tab-clicker')">⛏️ 골드 채굴 & 클리커</button>
              <button class="tab-btn" onclick="switchTab('tab-casino')">🎰 웹 카지노 & 도박</button>
              <button class="tab-btn" onclick="switchTab('tab-ranking')">🏆 자산가 순위표</button>
            </div>

            <!-- 탭 1: 주식 시장 & 차트 -->
            <div id="tab-stocks" class="tab-pane active">
              <div class="market-trends-panel">
                <div class="trends-header">
                  <div class="trends-title">
                    <span class="pulse-dot"></span>
                    🔥 실시간 시장 상승세 & 급등 종목 랭킹
                  </div>
                  <div class="market-sentiment-pill">
                    <span>상승 🟢 <b>${upCount}개</b></span>
                    <span>하락 🔴 <b>${downCount}개</b></span>
                    <span class="${isMarketPositive ? 'text-up' : 'text-down'}">평균 ${isMarketPositive ? '+' : ''}${avgRate}%</span>
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

              <h2 class="section-title">📊 실시간 가상 주식 시세 & 차트 분석</h2>
              <div class="stocks-grid">
                ${stockCardsHtml}
              </div>
            </div>

            <!-- 탭 2: ⚡ 실시간 모든 로그 (주가 변동, 거래 체결, 도박, 경제) 라이브 스트림 -->
            <div id="tab-feed" class="tab-pane">
              <div class="feed-container">
                <div class="feed-header">
                  <div class="feed-title">
                    <span class="pulse-dot"></span>
                    ⚡ 실시간 모든 시스템 로그 & 주가 변동 스트림
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

            <!-- 탭 3: 📰 시장 뉴스 & 경제 공시 허브 -->
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

            <!-- 탭 4: ⛏️ 골드 채굴 클리커 게임 & 턴 상점 -->
            <div id="tab-clicker" class="tab-pane">
              <div class="clicker-container">
                
                <!-- 클리커 채굴 영역 -->
                <div class="clicker-box" id="clicker-zone">
                  <h2 style="font-family: 'Outfit', sans-serif; font-size: 1.4rem; font-weight: 800; color: #fbbf24; margin-bottom: 4px;">⛏️ 골드 & 턴 마이닝 클리커</h2>
                  <p style="color: #9ca3af; font-size: 0.85rem; margin-bottom: 12px;">보석을 마구 클릭하여 현금을 채굴하고 ⚡도박 턴을 획득하세요!</p>

                  <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--card-border); padding: 12px; border-radius: 14px; margin-bottom: 16px; display: flex; justify-content: space-around;">
                    <div>
                      <span style="font-size: 0.75rem; color: #9ca3af; display: block;">클릭당 채굴량</span>
                      <b id="clicker-power-val" style="color: #34d399; font-size: 1.1rem; font-family: 'Outfit', sans-serif;">+100원</b>
                    </div>
                    <div>
                      <span style="font-size: 0.75rem; color: #9ca3af; display: block;">남은 도박 턴</span>
                      <b id="clicker-turns-val" style="color: #fbbf24; font-size: 1.1rem; font-family: 'Outfit', sans-serif;">${userTurnsInfo.turns} / 50</b>
                    </div>
                    <div>
                      <span style="font-size: 0.75rem; color: #9ca3af; display: block;">자동 초당 채굴</span>
                      <b id="clicker-auto-val" style="color: #818cf8; font-size: 1.1rem; font-family: 'Outfit', sans-serif;">+0원/s</b>
                    </div>
                  </div>

                  <div class="big-click-gem" id="gem-clicker" onclick="handleClickMining(event)">💎</div>
                  
                  <div style="font-size: 0.85rem; font-weight: 600; color: #cbd5e1; margin-top: 10px;" id="click-feedback-msg">
                    광석을 클릭하면 15% 확률로 5배 크리티컬 및 도박 턴이 드랍됩니다!
                  </div>
                </div>

                <!-- 업그레이드 상점 -->
                <div class="shop-box">
                  <h3 style="font-family: 'Outfit', sans-serif; font-size: 1.25rem; font-weight: 800; color: #e0e7ff; margin-bottom: 16px;">🛒 채굴기 & 턴 업그레이드 상점</h3>

                  <div class="shop-item">
                    <div class="shop-item-info">
                      <h4>🔨 클릭 파워 강화 (Lv.<span id="shop-power-lv">1</span>)</h4>
                      <p>클릭당 현금 획득량 +100원 증가</p>
                    </div>
                    <button class="btn-upgrade" onclick="buyUpgrade('power')"><span id="shop-power-cost">10,000원</span> 강화</button>
                  </div>

                  <div class="shop-item">
                    <div class="shop-item-info">
                      <h4>🤖 자동 채굴 봇 (Lv.<span id="shop-auto-lv">0</span>)</h4>
                      <p>아무것도 안 해도 초당 현금 자동 채굴</p>
                    </div>
                    <button class="btn-upgrade" onclick="buyUpgrade('auto')"><span id="shop-auto-cost">30,000원</span> 구매</button>
                  </div>

                  <div class="shop-item">
                    <div class="shop-item-info">
                      <h4>⚡ 도박 턴 +25개 긴급 충전팩</h4>
                      <p>즉시 도박 턴 25개를 즉시 충전합니다</p>
                    </div>
                    <button class="btn-upgrade" style="background: linear-gradient(135deg, #f59e0b, #d97706);" onclick="buyUpgrade('recharge')">20,000원 충전</button>
                  </div>
                </div>

              </div>
            </div>

            <!-- 탭 5: 웹 카지노 & 도박 -->
            <div id="tab-casino" class="tab-pane">
              <div class="casino-hub-grid">
                
                <!-- 슬롯머신 -->
                <div class="casino-card">
                  <span class="turn-cost-tag">🎰 무제한 플레이</span>
                  <div class="casino-title">🎰 3릴 슬롯머신</div>
                  <p class="casino-desc">다이아몬드(50배), 7(20배), 골든벨(10배), 포도(5배), 레몬(3배), 체리(2배)</p>
                  
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
                  <span class="turn-cost-tag">🪙 무제한 플레이</span>
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
                  <span class="turn-cost-tag">🎲 무제한 플레이</span>
                  <div class="casino-title">🎲 주사위 대결 (2.0배)</div>
                  <p class="casino-desc">나와 딜러가 각각 2개의 주사위를 굴려 더 높은 숫자가 나오면 승리!</p>
                  
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

              <div class="chart-stat-grid">
                <div class="stat-tile">
                  <span class="stat-lbl">24H 최고가</span>
                  <span class="stat-val" id="detail-high">0원</span>
                </div>
                <div class="stat-tile">
                  <span class="stat-lbl">24H 최저가</span>
                  <span class="stat-val" id="detail-low">0원</span>
                </div>
                <div class="stat-tile">
                  <span class="stat-lbl">추정 시가총액</span>
                  <span class="stat-val" id="detail-cap">0원</span>
                </div>
                <div class="stat-tile">
                  <span class="stat-lbl">PER / 배당수익률</span>
                  <span class="stat-val" id="detail-pe-div">15.0x / 2.5%</span>
                </div>
              </div>

              <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--card-border); padding: 14px; border-radius: 12px; margin-bottom: 18px;">
                <span style="font-size: 0.8rem; font-weight: 700; color: #a5b4fc; display: block; margin-bottom: 4px;">🏢 기업 개요 및 기술 분석</span>
                <p id="detail-description" style="font-size: 0.85rem; color: #cbd5e1; line-height: 1.5;">기업 설명 로딩 중...</p>
              </div>

              <div style="display: flex; gap: 8px;">
                <button class="btn-play-game" style="background: #10b981; flex: 1;" onclick="openTradeFromDetail('buy')">🛒 매수하기</button>
                <button class="btn-play-game" style="background: #ef4444; flex: 1;" onclick="openTradeFromDetail('sell')">💰 매도하기</button>
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
              <p style="color: #9ca3af; font-size: 0.9rem; margin-bottom: 16px;" id="modal-stock-info">종목 정보</p>
              
              <div class="bet-input-group">
                <label>주문 수량 (주)</label>
                <input type="number" id="trade-amount-input" class="bet-input" value="1" min="1" oninput="calcTradeTotal()">
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
              </div>

              <button class="btn-play-game" id="btn-submit-trade" onclick="submitTradeOrder()">주문 실행</button>
            </div>
          </div>

          <!-- 은행 입출금 모달 -->
          <div class="modal-overlay" id="bank-modal">
            <div class="modal-box">
              <div class="modal-title">
                <span>🏦 은행 입금 / 출금</span>
                <button class="btn-close-modal" onclick="closeBankModal()">&times;</button>
              </div>
              <div class="choice-btn-group">
                <button class="btn-choice selected" id="bank-act-deposit" onclick="selectBankAction('deposit')">💵 입금 (현금 ➔ 은행)</button>
                <button class="btn-choice" id="bank-act-withdraw" onclick="selectBankAction('withdraw')">🏧 출금 (은행 ➔ 현금)</button>
              </div>

              <div class="bet-input-group">
                <label>이체 금액 (원)</label>
                <input type="number" id="bank-amount-input" class="bet-input" value="10000" min="1000" step="1000">
                <div class="btn-chip-grid" style="margin-top: 8px;">
                  <button class="btn-chip" onclick="document.getElementById('bank-amount-input').value = 10000">1만원</button>
                  <button class="btn-chip" onclick="document.getElementById('bank-amount-input').value = 50000">5만원</button>
                  <button class="btn-chip" onclick="document.getElementById('bank-amount-input').value = 100000">10만원</button>
                  <button class="btn-chip" onclick="document.getElementById('bank-amount-input').value = 'all'">전액</button>
                </div>
              </div>

              <button class="btn-play-game" onclick="submitBankTransfer()">이체 완료</button>
            </div>
          </div>

          <!-- 웹 인터랙티브 & 실시간 라이브 스트림 스크립트 -->
          <script>
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
              document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
              document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
              if (event && event.currentTarget) {
                event.currentTarget.classList.add('active');
              } else {
                const targetBtn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick')?.includes(tabId));
                if (targetBtn) targetBtn.classList.add('active');
              }
              document.getElementById(tabId).classList.add('active');

              if (tabId === 'tab-feed') {
                fetchLiveActivityFeed();
              }
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
              gem.style.transform = 'scale(0.88)';
              setTimeout(() => { gem.style.transform = 'scale(1)'; }, 80);

              const isCrit = Math.random() < 0.15;
              const text = isCrit ? '✨ 5X 크리티컬!' : '+골드 채굴!';
              const floatElem = document.createElement('div');
              floatElem.className = 'floating-coin';
              floatElem.innerText = text;
              if (isCrit) floatElem.style.color = '#fbbf24';
              
              const rect = gem.getBoundingClientRect();
              const zoneRect = document.getElementById('clicker-zone').getBoundingClientRect();
              floatElem.style.left = (e.clientX - zoneRect.left - 20) + 'px';
              floatElem.style.top = (e.clientY - zoneRect.top - 20) + 'px';
              document.getElementById('clicker-zone').appendChild(floatElem);
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
                  updateUserTurnsDisplay(data.turns, data.maxTurns);
                  if (data.bonusTurns > 0) {
                    showToast('warn', '⚡ 도박 턴 드랍!', '광석 채굴 중 도박 턴 +' + data.bonusTurns + '개를 획득했습니다!');
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
                if (data.clickerLevel) {
                  document.getElementById('clicker-power-val').innerText = '+' + (data.clickerLevel * 100).toLocaleString() + '원';
                  document.getElementById('shop-power-lv').innerText = data.clickerLevel;
                  document.getElementById('shop-power-cost').innerText = (data.clickerLevel * 10000).toLocaleString() + '원';
                }
                if (data.autoLevel) {
                  document.getElementById('clicker-auto-val').innerText = '+' + (data.autoLevel * 300).toLocaleString() + '원/s';
                  document.getElementById('shop-auto-lv').innerText = data.autoLevel;
                  document.getElementById('shop-auto-cost').innerText = ((data.autoLevel + 1) * 30000).toLocaleString() + '원';
                }
                if (data.turns) {
                  updateUserTurnsDisplay(data.turns, 50);
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
              openTradeModal(currentDetailStock.stock_id, currentDetailStock.name, currentDetailStock.price, action);
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
                  updateUserTurnsDisplay(data.turns, data.maxTurns);
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
                  updateUserTurnsDisplay(data.turns, data.maxTurns);
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
                  updateUserTurnsDisplay(data.turns, data.maxTurns);
                  showToast(data.isWin ? 'success' : (data.isTie ? 'warn' : 'info'), '🎲 주사위 결과', data.message);
                }, 800);
              } catch (e) {
                setGameLock(false);
                btn.innerText = '🎲 주사위 굴리기';
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
                if (data.turns) updateUserTurnsDisplay(data.turns, 50);
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
                if (data.turns) updateUserTurnsDisplay(data.turns, 50);
              } catch (e) { showToast('error', '통신 오류', '지원금 신청 서버 연결 실패'); }
            }

            // 7. 주식 거래 모달
            function openTradeModal(stockId, name, price, action) {
              currentTrade = { stockId, name, price, action };
              document.getElementById('modal-trade-title').innerText = (action === 'buy' ? '🛒 주식 매수: ' : '💰 주식 매도: ') + name;
              document.getElementById('modal-stock-info').innerText = '종목코드: [' + stockId + '] | 현재가: ' + Number(price).toLocaleString() + '원';
              document.getElementById('modal-unit-price').innerText = Number(price).toLocaleString() + '원';
              document.getElementById('trade-amount-input').value = 1;
              calcTradeTotal();
              document.getElementById('btn-submit-trade').innerText = (action === 'buy' ? '🛒 매수 주문 체결' : '💰 매도 주문 체결');
              document.getElementById('trade-modal').style.display = 'flex';
            }

            function closeTradeModal() {
              document.getElementById('trade-modal').style.display = 'none';
            }

            function calcTradeTotal() {
              const count = parseInt(document.getElementById('trade-amount-input').value, 10) || 0;
              const total = BigInt(count) * BigInt(currentTrade.price || 0);
              document.getElementById('modal-total-price').innerText = Number(total).toLocaleString() + '원';
            }

            async function submitTradeOrder() {
              const amount = document.getElementById('trade-amount-input').value;
              const btn = document.getElementById('btn-submit-trade');
              btn.disabled = true;
              btn.innerText = '⏳ 주문 처리 중...';

              try {
                const res = await fetch('/api/stock/trade', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    action: currentTrade.action,
                    stockId: currentTrade.stockId,
                    amount
                  })
                });
                const data = await res.json();
                btn.disabled = false;
                if (!data.success) {
                  showToast('error', '거래 체결 실패', data.error);
                  return;
                }
                showToast('success', '주식 체결 완료', data.message);
                closeTradeModal();
                updateUserCashDisplay(data.newCash);
                setTimeout(() => location.reload(), 1000);
              } catch (e) {
                btn.disabled = false;
                showToast('error', '통신 오류', '거래 처리 실패');
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

            function updateUserCashDisplay(cashVal) {
              const cashElem = document.getElementById('my-cash');
              if (cashElem && cashVal) {
                cashElem.innerText = Number(cashVal).toLocaleString() + '원';
                cashElem.style.color = '#34d399';
                setTimeout(() => { cashElem.style.color = '#fff'; }, 1000);
              }
            }

            function updateUserTurnsDisplay(turnsVal, maxVal) {
              const max = maxVal || 50;
              const turnsElems = [document.getElementById('my-turns'), document.getElementById('clicker-turns-val'), document.getElementById('nav-turns')];
              turnsElems.forEach(el => {
                if (el) el.innerText = (el.id === 'nav-turns') ? turnsVal : (turnsVal + ' / ' + max);
              });
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
      const [userCountRow] = await pool.query('SELECT COUNT(*) as count FROM users');
      const totalUsers = userCountRow[0]?.count || 0;

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

  app.listen(PORT, () => {
    console.log(`🌐 디스코드 경제 & OAuth2 웹 서버가 실행되었습니다 (포트: ${PORT})`);
    console.log(`🔗 메인 웹사이트: http://localhost:${PORT}`);
    console.log(`🔗 관리자 관제 패널: http://localhost:${PORT}/admin`);
    console.log(`🔗 Discord OAuth2 Redirect URI: ${config.discord.redirectUri}`);
  });
}

module.exports = { startWebServer };
