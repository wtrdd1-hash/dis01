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

// 타겟 섹터별 가상 경제 뉴스 & 공시 이벤트 풀 (30가지 이상의 풍부한 경제 시나리오)
const NEWS_EVENTS = [
  { 
    title: '🏦 중앙은행, 기준금리 전격 0.5%p 인하 발표',
    text: '중앙은행 금융통화위원회가 경기 부양과 물가 안정을 위해 기준금리를 파격적으로 인하했습니다. 시중 유동성이 증시와 가상자산 시장으로 대거 유입되고 있습니다.', 
    eventType: 'MACRO_POLICY',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'ALL',
    impactSector: '거시경제 & 금융',
    impact: { ALL: 0.06, BTC: 0.12, ETH: 0.10, AAPL: 0.05, NVDA: 0.06 } 
  },
  { 
    title: '📉 글로벌 CPI 물가지수 예상치 대폭 상회 긴축 공포',
    text: '미국 및 주요국 소비자물가지수(CPI)가 시장 예상치를 크게 상회하며 금리 인하 기대감이 후퇴했습니다. 차익 실현 및 위험자산 회피 매도세가 급증하고 있습니다.', 
    eventType: 'MACRO_POLICY',
    sentiment: 'BEAR',
    importance: 'URGENT',
    relatedStock: 'ALL',
    impactSector: '거시경제 & 금리',
    impact: { ALL: -0.06, BTC: -0.09, ETH: -0.08, NVDA: -0.05 } 
  },
  { 
    title: '🚀 엔비칩스, 10배 빠른 차세대 초거대 AI 슈퍼칩 양산 돌입',
    text: '엔비칩스가 기존 GPU 대비 1,000% 향상된 초저전력 차세대 AI 가속기 칩 양산에 성공했다고 발표했습니다. 글로벌 클라우드 빅테크의 독점 주문이 쇄도하고 있습니다.', 
    eventType: 'TECH_AI',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'NVDA',
    impactSector: '인공지능 & GPU 반도체',
    impact: { NVDA: 0.20, SAM: 0.09, AAPL: 0.05 } 
  },
  { 
    title: '⚡ 디스코인, 전 세계 10대 국부펀드 최초 포트폴리오 편입',
    text: '중동 및 아시아 주요 국부펀드가 국가 비축 자산의 3%를 디스코인에 전략적으로 배분하기로 의결했습니다. 기관 자금의 대규모 시장 유입이 시작되었습니다.', 
    eventType: 'CRYPTO',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'BTC',
    impactSector: '디지털 자산 & 블록체인',
    impact: { BTC: 0.22, ETH: 0.15 } 
  },
  { 
    title: '💎 에테르코인, 초당 10만 건 처리 차세대 샤딩 메인넷 가동',
    text: '에테르코인 네트워크의 레이어1 전송 속도가 100배 향상되고 수수료가 99% 절감되는 혁신적 샤딩 업그레이드가 성공적으로 배포되었습니다.', 
    eventType: 'CRYPTO',
    sentiment: 'BULL',
    importance: 'HIGH',
    relatedStock: 'ETH',
    impactSector: '스마트 컨트랙트 & Web3',
    impact: { ETH: 0.18, BTC: 0.05 } 
  },
  { 
    title: '🎉 알약바이오, 난치성 치매 표적 신약 미국 FDA 최종 승인!',
    text: '알약바이오의 핵심 파이프라인 신약이 미국 FDA로부터 만장일치로 신속 승인을 획득했습니다. 연간 5조원 이상의 독점 매출 창출이 기대됩니다.', 
    eventType: 'BIO_HEALTH',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'BIO',
    impactSector: '바이오 & 신약 개발',
    impact: { BIO: 0.35 } 
  },
  { 
    title: '⚠️ 알약바이오, 경쟁사 특허 침해 가처분 신청 및 소송 제기',
    text: '글로벌 다국적 제약사가 알약바이오의 주력 원천 물질에 대한 특허 침해 가처분 소송을 제기하며 단기적인 불확실성이 증대되고 있습니다.', 
    eventType: 'BIO_HEALTH',
    sentiment: 'BEAR',
    importance: 'HIGH',
    relatedStock: 'BIO',
    impactSector: '바이오 & 제약',
    impact: { BIO: -0.15 } 
  },
  { 
    title: '🍏 사과전자, 1:10 주식 액면분할 및 50조원 자사주 소각 공시',
    text: '사과전자가 주주가치 제고를 위해 10대 1 액면분할과 함께 역대 최대 규모의 자사주 매입 및 즉시 소각 계획을 발표했습니다. 개인 투자자 매수세가 폭발하고 있습니다.', 
    eventType: 'DIVIDEND_SPLIT',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'AAPL',
    impactSector: '빅테크 & 모바일 AI',
    impact: { AAPL: 0.16, SAM: 0.04 } 
  },
  { 
    title: '🏛️ 삼송전자, 차세대 1.4나노 극자외선(EUV) 파운드리 수율 90% 달성',
    text: '삼송전자가 차세대 초미세 반도체 공정에서 글로벌 경쟁사를 압도하는 수율을 달성하며 세계 유수의 팹리스 고객사들을 대거 영입했습니다.', 
    eventType: 'TECH_AI',
    sentiment: 'BULL',
    importance: 'HIGH',
    relatedStock: 'SAM',
    impactSector: '종합 전자 & 파운드리',
    impact: { SAM: 0.14, NVDA: 0.03 } 
  },
  { 
    title: '⚠️ 글로벌 희토류 및 반도체 핵심 원자재 공급망 일시 차질',
    text: '주요 광산 파업 및 해상 물류 운송 지연으로 반도체 웨이퍼 제조에 필수적인 희귀 가스 공급에 일시적인 차질이 발생했습니다.', 
    eventType: 'GEOPOLITICS',
    sentiment: 'BEAR',
    importance: 'HIGH',
    relatedStock: 'SAM',
    impactSector: '반도체 제조 공급망',
    impact: { SAM: -0.08, NVDA: -0.07 } 
  },
  { 
    title: '🔥 공매도 세력 대규모 강제 청산: 쇼트 스퀴즈 폭등 랠리!',
    text: '기관의 숏(공매도) 포지션이 강제 마진콜 청산되면서 시장가 매수세가 쏟아져 엔비칩스와 디스코인이 기록적인 폭등세를 기록했습니다.', 
    eventType: 'SHORT_SQUEEZE',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'ALL',
    impactSector: '시장 유동성 & 파생상품',
    impact: { NVDA: 0.15, BTC: 0.16, BIO: 0.10 } 
  },
  { 
    title: '🌐 글로벌 1위 신용카드사, 디스코인 & 에테르코인 1초 결제망 개방',
    text: '비자/마스터카드 전 세계 8천만 개 가맹점에서 암호화폐 무수수료 즉시 결제를 상용화했습니다. 실물 경제 결제 수단으로의 대중화가 가속화됩니다.', 
    eventType: 'FINTECH',
    sentiment: 'BULL',
    importance: 'HIGH',
    relatedStock: 'BTC',
    impactSector: '가상자산 & 핀테크',
    impact: { BTC: 0.14, ETH: 0.13 } 
  },
  { 
    title: '📊 삼송전자 & 사과전자, 분기 사상 최대 영업이익 어닝 서프라이즈',
    text: '온디바이스 AI 단말기 및 고대역폭메모리(HBM)의 역대급 수요 폭증에 힘입어 양사의 분기 영업이익이 전년 동기 대비 250% 급증했습니다.', 
    eventType: 'EARNINGS',
    sentiment: 'BULL',
    importance: 'HIGH',
    relatedStock: 'SAM',
    impactSector: '빅테크 & 전자부품',
    impact: { SAM: 0.12, AAPL: 0.11 } 
  },
  { 
    title: '🚨 국제 가상자산 규제 위원회, 불법 자금세탁 거래소 엄벌 발표',
    text: '주요 20개국(G20) 금융 당국이 비인가 가상자산 파생상품 거래소에 대한 고강도 전수 조사에 착수하며 단기 투자 심리가 위축되었습니다.', 
    eventType: 'CRYPTO',
    sentiment: 'BEAR',
    importance: 'NORMAL',
    relatedStock: 'BTC',
    impactSector: '가상자산 규제',
    impact: { BTC: -0.09, ETH: -0.08 } 
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
        sentiment: selectedEvent.sentiment,
        importance: selectedEvent.importance,
        impactSector: selectedEvent.impactSector,
        relatedStock: selectedEvent.relatedStock,
        regime: currentRegime.name
      };
      eventImpactMap = selectedEvent.impact;

      try {
        await connection.query(`
          INSERT INTO market_news_feed (title, content, event_type, impact_sector, related_stock, impact_rate, sentiment, importance)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          selectedEvent.title,
          selectedEvent.text,
          selectedEvent.eventType,
          selectedEvent.impactSector || '종합 시장',
          selectedEvent.relatedStock || 'ALL',
          selectedEvent.impact['ALL'] || selectedEvent.impact[Object.keys(selectedEvent.impact)[0]] || 0,
          selectedEvent.sentiment || 'BULL',
          selectedEvent.importance || 'NORMAL'
        ]);
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

async function getRecentNewsFeed(limit = 20) {
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
