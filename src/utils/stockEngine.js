const { pool } = require('../config/database');

// 거시 경제 국면 정의 (Economic Regimes)
const MARKET_REGIMES = [
  { name: '📈 강세장 (Bull Market)', drift: 0.03, volatilityFactor: 1.0, desc: '전반적인 경제 호조와 위험자산 선호 심리로 시장 매수세가 우세합니다.' },
  { name: '📉 약세장 (Bear Market)', drift: -0.03, volatilityFactor: 1.2, desc: '경기 침체 우려와 긴축 기조로 전반적 매도세가 우세합니다.' },
  { name: '⚖️ 횡보장 (Sideways Market)', drift: 0.00, volatilityFactor: 0.8, desc: '뚜렷한 방향성 없이 좁은 박스권에서 매물 소화가 진행됩니다.' },
  { name: '🔥 인플레이션 Shock', drift: -0.02, volatilityFactor: 1.5, desc: '원자재 가격 급등 및 금리 인상 압박으로 시장 변동성이 심화됩니다.' },
  { name: '🚀 기술 혁신 Boom', drift: 0.04, volatilityFactor: 1.3, desc: 'AI 및 차세대 테크 산업을 중심으로 대규모 기관 자금이 유입됩니다.' },
  { name: '⚡ 유동성 파티 (Liquidity Rush)', drift: 0.05, volatilityFactor: 1.4, desc: '시중 유동성 공급 확대로 가상자산 및 성장주에 투기적 매수세가 집중됩니다.' }
];

