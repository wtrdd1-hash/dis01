'use strict';

const { pool } = require('../../config/database');
const { safeBigInt } = require('../../utils/moneyValue');
const { pushUserLive } = require('../../utils/liveSync');

class AdminSpendingService {
  /**
   * 🔍 유저 검색 (디스코드 ID 또는 닉네임)
   */
  static async searchUser(query) {
    if (!query) return [];
    const q = `%${String(query).trim()}%`;
    const [users] = await pool.query(
      `SELECT discord_id, username, avatar, cash, bank, created_at 
       FROM users 
       WHERE discord_id LIKE ? OR username LIKE ? 
       ORDER BY id DESC LIMIT 20`,
      [q, q]
    );
    return users.map((u) => ({
      discordId: u.discord_id,
      username: u.username || '익명',
      avatar: u.avatar,
      cash: u.cash.toString(),
      bank: u.bank.toString(),
      createdAt: u.created_at
    }));
  }

  /**
   * 📊 유저 소비 및 소유 전체 프로필 조회 (인벤토리, 장착 외형, 제작 재료, 덕하우스)
   */
  static async getUserFullSpendingProfile(userId) {
    if (!userId) throw new Error('유저 ID가 필요합니다.');

    const [userRows] = await pool.query(`SELECT * FROM users WHERE discord_id = ?`, [userId]);
    if (userRows.length === 0) throw new Error('유저를 찾을 수 없습니다.');
    const user = userRows[0];

    // 1. 인벤토리 목록
    const [inventory] = await pool.query(
      `SELECT * FROM user_inventory WHERE user_id = ? ORDER BY id DESC`,
      [userId]
    );

    // 2. 장착 로드아웃
    const [loadout] = await pool.query(
      `SELECT * FROM user_cosmetic_loadout WHERE user_id = ?`,
      [userId]
    );

    // 3. 제작 재료
    const [materials] = await pool.query(
      `SELECT * FROM craft_materials WHERE user_id = ?`,
      [userId]
    );

    // 4. 덕하우스
    const [houses] = await pool.query(
      `SELECT * FROM user_duck_houses WHERE user_id = ?`,
      [userId]
    );

    const [slots] = await pool.query(
      `SELECT * FROM user_duck_house_slots WHERE user_id = ? ORDER BY slot_index ASC`,
      [userId]
    );

    return {
      user: {
        discordId: user.discord_id,
        username: user.username,
        cash: user.cash.toString(),
        bank: user.bank.toString()
      },
      inventory: inventory.map((i) => ({
        id: i.id,
        itemKey: i.item_key,
        itemType: i.item_type,
        name: i.item_name || i.item_key,
        expiresAt: i.expires_at,
        isActive: Boolean(i.is_active),
        createdAt: i.created_at
      })),
      loadout: loadoutMap,
      materials: {
        goldenFeatherShards: materials.find((m) => m.material_key === 'golden_feather_shard')?.quantity || 0
      },
      duckHouse: {
        level: house.level || 1,
        houseName: house.house_name || '기본 방',
        theme: house.theme_item_id || 'default',
        slots: slots.map((s) => ({
          slotIndex: s.slot_index,
          inventoryId: s.inventory_id,
          itemKey: s.item_key
        }))
      }
    };
  }

