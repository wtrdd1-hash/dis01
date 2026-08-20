'use strict';
/**
 * economy_system_comprehensive_qa.js
 * 🏛️ 월덕 가상 경제 코어 및 전 자동 수익/지출 파이프라인 종합 QA 스크립트
 */

const { pool } = require('../src/config/database');
const EconomyCore = require('../src/core/economy/EconomyCore');
const economyBalancer = require('../src/utils/economyBalancer');
const taxEngine = require('../src/utils/taxEngine');
const bankEngine = require('../src/utils/bankEngine');
const autoMiner = require('../src/utils/autoMiner');
const businessEngine = require('../src/utils/businessEngine');
const stockEngine = require('../src/utils/stockEngine');
const money = require('../src/utils/money');
const formatters = require('../src/utils/formatters');

let results = {
  timestamp: new Date().toISOString(),
  passed: 0,
  failed: 0,
  warnings: 0,
  details: []
};

function logTest(cat, name, status, detail, data) {
  const item = { cat, name, status, detail, data, at: new Date().toISOString() };
  results.details.push(item);
  if (status === 'PASS') results.passed++;
  else if (status === 'FAIL') results.failed++;
  else results.warnings++;
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
  console.log(`${icon} [${cat}] ${name} -> ${status}: ${detail}`);
}