// 타겟 섹터별 가상 경제 뉴스 & 공시 이벤트 (다채로운 이벤트 시스템)
const NEWS_EVENTS = [
  { 
    title: '🏦 중앙은행, 기준금리 전격 인하 시사',
    text: '중앙은행 총재가 물가 안정과 경기 부양을 위해 연내 기준금리 인하 가능성을 시사했습니다. 위험자산 전반에 강력한 매수세가 유입됩니다.', 
    eventType: 'MACRO_POLICY',
    impact: { ALL: 0.05, BTC: 0.09, ETH: 0.08, AAPL: 0.04 } 
  },
  { 
    title: '📉 글로벌 긴축 장기화 및 CPI 물가지수 쇼크',
    text: '예상치를 상회한 고물가 지표로 인해 통화 긴축이 장기화될 것이라는 우려가 확산되며 전 종목에 걸쳐 차익 실현 매도세가 출회되었습니다.', 
    eventType: 'MACRO_SHOCK',
    impact: { ALL: -0.05, BTC: -0.08, ETH: -0.07 } 
  },
  { 
    title: '🚀 엔비칩스, 차세대 초거대 AI 가속기 칩 양산 성공',
    text: '엔비칩스가 기존 대비 연산 속도가 400% 향상된 초고성능 AI 반도체 칩 양산에 성공했다고 공식 발표했습니다. 테크주 랠리를 주도합니다.', 
    eventType: 'TECH_BREAKTHROUGH',
    impact: { NVDA: 0.16, SAM: 0.08, AAPL: 0.05 } 
  },
  { 
    title: '⚡ 디스코인 현물 ETF 대형 자산운용사 대량 매수세',
    text: '월가 주요 헤지펀드 및 대형 연기금이 디스코인 현물 ETF를 포트폴리오에 편입하며 기록적인 자금 유입이 확인되었습니다.', 
    eventType: 'CRYPTO_RUSH',
    impact: { BTC: 0.18, ETH: 0.14 } 
  },
  { 
    title: '⚠️ 글로벌 반도체 원자재 공급망 일시적 병목 현상',
    text: '핵심 희귀 원자재 수출 제한 루머로 인해 글로벌 반도체 생산 차질 우려가 대두되며 엔비칩스와 삼송전자가 일시적 조정을 겪고 있습니다.', 
    eventType: 'SUPPLY_CHAIN',
    impact: { NVDA: -0.06, SAM: -0.07 } 
  },
  { 
    title: '🎉 알약바이오, 난치성 질환 표적 항암제 임상 3상 성공',
    text: '알약바이오가 다국적 제약사와 1조 5천억원 규모의 초대형 글로벌 판권 라이선스 아웃 계약을 체결했습니다.', 
    eventType: 'BIO_SUCCESS',
    impact: { BIO: 0.22 } 
  },
  { 
    title: '⚠️ 글로벌 바이오 특허 분쟁 및 임상 지연 우려',
    text: '알약바이오의 주력 파이프라인에 대한 경쟁사의 특허 침해 소송 제기 소식으로 투자 심리가 일시 냉각되었습니다.', 
    eventType: 'BIO_RISK',
    impact: { BIO: -0.12 } 
  },
  { 
    title: '🍏 사과전자, 역대 최대 실적 어닝 서프라이즈 발표',
    text: '사과전자가 차세대 온디바이스 AI 디바이스의 폭발적 판매 호조에 힘입어 분기 영업이익 사상 최고치를 경신했습니다.', 
    eventType: 'EARNINGS_SURPRISE',
    impact: { AAPL: 0.12, SAM: 0.04 } 
  },
  { 
    title: '💎 에테르코인, 초고속 확장성 네트워크 하드포크 완료',
    text: '에테르코인 네트워크의 처리 속도가 10배 향상되고 가스비가 90% 절감되는 차세대 메인넷 업그레이드가 성공적으로 가동되었습니다.', 
    eventType: 'CRYPTO_UPGRADE',
    impact: { ETH: 0.15, BTC: 0.04 } 
  },
  { 
    title: '🏛️ 삼송전자, 차세대 2나노 초미세 파운드리 고객사 대거 확보',
    text: '삼송전자가 글로벌 빅테크 기업들로부터 차세대 인공지능 칩 위탁생산 물량을 전격 수주했다고 밝혔습니다.', 
    eventType: 'CORPORATE_EXPANSION',
    impact: { SAM: 0.11, NVDA: 0.03 } 
  },
  { 
    title: '🌐 가상자산 글로벌 결제 시스템 도입 확산',
    text: '주요 글로벌 결제 네트워크에서 디스코인과 에테르코인의 실시간 간편 결제 연동을 지원하기 시작했습니다.', 
    eventType: 'CRYPTO_ADOPTION',
    impact: { BTC: 0.10, ETH: 0.09 } 
  },
  { 
    title: '🔥 쇼트 스퀴즈 랠리: 공매도 세력 청산으로 급등',
    text: '기관의 숏 포지션이 강제 청산되며 일부 핵심 종목들에 숏스퀴즈성 강력한 매수세가 유입되어 가격이 급등했습니다.', 
    eventType: 'SHORT_SQUEEZE',
    impact: { NVDA: 0.12, BTC: 0.11, BIO: 0.09 } 
  }
];

let currentRegimeIndex = 0;
let regimeCyclesLeft = 10;
let lastNews = null;
let historyCleanupCounter = 0;

