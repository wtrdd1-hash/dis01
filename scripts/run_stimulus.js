const { pool } = require('../src/config/database');
const { applyCashDelta } = require('../src/utils/money');
const { formatMoney } = require('../src/utils/formatters');

(async () => {
  try {
    console.log('=== 🚀 경제 긴급 부양 정책 패키지 실행 (실서버) ===');

    // 1. 전국민 긴급 경기부양 재난지원금 (100만원)
    const [users] = await pool.query('SELECT discord_id, username FROM users');
    let count = 0;
    for (const u of users) {
      try {
        await applyCashDelta(u.discord_id, 1000000n);
        count++;
      } catch (e) {}
    }
    console.log(`1. 전국민 경기부양 재난지원금 100만원 에어드랍: 총 ${count}명 지급 완료!`);

    // 2. 주식 시장 전종목 주가 +15% 랠리 부양
    await pool.query('UPDATE stocks SET price = ROUND(price * 1.15)');
    console.log('2. 주식 시장 전종목 +15% 랠리 부양 완료!');

    console.log('=== ✅ 경제 부양 조치 성공적으로 실행 완료! ===');
    process.exit(0);
  } catch (e) {
    console.error('에러 발생:', e);
    process.exit(1);
  }
})();
