const { pool } = require('../src/config/database');
const { formatMoney } = require('../src/utils/formatters');
const { safeBigInt } = require('../src/utils/money');

const DEFAULT_STOCKS = [
  { stock_id: 'WTRD', name: '월덕 인터내셔널 (지주사)', price: 50000, prev_price: 49500, volatility: 0.03, sector: '커뮤니티 지주 & AI 플랫폼' },
  { stock_id: 'MINE', name: '월덕 광업 & 제련 (채굴/골드)', price: 12500, prev_price: 12100, volatility: 0.05, sector: '자원 개발 & 골드 채굴' },
  { stock_id: 'CASN', name: '황금오리 카지노 & 엔터 (게이밍)', price: 35000, prev_price: 33800, volatility: 0.07, sector: '카지노 게이밍 & 엔터테인먼트' },
  { stock_id: 'BANK', name: '덕스 중앙은행 & 파이낸스 (금융)', price: 85000, prev_price: 84200, volatility: 0.02, sector: '서버 기축 금융 & 예금/지원금' },
  { stock_id: 'NEKO', name: '네코 에너지 & 냥코 랩스 (양자)', price: 8800, prev_price: 9200, volatility: 0.09, sector: '초전도 양자 & 미래 에너지' },
  { stock_id: 'CHKN', name: '황금닭 치킨 & 푸드 테크 (소비재)', price: 3500, prev_price: 3450, volatility: 0.02, sector: '식음료 & 스테미나 푸드' },
  { stock_id: 'SLOT', name: '럭키세븐 다이아 복권 (초보입문/국민주)', price: 100, prev_price: 100, volatility: 0.06, sector: '초보자 입문 & 복권/테마' },
  { stock_id: 'SCRP', name: '이지스크랩 데이터 테크 (빅데이터)', price: 120000, prev_price: 118000, volatility: 0.04, sector: '빅데이터 & 고속 웹 인프라' },
  { stock_id: 'AICH', name: '오리 인공지능 & 퀀텀 칩스 (AI 반도체)', price: 150000, prev_price: 148000, volatility: 0.05, sector: 'AI 반도체 & NPU 가속기' },
  { stock_id: 'SPAC', name: '덕스 에어로스페이스 & 방산 (우주항공)', price: 65000, prev_price: 63500, volatility: 0.05, sector: '우주항공 & 국방 방위산업' },
  { stock_id: 'BIOX', name: '월덕 바이오 파마 (생명공학/신약)', price: 45000, prev_price: 44200, volatility: 0.06, sector: '바이오 헬스케어 & 신약 개발' },
  { stock_id: 'LUXU', name: '황금오리 럭셔리 & 부티크 (명품/소비재)', price: 75000, prev_price: 74000, volatility: 0.04, sector: '글로벌 명품 패션 & 하이엔드 쥬얼리' },
  { stock_id: 'AUTO', name: '덕스 모빌리티 & 자율주행 (전기차)', price: 95000, prev_price: 93500, volatility: 0.05, sector: '자율주행 전기차 & 미래 모빌리티' }
];

async function normalizeStockMarket() {
  console.log('🚀 [주식 시장 시세 전면 정상화 시작]');

  for (const s of DEFAULT_STOCKS) {
    await pool.query(`
      UPDATE stocks 
      SET price = ?, prev_price = ?, high_24h = ?, low_24h = ?, volume_24h = 0, volatility = ?
      WHERE stock_id = ?
    `, [s.price, s.prev_price, Math.floor(s.price * 1.05), Math.floor(s.price * 0.95), s.volatility, s.stock_id]);
    console.log(`✅ [${s.stock_id}] ${s.name} 시세 정상화 완료 -> 현재가: ${formatMoney(s.price)}`);

    await pool.query(`
      INSERT INTO stock_history (stock_id, price, recorded_at)
      VALUES (?, ?, NOW())
    `, [s.stock_id, s.price.toString()]);
  }

  // 시장 뉴스 공시 기록
  await pool.query(`
    INSERT INTO market_news_feed (title, content, event_type, impact_sector, related_stock, impact_rate, sentiment, importance)
    VALUES ('🏛️ 덕스 금융감독위원회, 증권 시장 건전성 회복 및 시세 정상화 공시', '금융당국의 시장 모니터링 강화 및 13대 대표 상장 종목의 밸류에이션 정상화 조치가 완료되었습니다.', 'POLICY_NORMALIZATION', '시장 전반', 'ALL', 0.0000, 'BULL', 'URGENT')
  `);

  // 유저 보유 주식 중 total_spent 동기화
  const [userStocks] = await pool.query('SELECT us.*, s.price FROM user_stocks us JOIN stocks s ON us.stock_id = s.stock_id');
  for (const us of userStocks) {
    const amt = Number(us.amount || 0);
    const price = Number(us.price || 0);
    const newSpent = Math.floor(amt * price);
    await pool.query('UPDATE user_stocks SET total_spent = ? WHERE user_id = ? AND stock_id = ?', [newSpent.toString(), us.user_id, us.stock_id]);
  }
  console.log('✅ 유저 보유 주식 투자원금/평단가 동기화 완료');

  console.log('🎉 주식 시장 13개 종목 시세가 모두 완벽하게 정상화되었습니다!');
  process.exit(0);
}

normalizeStockMarket().catch(err => {
  console.error(err);
  process.exit(1);
});
