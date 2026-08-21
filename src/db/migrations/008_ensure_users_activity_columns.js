'use strict';

/**
 * Migration 008: users 테이블 활동 추적 컬럼(updated_at, last_active_at) 무결성 확보
 */
module.exports = {
  version: 8,
  name: '008_ensure_users_activity_columns',
  async up(connection) {
    const [cols] = await connection.query('SHOW COLUMNS FROM users');
    const existing = new Set(cols.map(c => c.Field));

    if (!existing.has('updated_at')) {
      await connection.query('ALTER TABLE users ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    }
    if (!existing.has('last_active_at')) {
      await connection.query('ALTER TABLE users ADD COLUMN last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP');
    }
    if (!existing.has('mine_genre')) {
      await connection.query('ALTER TABLE users ADD COLUMN mine_genre VARCHAR(16) NOT NULL DEFAULT "classic"');
    }

    console.log('✅ [Migration 008] users 테이블 활동 추적(updated_at, last_active_at) 컬럼 추가 완료');
  },
  async down(connection) {}
};
