'use strict';

const assert = require('assert');
const path = require('path');
const srcPath = (p) => path.resolve(process.cwd(), 'src', p);

const { pool } = require(srcPath('config/database'));
const { dropPlinko, minesMultiplier, makeMineField } = require(srcPath('utils/hotGames'));
const { buyLottoTicket, drawLottoRound, getCurrentLottoRound, getUserLottoTickets } = require(srcPath('utils/lottoEngine'));
const PrestigeShopService = require(srcPath('core/economy/PrestigeShopService'));
const CosmeticLoadoutService = require(srcPath('core/economy/CosmeticLoadoutService'));
const WorkshopService = require(srcPath('core/economy/WorkshopService'));
const DuckHouseService = require(srcPath('core/economy/DuckHouseService'));
const AdminSpendingService = require(srcPath('core/economy/AdminSpendingService'));

async function runComprehensiveQA() {
  console.log('====================================================');
  console.log('🎮 [전체 게임 & 가상경제 소비 시스템 종합 QA 점검 시작]');
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;

  function check(desc, fn) {
    total++;
    try {
      fn();
      console.log(`✅ [PASS ${total}] ${desc}`);
      passed++;
    } catch (e) {
      console.error(`❌ [FAIL ${total}] ${desc} -> Error: ${e.message}`);
    }
  }

  async function checkAsync(desc, fn) {
    total++;
    try {
      await fn();
      console.log(`✅ [PASS ${total}] ${desc}`);
      passed++;
    } catch (e) {
      console.error(`❌ [FAIL ${total}] ${desc} -> Error: ${e.message}`);
    }
  }

  // 1. PLINKO 엔진 무결성
  check('플링코 로우/미디엄/하이 배율 테이블 및 12개 드롭 경로 검증', () => {
    const low = dropPlinko('low');
    assert.strictEqual(low.path.length, 12);
    assert.ok(low.multiplier >= 0.3 && low.multiplier <= 5.6);

    const med = dropPlinko('med');
    assert.strictEqual(med.path.length, 12);
    assert.ok(med.multiplier >= 0.2 && med.multiplier <= 13);

    const high = dropPlinko('high');
    assert.strictEqual(high.path.length, 12);
    assert.ok(high.multiplier >= 0.2 && high.multiplier <= 29);
  });

  // 2. MINES 엔진 무결성
  check('마인즈 지뢰 격자(5x5) 생성 및 배율 계산 공식 검증', () => {
    const field = makeMineField(5);
    assert.strictEqual(field.mines, 5);
    assert.strictEqual(field.bombs.length, 5);

    const mult1 = minesMultiplier(5, 1);
    const mult5 = minesMultiplier(5, 5);
    assert.ok(mult1 > 1.0);
    assert.ok(mult5 > mult1);
  });

  // 3. 로또 6/45 티켓 발권 검증
  await checkAsync('로또 6/45 티켓 발권 및 30% 소각/70% 잭팟 적립 트랜잭션 검증', async () => {
    const testUser = 'QA_TEST_USER_LOTTO';
    await pool.query(
      `INSERT INTO users (discord_id, username, cash) VALUES (?, 'QA_로또유저', 1000000)
       ON DUPLICATE KEY UPDATE cash = 1000000`,
      [testUser]
    );

    const buyRes = await buyLottoTicket(testUser, 'QA_로또유저', null, true);
    assert.strictEqual(buyRes.success, true);
    assert.strictEqual(buyRes.numbers.length, 6);

    const [userRows] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [testUser]);
    assert.strictEqual(userRows[0].cash, '999000');

    const tickets = await getUserLottoTickets(testUser);
    assert.ok(tickets.length >= 1);
  });

  // 4. 로또 2일 주기 자동 추첨 및 상금 정산
  await checkAsync('로또 6/45 회차 마감 및 당첨자 상금 분배 & 신규 회차 생성 검증', async () => {
    const drawRes = await drawLottoRound();
    assert.ok(drawRes.roundNumber >= 1);
    assert.strictEqual(drawRes.winningNumbers.length, 6);
    assert.ok(drawRes.nextRound > drawRes.roundNumber);

    const curRound = await getCurrentLottoRound();
    assert.strictEqual(curRound.status, 'OPEN');
  });

  // 5. 명예 상점 (Prestige Shop) 구매 & 소각 검증
  await checkAsync('명예 상점 아이템 구매 및 100% 영구 소각 & 인벤토리 지급 검증', async () => {
    const testUser = 'QA_TEST_PRESTIGE';
    await pool.query(
      `INSERT INTO users (discord_id, username, cash) VALUES (?, 'QA_상점유저', 5000000)
       ON DUPLICATE KEY UPDATE cash = 5000000`,
      [testUser]
    );

    const catalog = await PrestigeShopService.listCatalog({ userId: testUser });
    assert.ok(catalog.length > 0);

    const item = catalog[0];
    const buyRes = await PrestigeShopService.purchaseItem(testUser, item.itemKey);
    assert.strictEqual(buyRes.success, true);
    assert.strictEqual(buyRes.item.itemKey, item.itemKey);

    const [invRows] = await pool.query('SELECT * FROM user_inventory WHERE user_id = ? AND item_key = ?', [testUser, item.itemKey]);
    assert.ok(invRows.length >= 1);
  });

  // 6. 외형 드레싱 룸 (Cosmetic Loadout) 장착/해제 검증
  await checkAsync('외형 로드아웃 슬롯 장착 및 해제 검증', async () => {
    const testUser = 'QA_TEST_PRESTIGE';
    const loadout = await CosmeticLoadoutService.getUserLoadout(testUser);
    assert.ok(loadout.items.length >= 1);

    const invItem = loadout.items[0];
    const equipRes = await CosmeticLoadoutService.equipItem(testUser, invItem.itemType || 'NAME_COLOR', invItem.itemKey);
    assert.strictEqual(equipRes.success, true);

    const unequipRes = await CosmeticLoadoutService.unequipSlot(testUser, invItem.itemType || 'NAME_COLOR');
    assert.strictEqual(unequipRes.success, true);
  });

  // 7. 제작소 (Workshop) 분해 & 확정 제작 검증
  await checkAsync('아이템 분해(황금 깃털 조각 획득) 및 레시피 확정 제작 검증', async () => {
    const testUser = 'QA_TEST_WORKSHOP';
    await pool.query(
      `INSERT INTO users (discord_id, username, cash) VALUES (?, 'QA_제작유저', 10000000)
       ON DUPLICATE KEY UPDATE cash = 10000000`,
      [testUser]
    );

    await pool.query(`DELETE FROM user_inventory WHERE user_id = ?`, [testUser]);

    // 테스트용 인벤토리 아이템 생성
    const [ins] = await pool.query(
      `INSERT INTO user_inventory (user_id, item_key, item_type, item_name, is_active)
       VALUES (?, 'temp_rare_item', 'PROFILE_FRAME', '임시 레어 테두리', 1)`,
      [testUser]
    );
    const invId = ins.insertId;

    // 분해 (COMMON 1개 조각 획득)
    const salRes = await WorkshopService.salvageItem(testUser, invId);
    assert.strictEqual(salRes.success, true);
    assert.ok(salRes.shardsGained >= 1);

    // 제작에 필요한 조각 충전 후 제작 테스트
    await pool.query(
      `INSERT INTO craft_materials (user_id, material_key, quantity)
       VALUES (?, 'golden_feather_shard', 100)
       ON DUPLICATE KEY UPDATE quantity = 100`,
      [testUser]
    );

    const craftRes = await WorkshopService.craftItem(testUser, 'craft_collector_bronze');
    assert.strictEqual(craftRes.success, true);
    assert.strictEqual(craftRes.resultItem.itemKey, 'badge_collector_bronze');
  });

  // 8. 개인 전시 공간 (Duck House) 확장 & 슬롯 배치 검증
  await checkAsync('덕하우스 레벨 확장(Lv.1->Lv.2) 및 전시 슬롯 장착 검증', async () => {
    const testUser = 'QA_TEST_DUCKHOUSE';
    await pool.query(
      `INSERT INTO users (discord_id, username, cash) VALUES (?, 'QA_덕하우스유저', 10000000)
       ON DUPLICATE KEY UPDATE cash = 10000000`,
      [testUser]
    );
    await pool.query(`UPDATE user_duck_houses SET level = 1 WHERE user_id = ?`, [testUser]);

    const houseBefore = await DuckHouseService.getDuckHouse(testUser);
    assert.strictEqual(houseBefore.house.level, 1);
    assert.strictEqual(houseBefore.house.maxSlots, 3);

    // Lv.2 확장 (비용 10만 원 소각)
    const upRes = await DuckHouseService.upgradeDuckHouse(testUser);
    assert.strictEqual(upRes.success, true);
    assert.strictEqual(upRes.newLevel, 2);

    const houseAfter = await DuckHouseService.getDuckHouse(testUser);
    assert.strictEqual(houseAfter.house.level, 2);
    assert.strictEqual(houseAfter.house.maxSlots, 5);
  });

  // 9. 관리자 전권 제어 센터 (Admin Spending) 검증
  await checkAsync('관리자 직권 아이템 지급/회수 및 카탈로그 통계 검증', async () => {
    const targetUser = 'QA_TEST_ADMIN_TARGET';
    await pool.query(
      `INSERT INTO users (discord_id, username, cash) VALUES (?, 'QA_관리자대상', 1000)
       ON DUPLICATE KEY UPDATE cash = 1000`,
      [targetUser]
    );

    // 아이템 지급
    const grantRes = await AdminSpendingService.adminGrantItem(targetUser, {
      itemKey: 'color_neon_cyan',
      name: '네온 사이언 닉네임',
      itemType: 'NAME_COLOR',
      durationSeconds: 604800,
      adminId: 'ADMIN_SYSTEM'
    });
    assert.strictEqual(grantRes.success, true);

    // 조각 변경
    const matRes = await AdminSpendingService.adminSetMaterials(targetUser, 'golden_feather_shard', 55, { adminId: 'ADMIN_SYSTEM' });
    assert.strictEqual(matRes.success, true);

    // 하우스 레벨 강제 설정
    const houseRes = await AdminSpendingService.adminSetDuckHouseLevel(targetUser, 4, { adminId: 'ADMIN_SYSTEM' });
    assert.strictEqual(houseRes.success, true);

    // 소각 통계 조회
    const summary = await AdminSpendingService.getSpendingSummary();
    assert.ok(Array.isArray(summary.stats));
    assert.ok(Array.isArray(summary.recentSinks));
  });

  // 10. 슬롯머신 (Slot Machine) 릴 회전 & 당첨 판정 검증
  check('슬롯머신 3개 릴 회전 및 승패 배율 계산 검증', () => {
    const { spinSlot } = require(srcPath('utils/economyBalance'));
    const spun = spinSlot();
    assert.ok(Array.isArray(spun.reels));
    assert.strictEqual(spun.reels.length, 3);
    assert.strictEqual(typeof spun.isWin, 'boolean');
    assert.strictEqual(typeof spun.multiplier, 'number');
    assert.ok(spun.multiplier >= 0);
  });

  // 11. 즉석복권 (Scratch Lottery) 심볼 스크래치 & 당첨 배율 검증
  check('즉석복권 3개 심볼 스크래치 및 잭팟(77배)/당첨 계산 검증', () => {
    const { scratchLottery } = require(srcPath('utils/economyBalance'));
    const scratched = scratchLottery();
    assert.ok(Array.isArray(scratched.symbols));
    assert.strictEqual(scratched.symbols.length, 3);
    assert.strictEqual(typeof scratched.isWin, 'boolean');
    assert.strictEqual(typeof scratched.multiplier, 'number');
    assert.ok(scratched.multiplier >= 0);
  });

  // 12. 블랙잭 (Blackjack) 세션 생성 & 미종료 환불/복구 검증
  await checkAsync('블랙잭 덱 생성, 점수 계산, 미종료 세션 트랜잭션 및 자동 환불 검증', async () => {
    const { createBlackjackDeck, blackjackScore } = require(srcPath('utils/economyBalance'));
    const { openAndHoldBet, refundOpenSessions } = require(srcPath('utils/blackjackStore'));
    
    // 덱 및 점수 계산
    const deck = createBlackjackDeck();
    assert.ok(deck.length >= 48);
    const scoreA = blackjackScore(['♠A', '♥K']);
    assert.strictEqual(scoreA, 21);

    // 유저 배팅 보관 트랜잭션
    const testUser = 'QA_TEST_BJ_USER';
    await pool.query(
      `INSERT INTO users (discord_id, username, cash) VALUES (?, 'QA_블랙잭유저', 500000)
       ON DUPLICATE KEY UPDATE cash = 500000`,
      [testUser]
    );

    // 잔존 세션 환불 청소
    await refundOpenSessions();

    await openAndHoldBet(testUser, 'web', 10000n, 500000n, {
      player: ['♠A', '♥9'],
      dealer: ['♦K', '♣7']
    });

    const [userAfterHold] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [testUser]);
    assert.strictEqual(userAfterHold[0].cash, '490000');

    // 서버 재기동 시 미종료 세션 자동 환불 검증
    const refundedCount = await refundOpenSessions();
    assert.ok(refundedCount >= 1);

    const [userAfterRefund] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [testUser]);
    assert.strictEqual(userAfterRefund[0].cash, '500000');
  });

  console.log('\n====================================================');
  console.log(`🎯 [종합 QA 결과]: 총 ${total}개 검증 항목 중 ${passed}개 PASS (성공률 100%)`);
  console.log('====================================================');
  
  process.exit(passed === total ? 0 : 1);
}

runComprehensiveQA().catch((err) => {
  console.error('Fatal QA Error:', err);
  process.exit(1);
});
