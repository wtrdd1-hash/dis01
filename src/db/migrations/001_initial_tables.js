'use strict';

module.exports = {
  version: '001',
  name: '001_initial_tables.js',
  async up(connection) {
    // 1. 유저 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        discord_id VARCHAR(32) PRIMARY KEY,
        username VARCHAR(100) NULL,
        avatar VARCHAR(255) NULL,
        cash DECIMAL(65,0) NOT NULL DEFAULT 10000,
        bank DECIMAL(65,0) NOT NULL DEFAULT 0,
        last_daily DATETIME NULL,
        daily_streak INT NOT NULL DEFAULT 0,
        last_work DATETIME NULL,
        last_subsidy DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created_at (created_at),
        INDEX idx_cash (cash),
        INDEX idx_bank (bank)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 2. 주식 종목 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stocks (
        stock_id VARCHAR(16) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        price DECIMAL(65,0) NOT NULL,
        prev_price DECIMAL(65,0) NOT NULL,
        volatility DECIMAL(5,4) NOT NULL DEFAULT 0.05,
        sector VARCHAR(64) NOT NULL DEFAULT 'IT/기술',
        description TEXT NULL,
        high_24h DECIMAL(65,0) NOT NULL DEFAULT 0,
        low_24h DECIMAL(65,0) NOT NULL DEFAULT 0,
        volume_24h DECIMAL(65,0) NOT NULL DEFAULT 0,
        market_cap DECIMAL(65,0) NOT NULL DEFAULT 0,
        pe_ratio DECIMAL(6,2) NOT NULL DEFAULT 15.00,
        dividend_yield DECIMAL(5,2) NOT NULL DEFAULT 2.50,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        delisted_at DATETIME NULL,
        liquidation_price DECIMAL(65,0) NOT NULL DEFAULT 0,
        max_buy_limit BIGINT NULL DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 3. 유저 보유 주식
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_stocks (
        user_id VARCHAR(32) NOT NULL,
        stock_id VARCHAR(16) NOT NULL,
        amount DECIMAL(38, 4) NOT NULL DEFAULT 0.0000,
        total_spent DECIMAL(65,0) NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, stock_id),
        INDEX idx_user_id (user_id),
        INDEX idx_stock_id (stock_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 4. 주식 가격 히스토리
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        stock_id VARCHAR(16) NOT NULL,
        price DECIMAL(65,0) NOT NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_stock_id_recorded (stock_id, recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 5. 시장 뉴스 피드
    await connection.query(`
      CREATE TABLE IF NOT EXISTS market_news_feed (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        impact_sector VARCHAR(64) NULL,
        related_stock VARCHAR(16) NULL,
        impact_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0000,
        sentiment VARCHAR(16) NOT NULL DEFAULT 'BULL',
        importance VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created_at (created_at),
        INDEX idx_event_type (event_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 6. 도박 및 경제 로그
    await connection.query(`
      CREATE TABLE IF NOT EXISTS gambling_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        game VARCHAR(32) NOT NULL,
        bet DECIMAL(65,0) NOT NULL,
        payout DECIMAL(65,0) NOT NULL,
        profit DECIMAL(65,0) NOT NULL,
        balance_before DECIMAL(65,0) NOT NULL DEFAULT 0,
        balance_after DECIMAL(65,0) NOT NULL DEFAULT 0,
        details JSON NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS economy_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NULL,
        type VARCHAR(32) NOT NULL,
        amount DECIMAL(65,0) NOT NULL,
        balance_before DECIMAL(65,0) NOT NULL DEFAULT 0,
        balance_after DECIMAL(65,0) NOT NULL DEFAULT 0,
        description TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_type (type),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  }
};
