'use strict';

const { pool } = require('../src/config/database');
const { readTreasury } = require('../src/utils/taxEngine');
const { formatMoney } = require('../src/utils/formatters');

async function resetTaxPaymentsOnly() {
  console.log('🔍 [세금 납부 기록 초기화 & 국고 보존 작업 시작]...');

  // 1. 현재 국고 잔액 확인 (절대 변경하지 않고 보존)
  const treasuryBefore = await readTreasury();
  console.log(`🏛️ 현재 국고 잔액 (보존 대상): ${formatMoney(treasuryBefore)} (${treasuryBefore.toString()}원)`);

  // 2. 세금 납부 기록 건수 조회
  const taxTypes = ['TAX_TRADE', 'TAX_WEALTH', 'TAX_TRANSFER', 'TAX_ADMIN', 'TAX_REFUND'];
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) AS total_tax
     FROM economy_logs
     WHERE type IN (${taxTypes.map(() => '?').join(',')})`,
    taxTypes
  );

  console.log(`📋 초기화 대상 세금 납부 기록: 총 ${countRows[0]?.cnt || 0}건 (누적 ${formatMoney(countRows[0]?.total_tax || 0)})`);

  // 3. 세금 납부 기록만 안전하게 삭제 (일반 자금 로그 및 유저 잔고는 100% 보존)
  const [deleteRes] = await pool.query(
    `DELETE FROM economy_logs WHERE type IN (${taxTypes.map(() => '?').join(',')})`,
    taxTypes
  );

  console.log(`✅ 세금 납부 기록 ${deleteRes.affectedRows}건 초기화 완료.`);

  // 4. 국고 잔액이 그대로 보존되었는지 재확인
  const treasuryAfter = await readTreasury();
  console.log(`🏛️ 작업 후 국고 잔액 (완벽 보존 확인): ${formatMoney(treasuryAfter)} (${treasuryAfter.toString()}원)`);

  if (treasuryBefore !== treasuryAfter) {
    throw new Error('국고 잔액 불일치 오류 발생!');
  }

  console.log('🎉 [국고 잔액 100% 보존 및 세금 납부 기록 초기화 완료!]');
  process.exit(0);
}

resetTaxPaymentsOnly().catch(err => {
  console.error('❌ 작업 실패:', err);
  process.exit(1);
});
