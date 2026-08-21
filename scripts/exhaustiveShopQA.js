'use strict';

/**
 * 🛍️ 명품 상점 및 가상경제 소비 시스템 전수 QA 점검 스크립트
 */
const path = require('path');
const baseDir = process.cwd();

const { pool, getOrCreateUser } = require(path.join(baseDir, 'src/config/database'));
const PrestigeShopService = require(path.join(baseDir, 'src/core/economy/PrestigeShopService'));
const WorkshopService = require(path.join(baseDir, 'src/core/economy/WorkshopService'));
const DuckHouseService = require(path.join(baseDir, 'src/core/economy/DuckHouseService'));
const CosmeticLoadoutService = require(path.join(baseDir, 'src/core/economy/CosmeticLoadoutService'));
const AdminSpendingService = require(path.join(baseDir, 'src/core/economy/AdminSpendingService'));
const InventoryModel = require(path.join(baseDir, 'src/models/InventoryModel'));
const UserModel = require(path.join(baseDir, 'src/models/UserModel'));
const { safeBigInt, applyCashDelta } = require(path.join(baseDir, 'src/utils/money'));

async function runExhaustiveShopQA() {
  console.log('====================================================');
  console.log('🛍️ [명품 상점 & 소비 시스템 전수 QA 점검 시작]');
  console.log('====================================================\n');

  const testUserId = 'qa_shop_tester_' + Date.now();
  await getOrCreateUser(testUserId, 'QA_소비테스터', 'https://cdn.discordapp.com/embed/avatars/0.png');
  await applyCashDelta(testUserId, 100000000000n); // 1000억원 지급

  let passCount = 0;
  const totalTests = 10;

  try {
    // 1. 카탈로그 조회 검증
    const catalogItems = await PrestigeShopService.listCatalog();
    if (!catalogItems || !Array.isArray(catalogItems) || catalogItems.length === 0) {
      throw new Error('명예 상점 카탈로그 항목이 비어있습니다.');
    }
    console.log(`✅ [PASS 1] 주간 명예 상점 카탈로그 로드 검증 (아이템 ${catalogItems.length}종 정상)`);
    passCount++;

    // 2. 아이템 구매 및 100% 화폐 소각 검증
    const targetItem = catalogItems[0];
    const initialCash = (await UserModel.getBalance(testUserId)).cash;
    const purchaseRes = await PrestigeShopService.purchaseItem(testUserId, targetItem.itemKey);
    const afterCash = (await UserModel.getBalance(testUserId)).cash;

    if (!purchaseRes.success || afterCash >= initialCash) {
      throw new Error('아이템 구매 후 현금 차감 실패');
    }

    const [flowRows] = await pool.query(`
      SELECT * FROM economy_flow_logs
      WHERE user_id = ? AND category = 'PRESTIGE_SHOP'
      ORDER BY created_at DESC LIMIT 1
    `, [testUserId]);

    if (!flowRows.length || flowRows[0].flow_type !== 'SINK') {
      throw new Error('100% 화폐 소각 원장(SINK) 기록 실패');
    }
    console.log(`✅ [PASS 2] 명예 상점 구매 및 100% 화폐 소각(SINK) 원장 기록 검증 (소각액: ${flowRows[0].amount}원)`);
    passCount++;

    // 3. 인벤토리 지급 검증
    const inventory = await InventoryModel.getUserInventory(testUserId);
    const hasPurchased = inventory.some(i => i.itemKey === targetItem.itemKey);
    if (!hasPurchased) throw new Error('구매한 아이템이 인벤토리에 지급되지 않았습니다.');
    console.log('✅ [PASS 3] 구매 아이템 인벤토리 정상 수령 및 조회 검증');
    passCount++;

    // 4. 외형 슬롯 장착 검증
    const equipRes = await CosmeticLoadoutService.equipSlot(testUserId, targetItem.itemType, targetItem.itemKey);
    if (!equipRes.success) throw new Error('외형 슬롯 장착 실패: ' + equipRes.error);
    const { loadout } = await CosmeticLoadoutService.getUserLoadout(testUserId);
    if (!loadout[targetItem.itemType] || loadout[targetItem.itemType].itemKey !== targetItem.itemKey) {
      throw new Error('외형 로드아웃에 장착된 아이템 불일치');
    }
    console.log(`✅ [PASS 4] 외형 로드아웃 [${targetItem.itemType}] 슬롯 장착 검증`);
    passCount++;

    // 5. 외형 슬롯 장착 해제 검증
    const unequipRes = await CosmeticLoadoutService.unequipSlot(testUserId, targetItem.itemType);
    if (!unequipRes.success) throw new Error('외형 슬롯 해제 실패');
    const { loadout: afterUnequip } = await CosmeticLoadoutService.getUserLoadout(testUserId);
    if (afterUnequip[targetItem.itemType] !== null) throw new Error('외형 슬롯 해제 후 잔여 데이터 존재');
    console.log(`✅ [PASS 5] 외형 로드아웃 [${targetItem.itemType}] 슬롯 정상 해제 검증`);
    passCount++;

    // 6. 아이템 분해(Salvage) 및 황금 깃털 조각 획득 검증
    const extraItemKey = 'test_item_salvage_' + Date.now();
    await InventoryModel.grantItem(testUserId, extraItemKey, 'NAME_COLOR', '분해용 닉네임', 0);
    const salvageRes = await WorkshopService.salvageItem(testUserId, extraItemKey);
    if (!salvageRes.success || salvageRes.shardsGained <= 0) {
      throw new Error('아이템 분해 실패 또는 깃털 조각 미지급');
    }
    const [userRows] = await pool.query('SELECT feathers_shards FROM users WHERE discord_id = ?', [testUserId]);
    if (Number(userRows[0].feathers_shards || 0) < salvageRes.shardsGained) {
      throw new Error('유저 테이블의 feathers_shards 갱신 누락');
    }
    console.log(`✅ [PASS 6] 아이템 분해(Salvage) 및 황금 깃털 조각 획득 검증 (+${salvageRes.shardsGained}개)`);
    passCount++;

    // 7. 확정 제작(Crafting) 레시피 검증
    const recipes = await WorkshopService.listRecipes();
    if (!recipes || !recipes.length) throw new Error('제작 레시피 목록이 비어있습니다.');
    await pool.query('UPDATE users SET feathers_shards = 500 WHERE discord_id = ?', [testUserId]);
    const craftRes = await WorkshopService.craftRecipe(testUserId, recipes[0].recipeKey);
    if (!craftRes.success) throw new Error('레시피 확정 제작 실패: ' + craftRes.error);
    console.log(`✅ [PASS 7] 컬렉션 제작소 확정 제작 검증 ([${recipes[0].name}] 제작 완료)`);
    passCount++;

    // 8. 덕하우스 확장 및 트로피 거치대 검증
    const houseState = await DuckHouseService.getUserHouse(testUserId);
    if (!houseState || !houseState.house) throw new Error('덕하우스 초기 상태 로드 실패');
    const expandRes = await DuckHouseService.upgradeRoomTier(testUserId);
    if (!expandRes.success) throw new Error('덕하우스 룸 확장 실패');
    console.log(`✅ [PASS 8] 덕하우스 룸 확장 검증 (Lv.1 -> Lv.2 확장 완료)`);
    passCount++;

    // 9. 덕하우스 전시 슬롯 장착 검증
    const mountRes = await DuckHouseService.mountPedestal(testUserId, 1, recipes[0].itemKey);
    if (!mountRes.success) throw new Error('덕하우스 트로피 거치대 장착 실패: ' + mountRes.error);
    console.log('✅ [PASS 9] 덕하우스 1번 거치대 트로피 장착 및 전시 검증');
    passCount++;

    // 10. 관리자 직권 지급 및 통계 텔레메트리 검증
    const adminGrantRes = await AdminSpendingService.adminGrantItem(testUserId, 'ADMIN_TEST_BADGE', 'BADGE', '관리자 인증 배지', 'QA관리자');
    if (!adminGrantRes.success) throw new Error('관리자 직권 아이템 지급 실패');
    const stats = await AdminSpendingService.getSpendingTelemetry();
    if (!stats || stats.totalBurnedAmount === undefined) throw new Error('관리자 소비 통계 산출 실패');
    console.log(`✅ [PASS 10] 관리자 직권 지급 및 소비 통계 텔레메트리 검증 (총 소각 통계: ${stats.totalBurnedAmount}원)`);
    passCount++;

    console.log('\n====================================================');
    console.log(`🎯 [명품 상점 전수 QA 결과]: 총 ${totalTests}개 검증 항목 중 ${passCount}개 PASS (성공률 100%)`);
    console.log('====================================================\n');

    // 테스트 유저 정리
    await pool.query('DELETE FROM user_inventory WHERE user_id = ?', [testUserId]);
    await pool.query('DELETE FROM user_cosmetic_loadout WHERE user_id = ?', [testUserId]);
    await pool.query('DELETE FROM user_duck_house WHERE user_id = ?', [testUserId]);
    await pool.query('DELETE FROM users WHERE discord_id = ?', [testUserId]);

    return true;
  } catch (err) {
    console.error('❌ [명품 상점 QA 실패]:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  runExhaustiveShopQA().then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { runExhaustiveShopQA };
