'use strict';

/**
 * Migration 006: 사이트 공지사항 및 팝업 모달 시스템
 */
module.exports = {
  version: 6,
  name: '006_site_announcements',
  async up(connection) {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS site_announcements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        type VARCHAR(32) NOT NULL DEFAULT 'GENERAL',
        is_popup TINYINT(1) NOT NULL DEFAULT 1,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        author VARCHAR(64) DEFAULT 'ADMIN',
        starts_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ends_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_active_popup (is_active, is_popup)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 기본 환영 공지 등록 (예시)
    await connection.query(`
      INSERT INTO site_announcements (title, content, type, is_popup, is_active, author)
      VALUES (
        '🎉 월덕 가상 경제 2.0 & 명품 상점 정식 오픈 안내',
        '안녕하세요, 월덕 커뮤니티 여러분!\n\n가상 경제 2.0 대개편과 함께 새로운 명품 상점, 주간 6/45 메가 로또, 드릴 대장간 강화 시스템이 오픈되었습니다.\n\n건전하고 재미있는 커뮤니티 활동을 즐겨보세요!',
        'IMPORTANT',
        1,
        1,
        '운영진'
      );
    `);

    console.log('✅ [Migration 006] 사이트 공지사항 및 팝업 테이블 생성 완료');
  },
  async down(connection) {
    await connection.query('DROP TABLE IF EXISTS site_announcements');
  }
};
