'use strict';

const { pool } = require('./src/config/database');

async function migrateSeason2() {
  console.log('🚀 [Season 2 Migration] DB 초기화 및 칭호 하사 작업 시작...');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. QA 테스트 계정 삭제
    console.log('1. QA 테스트 계정 삭제 중...');
    const [delRes] = await conn.query(`
      DELETE FROM users 
      WHERE username LIKE '%qa%' 
         OR username LIKE '%QA%' 
         OR username LIKE '%test%' 
         OR discord_id LIKE 'qa_%'
    `);
    console.log(`   - 삭제된 QA 계정 수: ${delRes.affectedRows}명`);

    // 2. 전체 유저 경제 정보 초기화 (시즌 2 시작)
    console.log('2. 유저 경제 정보 초기화 중 (Cash/Bank = 0)...');
    await conn.query('UPDATE users SET cash = 0, bank = 0');

    // 3. 기존 경제 거래 내역 및 주식/대출/로또 초기화
    console.log('3. 주식/원장/대출/로또 테이블 리셋 중...');
    const tablesToClear = [
      'user_stocks',
      'economy_logs',
      'lotto_tickets',
      'loan_records',
      'user_inventory',
      'user_cosmetic_loadout'
    ];

    for (const t of tablesToClear) {
      try {
        await conn.query(`DELETE FROM ${t}`);
      } catch (e) {
        console.log(`   (테이블 ${t} 정리 건너뜀: ${e.message})`);
      }
    }

    // 4. 칭호 아이템 등록 (카탈로그)
    console.log('4. 칭호 카탈로그 등록 중 (테스터 / 버거 / 버그악용자 / 내꼬리 / 인내심왕)...');
    await conn.query(`
      INSERT INTO economy_catalog_items 
        (item_key, item_type, name, description, price, duration_seconds, rarity, rotation_group, icon, preview_css)
      VALUES 
        ('title_season1_tester', 'TITLE', '🧪 테스터', '월덕 경제 시스템 초기 테스트에 참여한 선구자 칭호입니다.', 0, 0, 'SPECIAL', 'ALWAYS', '🧪', 'background: linear-gradient(135deg, #38bdf8, #818cf8); color: #fff; padding: 2px 8px; border-radius: 6px; font-weight: 800; font-size: 11px; border: 1px solid rgba(56,189,248,0.5);'),
        ('title_burger', 'TITLE', '🍔 버거', '특별 하사된 전설의 버거 칭호입니다.', 0, 0, 'LEGENDARY', 'ALWAYS', '🍔', 'background: linear-gradient(135deg, #d97706, #b45309); color: #fff; font-weight: 900; padding: 2px 8px; border-radius: 6px; font-size: 11px; box-shadow: 0 0 10px rgba(217,119,6,0.6);'),
        ('title_bug_abuser', 'TITLE', '🐛 버그악용자', '특별 수여된 버그악용자 칭호입니다.', 0, 0, 'EPIC', 'ALWAYS', '🐛', 'background: linear-gradient(135deg, #ef4444, #dc2626); color: #fff; font-weight: 900; padding: 2px 8px; border-radius: 6px; font-size: 11px; box-shadow: 0 0 10px rgba(239,68,68,0.6);'),
        ('title_naekkori', 'TITLE', '🦊 내꼬리', '특별 하사된 고귀한 내꼬리 칭호입니다.', 0, 0, 'LEGENDARY', 'ALWAYS', '🦊', 'background: linear-gradient(135deg, #f97316, #ea580c); color: #fff; font-weight: 900; padding: 2px 8px; border-radius: 6px; font-size: 11px; box-shadow: 0 0 10px rgba(249,115,22,0.6);'),
        ('title_patience_king', 'TITLE', '👑 인내심왕', '경이로운 인내의 미덕을 지닌 자에게 하사된 영예로운 칭호입니다.', 0, 0, 'LEGENDARY', 'ALWAYS', '👑', 'background: linear-gradient(135deg, #a855f7, #6366f1); color: #fff; font-weight: 900; padding: 2px 8px; border-radius: 6px; font-size: 11px; box-shadow: 0 0 10px rgba(168,85,247,0.6);')
      ON DUPLICATE KEY UPDATE 
        name=VALUES(name), description=VALUES(description), preview_css=VALUES(preview_css), icon=VALUES(icon)
    `);

    // 5. 지정 유저 확인 및 남은 모든 유저 조회 & 칭호 지급
    await conn.query(`
      INSERT INTO users (discord_id, username, cash, bank)
      VALUES ('270537117673717760', '내꼬리', 0, 0)
      ON DUPLICATE KEY UPDATE username = VALUES(username)
    `);

    const [remainingUsers] = await conn.query('SELECT discord_id, username FROM users');
    console.log(`5. 총 ${remainingUsers.length}명의 유저에게 칭호 지급 및 장착 중...`);

    const BURGER_USER_ID = '1481258930909872239';
    const NAEKKORI_USER_ID = '270537117673717760';
    const PATIENCE_KING_USER_ID = '1233844690487345153';

    for (const u of remainingUsers) {
      const uid = String(u.discord_id);

      if (uid === BURGER_USER_ID) {
        // 버거 & 버그악용자 칭호 2종 모두 지급, 기본 장착: 버거
        const [inv1] = await conn.query(`
          INSERT INTO user_inventory (user_id, item_key, item_type, item_name, is_active)
          VALUES (?, 'title_burger', 'TITLE', '🍔 버거', 1)
        `, [uid]);
        await conn.query(`
          INSERT INTO user_inventory (user_id, item_key, item_type, item_name, is_active)
          VALUES (?, 'title_bug_abuser', 'TITLE', '🐛 버그악용자', 1)
        `, [uid]);

        await conn.query(`
          INSERT INTO user_cosmetic_loadout (user_id, slot, inventory_id, item_key)
          VALUES (?, 'TITLE', ?, 'title_burger')
          ON DUPLICATE KEY UPDATE inventory_id = VALUES(inventory_id), item_key = VALUES(item_key)
        `, [uid, inv1.insertId]);

        console.log(`   - [${uid}] ${u.username} -> 칭호 [🍔 버거, 🐛 버그악용자] 지급 (기본 장착: 🍔 버거)`);
      } else if (uid === NAEKKORI_USER_ID) {
        // 내꼬리 칭호 지급 및 장착
        const [invRes] = await conn.query(`
          INSERT INTO user_inventory (user_id, item_key, item_type, item_name, is_active)
          VALUES (?, 'title_naekkori', 'TITLE', '🦊 내꼬리', 1)
        `, [uid]);

        await conn.query(`
          INSERT INTO user_cosmetic_loadout (user_id, slot, inventory_id, item_key)
          VALUES (?, 'TITLE', ?, 'title_naekkori')
          ON DUPLICATE KEY UPDATE inventory_id = VALUES(inventory_id), item_key = VALUES(item_key)
        `, [uid, invRes.insertId]);

        console.log(`   - [${uid}] ${u.username} -> 칭호 [🦊 내꼬리] 지급 및 장착 완료!`);
      } else if (uid === PATIENCE_KING_USER_ID) {
        // 인내심왕 칭호 지급 및 장착
        const [invRes] = await conn.query(`
          INSERT INTO user_inventory (user_id, item_key, item_type, item_name, is_active)
          VALUES (?, 'title_patience_king', 'TITLE', '👑 인내심왕', 1)
        `, [uid]);

        await conn.query(`
          INSERT INTO user_cosmetic_loadout (user_id, slot, inventory_id, item_key)
          VALUES (?, 'TITLE', ?, 'title_patience_king')
          ON DUPLICATE KEY UPDATE inventory_id = VALUES(inventory_id), item_key = VALUES(item_key)
        `, [uid, invRes.insertId]);

        console.log(`   - [${uid}] ${u.username} -> 칭호 [👑 인내심왕] 지급 및 장착 완료!`);
      } else {
        // 기본 테스터 칭호 지급 및 장착
        const [invRes] = await conn.query(`
          INSERT INTO user_inventory (user_id, item_key, item_type, item_name, is_active)
          VALUES (?, 'title_season1_tester', 'TITLE', '🧪 테스터', 1)
        `, [uid]);

        await conn.query(`
          INSERT INTO user_cosmetic_loadout (user_id, slot, inventory_id, item_key)
          VALUES (?, 'TITLE', ?, 'title_season1_tester')
          ON DUPLICATE KEY UPDATE inventory_id = VALUES(inventory_id), item_key = VALUES(item_key)
        `, [uid, invRes.insertId]);

        console.log(`   - [${uid}] ${u.username} -> 칭호 [🧪 테스터] 장착 완료!`);
      }
    }

    await conn.commit();
    console.log('✅ [Season 2 Migration] 모든 유저 데이터 리셋 및 칭호 하사 완료!');
  } catch (err) {
    await conn.rollback();
    console.error('❌ [Season 2 Migration] 오류 발생, 롤백됨:', err);
    throw err;
  } finally {
    conn.release();
  }
}

if (require.main === module) {
  migrateSeason2()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = migrateSeason2;
