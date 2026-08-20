const { pool } = require('../src/config/database');
const { createDatabaseBackup } = require('../src/utils/backupEngine');

async function run() {
  try {
    console.log('🔍 [1] 주식 매매 거래 장부(stock_transactions) 테이블 확인...');
    const [tables] = await pool.query("SHOW TABLES LIKE 'stock_transactions'");
    console.log('테이블 존재 여부:', tables.length > 0 ? '✅ 정상 존재' : '❌ 없음');

    const [cntRows] = await pool.query('SELECT COUNT(*) as cnt FROM stock_transactions');
    console.log(`📊 총 누적 주식 매매 체결 건수: ${cntRows[0].cnt}건`);

    const [recent] = await pool.query('SELECT id, user_id, username, stock_id, stock_name, action, amount, price, total_price, created_at FROM stock_transactions ORDER BY id DESC LIMIT 5');
    console.log('📋 최근 주식 매매 기록 5건:');
    console.table(recent);

    console.log('\n💾 [2] 전체 데이터베이스 즉시 백업 생성 시작...');
    const backupResult = await createDatabaseBackup();
    console.log('✅ 데이터베이스 백업 완료:');
    console.log(backupResult);

    process.exit(0);
  } catch (err) {
    console.error('❌ 실행 중 오류 발생:', err);
    process.exit(1);
  }
}

run();
