'use strict';

const { pool } = require('../src/config/database');
const { executeSpinOff } = require('../src/utils/stockEngine');

async function testSpinOff() {
  console.log('🧪 [인적분할 실행 테스트 시작]...');
  try {
    const [stocks] = await pool.query("SELECT stock_id, name, price FROM stocks WHERE status = 'ACTIVE' LIMIT 1");
    if (!stocks.length) {
      console.log('활성 종목이 없습니다.');
      process.exit(0);
    }

    const parent = stocks[0];
    const newStockId = (parent.stock_id + '_T').slice(0, 8);
    const newStockName = `${parent.name.split(' ')[0]} 테크 신성장`;

    console.log(`선택된 모회사: ${parent.name} (${parent.stock_id}) ➔ 신설회사: ${newStockName} (${newStockId})`);

    const res = await executeSpinOff(parent.stock_id, newStockId, newStockName, 0.3, '신성장테크', '거래소 인적분할 테스트');
    console.log('✅ 인적분할 실행 성공 결과:', res);

    // 테스트 생성된 종목 정리
    await pool.query('DELETE FROM stocks WHERE stock_id = ?', [newStockId]);
    await pool.query('DELETE FROM user_stocks WHERE stock_id = ?', [newStockId]);
    console.log('🧹 테스트 종목 정상 정리 완료');

    process.exit(0);
  } catch (err) {
    console.error('❌ 인적분할 실행 실패:', err);
    process.exit(1);
  }
}

testSpinOff();
