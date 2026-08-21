'use strict';

/**
 * Migration 010: 월덕 가상경제 소비 시스템 (주간 명예 상점, 외형 장착, 컬렉션 제작소, 덕하우스)
 */
module.exports = {
  version: 10,
  name: '010_economy_spending_system',
  async up(connection) {
    // 1. 명예 상점 카탈로그
    await connection.query(`
      CREATE TABLE IF NOT EXISTS economy_catalog_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        item_key VARCHAR(64) NOT NULL UNIQUE,
        item_type VARCHAR(32) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT NULL,
        price DECIMAL(65,0) NOT NULL DEFAULT 0,
        duration_seconds INT NOT NULL DEFAULT 0,
        rarity VARCHAR(32) NOT NULL DEFAULT 'COMMON',
        rotation_group VARCHAR(32) NOT NULL DEFAULT 'DEFAULT',
        purchase_limit INT NOT NULL DEFAULT 0,
        starts_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
        ends_at DATETIME NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        icon VARCHAR(64) DEFAULT '✨',
        preview_css TEXT NULL,
        metadata JSON NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_active_rotation (is_active, rotation_group)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. 유저 외형 장착 로드아웃
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_cosmetic_loadout (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        slot VARCHAR(32) NOT NULL,
        inventory_id INT NULL,
        item_key VARCHAR(64) NOT NULL,
        equipped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_slot (user_id, slot),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. 유저 제작 재료 (황금 깃털 조각 등)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS craft_materials (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        material_key VARCHAR(64) NOT NULL DEFAULT 'golden_feather_shard',
        quantity INT NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_material (user_id, material_key),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. 제작소 레시피
    await connection.query(`
      CREATE TABLE IF NOT EXISTS craft_recipes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        recipe_key VARCHAR(64) NOT NULL UNIQUE,
        result_item_key VARCHAR(64) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT NULL,
        material_cost INT NOT NULL DEFAULT 1,
        cash_cost DECIMAL(65,0) NOT NULL DEFAULT 0,
        rarity VARCHAR(32) NOT NULL DEFAULT 'COMMON',
        icon VARCHAR(64) DEFAULT '🔨',
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 5. 유저 덕하우스
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_duck_houses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL UNIQUE,
        level INT NOT NULL DEFAULT 1,
        theme_item_id VARCHAR(64) NOT NULL DEFAULT 'basic',
        house_name VARCHAR(100) DEFAULT '나만의 덕하우스',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 6. 덕하우스 전시 슬롯
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_duck_house_slots (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        slot_index INT NOT NULL,
        inventory_id INT NULL,
        item_key VARCHAR(64) NOT NULL,
        position_metadata JSON NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_slot (user_id, slot_index),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 7. 기본 명예 상품 시드 데이터 등록
    const initialCatalogItems = [
      // 🌟 체험 등급 (2,000 ~ 5,000원)
      ['color_neon_cyan', 'NAME_COLOR', '네온 사이언 닉네임', '프로필과 랭킹에서 빛나는 청록색 닉네임 컬러를 적용합니다.', 3000, 604800, 'COMMON', 'WEEKLY_A', '🎨', 'color: #06b6d4; text-shadow: 0 0 8px rgba(6,182,212,0.6);'],
      ['color_electric_purple', 'NAME_COLOR', '일렉트릭 퍼플 닉네임', '강렬한 보랏빛 네온으로 닉네임을 강조합니다.', 5000, 604800, 'COMMON', 'WEEKLY_A', '💜', 'color: #a855f7; text-shadow: 0 0 8px rgba(168,85,247,0.6);'],
      ['color_emerald_mint', 'NAME_COLOR', '에메랄드 민트 닉네임', '상쾌하고 부유한 느낌의 에메랄드 닉네임 컬러입니다.', 5000, 604800, 'COMMON', 'WEEKLY_B', '🌱', 'color: #10b981; text-shadow: 0 0 8px rgba(16,185,129,0.6);'],
      
      // 🌟 일반 등급 (10,000 ~ 50,000원)
      ['frame_cyber_circuit', 'PROFILE_FRAME', '사이버 서킷 테두리', '프로필 사진 주위에 미래지향적 사이버 회로 테두리를 30일간 장착합니다.', 20000, 2592000, 'RARE', 'WEEKLY_A', '🔲', 'border: 2px solid #6366f1; box-shadow: 0 0 12px rgba(99,102,241,0.5);'],
      ['frame_golden_leaf', 'PROFILE_FRAME', '황금 월계관 테두리', '고귀한 황금 잎사귀 테두리가 프로필을 둘러쌉니다.', 30000, 2592000, 'RARE', 'WEEKLY_B', '🌿', 'border: 2px solid #fbbf24; box-shadow: 0 0 12px rgba(251,191,36,0.5);'],
      ['skin_cyber_factory', 'BUSINESS_SKIN', '사이버 팩토리 사업장 간판', '내 사업 페이지에 세련된 사이버 펑크 간판 스킨을 적용합니다.', 30000, 2592000, 'RARE', 'WEEKLY_A', '🏭', 'background: linear-gradient(135deg, #1e1b4b, #312e81); border: 1px solid #6366f1;'],
      
      // 🌟 명예 등급 (100,000 ~ 500,000원)
      ['frame_animated_nebula', 'PROFILE_FRAME', '성운 오로라 애니메이션 테두리', '화려하게 회전하는 성운 오로라 애니메이션 테두리를 장착합니다.', 100000, 2592000, 'EPIC', 'WEEKLY_A', '🌌', 'border: 2px solid transparent; background: linear-gradient(#13151b, #13151b) padding-box, linear-gradient(135deg, #ec4899, #8b5cf6, #06b6d4) border-box; box-shadow: 0 0 18px rgba(236,72,153,0.5); animation: spin 8s linear infinite;'],
      ['house_skin_penthouse', 'HOUSE_SKIN', '모던 펜트하우스 덕하우스 스킨', '덕하우스 외관을 초호화 모던 펜트하우스 테마로 영구 변경합니다.', 500000, 0, 'EPIC', 'ALWAYS', '🏛️', 'background: linear-gradient(135deg, #0f172a, #1e293b); border: 2px solid #94a3b8;'],
      
      // 🌟 전설 등급 (1,000,000원 이상)
      ['plaque_legendary_patron', 'BADGE', '전설의 자산가 명판 배지', '월덕 가상경제의 최고위 명예를 상징하는 영구 전시용 황금 명판 배지입니다.', 1000000, 0, 'LEGENDARY', 'ALWAYS', '👑', 'background: linear-gradient(135deg, #f59e0b, #d97706); color: #000; font-weight: 900; box-shadow: 0 0 20px rgba(245,158,11,0.7);']
    ];

    for (const item of initialCatalogItems) {
      await connection.query(`
        INSERT INTO economy_catalog_items (item_key, item_type, name, description, price, duration_seconds, rarity, rotation_group, icon, preview_css)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE name=VALUES(name), price=VALUES(price), description=VALUES(description), preview_css=VALUES(preview_css)
      `, item);
    }

    // 8. 기본 제작소 레시피 시드 데이터 등록
    const initialRecipes = [
      ['craft_collector_bronze', 'badge_collector_bronze', '수집가 브론즈 배지', '황금 깃털 조각 5개와 1만 원으로 제작하는 입문 수집가 배지입니다.', 5, 10000, 'COMMON', '🥉'],
      ['craft_collector_silver', 'frame_collector_silver', '수집가 실버 테두리', '황금 깃털 조각 15개와 3만 원으로 제작하는 고급 실버 테두리입니다.', 15, 30000, 'RARE', '🥈'],
      ['craft_collector_gold', 'plaque_collector_gold', '수집가 골드 명판', '황금 깃털 조각 30개와 10만 원으로 제작하는 영구 골드 명판입니다.', 30, 100000, 'EPIC', '🥇'],
      ['craft_dia_collector', 'effect_dia_collector', '다이아 컬렉터 애니메이션', '황금 깃털 조각 60개와 30만 원으로 제작하는 눈부신 다이아몬드 이펙트입니다.', 60, 300000, 'EPIC', '💎'],
      ['craft_duck_statue', 'statue_golden_duck', '황금 월덕 기념 동상', '황금 깃털 조각 100개와 100만 원으로 제작하는 덕하우스 최고위 기념 동상입니다.', 100, 1000000, 'LEGENDARY', '🗽']
    ];

    for (const r of initialRecipes) {
      await connection.query(`
        INSERT INTO craft_recipes (recipe_key, result_item_key, name, description, material_cost, cash_cost, rarity, icon)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE name=VALUES(name), material_cost=VALUES(material_cost), cash_cost=VALUES(cash_cost)
      `, r);
    }

    console.log('✅ [Migration 010] 월덕 가상경제 소비 시스템 (명예 상점, 제작소, 덕하우스) 테이블 생성 완료');
  },
  async down(connection) {
    await connection.query('DROP TABLE IF EXISTS user_duck_house_slots');
    await connection.query('DROP TABLE IF EXISTS user_duck_houses');
    await connection.query('DROP TABLE IF EXISTS craft_recipes');
    await connection.query('DROP TABLE IF EXISTS craft_materials');
    await connection.query('DROP TABLE IF EXISTS user_cosmetic_loadout');
    await connection.query('DROP TABLE IF EXISTS economy_catalog_items');
  }
};
