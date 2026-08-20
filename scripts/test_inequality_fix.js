const { pool } = require('../src/config/database');
const { getTaxOverview, previewWealthTax, collectWealthTax, loadWealthSnapshot } = require('../src/utils/taxEngine');
const { formatMoney } = require('../src/utils/formatters');
const { SUBSIDY, subsidyStatus } = require('../src/utils/economyBalance');

async function test() {
  console.log('=== ⚖️ 빈부격차 해소 및 누진 재산세(순자산 기준) 과세 정밀 진단 ===\n');

  // 1. 일반 유저 순자산 랭킹 상위/하위 조회
  const [users] = await pool.query(`
    SELECT u.discord_id, u.username, u.cash, u.bank,
           CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0)) AS stock_val,
           (CAST(u.cash AS DECIMAL(65,0)) + CAST(u.bank AS DECIMAL(65,0)) + CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0))) AS net_worth
    FROM users u
    LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
    LEFT JOIN stocks s ON us.stock_id = s.stock_id
    GROUP BY u.discord_id, u.username, u.cash, u.bank
    ORDER BY net_worth DESC
  `);

  console.log('1. 전체 유저 순자산 현황:');
  for (const u of users) {
    const snap = await loadWealthSnapshot(u.discord_id);
    const sub = subsidyStatus(snap.cash, snap.bank, snap.stock);
    console.log(`   - @${u.username || u.discord_id}: 순자산 ${formatMoney(u.net_worth)} (현금: ${formatMoney(u.cash)}, 예금: ${formatMoney(u.bank)}, 주식: ${formatMoney(u.stock_val)}) | 지원금수령자격: ${sub.eligible ? '✅ 가능' : '❌ 불가'}`);
  }

  // 2. 재산세 징수 미리보기 (순자산 기준)
  console.log('\n2. 🏛️ 재산세 징수 시뮬레이션:');
  const preview = await previewWealthTax();
  console.log(`   - 과세 대상자 수: ${preview.count}명`);
  console.log(`   - 예상 징수 총액: ${preview.totalText}`);
  console.log('   - 대상자별 예상 납부액:');
  preview.samples.forEach(s => {
    console.log(`     • @${s.username}: ${s.levyText}`);
  });

  console.log('\n=== ✅ 진단 완료 ===');
  process.exit(0);
}

test().catch(e => {
  console.error('❌ Error in test:', e);
  process.exit(1);
});
