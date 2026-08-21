'use strict';

/**
 * Migration 004: 경제 밸런스 2.0 (통합 원장, 카지노 준비금, 기업 이익 풀)
 */
module.exports = {
  version: '004',
  name: '004_economy_rebalance_v2.js',
  async up(connection) {
    // 1. 통합 통화 순환 원장 (MINT / SINK / TRANSFER)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS economy_flow_logs (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        flow_type ENUM('INFLOW_MINT', 'OUTFLOW_SINK', 'TRANSFER') NOT NULL,
        category VARCHAR(64) NOT NULL,
        amount DECIMAL(65,0) NOT NULL DEFAULT 0,
        user_id VARCHAR(32) NULL,
        target_user_id VARCHAR(32) NULL,
        balance_after DECIMAL(65,0) NULL,
        reason VARCHAR(255) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_flow_type_date (flow_type, created_at),
        INDEX idx_flow_cat_date (category, created_at),
        INDEX idx_flow_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 2. 카지노 지급 준비금 및 잭팟 풀
    await connection.query(`
      CREATE TABLE IF NOT EXISTS casino_reserves (
        id INT PRIMARY KEY DEFAULT 1,
        current_reserve DECIMAL(65,0) NOT NULL DEFAULT 50000000,
        total_in DECIMAL(65,0) NOT NULL DEFAULT 0,
        total_out DECIMAL(65,0) NOT NULL DEFAULT 0,
        jackpot_pool DECIMAL(65,0) NOT NULL DEFAULT 5000000,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 초기 준비금(5천만원) 및 잭팟 풀 시드 (기존에 없으면 삽입)
    await connection.query(`
      INSERT INTO casino_reserves (id, current_reserve, total_in, total_out, jackpot_pool)
      VALUES (1, 50000000, 0, 0, 5000000)
      ON DUPLICATE KEY UPDATE id=1;
    `);

    // 3. 기업 영업이익 및 배당 풀 (실물 경제 주식 연동)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS corporate_earnings (
        stock_id VARCHAR(16) PRIMARY KEY,
        earnings_pool DECIMAL(65,0) NOT NULL DEFAULT 10000000,
        total_revenue DECIMAL(65,0) NOT NULL DEFAULT 0,
        total_dividend_paid DECIMAL(65,0) NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 주요 연동 기업 시드
    const coreStocks = ['CASN', 'BANK', 'MINE', 'WTRD', 'COFF', 'PAYX', 'REIT', 'ARMS'];
    for (const sid of coreStocks) {
      await connection.query(`
        INSERT INTO corporate_earnings (stock_id, earnings_pool, total_revenue, total_dividend_paid)
        VALUES (?, 10000000, 0, 0)
        ON DUPLICATE KEY UPDATE stock_id=stock_id;
      `, [sid]);
    }

    console.log('✅ [Migration 004] 경제 밸런스 2.0 (통합 원장, 카지노 준비금, 기업 이익 풀) 적용 완료');
  },
  async down(connection) {
    await connection.query('DROP TABLE IF EXISTS economy_flow_logs;');
    await connection.query('DROP TABLE IF EXISTS casino_reserves;');
    await connection.query('DROP TABLE IF EXISTS corporate_earnings;');
  }
};
