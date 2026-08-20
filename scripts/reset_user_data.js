/**
 * 🧹 [전체 유저 데이터 초기화 스크립트]
 *
 * 관리자 계정은 완전히 보존되며, 일반 유저의 모든 경제 데이터를 초기화합니다.
 *
 * - users: cash → 10000원, bank → 0, 클릭/오토채굴/주식잔액/사업/대출/조회시각 등 모두 리셋
 * - user_stocks: 전량 0 (또는 행 삭제)
 * - gambling_logs: 일반 유저 분 삭제
 * - stock_transactions: 일반 유저 분 삭제
 * - economy_logs: 일반 유저 분 삭제
 * - blackjack/poker/seven_poker_sessions: 일반 유저 세션 종료(삭제)
 * - inquiries: 일반 유저 문의는 유지(고객기록 보존)
 * - chat_messages: 유지(커뮤니티 기록 보존)
 * - command_logs: 일반 유저 분 삭제
 * - web_access_logs: 일반 유저 분 삭제
 *
 * 주식 가격/국면/뉴스/배당/허용 한도 등은 별개로 유지됩니다.
 * - 필요 시 normalize_stock_market.js / reset_jackpot.js 등을 추가 실행하세요.
 */
const { pool } = require('../src/config/database');
const config = require('../src/config/config');

