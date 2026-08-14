const { pool } = require('../config/database');

// 거시 경제 국면 정의 (Economic Regimes)
const MARKET_REGIMES = [
  { name: '📈 강세장 (Bull Market)', drift: 0.03, volatilityFactor: 1.0, desc: '전반적인 경제 호조로 시장 매수세가 우세합니다.' },
  { name: '📉 약세장 (Bear Market)', drift: -0.03, volatilityFactor: 1.2, desc: '경기 침체 우려로 투자 심리가 위축되어 있습니다.' },
  { name: '⚖️ 횡보장 (Sideways Market)', drift: 0.00, volatilityFactor: 0.8, desc: '뚜렷한 방향성 없이 좁은 박스권에서 움직입니다.' },
  { name: '🔥 인플레이션 Shock', drift: -0.02, volatilityFactor: 1.5, desc: '물가 상승과 금리 압박으로 변동성이 심화됩니다.' },
  { name: '🚀 기술 혁신 Boom', drift: 0.04, volatilityFactor: 1.3, desc: 'AI 및 첨단 기술 산업을 중심으로 대규모 자금이 유입됩니다.' }
];

// 타겟 섹터별 가상 경제 뉴스 이벤트
const NEWS_EVENTS = [
  { 
    text: '🏦 중앙은행, 기준금리 동결 시사! 증시 전반에 봄바람이 붑니다.', 
    impact: { ALL: 0.05, BTC: 0.08, ETH: 0.07 } 
  },
  { 
    text: '📉 예기치 못한 물가지수(CPI) 상승으로 중앙은행의 긴축 장기화 우려에 매도세가 쏟아집니다.', 
    impact: { ALL: -0.06, BTC: -0.08 } 
  },
  { 
    text: '🚀 엔비칩스, 차세대 AI 가속기 칩 획기적 성능 발표! AI 및 반도체 섹터 폭발적 상승!', 
    impact: { NVDA: 0.15, SAM: 0.08, AAPL: 0.04 } 
  },
  { 
    text: '⚡ 디스코인 대형 기관 자금 대량 유입! 가상자산 시장 전반 랠리!', 
    impact: { BTC: 0.16, ETH: 0.12 } 
  },
  { 
    text: '⚠️ 글로벌 반도체 공급망 차질 우려로 삼송전자 및 첨단 제조주 일시 조정.', 
    impact: { SAM: -0.07, NVDA: -0.05, AAPL: -0.04 } 
  },
  { 
    text: '🎉 알약바이오 핵심 신약 3상 성공 및 글로벌 제약사 기술 수출 계약 체결!', 
    impact: { BIO: 0.18 } 
  },
  { 
    text: '⚠️ 주요 국 바이오 임상 차질 소식 및 약가 규제 논의로 알약바이오 투심 악화.', 
    impact: { BIO: -0.10 } 
  },
  { 
    text: '🍏 사과전자, 혁신적인 차세대 온디바이스 AI 단말기 공개로 실적 기대감 폭발!', 
    impact: { AAPL: 0.10, SAM: 0.03 } 
  },
  { 
    text: '🏛️ 주요 7개국(G7) 가상자산 규제 강화 합의 소식에 디스코인 & 에테르코인 일시 하락.', 
    impact: { BTC: -0.10, ETH: -0.09 } 
  }
];

let currentRegimeIndex = 0; // 초기 강세장
let regimeCyclesLeft = 10;   // 10회 주기마다 경기 국면 전환 검토
let lastNews = null;

let historyCleanupCounter = 0;

async function updateStockPrices() {
  const connection = await pool.getConnection();
  try {
    // 경기 국면 주기 관리
    regimeCyclesLeft--;
    if (regimeCyclesLeft <= 0 || Math.random() < 0.15) {
      currentRegimeIndex = Math.floor(Math.random() * MARKET_REGIMES.length);
      regimeCyclesLeft = Math.floor(Math.random() * 8) + 8; // 8~15회 동안 국면 유지
    }
    const currentRegime = MARKET_REGIMES[currentRegimeIndex];

    const [stocks] = await connection.query('SELECT * FROM stocks');
    
    // 30% 확률로 현실적 경제 뉴스 이벤트 발생
    let eventImpactMap = {};
    lastNews = null;
    if (Math.random() < 0.3) {
      const selectedEvent = NEWS_EVENTS[Math.floor(Math.random() * NEWS_EVENTS.length)];
      lastNews = {
        text: selectedEvent.text,
        regime: currentRegime.name
      };
      eventImpactMap = selectedEvent.impact;
    }

    await connection.beginTransaction();

    for (const stock of stocks) {
      const currentPrice = BigInt(stock.price);
      const baseVolatility = parseFloat(stock.volatility);
      const stockId = stock.stock_id;

      // 1. 경기 국면 추세 (Regime Drift)
      const regimeDrift = currentRegime.drift;

      // 2. 이벤트 영향도 (Event Impact)
      const eventBoost = (eventImpactMap[stockId] || 0) + (eventImpactMap['ALL'] || 0);

      // 3. 종목 개별 변동성 (Random Noise)
      const adjustedVolatility = baseVolatility * currentRegime.volatilityFactor;
      const noise = (Math.random() * 2 - 1) * adjustedVolatility;

      // 총 변동률 계산
      const totalDelta = regimeDrift + eventBoost + noise;
      
      let newPrice = BigInt(Math.round(Number(currentPrice) * (1 + totalDelta)));

      // 최소 주가 제한 (10원 이상)
      if (newPrice < 10n) {
        newPrice = 10n;
      }

      await connection.query(`
        UPDATE stocks
        SET prev_price = price, price = ?, updated_at = NOW()
        WHERE stock_id = ?
      `, [newPrice.toString(), stockId]);

      // 히스토리 기록
      await connection.query(`
        INSERT INTO stock_history (stock_id, price)
        VALUES (?, ?)
      `, [stockId, newPrice.toString()]);
    }

    await connection.commit();

    // 10회 주기마다 30개 초과된 오래된 히스토리 자동 정돈 (DB 부하 최적화)
    historyCleanupCounter++;
    if (historyCleanupCounter >= 10) {
      historyCleanupCounter = 0;
      await connection.query(`
        DELETE FROM stock_history
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY id DESC) as rn
            FROM stock_history
          ) t WHERE t.rn <= 30
        )
      `);
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
  generateAsciiChart
};
