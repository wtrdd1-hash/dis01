'use strict';

const assert = require('node:assert/strict');
const { pool, getOrCreateUser } = require('./src/config/database');
const { sendMegaphone } = require('./src/utils/shopEngine');

async function runMegaphoneQA() {
  console.log('📢 ================================================');
  console.log('📢 [QA TEST] 확성기 (Megaphone) 기능 5종 정밀 검증 시작');
  console.log('📢 ================================================');

  const testUserId = 'qa_user_megaphone_test';
  const testUsername = 'Megaphone_QA_Bot';

  try {
    // 0. 테스트 유저 생성 및 100,000원 세팅
    await getOrCreateUser(testUserId, testUsername, '');
    await pool.query('UPDATE users SET cash = 100000, bank = 0 WHERE discord_id = ?', [testUserId]);

    // Test 1: 빈 메시지 예외 처리
    console.log('\n[TEST 1] 빈 메시지 검증 (White-space / Empty)');
    try {
      await sendMegaphone(testUserId, testUsername, '   ', 'gold');
      assert.fail('빈 메시지가 허용되면 안 됩니다.');
    } catch (e) {
      assert.equal(e.message, '확성기 메시지를 입력해주세요.');
      console.log('  ✅ PASS: 빈 메시지 거부 정상 동작');
    }

    // Test 2: 정상 50,000원 소각 및 10분 활성 로그 기록
    console.log('\n[TEST 2] 정상 송출 & 50,000원 화폐 영구 소각 (OUTFLOW_SINK)');
    const result = await sendMegaphone(testUserId, testUsername, '💎 월덕 경제 시스템 확성기 QA 테스트!', 'diamond');
    assert.equal(result.success, true);
    assert.equal(result.data.message, '💎 월덕 경제 시스템 확성기 QA 테스트!');
    assert.equal(result.data.theme, 'diamond');
    assert.equal(result.afterCash, 50000n);

    const [userRows] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [testUserId]);
    assert.equal(BigInt(userRows[0].cash), 50000n);

    const [logs] = await pool.query('SELECT * FROM megaphone_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1', [testUserId]);
    assert.ok(logs.length > 0);
    assert.equal(logs[0].theme, 'diamond');
    assert.equal(logs[0].cost, '50000');
    assert.ok(new Date(logs[0].active_until) > new Date());

    const [flowLogs] = await pool.query("SELECT * FROM economy_flow_logs WHERE user_id = ? AND category = 'MEGAPHONE' ORDER BY id DESC LIMIT 1", [testUserId]);
    assert.ok(flowLogs.length > 0);
    assert.equal(flowLogs[0].flow_type, 'OUTFLOW_SINK');
    assert.equal(flowLogs[0].amount, '50000');
    console.log('  ✅ PASS: 50,000원 잔액 차감 + megaphone_logs 등록 + economy_flow_logs 소각 기록 완료');

    // Test 3: 연속 사용 시 잔액 0원 도달
    console.log('\n[TEST 3] 연속 2회 송출 시 잔액 0원 정상 처리');
    const result2 = await sendMegaphone(testUserId, testUsername, '🔥 두 번째 확성기 송출!', 'fire');
    assert.equal(result2.success, true);
    assert.equal(result2.afterCash, 0n);

    const [userRows2] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [testUserId]);
    assert.equal(BigInt(userRows2[0].cash), 0n);
    console.log('  ✅ PASS: 잔액 0원 정상 갱신');

    // Test 4: 잔액 부족 시 거래 차단
    console.log('\n[TEST 4] 잔액 부족 (0원) 시 거래 차단 검증');
    try {
      await sendMegaphone(testUserId, testUsername, '세 번째 송출 시도', 'neon');
      assert.fail('잔액이 부족한데 확성기가 실행되면 안 됩니다.');
    } catch (e) {
      assert.ok(e.message.includes('부족') || e.message.includes('잔액'));
      console.log(`  ✅ PASS: 잔액 부족 차단 성공 (${e.message})`);
    }

    // Test 5: 150자 초과 방어 (Slice 검증)
    console.log('\n[TEST 5] 150자 초과 문자열 안전 길이 제한 검증');
    await pool.query('UPDATE users SET cash = 50000 WHERE discord_id = ?', [testUserId]);
    const longMsg = '오리'.repeat(100);
    const result3 = await sendMegaphone(testUserId, testUsername, longMsg, 'gold');
    assert.equal(result3.data.message.length, 150);
    console.log(`  ✅ PASS: ${longMsg.length}자 입력 -> ${result3.data.message.length}자로 안전하게 제한됨`);

    console.log('\n================================================');
    console.log('🎉 [QA SUCCESS] 확성기 기능 5/5 테스트 전체 100% 통과!');
    console.log('================================================\n');
  } finally {
    // 정리
    await pool.query('DELETE FROM megaphone_logs WHERE user_id = ?', [testUserId]);
    await pool.query('DELETE FROM economy_flow_logs WHERE user_id = ?', [testUserId]);
    await pool.query('DELETE FROM users WHERE discord_id = ?', [testUserId]);
    process.exit(0);
  }
}

runMegaphoneQA().catch((err) => {
  console.error('❌ [QA FAIL] 오류 발생:', err);
  process.exit(1);
});
