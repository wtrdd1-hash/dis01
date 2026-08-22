'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool, getOrCreateUser } = require('../src/config/database');
const { sendMegaphone } = require('../src/utils/shopEngine');

test('📢 [확성기 QA] 확성기 기능 정밀 검증', async (t) => {
  const testUserId = 'test_megaphone_qa_user';
  const testUsername = 'QA_MegaphoneTester';

  // DB 연결 확인
  try {
    const conn = await pool.getConnection();
    conn.release();
  } catch (e) {
    t.skip('MySQL 데이터베이스 연결 불가로 건너뜁니다.');
    return;
  }

  // 유저 생성 및 초기 잔액 세팅 (100,000원)
  await getOrCreateUser(testUserId, testUsername, '');
  await pool.query('UPDATE users SET cash = 100000, bank = 0 WHERE discord_id = ?', [testUserId]);

  await t.test('1. 빈 메시지는 거부된다', async () => {
    await assert.rejects(
      async () => {
        await sendMegaphone(testUserId, testUsername, '   ', 'gold');
      },
      { message: '확성기 메시지를 입력해주세요.' }
    );
  });

  await t.test('2. 정상 메시지는 50,000원을 소각하고 10분간 활성화된다', async () => {
    const result = await sendMegaphone(testUserId, testUsername, '안녕하세요! 월덕 확성기 테스트입니다.', 'neon');
    assert.equal(result.success, true);
    assert.equal(result.data.message, '안녕하세요! 월덕 확성기 테스트입니다.');
    assert.equal(result.data.theme, 'neon');
    assert.equal(result.afterCash, 50000n);

    // DB 확인
    const [userRows] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [testUserId]);
    assert.equal(BigInt(userRows[0].cash), 50000n);

    const [logs] = await pool.query('SELECT * FROM megaphone_logs WHERE user_id = ? ORDER BY id DESC LIMIT 1', [testUserId]);
    assert.ok(logs.length > 0);
    assert.equal(logs[0].message, '안녕하세요! 월덕 확성기 테스트입니다.');
    assert.equal(logs[0].theme, 'neon');
    assert.equal(logs[0].cost, '50000');
    assert.ok(new Date(logs[0].active_until) > new Date());

    // 경제 소각 플로우 로그 확인
    const [flowLogs] = await pool.query("SELECT * FROM economy_flow_logs WHERE user_id = ? AND category = 'MEGAPHONE' ORDER BY id DESC LIMIT 1", [testUserId]);
    assert.ok(flowLogs.length > 0);
    assert.equal(flowLogs[0].flow_type, 'OUTFLOW_SINK');
    assert.equal(flowLogs[0].amount, '50000');
  });

  await t.test('3. 잔액이 50,000원일 때 1회 더 사용하면 잔액이 0원이 된다', async () => {
    const result = await sendMegaphone(testUserId, testUsername, '두 번째 확성기 메시지!', 'diamond');
    assert.equal(result.success, true);
    assert.equal(result.afterCash, 0n);

    const [userRows] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [testUserId]);
    assert.equal(BigInt(userRows[0].cash), 0n);
  });

  await t.test('4. 잔액이 부족(0원)하면 거부된다', async () => {
    await assert.rejects(
      async () => {
        await sendMegaphone(testUserId, testUsername, '잔액 부족 테스트', 'fire');
      },
      /부족/
    );
  });

  await t.test('5. 150자 초과 메시지는 150자로 안전하게 슬라이스된다', async () => {
    await pool.query('UPDATE users SET cash = 50000 WHERE discord_id = ?', [testUserId]);
    const longMsg = 'A'.repeat(200);
    const result = await sendMegaphone(testUserId, testUsername, longMsg, 'fire');
    assert.equal(result.data.message.length, 150);
  });

  // 테스트 유저 및 데이터 정리
  await pool.query('DELETE FROM megaphone_logs WHERE user_id = ?', [testUserId]);
  await pool.query('DELETE FROM economy_flow_logs WHERE user_id = ?', [testUserId]);
  await pool.query('DELETE FROM users WHERE discord_id = ?', [testUserId]);
});
