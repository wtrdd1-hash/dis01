'use strict';

/**
 * Migration 007: users 테이블 채굴 및 클리커 컬럼 무결성 확보
 */
module.exports = {
  version: 7,
  name: '007_ensure_user_mining_columns',
  async up(connection) {
    const [cols] = await connection.query('SHOW COLUMNS FROM users');
    const existing = new Set(cols.map(c => c.Field));

    if (!existing.has('clicker_level')) {
      await connection.query('ALTER TABLE users ADD COLUMN clicker_level INT NOT NULL DEFAULT 1');
    }
    if (!existing.has('auto_miner_level')) {
      await connection.query('ALTER TABLE users ADD COLUMN auto_miner_level INT NOT NULL DEFAULT 0');
    }
    if (!existing.has('total_clicks')) {
      await connection.query('ALTER TABLE users ADD COLUMN total_clicks BIGINT NOT NULL DEFAULT 0');
    }
    if (!existing.has('gamble_turns')) {
      await connection.query('ALTER TABLE users ADD COLUMN gamble_turns BIGINT NOT NULL DEFAULT 0');
    }

    console.log('✅ [Migration 007] users 테이블 채굴/클리커 컬럼(clicker_level, auto_miner_level, total_clicks, gamble_turns) 무결성 확보 완료');
  },
  async down(connection) {}
};
