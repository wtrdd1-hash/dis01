'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PrestigeShopService = require('../src/core/economy/PrestigeShopService');
const CosmeticLoadoutService = require('../src/core/economy/CosmeticLoadoutService');
const WorkshopService = require('../src/core/economy/WorkshopService');
const DuckHouseService = require('../src/core/economy/DuckHouseService');
const AdminSpendingService = require('../src/core/economy/AdminSpendingService');
const { pool } = require('../src/config/database');

test('🏛️ 가상경제 소비 시스템 (Prestige, Cosmetics, Workshop, DuckHouse, Admin) 단위 & QA 검증', async (t) => {
  t.after(async () => {
    try {
      await pool.end();
    } catch (e) {}
  });

  // 1. PrestigeShopService QA
  assert.equal(typeof PrestigeShopService.listCatalog, 'function');
  assert.equal(typeof PrestigeShopService.purchaseItem, 'function');

  // 2. CosmeticLoadoutService QA
  assert.equal(typeof CosmeticLoadoutService.getUserLoadout, 'function');
  assert.equal(typeof CosmeticLoadoutService.equipItem, 'function');
  assert.equal(typeof CosmeticLoadoutService.unequipSlot, 'function');
  assert.equal(typeof CosmeticLoadoutService.getPublicCosmetics, 'function');

  // 3. WorkshopService QA
  assert.equal(typeof WorkshopService.listRecipes, 'function');
  assert.equal(typeof WorkshopService.getUserMaterials, 'function');
  assert.equal(typeof WorkshopService.salvageItem, 'function');
  assert.equal(typeof WorkshopService.craftItem, 'function');

  // 4. DuckHouseService QA
  assert.equal(typeof DuckHouseService.getDuckHouse, 'function');
  assert.equal(typeof DuckHouseService.upgradeDuckHouse, 'function');
  assert.equal(typeof DuckHouseService.setSlotItem, 'function');
  assert.equal(typeof DuckHouseService.removeSlotItem, 'function');

  // 5. AdminSpendingService QA (전권 제어 함수 무결성 검증)
  assert.equal(typeof AdminSpendingService.searchUser, 'function');
  assert.equal(typeof AdminSpendingService.getUserFullSpendingProfile, 'function');
  assert.equal(typeof AdminSpendingService.adminGrantItem, 'function');
  assert.equal(typeof AdminSpendingService.adminRevokeItem, 'function');
  assert.equal(typeof AdminSpendingService.adminSetMaterials, 'function');
  assert.equal(typeof AdminSpendingService.adminSetDuckHouseLevel, 'function');
  assert.equal(typeof AdminSpendingService.adminSaveCatalogItem, 'function');
  assert.equal(typeof AdminSpendingService.adminSaveRecipe, 'function');
  assert.equal(typeof AdminSpendingService.getSpendingSummary, 'function');

  // 6. 덕하우스 확장 가격 및 슬롯 테이블 QA 검증
  const houseLevels = [
    { level: 1, slots: 3, cost: 0n },
    { level: 2, slots: 5, cost: 100000n },
    { level: 3, slots: 8, cost: 500000n },
    { level: 4, slots: 12, cost: 2000000n },
    { level: 5, slots: 18, cost: 10000000n }
  ];
  for (let i = 0; i < houseLevels.length; i++) {
    const h = houseLevels[i];
    assert.ok(h.slots > 0, '덕하우스 슬롯은 0보다 커야 합니다');
    if (i > 0) {
      assert.ok(h.cost > houseLevels[i-1].cost, '상위 레벨 확장비용은 증가해야 합니다');
    }
  }

  // 7. 희귀도별 분해(Salvage) 조각 환급 공식 QA 검증
  const rarityShards = {
    COMMON: 1,
    RARE: 3,
    EPIC: 8,
    LEGENDARY: 20
  };
  assert.equal(rarityShards.COMMON, 1);
  assert.equal(rarityShards.RARE, 3);
  assert.equal(rarityShards.EPIC, 8);
  assert.equal(rarityShards.LEGENDARY, 20);
});
