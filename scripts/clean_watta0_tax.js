const { pool } = require('../src/config/database');

(async () => {
  try {
    console.log('=== 🧹 @watta0 (w_b8bd6d3ffb3eb5df) 비정상 세금 내역 삭제 작업 ===\n');

    // 1. 해당 유저의 세금 로그 조회
    const [beforeRows] = await pool.query(`
      SELECT id, user_id, username, type, amount, created_at, description
      FROM economy_logs
      WHERE (user_id = 'w_b8bd6d3ffb3eb5df' OR user_id LIKE '%b8bd6d3ffb3eb5df%')
        AND type IN ('TAX_WEALTH', 'TAX_TRADE', 'TAX_ADMIN', 'TAX_TRANSFER')
    `);

    console.log(`발견된 세금 내역 건수: ${beforeRows.length}건`);
    beforeRows.forEach(r => {
      console.log(`  - [ID: ${r.id}] 타입: ${r.type} | 금액: ${r.amount} | 설명: ${r.description} | 일시: ${r.created_at}`);
    });

    // 2. 해당 세금 로그 삭제
    const [delRes] = await pool.query(`
      DELETE FROM economy_logs
      WHERE (user_id = 'w_b8bd6d3ffb3eb5df' OR user_id LIKE '%b8bd6d3ffb3eb5df%')
        AND type IN ('TAX_WEALTH', 'TAX_TRADE', 'TAX_ADMIN', 'TAX_TRANSFER')
    `);
    console.log(`\n총 ${delRes.affectedRows}건의 세금 로그를 삭제했습니다.`);

    // 3. 납세자 랭킹 재검증
    const { getTopTaxPayers } = require('../src/utils/taxEngine');
    const topPayers = await getTopTaxPayers(5);
    console.log('\n=== 🏆 갱신된 성실 납세자 랭킹 TOP 5 ===');
    topPayers.forEach(p => {
      console.log(`  [${p.rank}위] @${p.username} (${p.userId}) | 총 납부액: ${p.totalTaxPaidText} | 최근납부: ${p.lastTaxAtText}`);
    });

    console.log('\n=== ✅ @watta0 비정상 세금 내역 삭제 및 한국시간 포맷 정리 완료! ===');
    process.exit(0);
  } catch (e) {
    console.error('작업 에러:', e);
    process.exit(1);
  }
})();
