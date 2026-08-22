'use strict';

const express = require('express');
const { pool, getOrCreateUser } = require('../../config/database');
const StockModel = require('../../models/StockModel');
const UserModel = require('../../models/UserModel');
const { safeBigInt, withUserLock } = require('../../utils/money');

const { pushUserLive } = require('../../utils/liveSync');

function createStockRoutes(getSessionUser) {
  const router = express.Router();

  async function resolveUser(req) {
    let session = typeof getSessionUser === 'function' ? getSessionUser(req) : null;
    if (!session && req.session) {
      session = req.session.user || req.session.localUser;
    }
    if (!session || !session.id) return null;
    try {
      await getOrCreateUser(session.id, session.username || '손님', session.avatar || '');
    } catch (e) {}
    return session;
  }

  // 1. 전체 주식 목록 조회
  router.get('/', async (req, res) => {
    try {
      const stocks = await StockModel.getAllStocks();
      res.json({ success: true, stocks });
    } catch (err) {
      res.status(500).json({ success: false, error: '주식 목록을 불러오지 못했습니다.' });
    }
  });

  // 2. 내 보유 주식 포트폴리오 조회
  router.get('/holdings', async (req, res) => {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const { holdings, totalStockVal } = await StockModel.getUserHoldings(user.id);
      res.json({
        success: true,
        holdings,
        totalStockVal: totalStockVal.toString()
      });
    } catch (err) {
      res.status(500).json({ success: false, error: '보유 주식을 불러오지 못했습니다.' });
    }
  });

  // 3. 주식 매수 (BUY)
  router.post('/buy', async (req, res) => {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { stockId, amount } = req.body;
    if (!stockId || !amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: '종목 및 수량을 올바르게 입력하세요.' });
    }

    try {
      const result = await withUserLock(user.id, async () => {
        return await StockModel.buyStock(user.id, stockId, String(amount));
      });

      // Socket.IO 유저 잔액 갱신 브로드캐스트
      if (global.__io) {
        global.__io.emit('user:balance_update', {
          userId: user.id,
          cash: result.newCash
        });
      }

      res.json({
        success: true,
        cost: result.cost,
        newCash: result.newCash,
        message: `${stockId} ${amount}주 매수가 완료되었습니다.`
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message || '매수 처리에 실패했습니다.' });
    }
  });

  // 4. 주식 매도 (SELL)
  router.post('/sell', async (req, res) => {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { stockId, amount } = req.body;
    if (!stockId || !amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, error: '종목 및 수량을 올바르게 입력하세요.' });
    }

    try {
      const result = await withUserLock(user.id, async () => {
        return await StockModel.sellStock(user.id, stockId, String(amount));
      });

      // Socket.IO 유저 잔액 갱신 브로드캐스트
      if (global.__io) {
        global.__io.emit('user:balance_update', {
          userId: user.id,
          cash: result.newCash
        });
      }

      res.json({
        success: true,
        revenue: result.revenue,
        newCash: result.newCash,
        message: `${stockId} ${amount}주 매도가 완료되었습니다.`
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message || '매도 처리에 실패했습니다.' });
    }
  });

  // 5. 배당금 수령 (DIVIDENDS CLAIM - 1시간 쿨다운 & 동시성 락)
  router.post('/dividends/claim', async (req, res) => {
    const user = await resolveUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      return await withUserLock(user.id, async () => {
        // 🔒 배당금 1시간 쿨다운 (3600초) 검증
        const CLAIM_COOLDOWN_MS = 60 * 60 * 1000; // 1시간 (3,600,000 ms)
        const [recentLogs] = await pool.query(
          "SELECT created_at FROM economy_logs WHERE user_id = ? AND type = 'STOCK_DIVIDEND' ORDER BY id DESC LIMIT 1",
          [user.id]
        );

        if (recentLogs && recentLogs.length > 0 && recentLogs[0].created_at) {
          const lastClaimed = new Date(recentLogs[0].created_at).getTime();
          const now = Date.now();
          const elapsed = now - lastClaimed;
          if (elapsed < CLAIM_COOLDOWN_MS) {
            const remainSec = Math.ceil((CLAIM_COOLDOWN_MS - elapsed) / 1000);
            const remainMin = Math.floor(remainSec / 60);
            const remainSecOnly = remainSec % 60;
            return res.status(429).json({
              success: false,
              error: `배당금은 1시간에 1회만 수령할 수 있습니다. (남은 시간: ${remainMin}분 ${remainSecOnly}초)`
            });
          }
        }

        const { holdings, totalStockVal } = await StockModel.getUserHoldings(user.id);
        if (!holdings || holdings.length === 0 || totalStockVal <= 0n) {
          return res.status(400).json({ success: false, error: '수령할 수 있는 배당금이 없습니다. 먼저 주식을 보유하세요!' });
        }

        // 보유 총 평가액의 0.5% 배당금 산출 (최소 1,000원 ~ 1회 최대 10,000,000원 상한)
        let dividend = totalStockVal / 200n;
        if (dividend < 1000n) dividend = 1000n;
        const MAX_DIVIDEND = 10000000n; // 1회 최대 1,000만원 한도
        if (dividend > MAX_DIVIDEND) dividend = MAX_DIVIDEND;

        await pool.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [dividend.toString(), user.id]);
        await pool.query(`
          INSERT INTO economy_logs (user_id, username, type, amount, description)
          VALUES (?, ?, 'STOCK_DIVIDEND', ?, ?)
        `, [user.id, user.username || user.id, dividend.toString(), `보유 주식 정기 배당금 수령 (${dividend.toString()}원)`]);

        try { pushUserLive(user.id); } catch (e) {}

        return res.json({
          success: true,
          reward: dividend.toString(),
          message: `배당금 ${dividend.toLocaleString()}원이 지급되었습니다! (다음 수령 가능: 1시간 후)`
        });
      });
    } catch (err) {
      console.error('❌ [/api/stocks/dividends/claim] 배당금 처리 오류:', err);
      return res.status(500).json({ success: false, error: '배당금 처리에 실패했습니다.' });
    }
  });

  return router;
}

createStockRoutes.createStockRoutes = createStockRoutes;
module.exports = createStockRoutes;
