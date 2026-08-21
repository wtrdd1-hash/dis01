'use strict';

const { pool } = require('../../config/database');
const { safeBigInt } = require('../../utils/moneyValue');
const { pushUserLive } = require('../../utils/liveSync');

class PrestigeShopService {
  /**
   * 🌟 카탈로그 아이템 목록 조회 (유저 보유/장착 상태 포함)
   */
  static async listCatalog(options = {}) {
    const { userId, activeOnly = true } = options;
    const whereClauses = [];
    const params = [];

    if (activeOnly) {
      whereClauses.push('is_active = 1');
      whereClauses.push('(starts_at IS NULL OR starts_at <= NOW())');
      whereClauses.push('(ends_at IS NULL OR ends_at >= NOW())');
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const [items] = await pool.query(
      `SELECT * FROM economy_catalog_items ${whereSql} ORDER BY price ASC, id ASC`,
      params
    );

    let userInventoryMap = new Map();
    let userEquippedSet = new Set();

    if (userId) {
      // 보유 인벤토리 조회
      const [invRows] = await pool.query(
        `SELECT * FROM user_inventory 
         WHERE user_id = ? AND (expires_at IS NULL OR expires_at > NOW())`,
        [userId]
      );
      for (const row of invRows) {
        userInventoryMap.set(row.item_key, row);
      }

      // 현재 장착된 슬롯 조회
      const [loadoutRows] = await pool.query(
        `SELECT item_key FROM user_cosmetic_loadout WHERE user_id = ?`,
        [userId]
      );
      for (const row of loadoutRows) {
        userEquippedSet.add(row.item_key);
      }
    }

    return items.map((item) => {
      const inv = userInventoryMap.get(item.item_key);
      const isOwned = Boolean(inv);
      const isEquipped = userEquippedSet.has(item.item_key);
      const isPermanent = Number(item.duration_seconds) === 0;

      return {
        id: item.id,
        itemKey: item.item_key,
        itemType: item.item_type,
        name: item.name,
        description: item.description,
        price: item.price.toString(),
        durationSeconds: item.duration_seconds,
        isPermanent,
        rarity: item.rarity,
        rotationGroup: item.rotation_group,
        purchaseLimit: item.purchase_limit,
        icon: item.icon || '✨',
        previewCss: item.preview_css || '',
        isActive: Boolean(item.is_active),
        isOwned,
        isEquipped,
        expiresAt: inv?.expires_at || null,
        inventoryId: inv?.id || null
      };
    });
  }

  /**
   * 🛒 명예 상점 아이템 구매 (ACID 트랜잭션 + 원장 소각 기록)
   */
  static async purchaseItem(userId, itemKey, idempotencyKey = null) {
    if (!userId || !itemKey) {
      throw new Error('유저 ID와 상품 키가 필요합니다.');
    }

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. 상품 유효성 확인
      const [itemRows] = await connection.query(
        `SELECT * FROM economy_catalog_items 
         WHERE item_key = ? AND is_active = 1 
         AND (starts_at IS NULL OR starts_at <= NOW()) 
         AND (ends_at IS NULL OR ends_at >= NOW()) 
         LIMIT 1`,
        [itemKey]
      );

      if (itemRows.length === 0) {
        throw new Error('판매 중이지 않거나 존재하지 않는 상품입니다.');
      }

      const item = itemRows[0];
      const itemPrice = safeBigInt(item.price);

      // 2. 유저 정보 조회 및 FOR UPDATE 락
      const [userRows] = await connection.query(
        `SELECT * FROM users WHERE discord_id = ? FOR UPDATE`,
        [userId]
      );

      if (userRows.length === 0) {
        throw new Error('유저 정보를 찾을 수 없습니다.');
      }

      const user = userRows[0];
      const userCash = safeBigInt(user.cash);

      if (userCash < itemPrice) {
        const diff = itemPrice - userCash;
        throw new Error(`잔액이 부족합니다. (부족한 금액: ${diff.toLocaleString('ko-KR')}원)`);
      }

      // 3. 중복 보유 검사 (영구제 상품인 경우)
      const [existingInv] = await connection.query(
        `SELECT * FROM user_inventory 
         WHERE user_id = ? AND item_key = ? 
         AND (expires_at IS NULL OR expires_at > NOW())
         LIMIT 1`,
        [userId, itemKey]
      );

      const isPermanent = Number(item.duration_seconds) === 0;
      if (isPermanent && existingInv.length > 0) {
        throw new Error('이미 영구 보유 중인 아이템입니다.');
      }

      // 4. 잔액 차감
      const nextCash = userCash - itemPrice;
      await connection.query(
        `UPDATE users SET cash = ? WHERE discord_id = ?`,
        [nextCash.toString(), userId]
      );

      // 5. 인벤토리 지급 / 기간 연장
      let inventoryId = null;
      let expiresAt = null;

      if (!isPermanent) {
        const durationSec = Number(item.duration_seconds) || 604800;
        if (existingInv.length > 0 && existingInv[0].expires_at) {
          // 기존 기간에서 추가 연장
          const currentExp = new Date(existingInv[0].expires_at).getTime();
          const baseTime = currentExp > Date.now() ? currentExp : Date.now();
          expiresAt = new Date(baseTime + durationSec * 1000);
          inventoryId = existingInv[0].id;
          await connection.query(
            `UPDATE user_inventory SET expires_at = ?, is_active = 1 WHERE id = ?`,
            [expiresAt, inventoryId]
          );
        } else {
          expiresAt = new Date(Date.now() + durationSec * 1000);
          const [ins] = await connection.query(
            `INSERT INTO user_inventory (user_id, item_key, item_type, item_name, expires_at, is_active)
             VALUES (?, ?, ?, ?, ?, 1)`,
            [userId, item.item_key, item.item_type, item.name, expiresAt]
          );
          inventoryId = ins.insertId;
        }
      } else {
        const [ins] = await connection.query(
          `INSERT INTO user_inventory (user_id, item_key, item_type, item_name, expires_at, is_active)
           VALUES (?, ?, ?, ?, NULL, 1)`,
          [userId, item.item_key, item.item_type, item.name]
        );
        inventoryId = ins.insertId;
      }

      // 6. 🏛️ 통합 경제 원장 소각 (BURN) 기록
      await connection.query(
        `INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason, metadata)
         VALUES ('OUTFLOW_SINK', 'PRESTIGE_PURCHASE', ?, ?, ?, ?, ?)`,
        [
          itemPrice.toString(),
          userId,
          nextCash.toString(),
          `명예 상점 구매: ${item.name}`,
          JSON.stringify({ itemKey: item.item_key, itemType: item.item_type, isPermanent, idempotencyKey })
        ]
      );

      // 레거시 economy_logs 기록
      await connection.query(
        `INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
         VALUES (?, ?, 'SINK_PRESTIGE_SHOP', ?, ?, ?, ?)`,
        [userId, user.username || '유저', (-itemPrice).toString(), userCash.toString(), nextCash.toString(), `[명예상점] ${item.name} 구매`]
      );

      await connection.commit();

      // 실시간 웹/디스코드 잔액 소켓 동기화
      try { pushUserLive(userId); } catch (e) {}

      return {
        success: true,
        message: `🎉 [${item.name}] 상품을 성공적으로 구매했습니다!`,
        item: {
          itemKey: item.item_key,
          itemType: item.item_type,
          name: item.name,
          durationSeconds: item.duration_seconds,
          isPermanent,
          expiresAt
        },
        inventoryId,
        newCash: nextCash.toString()
      };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }
}

module.exports = PrestigeShopService;