  /**
   * 🎁 [관리자 권한] 유저에게 아이템/외형 강제 지급 (Grant)
   */
  static async adminGrantItem(userId, { itemKey, name, itemType = 'COSMETIC', durationSeconds = 0, adminId = 'ADMIN', reason = '' }) {
    if (!userId || !itemKey || !name) {
      throw new Error('유저 ID, 아이템 키, 이름은 필수입니다.');
    }

    let expiresAt = null;
    const dur = Number(durationSeconds) || 0;
    if (dur > 0) {
      expiresAt = new Date(Date.now() + dur * 1000);
    }

    const [ins] = await pool.query(
      `INSERT INTO user_inventory (user_id, item_key, item_type, item_name, expires_at, is_active)
       VALUES (?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE expires_at = VALUES(expires_at), is_active = 1, item_name = VALUES(item_name)`,
      [userId, itemKey, itemType, name, expiresAt]
    );

    // 관리자 감사 로그 기록
    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action, target_user_id, details)
       VALUES (?, ?, 'GRANT_ITEM', ?, ?)`,
      [adminId, adminId || '관리자', userId, JSON.stringify({ itemKey, name, itemType, durationSeconds, reason, inventoryId: ins.insertId })]
    );

    return {
      success: true,
      message: `✅ [${name}] 아이템을 ${userId} 유저에게 지급했습니다. (ID: ${ins.insertId})`,
      inventoryId: ins.insertId
    };
  }

  /**
   * 🚫 [관리자 권한] 유저의 아이템 회수 / 삭제 (Revoke)
   */
  static async adminRevokeItem(userId, inventoryId, data = {}) {
    const { adminId = 'ADMIN', reason = '관리자 회수' } = data;
    if (!userId || !inventoryId) throw new Error('유저 ID와 인벤토리 ID가 필요합니다.');

    const [invRows] = await pool.query(
      `SELECT * FROM user_inventory WHERE id = ? AND user_id = ?`,
      [inventoryId, userId]
    );

    if (invRows.length === 0) throw new Error('해당 인벤토리 아이템을 찾을 수 없습니다.');
    const item = invRows[0];

    // 장착 중인 슬롯이 있다면 해제
    await pool.query(`DELETE FROM user_cosmetic_loadout WHERE inventory_id = ?`, [inventoryId]);
    // 덕하우스 슬롯에서도 제거
    await pool.query(`DELETE FROM user_duck_house_slots WHERE inventory_id = ?`, [inventoryId]);
    // 인벤토리에서 완전 삭제
    await pool.query(`DELETE FROM user_inventory WHERE id = ?`, [inventoryId]);

    // 관리자 감사 로그
    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action, target_user_id, details)
       VALUES (?, ?, 'REVOKE_ITEM', ?, ?)`,
      [adminId, adminId || '관리자', userId, JSON.stringify({ inventoryId, itemKey: item.item_key, name: item.name, reason })]
    );

    return {
      success: true,
      message: `🗑️ [${item.name}] 아이템을 회수했습니다.`
    };
  }

  /**
   * 🪶 [관리자 권한] 유저 제작 재료(황금 깃털 조각) 수량 강제 설정 / 조정
   */
  static async adminSetMaterials(userId, materialKey = 'golden_feather_shard', quantity = 0, data = {}) {
    const { adminId = 'ADMIN', reason = '관리자 재료 조정' } = data;
    if (!userId) throw new Error('유저 ID가 필요합니다.');

    const qty = Math.max(0, parseInt(quantity, 10) || 0);

    await pool.query(
      `INSERT INTO craft_materials (user_id, material_key, quantity)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)`,
      [userId, materialKey, qty]
    );

    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action, target_user_id, details)
       VALUES (?, ?, 'SET_MATERIAL', ?, ?)`,
      [adminId, adminId || '관리자', userId, JSON.stringify({ materialKey, quantity: qty, reason })]
    );

    return {
      success: true,
      message: `🪶 유저의 [${materialKey}] 재료를 ${qty}개로 설정했습니다.`,
      quantity: qty
    };
  }

  /**
   * 🏰 [관리자 권한] 유저 덕하우스 레벨 강제 변경 (1~5)
   */
  static async adminSetDuckHouseLevel(userId, level, data = {}) {
    const { adminId = 'ADMIN', reason = '관리자 덕하우스 레벨 조정' } = data;
    if (!userId) throw new Error('유저 ID가 필요합니다.');

    const lv = Math.max(1, Math.min(5, parseInt(level, 10) || 1));

    await pool.query(
      `INSERT INTO user_duck_houses (user_id, level, theme_item_id, house_name)
       VALUES (?, ?, 'basic', '나만의 덕하우스')
       ON DUPLICATE KEY UPDATE level = VALUES(level)`,
      [userId, lv]
    );

    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action, target_user_id, details)
       VALUES (?, ?, 'SET_DUCK_HOUSE_LEVEL', ?, ?)`,
      [adminId, adminId || '관리자', userId, JSON.stringify({ level: lv, reason })]
    );

    return {
      success: true,
      message: `🏰 유저의 덕하우스 레벨을 [Lv.${lv}]로 변경했습니다.`,
      level: lv
    };
  }

  /**
   * 🛍️ [관리자 권한] 명예 상점 상품 생성 / 수정 / 삭제
   */
  static async adminSaveCatalogItem(itemData) {
    const {
      itemKey,
      itemType,
      name,
      description = '',
      price = 0,
      durationSeconds = 0,
      rarity = 'COMMON',
      rotationGroup = 'DEFAULT',
      icon = '✨',
      previewCss = '',
      isActive = 1
    } = itemData;

    if (!itemKey || !name || !itemType) throw new Error('itemKey, itemType, name은 필수 항목입니다.');

    await pool.query(
      `INSERT INTO economy_catalog_items 
       (item_key, item_type, name, description, price, duration_seconds, rarity, rotation_group, icon, preview_css, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         item_type = VALUES(item_type),
         name = VALUES(name),
         description = VALUES(description),
         price = VALUES(price),
         duration_seconds = VALUES(duration_seconds),
         rarity = VALUES(rarity),
         rotation_group = VALUES(rotation_group),
         icon = VALUES(icon),
         preview_css = VALUES(preview_css),
         is_active = VALUES(is_active)`,
      [itemKey, itemType, name, description, price.toString(), durationSeconds, rarity, rotationGroup, icon, previewCss, isActive ? 1 : 0]
    );

    return { success: true, message: `✅ 명예 상품 [${name}] (${itemKey}) 저장이 완료되었습니다.` };
  }

  static async adminDeleteCatalogItem(itemKey) {
    if (!itemKey) throw new Error('itemKey가 필요합니다.');
    await pool.query(`DELETE FROM economy_catalog_items WHERE item_key = ?`, [itemKey]);
    return { success: true, message: `🗑️ 명예 상품 [${itemKey}] 삭제가 완료되었습니다.` };
  }

  /**
   * 🔨 [관리자 권한] 제작 레시피 생성 / 수정 / 삭제
   */
  static async adminSaveRecipe(recipeData) {
    const {
      recipeKey,
      resultItemKey,
      name,
      description = '',
      materialCost = 1,
      cashCost = 0,
      rarity = 'COMMON',
      icon = '🔨',
      isActive = 1
    } = recipeData;

    if (!recipeKey || !resultItemKey || !name) throw new Error('recipeKey, resultItemKey, name은 필수 항목입니다.');

    await pool.query(
      `INSERT INTO craft_recipes 
       (recipe_key, result_item_key, name, description, material_cost, cash_cost, rarity, icon, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         result_item_key = VALUES(result_item_key),
         name = VALUES(name),
         description = VALUES(description),
         material_cost = VALUES(material_cost),
         cash_cost = VALUES(cash_cost),
         rarity = VALUES(rarity),
         icon = VALUES(icon),
         is_active = VALUES(is_active)`,
      [recipeKey, resultItemKey, name, description, materialCost, cashCost.toString(), rarity, icon, isActive ? 1 : 0]
    );

    return { success: true, message: `✅ 제작 레시피 [${name}] (${recipeKey}) 저장이 완료되었습니다.` };
  }

  static async adminDeleteRecipe(recipeKey) {
    if (!recipeKey) throw new Error('recipeKey가 필요합니다.');
    await pool.query(`DELETE FROM craft_recipes WHERE recipe_key = ?`, [recipeKey]);
    return { success: true, message: `🗑️ 제작 레시피 [${recipeKey}] 삭제가 완료되었습니다.` };
  }

  /**
   * 📈 [관리자 권한] 소비 및 소각(Sink) 원장 요약 통계
   */
  static async getSpendingSummary() {
    const [rows] = await pool.query(`
      SELECT category, COUNT(*) as count, SUM(amount) as total_amount
      FROM economy_flow_logs
      WHERE flow_type = 'OUTFLOW_SINK'
      GROUP BY category
      ORDER BY total_amount DESC
    `);

    const [recentSinks] = await pool.query(`
      SELECT * FROM economy_flow_logs
      WHERE flow_type = 'OUTFLOW_SINK'
      ORDER BY id DESC LIMIT 50
    `);

    return {
      stats: rows.map((r) => ({
        category: r.category,
        count: Number(r.count) || 0,
        totalAmount: (r.total_amount || 0).toString()
      })),
      recentSinks: recentSinks.map((s) => ({
        id: s.id,
        category: s.category,
        amount: s.amount.toString(),
        userId: s.user_id,
        reason: s.reason,
        createdAt: s.created_at
      }))
    };
  }
}

module.exports = AdminSpendingService;
