'use strict';

const { pool } = require('../../config/database');

class CosmeticLoadoutService {
  /**
   * 🎨 유저의 현재 장착 외형 및 보유 외형 인벤토리 조회
   */
  static async getUserLoadout(userId) {
    if (!userId) return { loadout: {}, items: [] };

    // 1. 유효한 보유 인벤토리 조회
    const [invRows] = await pool.query(
      `SELECT ui.*, eci.icon, eci.preview_css, eci.rarity
       FROM user_inventory ui
       LEFT JOIN economy_catalog_items eci ON ui.item_key = eci.item_key
       WHERE ui.user_id = ? 
       AND (ui.expires_at IS NULL OR ui.expires_at > NOW())
       AND ui.is_active = 1
       ORDER BY ui.created_at DESC`,
      [userId]
    );

    // 2. 현재 장착 슬롯 조회
    const [loadoutRows] = await pool.query(
      `SELECT ucl.*, eci.name, eci.icon, eci.preview_css, eci.rarity, eci.item_type
       FROM user_cosmetic_loadout ucl
       LEFT JOIN economy_catalog_items eci ON ucl.item_key = eci.item_key
       WHERE ucl.user_id = ?`,
      [userId]
    );

    const config = require('../../config/config');
    const isAdmin = config.isAdmin(userId);

    const loadout = {};
    for (const row of loadoutRows) {
      loadout[row.slot] = {
        slot: row.slot,
        itemKey: row.item_key,
        name: row.name || row.item_key,
        icon: row.icon || '✨',
        previewCss: row.preview_css || '',
        rarity: row.rarity || 'COMMON',
        equippedAt: row.equipped_at
      };
    }

    if (isAdmin && !loadout.TITLE) {
      loadout.TITLE = {
        slot: 'TITLE',
        itemKey: 'title_admin',
        name: '👑 총괄 관리자',
        icon: '👑',
        previewCss: 'background:linear-gradient(135deg,#f59e0b,#fbbf24);color:#000;font-weight:900;',
        rarity: 'LEGENDARY',
        equippedAt: new Date().toISOString()
      };
    }

    const items = invRows.map((r) => ({
      id: r.id,
      itemKey: r.item_key,
      itemType: r.item_type,
      name: r.item_name || r.name || r.item_key,
      icon: r.icon || '✨',
      previewCss: r.preview_css || '',
      rarity: r.rarity || 'COMMON',
      expiresAt: r.expires_at,
      isPermanent: !r.expires_at
    }));

    if (isAdmin && !items.some(i => i.itemKey === 'title_admin')) {
      items.unshift({
        id: 999999,
        itemKey: 'title_admin',
        itemType: 'TITLE',
        name: '👑 총괄 관리자',
        icon: '👑',
        previewCss: 'background:linear-gradient(135deg,#f59e0b,#fbbf24);color:#000;font-weight:900;',
        rarity: 'LEGENDARY',
        expiresAt: null,
        isPermanent: true
      });
    }

    return {
      loadout,
      items
    };
  }

  /**
   * 🔲 외형 아이템 장착 (슬롯 유효성 & 보유 확인)
   */
  static async equipItem(userId, slot, itemKey) {
    if (!userId || !slot || !itemKey) {
      throw new Error('유저 ID, 슬롯, 아이템 키가 모두 필요합니다.');
    }

    // 1. 보유 및 유효 기간 검증
    const [invRows] = await pool.query(
      `SELECT * FROM user_inventory
       WHERE user_id = ? AND item_key = ?
       AND (expires_at IS NULL OR expires_at > NOW())
       AND is_active = 1
       ORDER BY id DESC LIMIT 1`,
      [userId, itemKey]
    );

    if (invRows.length === 0) {
      throw new Error('보유하고 있지 않거나 유효 기간이 만료된 아이템입니다.');
    }

    const inv = invRows[0];

    // 2. 슬롯 호환성 검증 (PROFILE_FRAME, NAME_COLOR, BUSINESS_SKIN, HOUSE_SKIN, BADGE, AURA, TITLE)
    const allowedSlots = new Set(['PROFILE_FRAME', 'NAME_COLOR', 'BUSINESS_SKIN', 'HOUSE_SKIN', 'BADGE', 'AURA', 'TITLE']);
    const upperSlot = slot.toUpperCase();
    if (!allowedSlots.has(upperSlot)) {
      throw new Error('지원하지 않는 외형 슬롯입니다.');
    }

    // 3. 외형 장착 Upsert
    await pool.query(
      `INSERT INTO user_cosmetic_loadout (user_id, slot, inventory_id, item_key, equipped_at)
       VALUES (?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE 
         inventory_id = VALUES(inventory_id),
         item_key = VALUES(item_key),
         equipped_at = NOW()`,
      [userId, upperSlot, inv.id, itemKey]
    );

    return {
      success: true,
      message: `✨ [${inv.item_name || inv.name || itemKey}] 아이템을 ${upperSlot} 슬롯에 장착했습니다!`,
      slot: upperSlot,
      itemKey
    };
  }

  /**
   * ❌ 외형 장착 해제
   */
  static async unequipSlot(userId, slot) {
    if (!userId || !slot) {
      throw new Error('유저 ID와 슬롯이 필요합니다.');
    }

    const upperSlot = slot.toUpperCase();
    await pool.query(
      `DELETE FROM user_cosmetic_loadout WHERE user_id = ? AND slot = ?`,
      [userId, upperSlot]
    );

    return {
      success: true,
      message: `${upperSlot} 슬롯 장착을 해제했습니다.`,
      slot: upperSlot
    };
  }

  /**
   * 🌐 프로필/랭킹용 공개 외형 스타일 조회
   */
  static async getPublicCosmetics(userId) {
    if (!userId) return null;

    const [rows] = await pool.query(
      `SELECT ucl.slot, ucl.item_key, eci.name, eci.preview_css, eci.icon, eci.rarity
       FROM user_cosmetic_loadout ucl
       LEFT JOIN economy_catalog_items eci ON ucl.item_key = eci.item_key
       LEFT JOIN user_inventory ui ON ucl.inventory_id = ui.id
       WHERE ucl.user_id = ?
       AND (ui.expires_at IS NULL OR ui.expires_at > NOW())`,
      [userId]
    );

    const result = {
      nameColorCss: '',
      profileFrameCss: '',
      badge: null,
      aura: null,
      houseSkin: null
    };

    for (const r of rows) {
      if (r.slot === 'NAME_COLOR') result.nameColorCss = r.preview_css || '';
      if (r.slot === 'PROFILE_FRAME') result.profileFrameCss = r.preview_css || '';
      if (r.slot === 'BADGE') result.badge = { name: r.name, icon: r.icon, rarity: r.rarity };
      if (r.slot === 'AURA') result.aura = { name: r.name, previewCss: r.preview_css };
      if (r.slot === 'HOUSE_SKIN') result.houseSkin = { name: r.name, itemKey: r.item_key };
    }

    return result;
  }
}

module.exports = CosmeticLoadoutService;
