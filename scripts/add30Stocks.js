'use strict';

const { pool } = require('../src/config/database');

const new30Stocks = [
  { stock_id: 'NVAI', name: '엔비덕스 AI 칩셋 & 가속기 (반도체/AI)', price: 45000, volatility: 0.06, sector: 'AI 반도체', description: '생성형 AI 전용 NPU 및 초고대역폭 메모리 가속기를 설계/공급하는 글로벌 반도체 팹리스 기업입니다.', pe: 35.2, div: 1.2 },
  { stock_id: 'QNTM', name: '퀀텀 넥서스 컴퓨팅 (양자컴퓨팅)', price: 18000, volatility: 0.08, sector: '양자컴퓨팅', description: '초전도 큐비트 기반 차세대 양자 암호 및 초고속 양자 시뮬레이터를 개발하는 미래 기술 기업입니다.', pe: 58.0, div: 0.5 },
  { stock_id: 'ROBX', name: '사이버덕스 휴머노이드 로보틱스 (로봇)', price: 28000, volatility: 0.07, sector: '지능형 로봇', description: '산업용 협동 로봇 및 딥러닝 비전 기반 이족보행 휴머노이드 로봇을 양산하는 자동화 전문 기업입니다.', pe: 42.0, div: 1.0 },
  { stock_id: 'CLOD', name: '하이퍼스케일 클라우드 인프라 (클라우드)', price: 34000, volatility: 0.04, sector: '데이터/클라우드', description: '대규모 분산 서버 센터와 초저지연 CDN 및 엔터프라이즈 SaaS 인프라를 독점 운영하는 클라우드 기업입니다.', pe: 22.5, div: 2.5 },
  { stock_id: 'SATL', name: '스타링크 스페이스 궤도통신 (우주항공)', price: 22000, volatility: 0.06, sector: '우주/위성', description: '저궤도 군집 인공위성을 통한 초고속 글로벌 우주 인터넷망 구축 및 발사체 수송 기업입니다.', pe: 38.0, div: 0.8 },
  { stock_id: 'SEMI', name: '파운드리 실리콘 팹 (초미세공정)', price: 52000, volatility: 0.03, sector: '반도체 제조', description: '2나노 이하 차세대 게이트올어라운드(GAA) 초미세 파운드리 생산 라인을 가동하는 제조 파운드리입니다.', pe: 16.8, div: 3.2 },
  { stock_id: 'CYBR', name: '아이언실드 사이버 시큐리티 (보안)', price: 16500, volatility: 0.05, sector: '정보보안', description: '제로 트러스트 아키텍처 및 AI 기반 지능형 위협 탐지 시스템을 공급하는 국가 핵심 보안 기업입니다.', pe: 25.0, div: 2.0 },
  { stock_id: 'META', name: '홀로그램 메타버스 & VR (가상현실)', price: 14000, volatility: 0.08, sector: '메타버스/XR', description: '공간 컴퓨팅 헤드셋과 초실감 버추얼 월드 플랫폼을 구축하는 몰입형 XR 엔터테인먼트 기업입니다.', pe: 45.0, div: 0.6 },
  { stock_id: 'GENE', name: '유전자 가위 테라퓨틱스 (유전자치료)', price: 26000, volatility: 0.07, sector: '바이오/신약', description: 'CRISPR-Cas9 유전체 교정 기술로 난치성 유전 질환 치료제를 임상 개발하는 혁신 바이오텍입니다.', pe: 50.0, div: 0.5 },
  { stock_id: 'MEDI', name: '스마트 메디컬 AI 진단 (헬스케어)', price: 19500, volatility: 0.05, sector: '디지털 헬스', description: 'CT·MRI 영상 판독 인공지능 솔루션과 원격 스마트 헬스케어 플랫폼을 제공하는 의료 AI 선도기업입니다.', pe: 28.0, div: 1.5 },
  { stock_id: 'VACC', name: '나노 백신 바이오로직스 (면역항암제)', price: 31000, volatility: 0.06, sector: '바이오/항암제', description: 'mRNA 플랫폼과 지질나노입자(LNP) 전달체를 활용한 표적 면역 항암 신약을 개발하는 바이오 기업입니다.', pe: 34.0, div: 1.0 },
  { stock_id: 'CARE', name: '실버케어 & 바이오 에이징 (항노화)', price: 15000, volatility: 0.04, sector: '항노화/실버', description: '세포 역노화 치료제 및 초고령 사회 맞춤형 프리미엄 스마트 실버 케어 타운을 운영하는 기업입니다.', pe: 18.0, div: 2.8 },
  { stock_id: 'BATT', name: '전고체 기가 팩토리 2차전지 (배터리)', price: 42000, volatility: 0.06, sector: '2차전지', description: '화재 위험이 없는 차세대 전고체 배터리와 LFP 고밀도 배터리 셀을 대량 양산하는 에너지 기업입니다.', pe: 29.0, div: 1.8 },
  { stock_id: 'SOLR', name: '넥스트 퓨처 태양광 & 신재생 (친환경)', price: 11500, volatility: 0.05, sector: '친환경 에너지', description: '페로브스카이트 탠덤 태양광 패널과 대용량 산업용 ESS 전력망을 구축하는 클린테크 기업입니다.', pe: 15.0, div: 3.5 },
  { stock_id: 'HYDR', name: '블루 하이드로겐 수소 에너지 (수소)', price: 23000, volatility: 0.06, sector: '수소 경제', description: '청정 수전해 그린 수소 생산 및 액화 수소 운송 충전 인프라를 공급하는 수소 밸류체인 기업입니다.', pe: 32.0, div: 1.2 },
  { stock_id: 'EVMD', name: '자율주행 모빌리티 디바이스 (미래차)', price: 38000, volatility: 0.05, sector: '미래 모빌리티', description: '레벨4 도심 자율주행 소프트웨어 및 전동화 플랫폼을 완성차에 공급하는 모빌리티 테크 기업입니다.', pe: 26.0, div: 2.0 },
  { stock_id: 'ATOM', name: 'SMR 차세대 소형원자로 (원자력)', price: 27500, volatility: 0.05, sector: '차세대 원전', description: '무탄소 청정 에너지원인 4세대 소형 모듈 원자로(SMR) 설계 및 주기기 제작 대표 기업입니다.', pe: 21.0, div: 2.6 },
  { stock_id: 'GAME', name: '넥서스 인터랙티브 AAA 게임즈 (게임)', price: 29000, volatility: 0.06, sector: '게임 개발', description: '언리얼 엔진5 기반 글로벌 크로스플랫폼 오픈월드 AAA RPG 대작을 개발하는 게임 스튜디오입니다.', pe: 24.0, div: 2.2 },
  { stock_id: 'KPOP', name: '스타덤 글로벌 엔터테인먼트 (K-POP)', price: 36000, volatility: 0.07, sector: 'K-POP/엔터', description: '빌보드 핫100 1위 글로벌 최정상 아이돌 그룹 및 팬덤 커뮤니티 플랫폼을 운영하는 종합 엔터테인먼트사입니다.', pe: 31.0, div: 2.0 },
  { stock_id: 'TOON', name: 'K-스토리 글로벌 웹툰 & 애니 (콘텐츠)', price: 17500, volatility: 0.05, sector: '웹툰/콘텐츠', description: '글로벌 1억 뷰 웹툰 IP를 보유하고 넷플릭스·OTT 드라마 영상화 판권을 수출하는 K-스토리 대표 기업입니다.', pe: 27.0, div: 1.6 },
  { stock_id: 'FILM', name: '시네마틱 유니버스 스튜디오 (미디어)', price: 21000, volatility: 0.05, sector: '영화/미디어', description: '헐리우드급 버추얼 프로덕션 VFX 특수효과 및 글로벌 블록버스터 영화 제작을 총괄하는 스튜디오입니다.', pe: 20.0, div: 2.4 },
  { stock_id: 'SPRT', name: 'e스포츠 프로리그 & 스트리밍 (방송)', price: 13000, volatility: 0.06, sector: 'e스포츠/방송', description: '롤드컵/발로란트 명문 프로게임단 운영 및 라이브 인터랙티브 게임 스트리밍 플랫폼 기업입니다.', pe: 23.0, div: 1.5 },
  { stock_id: 'RAMN', name: 'K-스파이시 불닭 라면 인터내셔널 (K-푸드)', price: 16000, volatility: 0.03, sector: '식음료/식품', description: '전 세계 100개국에 K-매운맛 신드롬을 일으키며 연간 20억 봉지의 라면을 수출하는 글로벌 식품사입니다.', pe: 16.0, div: 3.8 },
  { stock_id: 'BEAU', name: 'K-글로우 코스메틱 & 뷰티 (K-뷰티)', price: 24500, volatility: 0.04, sector: '화장품/뷰티', description: '피부 장벽 강화 바이오 코스메슈티컬 및 글로벌 인디 뷰티 브랜드를 아마존 1위에 올린 K-뷰티 기업입니다.', pe: 19.5, div: 3.0 },
  { stock_id: 'FASH', name: '하이엔드 스트리트웨어 패션 (패션)', price: 19000, volatility: 0.05, sector: '패션/의류', description: 'MZ세대 워너비 디자이너 스트리트 패션 브랜드와 한정판 스니커즈 리셀 플랫폼을 운영하는 기업입니다.', pe: 22.0, div: 2.1 },
  { stock_id: 'MART', name: '초신선 로켓 물류 & e커머스 (유통)', price: 33000, volatility: 0.04, sector: '물류/유통', description: '새벽 배송 풀필먼트 물류 센터와 AI 수요 예측 풀필먼트 네트워크를 독점 보유한 유통 공룡입니다.', pe: 25.0, div: 1.8 },
  { stock_id: 'COFF', name: '프리미엄 로스터리 커피 & 카페 (음료)', price: 12000, volatility: 0.03, sector: '카페/프랜차이즈', description: '스페셜티 원두 직수입 로스팅 및 전국 3,000개 스마트 드라이브스루 매장을 직영하는 카페 브랜드입니다.', pe: 15.5, div: 4.0 },
  { stock_id: 'PAYX', name: '글로벌 핀테크 & 간편결제 (전자결제)', price: 28500, volatility: 0.04, sector: '핀테크/금융', description: '초간편 원터치 QR/NFC 온오프라인 결제 게이트웨이 및 소액 해외 송금을 독점 제공하는 금융 플랫폼입니다.', pe: 26.5, div: 2.2 },
  { stock_id: 'REIT', name: '월덕 강남 프라임 오피스 리츠 (부동산)', price: 9500, volatility: 0.02, sector: '부동산 리츠', description: '테헤란로 초고층 랜드마크 프라임 빌딩을 소유하여 매월 안정적인 임대 수익 배당을 지급하는 리츠입니다.', pe: 11.0, div: 6.8 },
  { stock_id: 'ARMS', name: '썬더볼트 첨단 유도미사일 방산 (K-방산)', price: 48000, volatility: 0.05, sector: '방위산업', description: '스텔스 무인 전투기, 천궁 유도무기 및 K2 전차 자주포를 나토(NATO)에 대량 수출하는 K-방산 대표 기업입니다.', pe: 17.5, div: 3.5 }
];

