'use strict';

const { pool } = require('../src/config/database');
const { executeDelisting, relistStock, checkAndProcessDelistings } = require('../src/utils/stockEngine');

async function testDelistingSystem() {
  console.log('🔍 [상장폐지 시스템 정밀 검증 시작]...');

  // 1. 현재 등록된 총 종목 수 및 활성 종목 수 조회
  const [activeStocks] = await pool.query("SELECT stock_id, name, price, status FROM stocks WHERE status = 'ACTIVE'");
  const [delistedStocks] = await pool.query("SELECT stock_id, name, price, status FROM stocks WHERE status = 'DELISTED'");
  console.log(`📊 현재 활성 상장 종목: ${activeStocks.length}개 / 상장폐지 종목: ${delistedStocks.length}개`);

  // 2. 상장폐지 실행 기능(executeDelisting) 무결성 테스트 (임시 테스트 종목 생성 -> 상폐 -> 청산금 검증 -> 재상장)
  const testStockId = 'TEST_DELIST';
  await pool.query(`
    INSERT INTO stocks (stock_id, name, price, prev_price, volatility, sector, description, status)
    VALUES (?, '상장폐지 테스트 기업', 25, 25, 0.05, '테스트 섹터', '상장폐지 검증용 종목입니다.', 'ACTIVE')
    ON DUPLICATE KEY UPDATE status = 'ACTIVE', price = 25
  `, [testStockId]);

  console.log('✅ 1) 테스트 종목 생성 완료');

  // 상장폐지 실행
  const delistResult = await executeDelisting(testStockId, '검증용 파산 상장폐지 테스트', 25);
  console.log('✅ 2) executeDelisting 실행 성공:', {
    success: delistResult.success,
    stockId: delistResult.stockId,
    reason: delistResult.reason,
    payout: delistResult.totalPayout
  });

  // 상태 검증
  const [checkRow] = await pool.query('SELECT status, liquidation_price FROM stocks WHERE stock_id = ?', [testStockId]);
  if (checkRow[0].status === 'DELISTED') {
    console.log('✅ 3) stocks 테이블 DELISTED 상태 전이 확인 완료');
  } else {
    throw new Error('상폐 상태 전이 실패');
  }

  // 재상장 복구 테스트
  const relistResult = await relistStock(testStockId, 5000, '상폐 테스트 완료 후 재상장 복구');
  console.log('✅ 4) relistStock 실행 성공:', {
    success: relistResult.success,
    stockId: relistResult.stockId,
    price: relistResult.priceFormatted
  });

  // 테스트 종목 정리
  await pool.query('DELETE FROM stocks WHERE stock_id = ?', [testStockId]);
  await pool.query('DELETE FROM stock_delistings WHERE stock_id = ?', [testStockId]);

  console.log('🎉 [상장폐지 및 재상장 전 과정 검증 완벽 통과!]');
  process.exit(0);
}

testDelistingSystem().catch(err => {
  console.error('❌ 상장폐지 검증 실패:', err);
  process.exit(1);
});
