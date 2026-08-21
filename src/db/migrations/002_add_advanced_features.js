'use strict';

module.exports = {
  version: '002',
  name: '002_add_advanced_features.js',
  async up(connection) {
    // 1. 클릭커 & 채굴 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_clicker (
        user_id VARCHAR(32) PRIMARY KEY,
        total_clicks BIGINT NOT NULL DEFAULT 0,
        clicker_level INT NOT NULL DEFAULT 1,
        auto_click_level INT NOT NULL DEFAULT 0,
        energy INT NOT NULL DEFAULT 100,
        max_energy INT NOT NULL DEFAULT 100,
        last_energy_update DATETIME DEFAULT CURRENT_TIMESTAMP,
        inventory JSON NULL,
        equipped_weapon VARCHAR(64) NULL,
        equipped_armor VARCHAR(64) NULL,
        dungeon_stage INT NOT NULL DEFAULT 1,
        stat_points INT NOT NULL DEFAULT 0,
        str_stat INT NOT NULL DEFAULT 0,
        dex_stat INT NOT NULL DEFAULT 0,
        int_stat INT NOT NULL DEFAULT 0,
        luk_stat INT NOT NULL DEFAULT 0,
        total_dungeon_clears INT NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 2. 유저 밴 & 감사 로그
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_ban_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NULL,
        admin_id VARCHAR(32) NOT NULL,
        admin_username VARCHAR(100) NULL,
        action VARCHAR(20) NOT NULL,
        duration_hours INT NULL,
        banned_until DATETIME NULL,
        reason VARCHAR(255) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ban_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 3. 지정가 주문
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock_limit_orders (
        id            BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id       VARCHAR(32) NOT NULL,
        username      VARCHAR(100) NOT NULL,
        stock_id      VARCHAR(16) NOT NULL,
        order_type    ENUM('BUY','SELL') NOT NULL,
        limit_price   DECIMAL(65,0) NOT NULL,
        amount        DECIMAL(38,4) NOT NULL,
        status        ENUM('PENDING','FILLED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'PENDING',
        filled_price  DECIMAL(65,0) DEFAULT NULL,
        expires_at    DATETIME DEFAULT NULL,
        filled_at     DATETIME DEFAULT NULL,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_lo_user     (user_id, status),
        INDEX idx_lo_stock    (stock_id, status),
        INDEX idx_lo_pending  (status, expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 4. 은행 예금 계좌 & 대출
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_bank_accounts (
        user_id VARCHAR(32) PRIMARY KEY,
        account_number VARCHAR(32) NOT NULL UNIQUE,
        balance DECIMAL(65,0) NOT NULL DEFAULT 0,
        last_interest_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        total_interest_earned DECIMAL(65,0) NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_loans (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        loan_amount DECIMAL(65,0) NOT NULL,
        remaining_principal DECIMAL(65,0) NOT NULL,
        accumulated_interest DECIMAL(65,0) NOT NULL DEFAULT 0,
        collateral_type VARCHAR(32) NOT NULL DEFAULT 'NONE',
        collateral_amount DECIMAL(65,0) NOT NULL DEFAULT 0,
        interest_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0500,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        due_date DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_loan_user (user_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 5. 국고 및 경제 설정
    await connection.query(`
      CREATE TABLE IF NOT EXISTS national_treasury (
        id INT PRIMARY KEY DEFAULT 1,
        balance DECIMAL(65,0) NOT NULL DEFAULT 0,
        total_tax_collected DECIMAL(65,0) NOT NULL DEFAULT 0,
        total_subsidy_paid DECIMAL(65,0) NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.query(`
      INSERT IGNORE INTO national_treasury (id, balance, total_tax_collected, total_subsidy_paid)
      VALUES (1, 0, 0, 0);
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS economy_settings (
        key_name VARCHAR(64) PRIMARY KEY,
        value VARCHAR(255) NOT NULL DEFAULT '1.0',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 6. 기업(비즈니스) 시스템
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_businesses (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        business_key VARCHAR(64) NOT NULL,
        level INT NOT NULL DEFAULT 1,
        last_collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        total_revenue_earned DECIMAL(65,0) NOT NULL DEFAULT 0,
        staff INT NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_biz (user_id, business_key),
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 7. 채팅 & 문의 & 웹 감사 로그
    await connection.query(`
      CREATE TABLE IF NOT EXISTS chat_rooms (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(16) NOT NULL,
        slug VARCHAR(64) NULL,
        title VARCHAR(100) NOT NULL,
        parent_room_id BIGINT NULL,
        parent_message_id BIGINT NULL,
        created_by VARCHAR(32) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_type (type),
        INDEX idx_parent_room (parent_room_id),
        UNIQUE KEY uniq_slug (slug)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.query(`
      INSERT IGNORE INTO chat_rooms (id, type, slug, title) VALUES
       (1, 'channel', 'plaza', '광장'),
       (2, 'channel', 'trade', '거래'),
       (3, 'channel', 'lounge', '잡담');
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        room_id BIGINT NOT NULL DEFAULT 1,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(64) NOT NULL,
        avatar VARCHAR(255) NULL,
        message VARCHAR(500) NOT NULL,
        is_admin TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created_at (created_at),
        INDEX idx_room_id (room_id),
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NOT NULL,
        avatar VARCHAR(255) NULL,
        category VARCHAR(64) NOT NULL DEFAULT '일반문의',
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        image_url TEXT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'WAITING',
        answer TEXT NULL,
        answered_by VARCHAR(100) NULL,
        answered_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin_roles (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        discord_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NOT NULL DEFAULT '',
        granted_by VARCHAR(32) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        note VARCHAR(255) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_discord_id (discord_id),
        INDEX idx_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }
};
