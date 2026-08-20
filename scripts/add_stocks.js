let pool;
try {
  pool = require('./src/config/database').pool;
} catch (e) {
  pool = require('../src/config/database').pool;
}

async function addStocks() {
  const newStocks = [
    {
      stock_id: 'CYBR',
      name: '사이버덕 보안 & 양자 암호화 (보안 테크)',
      price: '185000',
      prev_price: '180000',
      volatility: 0.05,
      dividend_yield: 2.50,
      pe_ratio: 24.0,
      sector: '사이버 보안 & 제로트러스트 클라우드',
      description: '사이버 공격 실시간 방어 및 양자 내성 암호화 전문 보안 기업'
    },
    {
      stock_id: 'GAME',
      name: '덕스 인터랙티브 게이밍 (메타버스/VR)',
      price: '95000',
      prev_price: '92000',
      volatility: 0.07,
      dividend_yield: 1.80,
      pe_ratio: 32.0,
      sector: 'AAA급 메타버스 게임 & 가상현실',
      description: '글로벌 히트 MMORPG 및 차세대 VR 가상현실 게임 개발사'
    },
    {
      stock_id: 'COSM',
      name: '월덕 우주 탐사 & 위성 통신 (스타링크)',
      price: '450000',
      prev_price: '440000',
      volatility: 0.06,
      dividend_yield: 0.80,
      pe_ratio: 45.0,
      sector: '저궤도 위성 통신 & 우주 로켓',
      description: '저궤도 초고속 위성 인터넷 통신망 및 우주 화물선 발사 기업'
    },
    {
      stock_id: 'SOLR',
      name: '그린덕 신재생 에너지 (태양광/수소)',
      price: '54000',
      prev_price: '52000',
      volatility: 0.04,
      dividend_yield: 3.80,
      pe_ratio: 16.0,
      sector: '차세대 수소 연료전지 & 청정에너지',
      description: '대규모 태양광 및 그린 수소 생산 인프라를 운영하는 친환경 에너지 기업'
    },
    {
      stock_id: 'MEME',
      name: '도지덕 밈코인 & NFT 파운데이션 (초고변동)',
      price: '777',
      prev_price: '700',
      volatility: 0.15,
      dividend_yield: 0.00,
      pe_ratio: 99.0,
      sector: '초고변동 밈코인 & 디지털 자산',
      description: '커뮤니티 열풍을 주도하는 초고변동성 밈 토큰 및 NFT 생태계'
    }
  ];

  console.log('🚀 신규 주식 5종목 등록 시작...');

  for (const s of newStocks) {
    await pool.query(`
      INSERT INTO stocks (stock_id, name, price, prev_price, volatility, dividend_yield, pe_ratio, sector, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        sector = VALUES(sector),
        description = VALUES(description),
        volatility = VALUES(volatility),
        dividend_yield = VALUES(dividend_yield),
        pe_ratio = VALUES(pe_ratio)
    `, [
      s.stock_id,
      s.name,
      s.price,
      s.prev_price,
      s.volatility,
      s.dividend_yield,
      s.pe_ratio,
      s.sector,
      s.description
    ]);

    // 초기 주가 히스토리 10개 생성 (차트용)
    const base = BigInt(s.price);
    for (let i = 10; i >= 1; i--) {
      const jitter = BigInt(Math.floor((Math.random() - 0.5) * Number(base) * 0.04));
      const histPrice = base + jitter;
      await pool.query(`
        INSERT INTO stock_history (stock_id, price, recorded_at)
        VALUES (?, ?, DATE_SUB(NOW(), INTERVAL ? MINUTE))
      `, [s.stock_id, histPrice.toString(), i * 5]);
    }

    console.log(`✅ [${s.stock_id}] ${s.name} 등록 완료`);
  }

  console.log('🎉 모든 신규 종목 등록 완료!');
  process.exit(0);
}

addStocks().catch(err => {
  console.error('오류:', err);
  process.exit(1);
});
