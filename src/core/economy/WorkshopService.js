'use strict';

const { pool } = require('../../config/database');
const { safeBigInt } = require('../../utils/moneyValue');
const { pushUserLive } = require('../../utils/liveSync');

class WorkshopService {
  /**
   * 📜 제작 레시피 목록 조회
   */
  static async listRecipes() {
    const [recipes] = await pool.query(
      `SELECT * FROM craft_recipes WHERE is_active = 1 ORDER BY cash_cost ASC, material_cost ASC`
    );
    return recipes.map((r) => ({
      id: r.id,
      recipeKey: r.recipe_key,
      resultItemKey: r.result_item_key,
      name: r.name,
      description: r.description,
      materialCost: r.material_cost,
      cashCost: r.cash_cost.toString(),
      rarity: r.rarity,
      icon: r.icon || '🔨',
      isActive: Boolean(r.is_active)
    }));
  }

  /**
   * 🪶 유저의 제작 재료 (황금 깃털 조각) 수량 조회
   */
  static async getUserMaterials(userId) {
    if (!userId) return { goldenFeatherShards: 0 };

    const [rows] = await pool.query(
      `SELECT material_key, quantity FROM craft_materials WHERE user_id = ?`,
      [userId]
    );

    let shards = 0;
    for (const r of rows) {
      if (r.material_key === 'golden_feather_shard') shards = Number(r.quantity) || 0;
    }

    return { goldenFeatherShards: shards };
  }

