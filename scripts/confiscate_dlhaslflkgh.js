const { pool } = require('../src/config/database');
const { formatMoney } = require('../src/utils/formatters');
const { safeBigInt } = require('../src/utils/money');

async function confiscateTargetAssets() {
  const targetId = '1481258930909872239';
  console.log(`🚀 [자산 전수 압류 시작] 대상 유저: ${targetId}`);

  // 1. 유저 기본 자산 조회
  const [users] = await pool.query('SELECT * FROM users WHERE discord_id = ?', [targetId]);
  if (!users.length) {
    console.error('유저를 찾을 수 없습니다.');
    process.exit(1);
  }
  const u = users[0];
  const cash = safeBigInt(u.cash);
  const bank = safeBigInt(u.bank);

  // 2. 보유 주식 평가액 계산 및 삭제
  const [stocks] = await pool.query(`
    SELECT us.*, s.price, s.name,
           CAST(ROUND(us.amount * s.price) AS DECIMAL(65,0)) AS eval_val
    FROM user_stocks us
    JOIN stocks s ON us.stock_id = s.stock_id
    WHERE us.user_id = ?
  `, [targetId]);

  let stockTotal = 0n;
  for (const s of stocks) {
    const val = safeBigInt(s.eval_val);
    stockTotal += val;
    console.log(`- 주식 압류: ${s.name} (${s.stock_id}) ${s.amount}주 (평가액: ${formatMoney(val)})`);
  }

  // 주식 보유 데이터 전량 삭제
  await pool.query('DELETE FROM user_stocks WHERE user_id = ?', [targetId]);

  // 3. 사업 데이터 전량 초기화
  await pool.query('DELETE FROM user_businesses WHERE user_id = ?', [targetId]);
  await pool.query('DELETE FROM user_business_meta WHERE user_id = ?', [targetId]);
  console.log('- 사업 데이터 및 본사 레벨 전체 초기화 완료');

  // 4. 총 압류 금액 계산 (현금 + 은행 + 주식 평가액)
  const totalSeized = cash + bank + stockTotal;
  console.log(`💰 총 압류 금액: ${formatMoney(totalSeized)} (현금: ${formatMoney(cash)}, 예금: ${formatMoney(bank)}, 주식: ${formatMoney(stockTotal)})`);

  // 5. 유저 현금/예금 0원 처리
  await pool.query('UPDATE users SET cash = 0, bank = 0 WHERE discord_id = ?', [targetId]);

  // 6. 국고(treasury)로 전액 귀속
  // treasury_logs에 기록하고 economy_logs에 관리자 몰수 기록
  await pool.query(`
    INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
    VALUES (?, ?, 'ADMIN_TAKE', ?, ?, 0, ?)
  `, [
    targetId,
    u.username,
    totalSeized.toString(),
    (cash + bank).toString(),
    `[부정 어뷰징 전액 압류] 사업 수금 취약점 악용 전액 국고 귀속 (현금 ${formatMoney(cash)} + 예금 ${formatMoney(bank)} + 주식 ${formatMoney(stockTotal)})`
  ]);

  // treasury_funds 테이블이 있는지 확인 후 국고 반영
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS treasury_funds (id INT PRIMARY KEY DEFAULT 1, balance DECIMAL(65,0) NOT NULL DEFAULT 0)');
    await pool.query('INSERT INTO treasury_funds (id, balance) VALUES (1, ?) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance)', [totalSeized.toString()]);
  } catch (e) {}

  console.log('✅ 1481258930909872239 유저의 모든 자산이 국고로 압류 및 0원 정상화되었습니다!');
  process.exit(0);
}

confiscateTargetAssets().catch(err => {
  console.error(err);
  process.exit(1);
});
