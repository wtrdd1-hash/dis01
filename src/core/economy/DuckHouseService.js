'use strict';

const { pool } = require('../../config/database');
const { safeBigInt } = require('../../utils/moneyValue');
const { pushUserLive } = require('../../utils/liveSync');

const DUCK_HOUSE_LEVELS = [
  { level: 1, name: '기본 방', slots: 3, cost: 0, desc: '아담하지만 따뜻한 오리의 보금자리' },
  { level: 2, name: '응접실', slots: 5, cost: 50000, desc: '친구들을 초대해 담소를 나눌 수 있는 세련된 응접실' },
  { level: 3, name: '갤러리', slots: 8, cost: 250000, desc: '수집한 명예 배지와 예술품을 전시하는 갤러리' },
  { level: 4, name: '펜트하우스', slots: 12, cost: 1000000, desc: '도심의 스카이라인이 한눈에 내려다보이는 초호화 펜트하우스' },
  { level: 5, name: '월덕 궁전', slots: 18, cost: 5000000, desc: '가상 경제 최정상 자산가만이 입주할 수 있는 눈부신 황금 궁전' }
];

class DuckHouseService {
  /**
   * 🏠 덕하우스 정보 및 전시 슬롯 조회
   */
  static async getDuckHouse(userId) {
    if (!userId) throw new Error('유저 ID가 필요합니다.');

    // 1. 덕하우스 기본 정보 조회 (없으면 Lv.1 자동 생성)
    let [rows] = await pool.query(`SELECT * FROM user_duck_houses WHERE user_id = ?`, [userId]);
    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO user_duck_houses (user_id, level, theme_item_id, house_name)
         VALUES (?, 1, 'basic', '나만의 덕하우스')
         ON DUPLICATE KEY UPDATE level=level`,
        [userId]
      );
      [rows] = await pool.query(`SELECT * FROM user_duck_houses WHERE user_id = ?`, [userId]);
    }

    const house = rows[0];
    const currentLevel = house.level || 1;
    const levelMeta = DUCK_HOUSE_LEVELS.find((l) => l.level === currentLevel) || DUCK_HOUSE_LEVELS[0];
    const nextLevelMeta = DUCK_HOUSE_LEVELS.find((l) => l.level === currentLevel + 1) || null;

    // 2. 전시 슬롯 조회
    const [slots] = await pool.query(
      `SELECT dhs.*, ui.item_name, ui.item_type
       FROM user_duck_house_slots dhs
       LEFT JOIN user_inventory ui ON dhs.inventory_id = ui.id
       WHERE dhs.user_id = ?
       ORDER BY dhs.slot_index ASC`,
      [userId]
    );

    // 3. 배치 가능한 인벤토리 아이템 조회
    const [inventory] = await pool.query(
      `SELECT ui.*, eci.icon, eci.rarity
       FROM user_inventory ui
       LEFT JOIN economy_catalog_items eci ON ui.item_key = eci.item_key
       WHERE ui.user_id = ? 
       AND (ui.expires_at IS NULL OR ui.expires_at > NOW())
       AND ui.is_active = 1
       ORDER BY ui.created_at DESC`,
      [userId]
    );

    return {
      house: {
        userId: house.user_id,
        level: currentLevel,
        levelName: levelMeta.name,
        maxSlots: levelMeta.slots,
        theme: house.theme_item_id,
        houseName: house.house_name,
        nextLevel: nextLevelMeta ? {
          level: nextLevelMeta.level,
          name: nextLevelMeta.name,
          slots: nextLevelMeta.slots,
          cost: nextLevelMeta.cost.toString(),
          desc: nextLevelMeta.desc
        } : null
      },
      slots: slots.map((s) => ({
        slotIndex: s.slot_index,
        inventoryId: s.inventory_id,
        itemKey: s.item_key,
        itemName: s.item_name || s.item_key,
        itemType: s.item_type || 'DECORATION',
        position: s.position_metadata || {}
      })),
      placeableItems: inventory.map((i) => ({
        id: i.id,
        itemKey: i.item_key,
        name: i.item_name || i.item_key,
        icon: i.icon || '🏆',
        rarity: i.rarity || 'COMMON',
        itemType: i.item_type
      }))
    };
  }

  /**
   * ⬆️ 덕하우스 레벨 업그레이드 (영구 소유, 비용 완전 소각)
   */
  static async upgradeDuckHouse(userId) {
    if (!userId) throw new Error('유저 ID가 필요합니다.');

    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. 현재 하우스 레벨 조회
      const [houseRows] = await connection.query(
        `SELECT * FROM user_duck_houses WHERE user_id = ? FOR UPDATE`,
        [userId]
      );

      const curLevel = houseRows[0]?.level || 1;
      if (curLevel >= 5) {
        throw new Error('이미 최고 등급(Lv.5 월덕 궁전)입니다.');
      }

      const nextLevelMeta = DUCK_HOUSE_LEVELS.find((l) => l.level === curLevel + 1);
      if (!nextLevelMeta) throw new Error('다음 레벨 정보를 찾을 수 없습니다.');

      const upgradeCost = safeBigInt(nextLevelMeta.cost);

      // 2. 유저 잔액 확인
      const [userRows] = await connection.query(
        `SELECT * FROM users WHERE discord_id = ? FOR UPDATE`,
        [userId]
      );

      if (userRows.length === 0) throw new Error('유저 정보를 찾을 수 없습니다.');
      const user = userRows[0];
      const userCash = safeBigInt(user.cash);

      if (userCash < upgradeCost) {
        const diff = upgradeCost - userCash;
        throw new Error(`업그레이드 비용이 부족합니다. (부족: ${diff.toLocaleString('ko-KR')}원)`);
      }

      // 3. 잔액 차감 & 레벨 갱신
      const nextCash = userCash - upgradeCost;
      await connection.query(`UPDATE users SET cash = ? WHERE discord_id = ?`, [nextCash.toString(), userId]);
      await connection.query(
        `UPDATE user_duck_houses SET level = ? WHERE user_id = ?`,
        [nextLevelMeta.level, userId]
      );

      // 4. 원장 소각 기록 (BURN/HOUSE_UPGRADE)
      await connection.query(
        `INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason, metadata)
         VALUES ('OUTFLOW_SINK', 'HOUSE_UPGRADE', ?, ?, ?, ?, ?)`,
        [
          upgradeCost.toString(),
          userId,
          nextCash.toString(),
          `덕하우스 확장: ${nextLevelMeta.name} (Lv.${nextLevelMeta.level})`,
          JSON.stringify({ fromLevel: curLevel, toLevel: nextLevelMeta.level, maxSlots: nextLevelMeta.slots })
        ]
      );

      await connection.query(
        `INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
         VALUES (?, ?, 'SINK_HOUSE_UPGRADE', ?, ?, ?, ?)`,
        [userId, user.username || '유저', (-upgradeCost).toString(), userCash.toString(), nextCash.toString(), `[덕하우스] ${nextLevelMeta.name} 확장`]
      );

      await connection.commit();
      try { pushUserLive(userId); } catch (e) {}

      return {
        success: true,
        message: `🏰 축하합니다! 덕하우스가 [Lv.${nextLevelMeta.level} ${nextLevelMeta.name}]으로 확장되었습니다! (전시 슬롯: ${nextLevelMeta.slots}개)`,
        newLevel: nextLevelMeta.level,
        newMaxSlots: nextLevelMeta.slots,
        newCash: nextCash.toString()
      };
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * 🖼️ 슬롯에 아이템 배치
   */
  static async setSlotItem(userId, slotIndex, inventoryId) {
    if (!userId || slotIndex === undefined || !inventoryId) {
      throw new Error('유저 ID, 슬롯 번호, 인벤토리 ID가 필요합니다.');
    }

    // 1. 하우스 레벨의 슬롯 한도 확인
    const [houseRows] = await pool.query(`SELECT level FROM user_duck_houses WHERE user_id = ?`, [userId]);
    const curLevel = houseRows[0]?.level || 1;
    const maxSlots = DUCK_HOUSE_LEVELS.find((l) => l.level === curLevel)?.slots || 3;

    if (slotIndex < 0 || slotIndex >= maxSlots) {
      throw new Error(`현재 덕하우스 레벨에서는 0~${maxSlots - 1}번 슬롯까지만 배치할 수 있습니다.`);
    }

    // 2. 인벤토리 소유권 확인
    const [invRows] = await pool.query(
      `SELECT * FROM user_inventory WHERE id = ? AND user_id = ? AND is_active = 1 LIMIT 1`,
      [inventoryId, userId]
    );

    if (invRows.length === 0) throw new Error('보유한 아이템이 아닙니다.');
    const inv = invRows[0];

    // 3. 슬롯 배치 Upsert
    await pool.query(
      `INSERT INTO user_duck_house_slots (user_id, slot_index, inventory_id, item_key)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE inventory_id = VALUES(inventory_id), item_key = VALUES(item_key)`,
      [userId, slotIndex, inv.id, inv.item_key]
    );

    return {
      success: true,
      message: `🖼️ ${slotIndex + 1}번 슬롯에 [${inv.name}] 아이템을 배치했습니다!`,
      slotIndex,
      itemKey: inv.item_key,
      itemName: inv.name
    };
  }

  /**
   * 🗑️ 슬롯 아이템 회수
   */
  static async removeSlotItem(userId, slotIndex) {
    if (!userId || slotIndex === undefined) throw new Error('유저 ID와 슬롯 번호가 필요합니다.');

    await pool.query(
      `DELETE FROM user_duck_house_slots WHERE user_id = ? AND slot_index = ?`,
      [userId, slotIndex]
    );

    return {
      success: true,
      message: `${slotIndex + 1}번 슬롯의 전시물을 회수했습니다.`,
      slotIndex
    };
  }

  /**
   * 🏷️ 하우스 이름 변경
   */
  static async updateHouseName(userId, houseName) {
    if (!userId || !houseName) throw new Error('하우스 이름이 필요합니다.');
    const sanitized = String(houseName).trim().slice(0, 30);

    await pool.query(
      `UPDATE user_duck_houses SET house_name = ? WHERE user_id = ?`,
      [sanitized, userId]
    );

    return { success: true, message: `하우스 이름이 '${sanitized}'(으)로 변경되었습니다.`, houseName: sanitized };
  }
}

module.exports = DuckHouseService;
