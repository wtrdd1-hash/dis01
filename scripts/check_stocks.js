const { pool } = require('../src/config/database');
const { formatMoney } = require('../src/utils/formatters');

async function checkStocks() {
  const [rows] = await pool.query('SELECT stock_id, name, sector, price, dividend_yield, volatility FROM stocks ORDER BY price DESC');
  console.log(`=== 📈 현재 상장된 13대 주식 종목 현황 (${rows.length}개) ===\n`);
  rows.forEach((s, idx) => {
    console.log(`${idx + 1}. [${s.stock_id}] ${s.name}`);
    console.log(`   - 섹터: ${s.sector} | 현재가: ${formatMoney(s.price)} | 연 배당률: ${s.dividend_yield}% | 변동성: ${s.volatility}`);
  });
  process.exit(0);
}

checkStocks().catch(e => {
  console.error('Error checking stocks:', e);
  process.exit(1);
});
