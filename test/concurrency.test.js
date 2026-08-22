'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EconomyCore = require('../src/core/economy/EconomyCore');
const { pool, getOrCreateUser } = require('../src/config/database');

test('동시성(Race Condition) 및 트랜잭션 안전성 테스트', async (t) => {
  let dbAvailable = false;
  try {
    const conn = await pool.getConnection();
    conn.release();
    dbAvailable = true;
  } catch (err) {
    console.warn('⚠️ [Test] MySQL 미가동 상태로 동시성 테스트를 건너뜁니다.');
  }

  if (!dbAvailable) {
    t.skip('MySQL 데이터베이스 연결 불가');
    return;
  }

  const userA = 'test_conc_user_a';
  const userB = 'test_conc_user_b';

  await getOrCreateUser(userA, '유저A');
  await getOrCreateUser(userB, '유저B');

  await pool.query('UPDATE users SET cash = 100000, bank = 0 WHERE discord_id = ?', [userA]);
  await pool.query('UPDATE users SET cash = 100000, bank = 0 WHERE discord_id = ?', [userB]);

  await t.test('1. 동시 20회 병렬 송금 시 총 자산 합계 보존 (Double Spend 방지)', async () => {
    const totalBefore = 200000n;
    const transferAmount = 1000n;

    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(EconomyCore.vault.transfer(userA, userB, transferAmount));
      promises.push(EconomyCore.vault.transfer(userB, userA, transferAmount));
    }

    const results = await Promise.allSettled(promises);
    if (results.some(r => r.status === 'rejected')) {
      console.log('REJECTION SAMPLE:', results.find(r => r.status === 'rejected')?.reason);
    }
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    assert.ok(successCount > 0, '최소 1개 이상의 송금이 성공해야 함');

    const balA = await EconomyCore.vault.getUserBalance(userA);
    const balB = await EconomyCore.vault.getUserBalance(userB);

    assert.equal(balA.cash + balB.cash, totalBefore, '동시 송금 후에도 두 유저의 총합 자산은 200,000원으로 완벽히 보존되어야 함');
  });

  await t.test('2. 잔고를 초과하는 동시 다중 차감 시 마이너스 잔고 발생 방지', async () => {
    await pool.query('UPDATE users SET cash = 5000 WHERE discord_id = ?', [userA]);

    const attempts = Array.from({ length: 5 }, () =>
      EconomyCore.vault.applyCashDelta(userA, -3000n, { allowNegative: false })
    );

    const outcomes = await Promise.allSettled(attempts);
    const successes = outcomes.filter(o => o.status === 'fulfilled');
    const failures = outcomes.filter(o => o.status === 'rejected');

    assert.equal(successes.length, 1, '정확히 1회만 차감에 성공해야 함');
    assert.equal(failures.length, 4, '나머지 4회는 잔고 부족으로 안전하게 거절되어야 함');

    const finalBal = await EconomyCore.vault.getUserBalance(userA);
    assert.equal(finalBal.cash, 2000n, '최종 잔고는 2000원이어야 함');
  });
});
