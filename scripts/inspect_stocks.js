const { pool } = require('../src/config/database');
const { formatMoney } = require('../src/utils/formatters');
const { safeBigInt } = require('../src/utils/money');

async function inspectStockMarket() {
  console.log('=== 1. 현재 등록된 주식 종목 시세 현황 ===');
  const [stocks] = await pool.query('SELECT * FROM stocks ORDER BY stock_id ASC');
  for (const s of stocks) {
    const cur = safeBigInt(s.price);
    const base = safeBigInt(s.base_price || 0);
    const prev = safeBigInt(s.prev_price || 0);
    const changePct = prev > 0n ? ((Number(cur - prev) / Number(prev)) * 100).toFixed(2) : '0.00';
    console.log(`[${s.stock_id}] ${s.name} | 현재가: ${formatMoney(cur)} (기준가: ${formatMoney(base)}) | 변동률: ${changePct}% | 총발행: ${s.total_shares || 0}주 | 거래량: ${s.volume || 0}`);
  }

  console.log('\n=== 2. 현재 유저 보유 주식 (상위 20건) ===');
  const [userStocks] = await pool.query(`
    SELECT us.*, u.username, s.name as stock_name, s.price as current_price,
           CAST(ROUND(us.amount * s.price) AS DECIMAL(65,0)) AS eval_val
    FROM user_stocks us
    JOIN users u ON us.user_id = u.discord_id
    JOIN stocks s ON us.stock_id = s.stock_id
    WHERE us.amount > 0
    ORDER BY eval_val DESC
    LIMIT 20
  `);
  for (const us of userStocks) {
    console.log(`@${us.username} (${us.user_id}) | ${us.stock_name} (${us.stock_id}) : ${us.amount}주 | 평가액: ${formatMoney(safeBigInt(us.eval_val))} (투자원금: ${formatMoney(safeBigInt(us.total_spent))})`);
  }

  console.log('\n=== 3. 현재 시장 국면 (Market Regime) 및 경제 상태 ===');
  const [regimes] = await pool.query('SELECT * FROM market_regimes ORDER BY id DESC LIMIT 1');
  console.log(regimes[0] || 'No regime table/row');

  console.log('\n=== 4. 최근 주가 변동 틱 로그 (최근 10건) ===');
  const [priceLogs] = await pool.query('SELECT * FROM stock_price_logs ORDER BY id DESC LIMIT 10');
  for (const pl of priceLogs) {
    console.log(`[${pl.created_at}] Stock: ${pl.stock_id} | Old: ${formatMoney(safeBigInt(pl.old_price))} -> New: ${formatMoney(safeBigInt(pl.new_price))} (${pl.change_rate}%) | Cause: ${pl.reason || pl.cause}`);
  }

  process.exit(0);
}

inspectStockMarket().catch(err => {
  console.error(err);
  process.exit(1);
});
