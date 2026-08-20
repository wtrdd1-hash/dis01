const { pool } = require('../src/config/database');
const { safeBigInt } = require('../src/utils/money');
const { formatMoney } = require('../src/utils/formatters');
const { readTreasury } = require('../src/utils/taxEngine');

async function recalcTreasury() {
  console.log('=== 🏛️ 국고(taxTreasury) 정밀 재계산 및 복구 ===\n');

  // 1. 세금 징수 로그 합계 (TAX_TRADE, TAX_TRANSFER, TAX_WEALTH, TAX_ADMIN)
  const [collectedRows] = await pool.query(`
    SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) AS total_collected
    FROM economy_logs
    WHERE type IN ('TAX_TRADE', 'TAX_TRANSFER', 'TAX_WEALTH', 'TAX_ADMIN')
  `);
  const totalCollected = safeBigInt(collectedRows[0]?.total_collected);

  // 2. 국고 환급 및 지원금 지출 로그 합계 (TAX_REFUND, TREASURY_SUBSIDY)
  const [refundRows] = await pool.query(`
    SELECT COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) AS total_refunded
    FROM economy_logs
    WHERE type IN ('TAX_REFUND', 'TREASURY_SUBSIDY')
  `);
  const totalRefunded = safeBigInt(refundRows[0]?.total_refunded);

  // 3. 실제 순 국고 잔액 = 총 징수액 - 총 환급/지원액
  const accurateTreasury = totalCollected - totalRefunded;

  console.log(`1. 총 세금 징수 누적액: ${formatMoney(totalCollected)} (${totalCollected.toString()}원)`);
  console.log(`2. 총 지원금/환급 지출액: ${formatMoney(totalRefunded)} (${totalRefunded.toString()}원)`);
  console.log(`3. 계산된 정확한 국고 잔액: ${formatMoney(accurateTreasury)} (${accurateTreasury.toString()}원)`);

  // 4. economy_settings에 정확한 BigInt 문자열로 저장
  await pool.query(
    `INSERT INTO economy_settings (key_name, value) VALUES ('taxTreasury', ?)
     ON DUPLICATE KEY UPDATE value = ?`,
    [accurateTreasury.toString(), accurateTreasury.toString()]
  );

  const restored = await readTreasury();
  console.log(`\n✅ 복구 완료! 현재 readTreasury() 반환값: ${formatMoney(restored)} (${restored.toString()}원)`);
  process.exit(0);
}

recalcTreasury().catch(e => {
  console.error('❌ Error recalculating treasury:', e);
  process.exit(1);
});
