'use strict';

const { pool } = require('../src/config/database');

async function abolishDelistingAndRestoreAll() {
  console.log('🏛️ [상장폐지 제도 전면 폐지 및 전 종목 영구 상장 복구 작업 시작]...');

  // 1. 모든 종목의 상태를 ACTIVE 정상 거래 상태로 일괄 복구
  const [res] = await pool.query(`
    UPDATE stocks
    SET status = 'ACTIVE',
        delisted_at = NULL,
        liquidation_price = 0
    WHERE status != 'ACTIVE'
  `);

  console.log(`✅ 비정상/상폐 상태였던 ${res.affectedRows}개 종목이 정상 거래(ACTIVE) 상태로 완벽 복구되었습니다.`);

  // 2. 현재 등록된 총 활성 종목 수 확인
  const [activeStocks] = await pool.query("SELECT stock_id, name, price, sector FROM stocks WHERE status = 'ACTIVE'");
  console.log(`📊 현재 거래소 전체 영구 상장 종목 수: 총 ${activeStocks.length}개`);

  // 3. 증시 속보 공시 등록
  await pool.query(`
    INSERT INTO market_news_feed (title, content, event_type, impact_sector, impact_rate, sentiment, importance)
    VALUES (
      '🛡️ [거래소 정책 대전환] 상장폐지 제도 전면 폐지 & 전 종목 영구 상장 보장제 시행!',
      '한국거래소 공시: 투자자 자산 보호 및 커뮤니티 증시 활성화를 위해 [상장폐지 제도]를 전격 폐지합니다. 이제 어떠한 종목도 파산이나 버블로 인해 강제 상장폐지되지 않으며, 모든 주주의 보유 주식은 100% 안전하게 영구 보존됩니다. 과열 종목은 오직 액면분할과 인적분할로만 주가를 안정화합니다.',
      'MARKET_REFORM', '전체 시장', 0.20, 'BULL', 'URGENT'
    )
  `);

  console.log('🎉 [상장폐지 제도 폐지 및 전 종목 영구 상장 보장 완료!]');
  process.exit(0);
}

abolishDelistingAndRestoreAll().catch(err => {
  console.error('❌ 작업 실패:', err);
  process.exit(1);
});