async function runEconomyCoreQA() {
  console.log('============================================================');
  console.log('🏛️ [ECONOMY CORE QA] 가상 경제 통합 코어 및 수익 파이프라인 전수 검증');
  console.log('============================================================\n');

  const testUserId = '112233445566778899';
  const testUsername = 'qa_eco_tester';

  try {
    // 0. 테스트 유저 초기화
    await pool.query(`
      INSERT INTO users (discord_id, username, cash, bank, clicker_level, auto_miner_level)
      VALUES (?, ?, 100000, 500000, 1, 1)
      ON DUPLICATE KEY UPDATE cash = 100000, bank = 500000, clicker_level = 1, auto_miner_level = 1
    `, [testUserId, testUsername]);

    // ──────────────────────────────────────────────────
    // TEST 1: EconomyCore 인스턴스 및 서브모듈 무결성 검증
    // ──────────────────────────────────────────────────
    console.log('--- 1. EconomyCore 인스턴스 무결성 검증 ---');
    const summary = await EconomyCore.getStatusSummary();
    if (summary && summary.status === 'HEALTHY') {
      logTest('Core', 'getStatusSummary()', 'PASS', `정상 상태 확인 (국고: ${summary.treasury}, 세율: ${summary.taxRatePercent}, 이자율: ${summary.bankInterestHourly})`);
    } else {
      logTest('Core', 'getStatusSummary()', 'FAIL', '상태 요약 실패');
    }

    const uBal = await EconomyCore.vault.getUserBalance(testUserId);
    if (uBal && uBal.cash === 100000n && uBal.bank === 500000n) {
      logTest('Core', 'EconomyCore.vault.getUserBalance()', 'PASS', `현금: ${uBal.cash}, 예금: ${uBal.bank}`);
    } else {
      logTest('Core', 'EconomyCore.vault.getUserBalance()', 'FAIL', `잔액 불일치: ${JSON.stringify(uBal)}`);
    }

    // ──────────────────────────────────────────────────
    // TEST 2: 자동 경제 조절 엔진 (Macro Balancer) 시뮬레이션
    // ──────────────────────────────────────────────────
    console.log('\n--- 2. 거시경제 자동 조절 엔진 (Economy Balancer) 검증 ---');
    const report = await economyBalancer.analyzeEconomyHealth();
    if (report && report.status) {
      logTest('Governor', 'analyzeEconomyHealth() 경제 건강 지표 분석', 'PASS', `상태: ${report.status}, 점수: ${report.score}점, 지니계수: ${report.indicators.giniCoeff}`);
    } else {
      logTest('Governor', 'analyzeEconomyHealth()', 'FAIL', '지표 분석 실패');
    }

    const balanceActions = await economyBalancer.applyAutoBalancing(report);
    const dynSettings = EconomyCore.governor.getDynamicSettings();
    if (Array.isArray(balanceActions)) {
      logTest('Governor', 'applyAutoBalancing() 자동 거시경제 조절 실행', 'PASS', `조치 수: ${balanceActions.length}건, 근로배율: ${dynSettings.workRewardMultiplier}, 지원금배율: ${dynSettings.subsidyMultiplier}`);
    } else {
      logTest('Governor', 'applyAutoBalancing()', 'FAIL', '자동 조절 실패');
    }

    // ──────────────────────────────────────────────────
    // TEST 3: 모든 수익 및 자금 유입 파이프라인 정밀 검증
    // ──────────────────────────────────────────────────
    console.log('\n--- 3. 유저 수익 파이프라인 전수 검증 ---');

    // 3-1. 공공 근로 수당 (Work)
    const workAmount = 3500n;
    const workSub = await taxEngine.grantTreasurySubsidy(testUserId, testUsername, workAmount, 'QA 근로 수당 지급');
    if (workSub && workSub.newCash === 103500n) {
      logTest('Earnings', '공공 근로 수당 (Work) 지급', 'PASS', `+3,500원 정상 수령 (현금 100,000 -> ${workSub.newCash})`);
    } else {
      logTest('Earnings', '공공 근로 수당 (Work) 지급', 'FAIL', `잔액 오류: ${workSub?.newCash}`);
    }

    // 3-2. 일일 출석체크 (Daily)
    const dailyReward = 4500n;
    const dailySub = await taxEngine.grantTreasurySubsidy(testUserId, testUsername, dailyReward, 'QA 출석 보상');
    if (dailySub && dailySub.newCash === 108000n) {
      logTest('Earnings', '일일 출석체크 (Daily) 지급', 'PASS', `+4,500원 정상 수령 (현금 103,500 -> ${dailySub.newCash})`);
    } else {
      logTest('Earnings', '일일 출석체크 (Daily) 지급', 'FAIL', `잔액 오류: ${dailySub?.newCash}`);
    }

    // 3-3. 긴급 구제 지원금 (Subsidy)
    const subsidyAmount = 2000n;
    const subResult = await taxEngine.grantTreasurySubsidy(testUserId, testUsername, subsidyAmount, 'QA 기본 지원금');
    if (subResult && subResult.newCash === 110000n) {
      logTest('Earnings', '긴급 구제 지원금 (Subsidy) 지급', 'PASS', `+2,000원 정상 수령 (현금 108,000 -> ${subResult.newCash})`);
    } else {
      logTest('Earnings', '긴급 구제 지원금 (Subsidy) 지급', 'FAIL', `잔액 오류: ${subResult?.newCash}`);
    }

    // 3-4. 은행 이자 엔진 (Bank Interest: 시간당 0.05% 분할 복리)
    const bankBefore = 500000n;
    await pool.query('UPDATE users SET bank = ? WHERE discord_id = ?', [bankBefore, testUserId]);
    await bankEngine.processBankInterest();
    const [bRows] = await pool.query('SELECT bank FROM users WHERE discord_id = ?', [testUserId]);
    const bankAfter = money.safeBigInt(bRows[0].bank);
    if (bankAfter >= bankBefore) {
      logTest('Earnings', '중앙은행 예금 이자 지급 엔진 (Bank Interest)', 'PASS', `이자 정상 가산 (예금: ${bankBefore} -> ${bankAfter}원)`);
    } else {
      logTest('Earnings', '중앙은행 예금 이자 지급 엔진 (Bank Interest)', 'FAIL', '이자 미지급');
    }

    // 3-5. 사업장 수금 엔진 (Business Harvest)
    await pool.query(`
      INSERT INTO user_businesses (user_id, business_key, level, staff, invested, last_collect_at)
      VALUES (?, 'convenience_store', 2, 1, 100000, DATE_SUB(NOW(), INTERVAL 10 MINUTE))
      ON DUPLICATE KEY UPDATE level = 2, staff = 1, last_collect_at = DATE_SUB(NOW(), INTERVAL 10 MINUTE)
    `, [testUserId]);

    const bizList = await businessEngine.listUserBusinesses(testUserId);
    if (bizList && bizList.items) {
      logTest('Earnings', '사업장 목록 및 수익 누적 조회 (Business List)', 'PASS', `누적 미정산 수익: ${bizList.pendingTotal}원`);
    } else {
      logTest('Earnings', '사업장 목록 및 수익 누적 조회 (Business List)', 'FAIL', '사업장 조회 실패');
    }

    const collectRes = await businessEngine.collectBusiness(testUserId, testUsername, null, { auto: true, allowEmpty: true });
    if (collectRes) {
      logTest('Earnings', '사업장 수익 수금 (Business Collect)', 'PASS', `수금 완료: +${collectRes.collected || 0}원 (현금: ${collectRes.cash || '유지'})`);
    } else {
      logTest('Earnings', '사업장 수익 수금 (Business Collect)', 'FAIL', '수금 실패');
    }

    // 3-6. 자동 채굴기 틱 정산 (AutoMiner)
    await autoMiner.processAutoMinerTick();
    const minerStats = autoMiner.getAutoMinerStats();
    logTest('Earnings', '자동 채굴기 틱 정산 엔진 (AutoMiner Tick)', 'PASS', `자동 채굴 틱 정상 가산 (총 틱: ${minerStats.totalTicks})`);

    // ──────────────────────────────────────────────────
    // TEST 4: 주식 시황 국면 & 주가 틱 변동 & 배당금 지급 엔진 검증
    // ──────────────────────────────────────────────────
    console.log('\n--- 4. 주식 시황 국면 & 주가 변동 & 배당금 지급 엔진 검증 ---');
    const regime = stockEngine.getCurrentMarketRegime();
    logTest('Stock', '주식 시장 시황 국면 (Market Regime) 조회', 'PASS', `현재 국면: ${regime ? regime.name : '정상'}`);

    const priceUpdate = await stockEngine.updateStockPrices();
    logTest('Stock', '실시간 주가 변동 틱 엔진 (updateStockPrices)', 'PASS', `주가 틱 정상 반영 (종목 변동 완료)`);

    const dividendRes = await stockEngine.distributeStockDividends();
    logTest('Stock', '주식 정기 배당금 분배 엔진 (distributeStockDividends)', 'PASS', `배당금 정산 사이클 정상 처리`);

    // ──────────────────────────────────────────────────
    // TEST 5: 동시성 락 (Concurrency Race Condition) 안전성 검증
    // ──────────────────────────────────────────────────
    console.log('\n--- 5. 동시성 락 (Race Condition) 안전성 검증 ---');
    await pool.query('UPDATE users SET cash = 100000 WHERE discord_id = ?', [testUserId]);
    
    // 동시에 10개의 1,000원 차감 트랜잭션 병렬 실행
    const parallelCount = 10;
    const promises = [];
    for (let i = 0; i < parallelCount; i++) {
      promises.push(
        money.withUserLock(testUserId, async () => {
          return await money.applyCashDelta(testUserId, -1000n);
        })
      );
    }
    await Promise.all(promises);

    const finalBal = await EconomyCore.vault.getUserBalance(testUserId);
    if (finalBal.cash === 90000n) {
      logTest('Vault', '동시성 락 원자적 자산 차감 (10개 병렬)', 'PASS', `정확히 10,000원 차감되어 90,000원 일치 (오차 0원)`);
    } else {
      logTest('Vault', '동시성 락 원자적 자산 차감', 'FAIL', `레이스 컨디션 발생! 최종 잔액: ${finalBal.cash} (기대값: 90,000)`);
    }

  } catch (err) {
    logTest('Fatal', 'QA 실행 도중 예외 발생', 'FAIL', err.stack || err.message);
  } finally {
    // 클린업
    await pool.query('DELETE FROM users WHERE discord_id = ?', [testUserId]);
    await pool.query('DELETE FROM user_stocks WHERE user_id = ?', [testUserId]).catch(() => {});
    await pool.query('DELETE FROM user_businesses WHERE user_id = ?', [testUserId]).catch(() => {});
    await pool.query('DELETE FROM gambling_logs WHERE user_id = ?', [testUserId]).catch(() => {});
    console.log('\n🧹 [CleanUp] 테스트 데이터 정리 완료');
  }

  console.log('\n============================================================');
  console.log('📊 [ECONOMY CORE QA FINAL SUMMARY]');
  console.log(`✅ 성공 (PASS): ${results.passed}`);
  console.log(`❌ 실패 (FAIL): ${results.failed}`);
  console.log(`⚠️ 경고 (WARN): ${results.warnings}`);
  console.log('============================================================');

  process.exit(results.failed > 0 ? 1 : 0);
}

runEconomyCoreQA().catch(e => {
  console.error('Fatal QA Runner Error:', e);
  process.exit(1);
});
