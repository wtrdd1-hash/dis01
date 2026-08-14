const { pool } = require('../config/database');

// 우리 커뮤니티 가상 경제 시황 국면 (Custom Community Economic Regimes)
const MARKET_REGIMES = [
  { name: '🦆 월덕 경제 번영기 (Duck Prosperity)', drift: 0.03, volatilityFactor: 1.0, desc: '서버 커뮤니티 활동과 채굴, 카지노 이용이 활발해지며 전 종목 매수세가 우세합니다.' },
  { name: '📉 가상 시장 조정기 (Market Cooldown)', drift: -0.02, volatilityFactor: 1.1, desc: '차익 실현 매물 출회와 자산 보수적 운용으로 단기 조정 국면에 진입했습니다.' },
  { name: '⚖️ 안정적 박스권 횡보 (Stable Sideways)', drift: 0.00, volatilityFactor: 0.7, desc: '예금과 실물 소비가 균형을 이루며 주가가 안정적인 가격대를 형성하고 있습니다.' },
  { name: '🔥 카지노 & 광산 대박 랠리 (Jackpot Boom)', drift: 0.04, volatilityFactor: 1.4, desc: '광산에서 초희귀 원석이 대량 출토되고 카지노 잭팟 열풍으로 투기적 매수세가 폭발합니다.' },
  { name: '🚀 냥코 양자 퀀텀 폭등 (Neko Quantum Surge)', drift: 0.05, volatilityFactor: 1.6, desc: '네코 랩스의 신비한 고양이 에너지 기술 발표로 첨단 테마주들이 폭등세를 주도합니다.' },
  { name: '🏦 중앙은행 유동성 무제한 살포 (Bank Liquidity)', drift: 0.04, volatilityFactor: 1.2, desc: '덕스 중앙은행의 지원금 확대와 예금 금리 우대로 풍부한 유동성이 증시로 유입됩니다.' }
];