async function updateStockPrices() {
  const connection = await pool.getConnection();
  try {
    regimeCyclesLeft--;
    if (regimeCyclesLeft <= 0 || Math.random() < 0.15) {
      currentRegimeIndex = Math.floor(Math.random() * MARKET_REGIMES.length);
      regimeCyclesLeft = Math.floor(Math.random() * 8) + 8;
    }
    const currentRegime = MARKET_REGIMES[currentRegimeIndex];

    const [stocks] = await connection.query('SELECT * FROM stocks');
    
    // 35% 확률로 시장 뉴스 이벤트 발생 및 DB 저장
    let eventImpactMap = {};
    lastNews = null;
    if (Math.random() < 0.35) {
      const selectedEvent = NEWS_EVENTS[Math.floor(Math.random() * NEWS_EVENTS.length)];
      lastNews = {
        title: selectedEvent.title,
        text: selectedEvent.text,
        eventType: selectedEvent.eventType,
        regime: currentRegime.name
      };
      eventImpactMap = selectedEvent.impact;

      try {
        await connection.query(`
          INSERT INTO market_news_feed (title, content, event_type, impact_rate)
          VALUES (?, ?, ?, ?)
        `, [selectedEvent.title, selectedEvent.text, selectedEvent.eventType, selectedEvent.impact['ALL'] || 0]);
      } catch (e) {}
    }

    await connection.beginTransaction();

    for (const stock of stocks) {
      const currentPrice = BigInt(stock.price);
      const baseVolatility = parseFloat(stock.volatility);
      const stockId = stock.stock_id;

      const regimeDrift = currentRegime.drift;
      const eventBoost = (eventImpactMap[stockId] || 0) + (eventImpactMap['ALL'] || 0);
      const adjustedVolatility = baseVolatility * currentRegime.volatilityFactor;
      const noise = (Math.random() * 2 - 1) * adjustedVolatility;

      const totalDelta = regimeDrift + eventBoost + noise;
      let newPrice = BigInt(Math.round(Number(currentPrice) * (1 + totalDelta)));

      if (newPrice < 10n) newPrice = 10n;

      // 24시간 고가 / 저가 갱신
      let high24h = BigInt(stock.high_24h || 0);
      let low24h = BigInt(stock.low_24h || 0);
      if (high24h === 0n || newPrice > high24h) high24h = newPrice;
      if (low24h === 0n || newPrice < low24h) low24h = newPrice;

      // 가상 거래량 누적
      const simVolume = BigInt(stock.volume_24h || 0) + BigInt(Math.floor(Math.random() * 50) + 10);

      await connection.query(`
        UPDATE stocks
        SET prev_price = price, price = ?, high_24h = ?, low_24h = ?, volume_24h = ?, updated_at = NOW()
        WHERE stock_id = ?
      `, [newPrice.toString(), high24h.toString(), low24h.toString(), simVolume.toString(), stockId]);

      // 히스토리 기록
      await connection.query(`
        INSERT INTO stock_history (stock_id, price)
        VALUES (?, ?)
      `, [stockId, newPrice.toString()]);
    }

    await connection.commit();
    console.log(`📈 [주식 엔진] 주가 변동 갱신 완료 (${currentRegime.name}) - ${stocks.length}개 종목${lastNews ? ` | 📢 뉴스: ${lastNews.title}` : ''}`);

    historyCleanupCounter++;
    if (historyCleanupCounter >= 10) {
      historyCleanupCounter = 0;
      await connection.query(`
        DELETE FROM stock_history
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY id DESC) as rn
            FROM stock_history
          ) t WHERE t.rn <= 50
        )
      `);
      await connection.query('DELETE FROM market_news_feed WHERE created_at < NOW() - INTERVAL 7 DAY');
    }

  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('❌ 주가 변동 엔진 에러:', error.message);
  } finally {
    connection.release();
  }
}

function getLastNews() {
  return lastNews;
}

function getCurrentMarketRegime() {
  return MARKET_REGIMES[currentRegimeIndex];
}

async function getRecentNewsFeed(limit = 10) {
  try {
    const [rows] = await pool.query('SELECT * FROM market_news_feed ORDER BY id DESC LIMIT ?', [limit]);
    return rows;
  } catch (e) {
    return [];
  }
}

// 텍스트 기반 아스키 차트 생성
function generateAsciiChart(historyPrices, height = 5) {
  if (!historyPrices || historyPrices.length === 0) {
    return '```차트 데이터가 없습니다.```';
  }

  const prices = historyPrices.map(p => Number(p));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const blocks = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  let line = '';

  for (const p of prices) {
    const norm = (p - min) / range;
    const blockIndex = Math.min(Math.floor(norm * blocks.length), blocks.length - 1);
    line += blocks[blockIndex];
  }

  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  const diff = lastPrice - firstPrice;
  const percent = ((diff / firstPrice) * 100).toFixed(2);
  const sign = diff >= 0 ? '+' : '';

  return `\`\`\`text
최저: ${min.toLocaleString()}원 | 최고: ${max.toLocaleString()}원 (${sign}${percent}%)
[과거] ${line} [현재]
\`\`\``;
}

module.exports = {
  updateStockPrices,
  getLastNews,
  getCurrentMarketRegime,
  getRecentNewsFeed,
  generateAsciiChart
};
