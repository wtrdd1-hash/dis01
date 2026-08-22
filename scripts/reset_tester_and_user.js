'use strict';

const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
  const host = process.env.DB_HOST || '127.0.0.1';
  const port = process.env.DB_PORT || 3306;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;

  console.log(`Connecting to DB: ${database}@${host}...`);
  const conn = await mysql.createConnection({ host, port, user, password, database });

  const targetUsers = ['1398148023393058846', '1391566601484107828'];
  const resetUser = '1398148023393058846';

  console.log('\n=== 1. 테스터 칭호 회수 (user_inventory & user_cosmetic_loadout) ===');
  for (const uid of targetUsers) {
    const [invDel] = await conn.query(
      `DELETE FROM user_inventory 
       WHERE user_id = ? 
       AND (item_key LIKE '%tester%' OR item_key LIKE '%테스터%' OR item_name LIKE '%테스터%')`,
      [uid]
    );
    const [loadoutDel] = await conn.query(
      `DELETE FROM user_cosmetic_loadout 
       WHERE user_id = ? 
       AND slot = 'TITLE' 
       AND (item_key LIKE '%tester%' OR item_key LIKE '%테스터%')`,
      [uid]
    );
    console.log(`[User ${uid}] 인벤토리 테스터 칭호 삭제: ${invDel.affectedRows}건, 장착 테스터 칭호 해제: ${loadoutDel.affectedRows}건`);
  }

  console.log(`\n=== 2. 유저 ${resetUser} 프로필 초기화 (다음 로그인 시 최신 디스코드 정보로 갱신) ===`);
  const [userReset] = await conn.query(
    `UPDATE users 
     SET username = '사용자', 
         avatar = 'https://cdn.discordapp.com/embed/avatars/0.png'
     WHERE discord_id = ?`,
    [resetUser]
  );
  console.log(`[User ${resetUser}] 프로필 초기화 완료: ${userReset.affectedRows}건`);

  // 현재 유저 정보 확인
  const [check] = await conn.query(
    'SELECT discord_id, username, avatar, cash, bank FROM users WHERE discord_id IN (?, ?)',
    targetUsers
  );
  console.log('\n=== 3. 현재 DB 유저 상태 ===');
  console.table(check);

  await conn.end();
  console.log('\n✅ 모든 작업 완료!');
}

main().catch(err => {
  console.error('❌ 에러 발생:', err);
  process.exit(1);
});
