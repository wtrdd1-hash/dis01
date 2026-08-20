const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/database');
const { logSystemEvent } = require('../src/utils/universalLogger');
const { formatMoney } = require('../src/utils/formatters');
const { safeBigInt } = require('../src/utils/money');

(async () => {
  try {
    console.log('=== 🚀 전체 로그 정형 텍스트 파일(.log) 전수 동기화 및 분리 생성 시작 ===\n');

    // 1. 웹 접속 로그 마이그레이션 (최근 200건)
    const [webLogs] = await pool.query('SELECT * FROM web_access_logs ORDER BY id ASC LIMIT 300');
    console.log(`1. 웹 접속 로그 ${webLogs.length}건 텍스트 변환...`);
    for (const w of webLogs) {
      logSystemEvent({
        category: 'WEB_ACCESS',
        level: w.status_code >= 400 ? 'WARN' : 'INFO',
        userId: w.user_id,
        username: w.username,
        ip: w.ip,
        action: `${w.method} ${w.url}`,
        message: `${w.status_code} (${w.duration_ms}ms) [${w.country_name || w.country || 'KR'}]`,
        details: { userAgent: (w.user_agent || '').slice(0, 150) }
      });
    }

    // 2. 자금 이동 로그 마이그레이션 (최근 300건)
    const [ecoLogs] = await pool.query('SELECT * FROM economy_logs ORDER BY id ASC LIMIT 300');
    console.log(`2. 자금 이동 로그 ${ecoLogs.length}건 텍스트 변환...`);
    for (const e of ecoLogs) {
      const amt = safeBigInt(e.amount);
      const after = safeBigInt(e.balance_after);
      logSystemEvent({
        category: 'ECONOMY',
        level: 'INFO',
        userId: e.user_id,
        username: e.username,
        action: e.type,
        message: `${amt >= 0n ? '+' : ''}${formatMoney(amt)} (잔여: ${formatMoney(after)})`,
        details: { description: e.description }
      });
    }

    // 3. 도박 로그 마이그레이션 (최근 200건)
    const [gambleLogs] = await pool.query('SELECT g.*, u.username FROM gambling_logs g LEFT JOIN users u ON g.user_id = u.discord_id ORDER BY g.id ASC LIMIT 200');
    console.log(`3. 도박/게임 로그 ${gambleLogs.length}건 텍스트 변환...`);
    for (const g of gambleLogs) {
      const prof = safeBigInt(g.profit);
      logSystemEvent({
        category: 'GAMBLE',
        level: 'INFO',
        userId: g.user_id,
        username: g.username,
        action: g.game,
        message: `배팅: ${formatMoney(safeBigInt(g.bet))} | 당첨: ${formatMoney(safeBigInt(g.payout))} | 손익: ${prof >= 0n ? '+' : ''}${formatMoney(prof)}`,
        details: { isRolledBack: Boolean(g.is_rolled_back) }
      });
    }

    // 4. 주식 거래 로그 마이그레이션 (최근 150건)
    const [stockLogs] = await pool.query('SELECT st.*, s.name as stock_name, u.username FROM stock_transactions st JOIN stocks s ON st.stock_id = s.stock_id LEFT JOIN users u ON st.user_id = u.discord_id ORDER BY st.id ASC LIMIT 150');
    console.log(`4. 주식 매매 체결 로그 ${stockLogs.length}건 텍스트 변환...`);
    for (const s of stockLogs) {
      logSystemEvent({
        category: 'STOCK',
        level: 'INFO',
        userId: s.user_id,
        username: s.username,
        action: s.action,
        message: `${s.stock_name}(${s.stock_id}) ${Number(s.amount).toLocaleString()}주 @ ${formatMoney(safeBigInt(s.price))} (총 ${formatMoney(safeBigInt(s.total_price))})`
      });
    }

    // 5. 생성된 로그 파일 목록 확인
    const logDir = path.join(__dirname, '../logs');
    const files = fs.readdirSync(logDir);
    console.log('\n=== 📁 생성된 로그 파일 목록 ===');
    files.forEach(f => {
      const st = fs.statSync(path.join(logDir, f));
      console.log(`  ✓ ${f.padEnd(25)} (${(st.size / 1024).toFixed(2)} KB)`);
    });

    console.log('\n=== ✅ 전체 통합 로그 및 부분별 분리 로그 파일 생성 완료! ===');
    process.exit(0);
  } catch (err) {
    console.error('동기화 오류:', err);
    process.exit(1);
  }
})();
