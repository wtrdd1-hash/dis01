const { pool } = require('../src/config/database');
const { adminSetJackpot, getLoopState } = require('../src/utils/casinoLoop');
const { formatMoney } = require('../src/utils/formatters');

async function resetJackpot() {
  console.log('=== 🎰 카지노 프로그레시브 잭팟(PROGRESSIVE JACKPOT) 초기화 ===\n');

  const [rows] = await pool.query('SELECT * FROM casino_pot WHERE id = 1');
  console.log('1. 현재 casino_pot 테이블 데이터:');
  console.log(rows[0]);

  const defaultJackpot = '1000000'; // 기본 잭팟: 100만원
  console.log(`\n2. 잭팟을 ${formatMoney(defaultJackpot)}으로 초기화합니다...`);
  const updated = await adminSetJackpot(defaultJackpot);

  console.log(`\n✅ 초기화 완료! 현재 잭팟 금액: ${formatMoney(updated)} (${updated.toString()}원)`);
  process.exit(0);
}

resetJackpot().catch(e => {
  console.error('❌ Error resetting jackpot:', e);
  process.exit(1);
});
