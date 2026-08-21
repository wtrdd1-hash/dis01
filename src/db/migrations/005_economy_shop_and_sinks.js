'use strict';

/**
 * Migration 005: 경제 소비처 & 상점 시스템 2.0 (인벤토리, 로또 6/45, 확성기, 드릴 대장간)
 */
module.exports = {
  version: 5,
  name: '005_economy_shop_and_sinks',
  async up(connection) {
    // 1. 유저 인벤토리 & 보유 아이템 (오라, 칭호, 전략 카드, 쿠폰)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_inventory (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        item_type VARCHAR(32) NOT NULL,
        item_key VARCHAR(64) NOT NULL,
        item_name VARCHAR(100) NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        expires_at DATETIME NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_inv (user_id, item_type),
        UNIQUE KEY uq_user_item (user_id, item_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. 주간 메가 로또 6/45 회차 관리
    await connection.query(`
      CREATE TABLE IF NOT EXISTS lotto_rounds (
        round_number INT PRIMARY KEY,
        jackpot_pool DECIMAL(65,0) NOT NULL DEFAULT 10000000,
        total_sales DECIMAL(65,0) NOT NULL DEFAULT 0,
        total_burned DECIMAL(65,0) NOT NULL DEFAULT 0,
        winning_numbers VARCHAR(64) NULL,
        bonus_number INT NULL,
        drawn_at DATETIME NULL,
        status ENUM('OPEN', 'DRAWN', 'SETTLED') DEFAULT 'OPEN',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 1회차 로또 기본 초기화
    await connection.query(`
      INSERT INTO lotto_rounds (round_number, jackpot_pool, total_sales, total_burned, status)
      VALUES (1, 10000000, 0, 0, 'OPEN')
      ON DUPLICATE KEY UPDATE jackpot_pool = VALUES(jackpot_pool);
    `);

    // 3. 로또 구매 티켓
    await connection.query(`
      CREATE TABLE IF NOT EXISTS lotto_tickets (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        round_number INT NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        numbers VARCHAR(64) NOT NULL,
        is_auto TINYINT(1) NOT NULL DEFAULT 0,
        prize_rank INT DEFAULT 0,
        prize_amount DECIMAL(65,0) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_round_user (round_number, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. 전 서버 및 웹 대시보드 실시간 확성기 로그
    await connection.query(`
      CREATE TABLE IF NOT EXISTS megaphone_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NOT NULL,
        message VARCHAR(300) NOT NULL,
        theme VARCHAR(32) DEFAULT 'gold',
        cost DECIMAL(65,0) NOT NULL DEFAULT 50000,
        active_until DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_active (active_until)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 5. 채굴 드릴 장비 대장간 (+0 ~ +15강)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_drill_equipment (
        user_id VARCHAR(32) PRIMARY KEY,
        enhancement_level INT NOT NULL DEFAULT 0,
        protection_tickets INT NOT NULL DEFAULT 0,
        overclock_until DATETIME NULL,
        total_spent DECIMAL(65,0) NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('✅ [Migration 005] 상점, 로또 6/45, 확성기, 드릴 대장간 테이블 생성 완료');
  },
  async down(connection) {
    await connection.query('DROP TABLE IF EXISTS user_inventory');
    await connection.query('DROP TABLE IF EXISTS lotto_tickets');
    await connection.query('DROP TABLE IF EXISTS lotto_rounds');
    await connection.query('DROP TABLE IF EXISTS megaphone_logs');
    await connection.query('DROP TABLE IF EXISTS user_drill_equipment');
  }
};