async function add30Stocks() {
  console.log('🚀 [30개 신규 혁신 종목 거래소 상장 시작]...');
  let addedCount = 0;

  for (const s of new30Stocks) {
    const marketCap = BigInt(s.price) * 100000000n;
    const [res] = await pool.query(`
      INSERT INTO stocks (
        stock_id, name, price, prev_price, volatility,
        sector, description, market_cap, pe_ratio, dividend_yield,
        status, high_24h, low_24h, volume_24h
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        'ACTIVE', ?, ?, 0
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        sector = VALUES(sector),
        description = VALUES(description),
        pe_ratio = VALUES(pe_ratio),
        dividend_yield = VALUES(dividend_yield)
    `, [
      s.stock_id,
      s.name,
      String(s.price),
      String(s.price),
      s.volatility,
      s.sector,
      s.description,
      marketCap.toString(),
      s.pe,
      s.div,
      String(s.price),
      String(s.price)
    ]);

    if (res.affectedRows > 0) {
      addedCount++;
      console.log(`✅ [상장 완료] ${s.name} (${s.stock_id}) - ${s.price.toLocaleString()}원 [${s.sector}]`);
    }
  }

  // 상장 공시 등록
  await pool.query(`
    INSERT INTO market_news_feed (title, content, event_type, impact_sector, impact_rate, sentiment, importance)
    VALUES (
      '🎉 [거래소 초대형 IPO 단행] 신성장 테마 30개 혁신 기업 동시 신규 상장!',
      '한국거래소 공시: AI 반도체, 양자컴퓨팅, 로봇, 2차전지, K-콘텐츠, 바이오, 방산 등 미래 신성장 산업을 이끌 30개 혁신 우량 기업이 거래소에 전격 신규 상장(IPO)되었습니다. 금일부터 웹 및 디스코드에서 전 종목 0.0001주 소수점 거래가 가능합니다.',
      'SUPER_IPO', '전체 시장', 0.35, 'BULL', 'URGENT'
    )
  `);

  console.log(`\n🎉 총 ${addedCount}개 신규 종목 상장 완료!`);
  process.exit(0);
}

add30Stocks().catch(err => {
  console.error('❌ 신규 종목 상장 오류:', err);
  process.exit(1);
});
