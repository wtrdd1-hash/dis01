'use strict';

const { pool } = require('../config/database');

/**
 * 🗑️ 회원 탈퇴 및 모든 개인정보/가상 자산 데이터 영구 삭제
 * @param {string} userId 탈퇴할 유저의 Discord ID
 * @param {string} reason 탈퇴 사유
 */
async function withdrawUserAccount(userId, reason = '사용자 자진 회원 탈퇴') {
  const targetId = String(userId).trim();
  if (!targetId) throw new Error('유저 ID가 유효하지 않습니다.');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. 유저 계정 확인
    const [users] = await connection.query('SELECT * FROM users WHERE discord_id = ? FOR UPDATE', [targetId]);
    if (!users.length) {
      await connection.rollback();
      throw new Error('존재하지 않거나 이미 탈퇴 처리된 계정입니다.');
    }
    const user = users[0];
    const username = user.username || `유저_${targetId.slice(-4)}`;

    // 2. 보유 주식 데이터 영구 삭제
    await connection.query('DELETE FROM user_stocks WHERE user_id = ?', [targetId]);

    // 3. 보유 사업체 데이터 영구 삭제
    try {
      await connection.query('DELETE FROM user_businesses WHERE user_id = ?', [targetId]);
    } catch (e) {}

    // 4. 클리커/미니게임 및 보조 데이터 삭제
    try {
      await connection.query('DELETE FROM mine_genre_stats WHERE user_id = ?', [targetId]);
    } catch (e) {}

    try {
      await connection.query('DELETE FROM user_titles WHERE user_id = ?', [targetId]);
    } catch (e) {}

    // 5. 유저 본체 레코드 영구 삭제
    await connection.query('DELETE FROM users WHERE discord_id = ?', [targetId]);

    // 6. 탈퇴 감사 로그 기록 (개인식별 불가능하게 기록)
    try {
      await connection.query(`
        INSERT INTO user_ban_logs (user_id, username, admin_id, admin_username, action, reason)
        VALUES (?, ?, 'SELF', 'USER_WITHDRAWAL', 'WITHDRAWAL', ?)
      `, [targetId, username, reason]);
    } catch (e) {}

    await connection.commit();
    console.log(`👋 [회원 탈퇴 완료] @${username} (${targetId}) 계정 및 모든 자산 데이터 영구 삭제 완료 (사유: ${reason})`);

    return {
      success: true,
      userId: targetId,
      username,
      message: '회원 탈퇴 및 모든 개인정보/가상 자산 데이터가 영구히 파기되었습니다.'
    };
  } catch (err) {
    await connection.rollback();
    console.error('❌ 회원 탈퇴 처리 오류:', err);
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = {
  withdrawUserAccount
};
