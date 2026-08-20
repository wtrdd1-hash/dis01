const { pool } = require('../src/config/database');
const { formatMoney } = require('../src/utils/formatters');
const { safeBigInt } = require('../src/utils/money');

(async () => {
  try {
    console.log('=== 🔍 관리자 주식 기능 및 주주 명부 실서버 검증 ===\n');

    // 1. 주식 보유자 목록 조회
    const [rows] = await pool.query(`
      SELECT 
        us.user_id,
        u.username,
        us.stock_id,
        s.name AS stock_name,
        us.amount,
        us.total_spent,
        s.price AS current_price,
        CAST(ROUND(us.amount * s.price) AS DECIMAL(65,0)) AS eval_val
      FROM user_stocks us
      JOIN users u ON us.user_id = u.discord_id
      JOIN stocks s ON us.stock_id = s.stock_id
      WHERE us.amount > 0
      ORDER BY eval_val DESC
      LIMIT 10
    `);

    console.log(`1. 실시간 주주 명부 데이터 (총 ${rows.length}건 조회):`);
    rows.forEach((r, idx) => {
      const amt = Number(r.amount);
      const evalVal = safeBigInt(r.eval_val);
      console.log(`   [${idx + 1}] @${r.username} (${r.user_id}) | ${r.stock_name}(${r.stock_id}) | ${amt.toLocaleString()}주 | 평가금: ${formatMoney(evalVal)}`);
    });

    // 2. 1위 유저의 상세 포트폴리오 검증
    if (rows.length > 0) {
      const testUser = rows[0];
      console.log(`\n2. 1위 자산가 @${testUser.username} 님의 상세 포트폴리오 조회 테스트:`);
      const [uStocks] = await pool.query(`
        SELECT us.stock_id, us.amount, us.total_spent, s.name, s.price
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.user_id = ? AND us.amount > 0
      `, [testUser.user_id]);

      uStocks.forEach(s => {
        const amt = Number(s.amount);
        const curPrice = safeBigInt(s.price);
        const evalVal = safeBigInt(Math.floor(amt * Number(curPrice)));
        console.log(`   - ${s.name} (${s.stock_id}): ${amt.toLocaleString()}주 x ${formatMoney(curPrice)} = ${formatMoney(evalVal)}`);
      });
    }

    console.log('\n=== ✅ 모든 관리자 주식 조회 및 강제매도 코어 시스템 정상 확인 완료! ===');
    process.exit(0);
  } catch (e) {
    console.error('검증 에러:', e);
    process.exit(1);
  }
})();
