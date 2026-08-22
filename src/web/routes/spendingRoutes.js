'use strict';

const express = require('express');
const PrestigeShopService = require('../../core/economy/PrestigeShopService');
const CosmeticLoadoutService = require('../../core/economy/CosmeticLoadoutService');
const WorkshopService = require('../../core/economy/WorkshopService');
const DuckHouseService = require('../../core/economy/DuckHouseService');

function resolveUser(session, req) {
  if (session && typeof session.getPlayUser === 'function') return session.getPlayUser(req);
  if (session && typeof session.getSessionUser === 'function') return session.getSessionUser(req);
  if (session && typeof session.getUser === 'function') return session.getUser(req);
  return req.session?.user || req.session?.localUser || null;
}

function getUserId(user) {
  return user?.id || user?.discord_id || user?.discordId || null;
}

function createSpendingRoutes(session) {
  const router = express.Router();

  // 1. 🛍️ 명예 상점 카탈로그 조회
  router.get('/economy/prestige-store', async (req, res) => {
    try {
      const user = resolveUser(session, req);
      const userId = getUserId(user);
      const items = await PrestigeShopService.listCatalog({ userId, activeOnly: true });
      return res.json({ success: true, items });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 2. 🛒 명예 상점 아이템 구매
  router.post('/economy/prestige-store/purchase', async (req, res) => {
    const user = resolveUser(session, req);
    const userId = getUserId(user);
    if (!userId) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { itemKey, idempotencyKey } = req.body;
    try {
      const result = await PrestigeShopService.purchaseItem(userId, itemKey, idempotencyKey);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 3. 🎨 외형 로드아웃 & 보유 아이템 조회
  router.get(['/economy/cosmetics', '/economy/cosmetics/loadout', '/cosmetics/loadout', '/cosmetics'], async (req, res) => {
    const user = resolveUser(session, req);
    const userId = getUserId(user);
    if (!userId) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const data = await CosmeticLoadoutService.getUserLoadout(userId);
      return res.json({ success: true, ...data });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4. 🔲 외형 슬롯 장착
  router.post(['/economy/cosmetics/equip', '/cosmetics/equip'], async (req, res) => {
    const user = resolveUser(session, req);
    const userId = getUserId(user);
    if (!userId) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { slot, itemKey } = req.body;
    try {
      const result = await CosmeticLoadoutService.equipItem(userId, slot, itemKey);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 5. ❌ 외형 슬롯 장착 해제
  router.post(['/economy/cosmetics/unequip', '/cosmetics/unequip'], async (req, res) => {
    const user = resolveUser(session, req);
    const userId = getUserId(user);
    if (!userId) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { slot } = req.body;
    try {
      const result = await CosmeticLoadoutService.unequipSlot(userId, slot);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 6. 📜 제작소 레시피 & 재료 조회
  router.get('/economy/workshop/recipes', async (req, res) => {
    try {
      const user = resolveUser(session, req);
      const userId = getUserId(user);
      const [recipes, materials] = await Promise.all([
        WorkshopService.listRecipes(),
        WorkshopService.getUserMaterials(userId)
      ]);
      return res.json({ success: true, recipes, ...materials });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 7. ♻️ 아이템 분해 (황금 깃털 조각 획득)
  router.post('/economy/workshop/salvage', async (req, res) => {
    const user = resolveUser(session, req);
    const userId = getUserId(user);
    if (!userId) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { inventoryId } = req.body;
    try {
      const result = await WorkshopService.salvageItem(userId, Number(inventoryId));
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 8. 🔨 확정 제작
  router.post('/economy/workshop/craft', async (req, res) => {
    const user = resolveUser(session, req);
    const userId = getUserId(user);
    if (!userId) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { recipeKey } = req.body;
    try {
      const result = await WorkshopService.craftItem(userId, recipeKey);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 9. 🏠 덕하우스 조회 (본인 또는 타 유저)
  async function handleDuckHouseGet(req, res) {
    const user = resolveUser(session, req);
    const targetId = req.params.targetUserId || getUserId(user);
    if (!targetId) return res.status(400).json({ success: false, error: '유저 ID가 필요합니다.' });

    try {
      const data = await DuckHouseService.getDuckHouse(targetId);
      const isOwner = getUserId(user) === targetId;
      return res.json({ success: true, isOwner, ...data });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  router.get('/economy/duck-house', handleDuckHouseGet);
  router.get('/economy/duck-house/:targetUserId', handleDuckHouseGet);

  // 10. 🏰 덕하우스 레벨 업그레이드
  router.post('/economy/duck-house/upgrade', async (req, res) => {
    const user = resolveUser(session, req);
    const userId = getUserId(user);
    if (!userId) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const result = await DuckHouseService.upgradeDuckHouse(userId);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 11. 🖼️ 덕하우스 슬롯 배치
  router.post('/economy/duck-house/slot', async (req, res) => {
    const user = resolveUser(session, req);
    const userId = getUserId(user);
    if (!userId) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { slotIndex, inventoryId } = req.body;
    try {
      const result = await DuckHouseService.setSlotItem(userId, Number(slotIndex), Number(inventoryId));
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 12. 🗑️ 덕하우스 슬롯 회수
  router.delete('/economy/duck-house/slot/:slotIndex', async (req, res) => {
    const user = resolveUser(session, req);
    const userId = getUserId(user);
    if (!userId) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      const result = await DuckHouseService.removeSlotItem(userId, Number(req.params.slotIndex));
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 13. 🏷️ 덕하우스 이름 변경
  router.post('/economy/duck-house/name', async (req, res) => {
    const user = resolveUser(session, req);
    const userId = getUserId(user);
    if (!userId) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { houseName } = req.body;
    try {
      const result = await DuckHouseService.updateHouseName(userId, houseName);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createSpendingRoutes };
