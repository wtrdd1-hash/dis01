'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool, getOrCreateUser } = require('../src/config/database');
const { updateStockPrices } = require('../src/utils/stockEngine');

test('⛏️ [Mining & Stocks QA] 채굴 시스템 및 주식 개별 변동성 정밀 검증', async (t) => {
  try {
    const conn = await pool.getConnection();
    conn.release();
  } catch (e) {
    t.skip('MySQL 데이터베이스 연결 불가로 건너뜁니다.');
    return;
  }

  const testUserId = 'test_mining_qa_user';
  const testUsername = 'Mining_QA_Bot';
  await getOrCreateUser(testUserId, testUsername, '');

  await t.test('1. 채굴 드릴 기본 장비 생성 및 강화 검증', async () => {
    const { getDrillEquipment, enhanceDrill } = require('../src/utils/enhancementEngine');
    const drill = await getDrillEquipment(testUserId);
    assert.ok(drill);
    assert.ok(drill.enhancement_level >= 0);

    await pool.query('UPDATE users SET cash = 100000 WHERE discord_id = ?', [testUserId]);
    const enhanceRes = await enhanceDrill(testUserId, testUsername);
    assert.ok(enhanceRes);
    assert.ok(enhanceRes.success !== undefined);
  });

  await t.test('2. 채굴 클릭 및 보상 획득 검증', async () => {
    const { clickMineGenre } = require('../src/utils/mineService');
    const result = await clickMineGenre(testUserId, testUsername, 'free_dirt', true);
    assert.ok(result);
    assert.ok(result.minedMoney !== undefined);
    assert.ok(BigInt(result.minedMoney) >= 0n);
  });

  await t.test('3. 주식 종목별 개별 변동성 (Idiosyncratic Shock) 검증 - 모든 종목이 동일하게 움직이지 않음', async () => {
    // 2회 가격 업데이트 진행 후 각 종목의 변동률 분포 확인
    await updateStockPrices();
    const [stocks] = await pool.query('SELECT stock_id, change_pct FROM stocks LIMIT 10');
    assert.ok(stocks.length > 1);

    const changeValues = stocks.map(s => Number(s.change_pct));
    const uniqueValues = new Set(changeValues);

    // 종목별로 서로 다른 변동률을 가져야 함 (모두 똑같은 +1.61%가 아님)
    assert.ok(uniqueValues.size > 1, `주식 변동률이 다양해야 합니다. 고유값 개수: ${uniqueValues.size}/${stocks.length}`);
  });

  // 정리
  await pool.query('DELETE FROM users WHERE discord_id = ?', [testUserId]);
});
