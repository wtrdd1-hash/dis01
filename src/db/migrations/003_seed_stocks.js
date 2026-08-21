'use strict';

module.exports = {
  version: '003',
  name: '003_seed_stocks.js',
  async up(connection) {
    const defaultStocks = [
      { stock_id: 'WTRD', name: '월덕 인터내셔널 (지주사)', price: 50000, prev_price: 49500, volatility: 0.03, sector: '커뮤니티 지주 & AI 플랫폼', description: '월덕 봇과 디스코드 커뮤니티 전반의 인프라를 총괄 운영하는 핵심 지주회사입니다.', market_cap: 5000000000000, pe_ratio: 18.50, dividend_yield: 4.20 },
      { stock_id: 'DUCK', name: '오리 전자 & 테크놀로지 (IT)', price: 75000, prev_price: 74200, volatility: 0.04, sector: '하드웨어 & 클라우드 서버', description: '초고성능 게이밍 하드웨어 및 봇 호스팅 데이터센터 서버를 제조/공급하는 IT 대장주입니다.', market_cap: 7500000000000, pe_ratio: 22.00, dividend_yield: 2.80 },
      { stock_id: 'BANK', name: '덕스 중앙은행 (국책금융)', price: 25000, prev_price: 25100, volatility: 0.02, sector: '서버 기축 금융 & 예금/지원금', description: '커뮤니티 내 유저 예금 보관 및 이자 지급을 전담하는 초우량 국책 금융기관입니다.', market_cap: 4200000000000, pe_ratio: 9.80, dividend_yield: 5.50 },
      { stock_id: 'NEKO', name: '네코 에너지 & 냥코 랩스 (양자)', price: 8800, prev_price: 9200, volatility: 0.09, sector: '초전도 양자 & 미래 에너지', description: '신비한 고양이 꾹꾹이 에너지로 봇 서버 냉각 및 초전도 양자 컴퓨팅을 연구하는 미래 혁신 벤처입니다.', market_cap: 680000000000, pe_ratio: 65.00, dividend_yield: 0.50 },
      { stock_id: 'CHKN', name: '황금닭 치킨 & 푸드 테크 (소비재)', price: 3500, prev_price: 3450, volatility: 0.02, sector: '식음료 & 스테미나 푸드', description: '밤샘 도박과 주식 투자를 즐기는 유저들에게 바삭한 치킨을 공급하는 국민 프랜차이즈 기업입니다.', market_cap: 450000000000, pe_ratio: 14.50, dividend_yield: 3.80 },
      { stock_id: 'SLOT', name: '럭키세븐 다이아 복권 (초보입문/국민주)', price: 100, prev_price: 100, volatility: 0.06, sector: '초보자 입문 & 복권/테마', description: '💡 [신규 유저 추천] 1주당 100원의 국민 입문주입니다.', market_cap: 50000000000, pe_ratio: 15.00, dividend_yield: 1.50 },
      { stock_id: 'SCRP', name: '이지스크랩 데이터 테크 (빅데이터)', price: 120000, prev_price: 118000, volatility: 0.04, sector: '빅데이터 & 고속 웹 인프라', description: '초당 10만 건의 웹 데이터를 가공 분석하는 데이터 테크놀로지 기업입니다.', market_cap: 3800000000000, pe_ratio: 32.00, dividend_yield: 1.20 },
      { stock_id: 'AICH', name: '오리 인공지능 & 퀀텀 칩스 (AI 반도체)', price: 150000, prev_price: 148000, volatility: 0.05, sector: 'AI 반도체 & NPU 가속기', description: '차세대 뉴럴 프로세서(NPU)를 설계·양산하는 반도체 대장주입니다.', market_cap: 5200000000000, pe_ratio: 38.00, dividend_yield: 1.80 },
      { stock_id: 'SPAC', name: '덕스 에어로스페이스 & 방산 (우주항공)', price: 65000, prev_price: 63500, volatility: 0.05, sector: '우주항공 & 국방 방위산업', description: '우주 로켓 발사체 및 무인 방산 드론을 생산하는 우주항공 기업입니다.', market_cap: 2900000000000, pe_ratio: 21.00, dividend_yield: 3.00 },
      { stock_id: 'BIOX', name: '월덕 바이오 파마 (생명공학/신약)', price: 42000, prev_price: 41000, volatility: 0.07, sector: '바이오 헬스케어 & 신약 개발', description: '항암 신약 물질을 임상 개발하는 고수익 바이오테크 혁신 기업입니다.', market_cap: 1750000000000, pe_ratio: 45.00, dividend_yield: 0.80 }
    ];

    // ✅ ON DUPLICATE KEY UPDATE를 사용하여 안전하게 시드/업데이트하며, 기존 생성 종목은 절대 삭제하지 않음
    for (const stock of defaultStocks) {
      await connection.query(`
        INSERT INTO stocks (stock_id, name, price, prev_price, volatility, sector, description, market_cap, pe_ratio, dividend_yield)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
          name=VALUES(name), 
          volatility=VALUES(volatility),
          sector=VALUES(sector),
          description=VALUES(description),
          market_cap=VALUES(market_cap),
          pe_ratio=VALUES(pe_ratio),
          dividend_yield=VALUES(dividend_yield);
      `, [
        stock.stock_id, stock.name, stock.price, stock.prev_price, stock.volatility,
        stock.sector, stock.description, stock.market_cap, stock.pe_ratio, stock.dividend_yield
      ]);
    }
  }
};
