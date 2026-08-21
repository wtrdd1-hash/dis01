'use strict';

module.exports = {
  version: '011',
  name: '011_ip_whitelist_and_schema_fix',

  async up(connection) {
    // 1. economy_logs 테이블 username 컬럼 NULL 허용 및 기본값 보정
    try {
      await connection.query(`
        ALTER TABLE economy_logs MODIFY COLUMN username VARCHAR(100) NULL DEFAULT '유저'
      `);
      console.log('✅ [Migration 011] economy_logs username 컬럼 기본값 보정 완료');
    } catch (e) {
      console.warn('[Migration 011] economy_logs modify username notice:', e.message);
    }

    // 2. 관리자 IP 화이트리스트 테이블 생성
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin_ip_whitelist (
        id INT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(64) NOT NULL UNIQUE,
        description VARCHAR(255) NULL,
        created_by VARCHAR(32) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ip (ip)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✅ [Migration 011] admin_ip_whitelist 테이블 생성 완료');

    // 3. 기본 화이트리스트 IP 시드 (운영진 기본 IP)
    try {
      await connection.query(`
        INSERT IGNORE INTO admin_ip_whitelist (ip, description, created_by)
        VALUES ('14.49.239.61', '운영진 기본 고정 IP', 'SYSTEM'),
               ('127.0.0.1', '로컬 루프백 IPv4', 'SYSTEM'),
               ('::1', '로컬 루프백 IPv6', 'SYSTEM')
      `);
    } catch (e) {}
  }
};
