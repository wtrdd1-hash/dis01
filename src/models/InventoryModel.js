'use strict';

const { pool } = require('../config/database');

class InventoryModel {
  /**
   * 유저의 유효 인벤토리 조회
   */
  static async getUserInventory(userId) {
    const id = String(userId);
    const [rows] = await pool.query(`
      SELECT ui.*, eci.icon, eci.preview_css, eci.rarity, eci.name as catalog_name
      FROM user_inventory ui
      LEFT JOIN economy_catalog_items eci ON ui.item_key = eci.item_key
      WHERE ui.user_id = ?
        AND (ui.expires_at IS NULL OR ui.expires_at > NOW())
        AND ui.is_active = 1
      ORDER BY ui.created_at DESC
    `, [id]);

    return rows.map(r => ({
      id: r.id,
      itemKey: r.item_key,
      itemType: r.item_type,
      name: r.item_name || r.catalog_name || r.item_key,
      icon: r.icon || '✨',
      previewCss: r.preview_css || '',
      rarity: r.rarity || 'COMMON',
      expiresAt: r.expires_at,
      isPermanent: !r.expires_at
    }));
  }

  /**
   * 아이템 지급 (인벤토리 추가)
   */
  static async grantItem(userId, itemKey, itemType, itemName, durationSeconds = 0) {
    const id = String(userId);
    const expiresAt = durationSeconds > 0
      ? new Date(Date.now() + durationSeconds * 1000)
      : null;

    const [res] = await pool.query(`
      INSERT INTO user_inventory (user_id, item_key, item_type, item_name, expires_at, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        expires_at = VALUES(expires_at),
        is_active = 1,
        item_name = VALUES(item_name)
    `, [id, itemKey, itemType, itemName, expiresAt]);

    return { success: true, insertId: res.insertId };
  }

  /**
   * 아이템 삭제 / 소모
   */
  static async removeItem(userId, itemKey) {
    const [res] = await pool.query('DELETE FROM user_inventory WHERE user_id = ? AND item_key = ?', [String(userId), itemKey]);
    return res.affectedRows > 0;
  }
}

module.exports = InventoryModel;
