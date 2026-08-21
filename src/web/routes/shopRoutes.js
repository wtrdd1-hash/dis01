'use strict';

const express = require('express');
const { getShopCatalog, buyShopItem, sendMegaphone, getUserInventory, openLuckyBox } = require('../../utils/shopEngine');
const { getCurrentLottoRound, buyLottoTicket, getUserLottoTickets } = require('../../utils/lottoEngine');
const { getDrillEquipment, enhanceDrill, applyOverclockOil } = require('../../utils/enhancementEngine');
const { pool } = require('../../config/database');

function resolveShopUser(session, req) {
  if (session && typeof session.getPlayUser === 'function') {
    return session.getPlayUser(req);
  }
  if (session && typeof session.getSessionUser === 'function') {
    return session.getSessionUser(req);
  }
  if (session && typeof session.getUser === 'function') {
    return session.getUser(req);
  }
  return req.session?.user || req.session?.localUser || null;
}

function serializeShopItem(item) {
  return {
    ...item,
    price: item.price.toString()
  };
}

function serializeLottoTicket(result) {
  return {
    ...result,
    afterCash: result.afterCash.toString()
  };
}

function createShopRoutes(session) {
  const router = express.Router();

  function getSessionUser(req) {
    return resolveShopUser(session, req);
  }

  // 1. 상점 카탈로그 조회
  router.get('/shop/catalog', (req, res) => {
    return res.json({ success: true, catalog: getShopCatalog() });
  });

  // 2. 상점 아이템 구매
  router.post('/shop/buy', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { itemKey } = req.body;
    try {
      if (itemKey === 'lucky_box') {
        const buyRes = await buyShopItem(user.id, user.username, itemKey);
        const gachaRes = await openLuckyBox(user.id, user.username);
        return res.json({
          success: true,
          afterCash: buyRes.afterCash.toString(),
          reward: gachaRes.reward,
          message: gachaRes.message
        });
      }

      const result = await buyShopItem(user.id, user.username, itemKey);
      return res.json({
        success: true,
        item: serializeShopItem(result.item),
        afterCash: result.afterCash.toString(),
        message: result.message
      });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 3. 실시간 확성기 발송
  router.post('/shop/megaphone', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { message, theme } = req.body;
    try {
      const result = await sendMegaphone(user.id, user.username, message, theme);
      return res.json({
        success: true,
        data: result.data,
        afterCash: result.afterCash.toString(),
        message: result.message
      });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 4. 활성 확성기 목록 조회 (상단 티커용)
  router.get('/megaphone/active', async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT id, user_id, username, message, theme, active_until
        FROM megaphone_logs
        WHERE active_until > NOW()
        ORDER BY id DESC
        LIMIT 10
      `);
      return res.json({ success: true, megaphones: rows });
    } catch (e) {
      return res.json({ success: true, megaphones: [] });
    }
  });

  // 5. 내 인벤토리 조회
  router.get('/shop/inventory', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const inv = await getUserInventory(user.id);
      return res.json({ success: true, inventory: inv });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 6. 로또 회차 현황
  router.get('/lotto/current', async (req, res) => {
    try {
      const round = await getCurrentLottoRound();
      return res.json({
        success: true,
        round: {
          ...round,
          jackpot_pool: round.jackpot_pool.toString(),
          total_sales: round.total_sales.toString(),
          total_burned: round.total_burned.toString()
        }
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 7. 로또 티켓 구매
  router.post('/lotto/buy', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { numbers, isAuto } = req.body;
    try {
      const result = await buyLottoTicket(user.id, user.username, numbers, isAuto);
      return res.json({
        success: true,
        ticket: serializeLottoTicket(result),
        afterCash: result.afterCash.toString(),
        message: result.message
      });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 8. 내 로또 티켓 목록
  router.get('/lotto/my-tickets', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const tickets = await getUserLottoTickets(user.id);
      return res.json({ success: true, tickets });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 9. 드릴 대장간 상태 조회
  router.get('/drill/info', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const info = await getDrillEquipment(user.id);
      return res.json({
        success: true,
        drill: {
          ...info,
          totalSpent: info.totalSpent.toString()
        }
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 10. 드릴 강화 시도
  router.post('/drill/enhance', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { useProtection } = req.body;
    try {
      const result = await enhanceDrill(user.id, user.username, useProtection);
      return res.json({
        success: true,
        result: {
          ...result,
          cost: result.cost.toString(),
          afterCash: result.afterCash.toString()
        }
      });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 11. 오버클럭 오일 주입
  router.post('/drill/overclock', async (req, res) => {
    const user = getSessionUser(req);
    if (!user) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const result = await applyOverclockOil(user.id);
      return res.json({ success: true, result });
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createShopRoutes, resolveShopUser, serializeShopItem, serializeLottoTicket };