// 우리만의 독창적인 가상 커뮤니티 기업 뉴스 & 경제 공시 풀 (30가지 이상의 서버 경제 시나리오)
const NEWS_EVENTS = [
  { 
    title: '🦆 월덕 인터내셔널, 월덕봇 2.0 초대형 업데이트 & 글로벌 서버 연동 공시',
    text: '월덕 지주사가 차세대 인공지능 경제 시스템 및 초고속 인터랙티브 웹 대시보드 2.0 릴리즈를 공식 발표했습니다. 커뮤니티 사용자 유입이 사상 최대치를 돌파했습니다.', 
    eventType: 'WTRD_UPDATE',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'WTRD',
    impactSector: '커뮤니티 지주 & AI 플랫폼',
    impact: { WTRD: 0.22, SCRP: 0.12, CASN: 0.08 } 
  },
  { 
    title: '⛏️ 월덕 광산 지하 700m에서 전설의 에메랄드 다이아 광맥 발견!',
    text: '클리커 채굴 유저들의 연타 작업 중 지하 암반층에서 순도 99.9%의 초대형 다이아몬드 광맥이 터졌습니다! 제련소 수출 주문이 폭주하며 광업 주가가 폭등합니다.', 
    eventType: 'MINING_BOOM',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'MINE',
    impactSector: '자원 개발 & 골드 채굴',
    impact: { MINE: 0.30, WTRD: 0.08, SLOT: 0.10 } 
  },
  { 
    title: '🎰 황금오리 카지노, 777 다이아몬드 50배 잭팟 당첨자 연속 배출!',
    text: '황금오리 카지노 슬롯머신과 주사위 룸에서 역대 최고액 당첨금이 연달아 터지며 서버 내 관광객과 배팅 자금이 물밀듯이 쏟아져 들어오고 있습니다.', 
    eventType: 'CASINO_JACKPOT',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'CASN',
    impactSector: '카지노 게이밍 & 엔터',
    impact: { CASN: 0.25, SLOT: 0.15, BANK: 0.05 } 
  },
  { 
    title: '🏦 덕스 중앙은행, 커뮤니티 기준금리 인하 및 기본소득 예산 200% 증액',
    text: '덕스 중앙은행 총재가 시장 유동성 공급과 초보 유저 정착을 위해 긴급 지원금 규모를 파격 확대한다고 발표했습니다. 전 종목 강력한 유동성 랠리가 시작됩니다.', 
    eventType: 'BANK_POLICY',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'BANK',
    impactSector: '서버 기축 금융 & 은행',
    impact: { ALL: 0.06, BANK: 0.16, WTRD: 0.09, CHKN: 0.07 } 
  },
  { 
    title: '🐱 네코 랩스, 상온 초전도 고양이 방석 & 냥코 양자 칩셋 개발 성공!',
    text: '네코 에너지가 고양이 꾹꾹이 파동을 이용해 무저항 상온 초전도체를 구현하는 획기적 양자 칩셋을 세계 최초로 공개했습니다. 매수 잔량이 수십만 주 쌓이고 있습니다.', 
    eventType: 'NEKO_QUANTUM',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'NEKO',
    impactSector: '초전도 양자 & 미래 에너지',
    impact: { NEKO: 0.40, SCRP: 0.10 } 
  },
  { 
    title: '🍗 황금닭 치킨, 심야 신메뉴 [마라뿌링클 콤보] 서버 전량 품절 사태',
    text: '주식 트레이더들과 카지노 유저들의 야식 주문 폭주로 황금닭 치킨의 전 매장 원료육이 30분 만에 완판되었습니다. 분기 사상 최대 영업이익이 확실시됩니다.', 
    eventType: 'FOOD_SURPRISE',
    sentiment: 'BULL',
    importance: 'HIGH',
    relatedStock: 'CHKN',
    impactSector: '식음료 & 스테미나 푸드',
    impact: { CHKN: 0.18, BANK: 0.03 } 
  },
  { 
    title: '⚡ 럭키세븐 다이아 복권, 1등 당첨금 10억 누적에 복권 매진 돌풍',
    text: '1등 당첨자가 5회 연속 이월되며 럭키세븐 복권 위원회의 잭팟 누적금이 천문학적으로 치솟았습니다. 1,000원짜리 복권 주식을 사려는 개미 투자자가 쇄도합니다.', 
    eventType: 'LOTTERY_FEVER',
    sentiment: 'BULL',
    importance: 'HIGH',
    relatedStock: 'SLOT',
    impactSector: '복권 & 럭키박스',
    impact: { SLOT: 0.28, CASN: 0.07 } 
  },
  { 
    title: '🌐 이지스크랩 데이터 테크, 초당 10만 건 분산 데이터 엔진 특허 취득',
    text: '이지스크랩이 전 세계 웹 데이터를 0.01초 만에 분석하여 시세와 로그를 스트리밍하는 독점 아키텍처 특허를 등록했습니다. 글로벌 IT 기업들과의 계약이 잇따르고 있습니다.', 
    eventType: 'TECH_INFRA',
    sentiment: 'BULL',
    importance: 'HIGH',
    relatedStock: 'SCRP',
    impactSector: '빅데이터 & 고속 웹 인프라',
    impact: { SCRP: 0.20, WTRD: 0.08 } 
  },
  { 
    title: '⚠️ 월덕 광산 제1갱도 안전 점검으로 24시간 채굴 임시 중단',
    text: '월덕 광업이 갱도 안전 강화를 위해 정기 보수 점검에 착수하며 단기 광석 생산량이 일시 감소했습니다. 투자자들의 단기 관망세가 짙어지고 있습니다.', 
    eventType: 'MINING_HALT',
    sentiment: 'BEAR',
    importance: 'HIGH',
    relatedStock: 'MINE',
    impactSector: '자원 개발 & 골드 채굴',
    impact: { MINE: -0.12 } 
  },
  { 
    title: '📉 네코 랩스, 고양이 낮잠 시간으로 양자 연산 가동률 일시 저하',
    text: '연구소 내 실험 냥이들의 단체 낮잠 타임으로 초전도 양자 연산 효율이 일시적으로 둔화되며 단기 차익 실현 매물이 출회되었습니다.', 
    eventType: 'NEKO_SLEEP',
    sentiment: 'BEAR',
    importance: 'NORMAL',
    relatedStock: 'NEKO',
    impactSector: '초전도 양자 & 미래 에너지',
    impact: { NEKO: -0.10 } 
  },
  { 
    title: '🎉 월덕 인터내셔널, 주주환원 1:5 무상증자 및 주당 5,000원 특별 배당',
    text: '월덕 지주사가 창립 기념 주주총회를 통해 역대급 무상증자와 고배당 지급을 결의했습니다. 장기 가치 투자자들의 매수세가 유입됩니다.', 
    eventType: 'DIVIDEND_BONUS',
    sentiment: 'BULL',
    importance: 'URGENT',
    relatedStock: 'WTRD',
    impactSector: '커뮤니티 지주 & AI 플랫폼',
    impact: { WTRD: 0.18, BANK: 0.06 } 
  },
  { 
    title: '⚠️ 황금닭 치킨, 생닭 사료용 곡물가 상승으로 원가 부담 증가',
    text: '국제 곡물가 변동으로 사료비 부담이 가중되었으나, 프리미엄 신메뉴 출시를 통해 수익성 방어에 나설 것으로 전망됩니다.', 
    eventType: 'COST_PRESSURE',
    sentiment: 'BEAR',
    importance: 'NORMAL',
    relatedStock: 'CHKN',
    impactSector: '식음료 & 스테미나 푸드',
    impact: { CHKN: -0.06 } 
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
    
    // 35% 확률로 커뮤니티 뉴스 이벤트 발생 및 DB 저장
    let eventImpactMap = {};
    lastNews = null;
    if (Math.random() < 0.35) {
      const selectedEvent = NEWS_EVENTS[Math.floor(Math.random() * NEWS_EVENTS.length)];
      lastNews = {
        title: selectedEvent.title,
        text: selectedEvent.text,
        eventType: selectedEvent.eventType,
        sentiment: selectedEvent.sentiment,
        importance: selectedEvent.importance
      };
      eventImpactMap = selectedEvent.impact || {};

      try {
        await connection.query(`
          INSERT INTO market_news_feed (title, content, event_type, impact_sector, related_stock, impact_rate, sentiment, importance)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          selectedEvent.title,
          selectedEvent.text,
          selectedEvent.eventType,
          selectedEvent.impactSector || null,
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

      // 실시간 주가 변동 틱 상세 로그 영구 기록
      const diff = newPrice - currentPrice;
      const changeRate = currentPrice > 0n ? ((Number(diff) / Number(currentPrice)) * 100).toFixed(2) : '0.00';
      const reasonStr = lastNews ? `[${lastNews.title}]` : `${currentRegime.name} 시황 변동`;

      try {
        await connection.query(`
          INSERT INTO stock_price_logs (stock_id, stock_name, prev_price, new_price, change_rate, diff, regime, reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          stockId, stock.name, currentPrice.toString(), newPrice.toString(),
          changeRate, diff.toString(), currentRegime.name, reasonStr
        ]);
      } catch (logErr) {}
    }

    await connection.commit();
    console.log(`📈 [월덕 가상 경제 엔진] 주가 변동 갱신 완료 (${currentRegime.name}) - ${stocks.length}개 종목${lastNews ? ` | 📢 공시: ${lastNews.title}` : ''}`);

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
    }
  } catch (error) {
    await connection.rollback().catch(() => {});
    console.error('❌ 주식 가격 변동 업데이트 실패:', error);
  } finally {
    connection.release();
  }
}

function startStockEngine(intervalMs = 60000) {
  console.log(`🚀 [월덕 가상 경제 엔진] 가동 시작 (갱신 주기: ${intervalMs / 1000}초)`);
  setTimeout(() => {
    updateStockPrices();
  }, 3000);
  setInterval(updateStockPrices, intervalMs);
}

function getCurrentMarketRegime() {
  return MARKET_REGIMES[currentRegimeIndex];
}

function getLastNews() {
  return lastNews;
}

async function getRecentNewsFeed(limit = 20) {
  try {
    const [rows] = await pool.query('SELECT * FROM market_news_feed ORDER BY id DESC LIMIT ?', [limit]);
    return rows;
  } catch (e) {
    return [];
  }
}

module.exports = {
  updateStockPrices,
  startStockEngine,
  getCurrentMarketRegime,
  getLastNews,
  getRecentNewsFeed,
  MARKET_REGIMES,
  NEWS_EVENTS
};
