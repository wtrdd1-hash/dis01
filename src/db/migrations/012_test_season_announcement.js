'use strict';

/**
 * Migration 012: 테스트 시즌 오픈 공지사항 자동 등록
 */
module.exports = {
  version: 12,
  name: '012_test_season_announcement',
  async up(connection) {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS site_announcements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(100) NOT NULL,
        content TEXT NOT NULL,
        type ENUM('NOTICE', 'EVENT', 'UPDATE', 'MAINTENANCE') DEFAULT 'NOTICE',
        is_popup TINYINT(1) DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        author VARCHAR(64) DEFAULT '관리자',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ann_active_popup (is_active, is_popup, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 기존 활성 팝업 정리 후 새 테스트 시즌 공지 삽입
    const [existing] = await connection.query(
      "SELECT id FROM site_announcements WHERE title LIKE '%테스트 시즌%' LIMIT 1"
    );
    if (!existing || existing.length === 0) {
      await connection.query(`
        INSERT INTO site_announcements (title, content, type, is_popup, is_active, author)
        VALUES (
          '✨ [시즌 안내] 월덕 가상 경제 테스트 시즌 오픈!',
          '현재 월덕 가상 경제는 테스트 시즌입니다. 주식 거래소, 카지노 허브, 채굴 광산, 명품 상점 및 VIP 메타버스 광장을 자유롭게 즐겨보세요! 오류나 불편한 점은 언제든 제보해 주시기 바랍니다.',
          'UPDATE',
          1,
          1,
          '운영진'
        )
      `);
    }
  },
  async down(connection) {
    await connection.query("DELETE FROM site_announcements WHERE title LIKE '%테스트 시즌%'");
  }
};