async function resetAllUsers() {
  console.log('🧹 [전체 유저 데이터 초기화] 시작...');
  console.log('⚠️  관리자 계정은 완전히 보존됩니다.');

  let adminIds = [];
  try {
    adminIds = (config.adminIds || []).map(String);
  } catch (e) {
    adminIds = [];
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 대상 유저(일반 유저) 목록 조회
    const adminParams = adminIds.length > 0 ? adminIds : ['__no_admin__'];
    const adminPlaceholders = adminIds.length > 0
      ? adminIds.map(() => '?').join(',')
      : '?';

    const [targetUsers] = await conn.query(
      `SELECT discord_id, username, cash, bank FROM users WHERE discord_id NOT IN (${adminPlaceholders})`,
      adminParams
    );
    console.log(`👥 대상 일반 유저: ${targetUsers.length}명 (관리자 ${adminIds.length}명은 보존)`);

    if (targetUsers.length === 0) {
      console.log('ℹ️  초기화할 일반 유저가 없습니다. 종료합니다.');
      await conn.commit();
      return;
    }

    const totalBeforeCash = targetUsers.reduce((a, u) => a + BigInt(u.cash || 0), 0n);
    const totalBeforeBank = targetUsers.reduce((a, u) => a + BigInt(u.bank || 0), 0n);

    // 1. users 테이블: 현금 10000, 은행 0, 레벨/스트릭/쿨다운/마지막시각 등 모두 초기화
    // 단, discord_id / username / avatar / github_* / discord 계정 식별 정보는 보존
    // 쿨다운 시각은 NULL로 두어 신규 유저처럼 즉시 사용 가능하게 함
    await conn.query(`
      UPDATE users
      SET
        cash = 10000,
        bank = 0,
        clicker_level = 1,
        auto_miner_level = 0,
        total_clicks = 0,
        daily_streak = 0,
        last_daily = NULL,
        last_work = NULL,
        last_subsidy = NULL,
        gamble_turns = 50,
        last_turn_update = NOW(),
        mine_genre = 'classic',
        is_banned = 0,
        banned_until = NULL,
        ban_reason = NULL,
        banned_at = NULL,
        banned_by = NULL
      WHERE discord_id NOT IN (${adminPlaceholders})
    `, adminParams);
    console.log('✅ users 테이블: 현금 10,000원 / 은행 0 / 쿨다운 초기화 완료');

    // 2. user_stocks: 일반 유저의 보유 주식 0 (행 삭제)
    await conn.query(
      `DELETE FROM user_stocks
       WHERE user_id NOT IN (${adminPlaceholders})`,
      adminParams
    );
    console.log('✅ user_stocks 테이블: 일반 유저 보유 주식 행 모두 삭제');

    // 3. user_businesses: 일반 유저의 사업 정보 모두 삭제
    await conn.query(
      `DELETE FROM user_businesses
       WHERE user_id NOT IN (${adminPlaceholders})`,
      adminParams
    );
    await conn.query(
      `DELETE FROM user_business_meta
       WHERE user_id NOT IN (${adminPlaceholders})`,
      adminParams
    );
    console.log('✅ user_businesses / user_business_meta 테이블: 일반 유저 사업 데이터 삭제');

    // 4. user_loan_credit: 일반 유저 대출 신용정보 초기화
    await conn.query(
      `DELETE FROM user_loan_credit
       WHERE user_id NOT IN (${adminPlaceholders})`,
      adminParams
    );
    console.log('✅ user_loan_credit: 일반 유저 대출 신용정보 삭제');

    // 5. bank_loans: 일반 유저 대출은 기록 보존을 위해 origin 컬럼이 있다면 표시, 없으면 그대로 삭제
    try {
      await conn.query(
        `DELETE FROM bank_loans
         WHERE user_id NOT IN (${adminPlaceholders})
           AND status IN ('PAID','DEFAULTED','CANCELLED')`,
        adminParams
      );
      // 미상환 대출은 'INIT_RESET' 표시로 보존
      await conn.query(
        `UPDATE bank_loans
         SET status = 'INIT_RESET'
         WHERE user_id NOT IN (${adminPlaceholders})
           AND status IN ('PENDING','ACTIVE','OVERDUE')`,
        adminParams
      );
    } catch (e) {
      // 컬럼이 없을 수 있으므로 시도 후 무시
    }
    console.log('✅ bank_loans: 일반 유저 대출 정리 (미상환은 INIT_RESET 마킹)');

    // 6. blackjack / poker / seven_poker_sessions: 일반 유저 세션 삭제
    await conn.query(
      `DELETE FROM blackjack_sessions WHERE user_id NOT IN (${adminPlaceholders})`,
      adminParams
    );
    await conn.query(
      `DELETE FROM poker_sessions WHERE user_id NOT IN (${adminPlaceholders})`,
      adminParams
    );
    await conn.query(
      `DELETE FROM seven_poker_sessions WHERE user_id NOT IN (${adminPlaceholders})`,
      adminParams
    );
    console.log('✅ 카지노/포커 세션 테이블: 일반 유저 세션 모두 삭제');

    // 7. user_casino: 일반 유저 미션/통계 초기화
    try {
      await conn.query(
        `DELETE FROM user_casino WHERE user_id NOT IN (${adminPlaceholders})`,
        adminParams
      );
    } catch (e) {}
    console.log('✅ user_casino: 일반 유저 미션 데이터 초기화');

    // 8. 로그성 데이터: 일반 유저 분 삭제 (감사 추적 최소화, 단 chat 메시지는 유지)
    const deletedLogs = {
      gambling: 0,
      stock_tx: 0,
      economy: 0,
      commands: 0,
      web_access: 0,
      security: 0,
      admin_logs: 0,
      user_ban_logs: 0
    };

    const [r1] = await conn.query(
      `DELETE FROM gambling_logs WHERE user_id NOT IN (${adminPlaceholders})`, adminParams
    ); deletedLogs.gambling = r1.affectedRows;

    const [r2] = await conn.query(
      `DELETE FROM stock_transactions WHERE user_id NOT IN (${adminPlaceholders})`, adminParams
    ); deletedLogs.stock_tx = r2.affectedRows;

    const [r3] = await conn.query(
      `DELETE FROM economy_logs WHERE user_id NOT IN (${adminPlaceholders})`, adminParams
    ); deletedLogs.economy = r3.affectedRows;

    try {
      const [r4] = await conn.query(
        `DELETE FROM command_logs WHERE user_id NOT IN (${adminPlaceholders})`, adminParams
      ); deletedLogs.commands = r4.affectedRows;
    } catch (e) {}

    try {
      const [r5] = await conn.query(
        `DELETE FROM web_access_logs WHERE user_id NOT IN (${adminPlaceholders})`, adminParams
      ); deletedLogs.web_access = r5.affectedRows;
    } catch (e) {}

    try {
      const [r6] = await conn.query(
        `DELETE FROM security_events WHERE 1=0`, []
      );
    } catch (e) {}

    try {
      const [r7] = await conn.query(
        `DELETE FROM admin_logs WHERE target_user_id NOT IN (${adminPlaceholders}) AND target_user_id IS NOT NULL`, adminParams
      ); deletedLogs.admin_logs = r7.affectedRows;
    } catch (e) {}

    console.log('✅ 일반 유저 로그 삭제:', JSON.stringify(deletedLogs, null, 2));

    // 9. 채팅/문의는 보존 (커뮤니티 기록)
    // inquiries: 보존 (고객 기록)
    // chat_messages: 보존

    // 10. treasury 잔액을 0으로 리셋 (국고도 초기화)
    try {
      await conn.query(
        `INSERT INTO economy_settings (key_name, value)
         VALUES ('taxTreasury', '0')
         ON DUPLICATE KEY UPDATE value = '0'`
      );
      console.log('✅ 국고(taxTreasury) 잔액을 0으로 리셋');
    } catch (e) {}

    await conn.commit();
    console.log('');
    console.log('🎉 [전체 유저 데이터 초기화] 완료!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📊 처리 결과 요약:`);
    console.log(`  • 일반 유저 ${targetUsers.length}명의 경제 데이터를 초기화했습니다.`);
    console.log(`  • 초기화 전 총 유동자산: ${totalBeforeCash.toLocaleString()}원 (현금) + ${totalBeforeBank.toLocaleString()}원 (예금)`);
    console.log(`  • 초기화 후: 모든 일반 유저 10,000원 / 0원 (예금 0) / 주식 0주 / 사업 0 / 미션 초기화`);
    console.log(`  • 관리자 ${adminIds.length}명의 데이터는 완전히 보존되었습니다.`);
    console.log(`  • 채팅 메시지 및 고객 문의(inquiries)는 보존되었습니다.`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('❌ 초기화 중 오류 발생 (롤백됨):', err);
    process.exitCode = 1;
  } finally {
    conn.release();
    process.exit(process.exitCode || 0);
  }
}

resetAllUsers();