  /**
   * ♻️ 아이템 분해 (중복/미사용 소비 아이템 -> 황금 깃털 조각 획득)
   */
  static async salvageItem(userId, inventoryId) {
    if (!userId || !inventoryId) {
      throw new Error('유저 ID와 인벤토리 ID가 필요합니다.');
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. 인벤토리 아이템 조회
      const [invRows] = await connection.query(
        `SELECT * FROM user_inventory 
         WHERE id = ? AND user_id = ? 
         AND (expires_at IS NULL OR expires_at > NOW())
         LIMIT 1 FOR UPDATE`,
        [inventoryId, userId]
      );

      if (invRows.length === 0) {
        throw new Error('분해할 수 있는 아이템이 존재하지 않습니다.');
      }

      const inv = invRows[0];

      // 2. 현재 장착 중인 아이템인지 확인 (장착 중이면 분해 불가)
      const [equippedRows] = await connection.query(
        `SELECT * FROM user_cosmetic_loadout WHERE inventory_id = ? LIMIT 1`,
        [inventoryId]
      );

      if (equippedRows.length > 0) {
        throw new Error('현재 장착 중인 외형 아이템은 분해할 수 없습니다. 먼저 장착을 해제해 주세요.');
      }

      // 3. 조각 보상 계산
      let shardReward = 1;
      const type = (inv.item_type || '').toUpperCase();
      if (type.includes('RARE') || type.includes('ADVANCED')) shardReward = 3;
      else if (type.includes('EPIC') || type.includes('AURA')) shardReward = 5;
      else if (type.includes('LEGENDARY') || !inv.expires_at) shardReward = 20;

      // 4. 아이템 삭제
      await connection.query(`DELETE FROM user_inventory WHERE id = ?`, [inventoryId]);

      // 5. 황금 깃털 조각 가산
      await connection.query(
        `INSERT INTO craft_materials (user_id, material_key, quantity)
         VALUES (?, 'golden_feather_shard', ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
        [userId, shardReward, shardReward]
      );

      const [matRows] = await connection.query(
        `SELECT quantity FROM craft_materials WHERE user_id = ? AND material_key = 'golden_feather_shard'`,
        [userId]
      );
      const totalShards = matRows[0]?.quantity || shardReward;

      // 6. 통합 원장 기록
      await connection.query(
        `INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, reason, metadata)
         VALUES ('OUTFLOW_SINK', 'ITEM_SALVAGE', 0, ?, ?, ?)`,
        [
          userId,
          `아이템 분해: ${inv.name} -> 황금 깃털 조각 +${shardReward}개`,
          JSON.stringify({ inventoryId, itemKey: inv.item_key, shardsGained: shardReward, totalShards })
        ]
      );

      await connection.commit();

      return {
        success: true,
        message: `♻️ [${inv.name}] 아이템을 분해하여 [황금 깃털 조각] ${shardReward}개를 획득했습니다!`,
        shardsGained: shardReward,
        totalShards
      };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * 🔨 확정 제작 (황금 깃털 조각 + 제작비 소모 -> 100% 확정 지급)
   */
  static async craftItem(userId, recipeKey) {
    if (!userId || !recipeKey) {
      throw new Error('유저 ID와 레시피 키가 필요합니다.');
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. 레시피 조회
      const [recipeRows] = await connection.query(
        `SELECT * FROM craft_recipes WHERE recipe_key = ? AND is_active = 1 LIMIT 1`,
        [recipeKey]
      );

      if (recipeRows.length === 0) {
        throw new Error('존재하지 않거나 비활성화된 제작 레시피입니다.');
      }

      const recipe = recipeRows[0];
      const craftFee = safeBigInt(recipe.cash_cost);
      const shardCost = Number(recipe.material_cost) || 1;

      // 2. 유저 잔액 및 조각 조회 (FOR UPDATE)
      const [userRows] = await connection.query(
        `SELECT * FROM users WHERE discord_id = ? FOR UPDATE`,
        [userId]
      );

      if (userRows.length === 0) throw new Error('유저 정보를 찾을 수 없습니다.');
      const user = userRows[0];
      const userCash = safeBigInt(user.cash);

      if (userCash < craftFee) {
        const diff = craftFee - userCash;
        throw new Error(`제작비가 부족합니다. (부족: ${diff.toLocaleString('ko-KR')}원)`);
      }

      const [matRows] = await connection.query(
        `SELECT quantity FROM craft_materials 
         WHERE user_id = ? AND material_key = 'golden_feather_shard' FOR UPDATE`,
        [userId]
      );

      const curShards = matRows[0]?.quantity || 0;
      if (curShards < shardCost) {
        throw new Error(`황금 깃털 조각이 부족합니다. (필요: ${shardCost}개 / 보유: ${curShards}개)`);
      }
      // 3. 이미 보유 중인지 확인 (영구 컬렉션 중복 방지)
      const [owned] = await connection.query(
        `SELECT id FROM user_inventory WHERE user_id = ? AND item_key = ?`,
        [userId, recipe.result_item_key]
      );
      if (owned.length > 0) {
        throw new Error(`이미 보유 중인 컬렉션 아이템([${recipe.name}])입니다.`);
      }

      // 4. 재료 및 현금 차감
      const nextCash = userCash - craftFee;
      const nextShards = curShards - shardCost;

      await connection.query(
        `UPDATE users SET cash = ? WHERE discord_id = ?`,
        [nextCash.toString(), userId]
      );

      await connection.query(
        `UPDATE craft_materials SET quantity = ? 
         WHERE user_id = ? AND material_key = 'golden_feather_shard'`,
        [nextShards, userId]
      );

      // 5. 완성 아이템 지급 (영구 지급)
      const [ins] = await connection.query(
        `INSERT INTO user_inventory (user_id, item_key, item_type, item_name, expires_at, is_active)
         VALUES (?, ?, 'COLLECTION', ?, NULL, 1)
         ON DUPLICATE KEY UPDATE is_active = 1`,
        [userId, recipe.result_item_key, recipe.name]
      );

      // 5. 🏛️ 통합 경제 원장 소각 기록 (BURN/CRAFT_FEE)
      await connection.query(
        `INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason, metadata)
         VALUES ('OUTFLOW_SINK', 'CRAFT_FEE', ?, ?, ?, ?, ?)`,
        [
          craftFee.toString(),
          userId,
          nextCash.toString(),
          `컬렉션 제작: ${recipe.name}`,
          JSON.stringify({ recipeKey: recipe.recipe_key, resultItemKey: recipe.result_item_key, shardCost })
        ]
      );

      await connection.query(
        `INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
         VALUES (?, ?, 'SINK_CRAFT_FEE', ?, ?, ?, ?)`,
        [userId, user.username || '유저', (-craftFee).toString(), userCash.toString(), nextCash.toString(), `[제작소] ${recipe.name} 제작`]
      );

      await connection.commit();

      // 실시간 지갑 동기화
      try { pushUserLive(userId); } catch (e) {}

      return {
        success: true,
        message: `🔨 축하합니다! [${recipe.name}] 제작에 성공했습니다!`,
        resultItem: {
          inventoryId: ins.insertId,
          itemKey: recipe.result_item_key,
          name: recipe.name,
          rarity: recipe.rarity,
          icon: recipe.icon
        },
        newCash: nextCash.toString(),
        remainingShards: nextShards
      };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }
}

module.exports = WorkshopService;
