const { pool } = require('../config/database');
const { STOCK, clampStockDelta, hourlyDividendForHolding } = require('./economyBalance');
const { pushUserLive } = require('./liveSync');
const { whereNotAdmin } = require('./economyCohort');

// 우리 커뮤니티 가상 경제 시황 국면 (Custom Community Economic Regimes - 역동적 박스권 & 경기 사이클)
const MARKET_REGIMES = [
  { id: 'BOOM', type: 'SUPER_BULL', name: '🦆 월덕 경제 번영기 (Duck Prosperity)', drift: 0.025, volatilityFactor: 1.0, desc: '커뮤니티 활동과 소비가 활발해지며 전반적인 매수세가 완만하게 우세합니다.' },
  { id: 'COOLDOWN', type: 'RECESSION', name: '📉 가상 시장 차익실현 조정기 (Market Cooldown)', drift: -0.015, volatilityFactor: 1.1, desc: '단기 급등에 따른 차익 실현 매물 출회로 전반적인 숨고르기 조정 국면에 진입했습니다.' },
  { id: 'STABLE', type: 'NORMAL', name: '⚖️ 안정적 박스권 횡보 (Stable Sideways)', drift: 0.005, volatilityFactor: 0.7, desc: '매수세와 매도세가 팽팽하게 맞서며 주가가 안정적인 가격대를 형성하고 있습니다.' },
  { id: 'RALLY', type: 'BULL', name: '🔥 카지노 & 광산 단기 랠리 (Jackpot Boom)', drift: 0.035, volatilityFactor: 1.3, desc: '단기 테마성 자금이 유입되며 일부 종목이 상승 탄력을 받습니다.' },
  { id: 'TIGHTENING', type: 'CRASH', name: '❄️ 시장 긴축 & 매물 소화기 (Market Tightening)', drift: -0.020, volatilityFactor: 1.2, desc: '중앙은행의 유동성 흡수와 현금 확보 심리로 주가가 하락세를 보입니다.' },
  { id: 'SLUMP', type: 'CRASH', name: '📉 경기 둔화 & 투자 심리 위축 (Market Slump)', drift: -0.022, volatilityFactor: 1.3, desc: '투자자들의 관망세와 손절 매물 출회로 주요 종목들이 약세를 면치 못하고 있습니다.' },
  { id: 'PANIC', type: 'CRASH', name: '⚠️ 패닉 셀 & 저가 매수 공방 (Panic Sell & Dip Buy)', drift: -0.010, volatilityFactor: 1.4, desc: '변동성이 극대화되며 급락과 반등이 치열하게 교차하는 구간입니다.' },
  { id: 'LIQUIDITY', type: 'SUPER_BULL', name: '🏦 중앙은행 유동성 완화 (Bank Liquidity)', drift: 0.028, volatilityFactor: 1.0, desc: '중앙은행의 유동성 공급으로 증시에 자금이 완만하게 유입됩니다.' },
  { id: 'LOW_VOL', type: 'NORMAL', name: '⚖️ 저변동 수렴 국면 (Low Volatility Range)', drift: 0.002, volatilityFactor: 0.6, desc: '거래량이 줄어들며 특정 지지선과 저항선 사이에서 수렴합니다.' }
];

// 120가지 이상의 독창적인 가상 커뮤니티 기업 뉴스 & 경제 공시 풀
const NEWS_EVENTS = [
  // 🦆 1. 월덕 인터내셔널 (WTRD) - 15개
  { title: '🦆 월덕 인터내셔널, 월덕봇 2.0 초대형 업데이트 & 글로벌 서버 연동 공시', text: '월덕 지주사가 차세대 인공지능 경제 시스템 및 초고속 인터랙티브 웹 대시보드 2.0 릴리즈를 공식 발표했습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.22, SCRP: 0.12, CASN: 0.08 } },
  { title: '🦆 월덕 지주사, 서버 인프라 글로벌 10개국 확장 계약 체결', text: '북미, 유럽, 아시아 거점 서버망을 증설하며 해외 사용자 트래픽이 300% 폭증했습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.18, SCRP: 0.10 } },
  { title: '🎉 월덕 인터내셔널, 1:5 무상증자 및 주당 특별 배당 결의', text: '월덕 지주사가 창립 기념 주주총회를 통해 역대급 무상증자와 고배당 지급을 결의했습니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.19, BANK: 0.06 } },
  { title: '🦆 월덕봇 AI 음성 비서 기능 전격 탑재 및 유료 구독 모델 론칭', text: '디스코드 음성 채널에서 실시간으로 경제 시황을 브리핑해주는 음성 비서가 공개되었습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.14, SCRP: 0.06 } },
  { title: '🦆 디스코드 공식 인증 Verified 봇 선정 & 메인 피처드 등록', text: '디스코드 개발자 포털 메인에 월덕봇이 공식 추천 봇으로 선정되며 신규 가입자가 폭주합니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.25, ALL: 0.05 } },
  { title: '⚠️ 월덕 인터내셔널, 대규모 서버 정기 점검 4시간 연장 안내', text: '클라우드 DB 마이그레이션 작업 지연으로 점검이 연장되며 단기 관망세가 형성되었습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: -0.08 } },
  { title: '🦆 월덕 지주사, 자사주 100만 주 장내 전량 소각 결정', text: '주주 가치 제고를 위해 보유 중인 자사주 100만 주를 전격 소각하여 주당 순자산 가치가 급상승했습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.16 } },
  { title: '🦆 월덕 엔터프라이즈 B2B 봇 솔루션, 100억원 규모 납품 계약 수주', text: '대형 게임사 커뮤니티 운영 봇 독점 공급 계약을 체결하며 기업 실적이 크게 개선되었습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.20, BANK: 0.05 } },
  { title: '🦆 월덕 보안팀, 대규모 디도스 공격 100% 실시간 방어 성공', text: '악의적 트래픽 공격을 0.001초 만에 우회 차단하며 시스템 신뢰도를 입증했습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.11, SCRP: 0.07 } },
  { title: '🦆 월덕봇 공식 굿즈 스토어 오픈 3분 만에 전 품목 완판', text: '월덕 인형과 키캡, 머그잔 한정판이 품절되며 부가 사업 수익이 급증했습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.13, CHKN: 0.04 } },
  { title: '🦆 월덕 호스팅 서버 아키텍처 개편으로 인프라 유지비용 60% 절감', text: '경량화 프레임워크 도입으로 고정비가 획기적으로 줄어들어 분기 영업이익률이 40%를 돌파했습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.15 } },
  { title: '⚠️ 월덕 AI 모델 파인튜닝 오류로 단기 답변 지연 해프닝 발생', text: '학습 데이터셋 정합성 문제로 일시적 답변 딜레이가 발생했으나 1시간 내에 핫픽스 패치되었습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: -0.06 } },
  { title: '🦆 월덕 인터내셔널, 분기 매출액 500억원 돌파 어닝 서프라이즈', text: '시장 컨센서스를 35% 상회하는 역대 최대 분기 실적을 공시했습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.23, BANK: 0.08 } },
  { title: '🦆 월덕 독점 특허 [가상 커뮤니티 실시간 경제 분산 원장] 등록 완료', text: '특허청으로부터 독점적인 가상 자산 처리 기술에 대한 특허권을 공식 인정받았습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.17, SCRP: 0.09 } },
  { title: '🦆 월덕 지주사, 커뮤니티 공헌 우수 유저 대상 감사 특별 상여금 지급', text: '서버 기여도가 높은 유저들에게 총 5억원의 현금 상여금을 지급하며 충성도가 극대화되었습니다.', eventType: 'WTRD_UPDATE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'WTRD', impactSector: '커뮤니티 지주 & AI 플랫폼', impact: { WTRD: 0.12, ALL: 0.03 } },

  // ⛏️ 2. 월덕 광업 & 제련 (MINE) - 15개
  { title: '⛏️ 월덕 광산 지하 700m에서 전설의 에메랄드 다이아 광맥 발견!', text: '클리커 채굴 유저들의 연타 작업 중 지하 암반층에서 순도 99.9%의 초대형 다이아몬드 광맥이 터졌습니다!', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.30, WTRD: 0.08, SLOT: 0.10 } },
  { title: '⛏️ 월덕 제련소, 고대 미스릴 원석 제련 성공 및 우주선 외피 납품', text: '고온 플라즈마 제련을 통해 초경량 고강도 미스릴 합금 양산에 성공했습니다.', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.26, NEKO: 0.10 } },
  { title: '⛏️ 채굴 봇 자동화 시스템 3.0 도입으로 일일 골드 생산량 300% 폭증', text: 'AI 무인 굴착 로봇 부대가 투입되어 24시간 쉬지 않는 채굴이 시작되었습니다.', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.22, SCRP: 0.07 } },
  { title: '⛏️ 국제 골드 & 원자재 선물 시세 신고가 돌파에 광산 채굴 수익 급증', text: '안전자산 선호 심리로 금 시세가 폭등하며 월덕 광업의 마진율이 50%를 넘어섰습니다.', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.18, BANK: 0.06 } },
  { title: '⛏️ 초순도 리튬 및 희토류 매장량 5,000만 톤 공식 확인', text: '지질연구소의 정밀 탐사 결과 향후 50년간 채굴 가능한 막대한 자원이 확인되었습니다.', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.28, NEKO: 0.12 } },
  { title: '⚠️ 월덕 광산 제1갱도 안전 점검으로 24시간 채굴 임시 중단', text: '월덕 광업이 갱도 안전 강화를 위해 정기 보수 점검에 착수하며 단기 광석 생산량이 일시 감소했습니다.', eventType: 'MINING_HALT', sentiment: 'BEAR', importance: 'HIGH', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: -0.12 } },
  { title: '⚠️ 채굴기 드릴 모터 결함 발생으로 일부 굴착 라인 정비 진행', text: '드릴 장비 소모품 교체로 반나절 동안 제련소 가동률이 소폭 하락했습니다.', eventType: 'MINING_HALT', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: -0.07 } },
  { title: '⛏️ 클리커 채굴 유저 10만 명 돌파 기념 골드 드랍률 2배 이벤트', text: '광산 참여자가 폭발적으로 늘어나며 제련 수수료 수익이 급증했습니다.', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.16, CASN: 0.05 } },
  { title: '⛏️ 월덕 광업, 심해 해저 광물 탐사권 독점 취득 공시', text: '태평양 해저 열수광상 탐사권을 획득하여 심해 광물 채굴 시대를 열었습니다.', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.21 } },
  { title: '⛏️ 친환경 슬래그 재활용 친환경 건축자재 신사업 진출', text: '제련 부산물을 고강도 친환경 시멘트로 가공하는 신사업이 순풍을 타고 있습니다.', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.13 } },
  { title: '⛏️ 광부 노조와 무분규 임금 협상 체결 및 생산성 보너스 지급', text: '노사 화합을 바탕으로 사상 최고 가동률을 유지하기로 합의했습니다.', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.11 } },
  { title: '⚠️ 제2광구 지하수 용출로 배수 펌프 긴급 가동 작업 진행', text: '지하수 유입으로 일부 채굴 구역의 접근이 제한되었으나 정상 복구 중입니다.', eventType: 'MINING_HALT', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: -0.08 } },
  { title: '⛏️ 초고온 플라즈마 제련로 4호기 증설 완공 및 시운전 성공', text: '제련 처리 용량이 기존 대비 2배로 확장되어 납품 대기 시간이 절반으로 단축되었습니다.', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.19 } },
  { title: '⛏️ 월덕 광업, 순이익 80% 주주 배당 및 골드 바 현물 교환권 지급', text: '주주들에게 순이익을 파격 환원하고 실물 골드 바 교환 혜택을 제공합니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.20, BANK: 0.07 } },
  { title: '⛏️ 초희귀 루비 사파이어 원석 100캐럿 발굴로 박물관 경매 출품', text: '초고가 보석 경매로 인한 일회성 영업외이익이 수백억 원 유입될 전망입니다.', eventType: 'MINING_BOOM', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'MINE', impactSector: '자원 개발 & 골드 채굴', impact: { MINE: 0.15, SLOT: 0.08 } },

  // 🎰 3. 황금오리 카지노 & 엔터 (CASN) - 15개
  { title: '🎰 황금오리 카지노, 777 다이아몬드 50배 잭팟 당첨자 연속 배출!', text: '황금오리 카지노 슬롯머신과 주사위 룸에서 역대 최고액 당첨금이 연달아 터지며 배팅 자금이 쏟아집니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.25, SLOT: 0.15, BANK: 0.05 } },
  { title: '🎰 카지노 VIP 하이롤러 전용 라운지 오픈 & 예약 마감', text: '1억 이상 배팅 가능한 VIP 전용 룸이 오픈 첫날부터 전석 매진을 기록했습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.21, BANK: 0.07 } },
  { title: '🎰 주말 카지노 동시 접속자 10만 명 돌파 신기록 달성', text: '동전 던지기와 슬롯머신 이용자 수가 사상 최고치를 경신하며 하우스 수익이 폭증했습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.23 } },
  { title: '🎰 황금오리 홀덤 & 주사위 챔피언십 토너먼트 상금 10억원 개최', text: '전 세계 최강 겜블러들이 모이는 초대형 대회가 성황리에 개막했습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.17, CHKN: 0.06 } },
  { title: '🎰 카지노 국제 라이선스 최고 등급 획득 및 무세금 관광 특구 지정', text: '합법적 글로벌 게이밍 라이선스를 획득하여 해외 배팅 자금이 유입됩니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.19, WTRD: 0.06 } },
  { title: '⚠️ 카지노 슬롯머신 배팅 확률 검증 점검으로 2시간 정기 점검', text: '공정성 검증 기구의 랜덤 넘버 알고리즘 감사로 단기 영업이 일시 중지되었습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: -0.06 } },
  { title: '🎰 카지노 모바일 웹 3D 그래픽 엔진 탑재 및 초고속 릴 회전 패치', text: '모바일 환경에서 렉 없는 60FPS 애니메이션이 구현되어 플레이 만족도가 향상되었습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.14, SCRP: 0.06 } },
  { title: '🎰 인기 스트리머의 [카지노 올인 챌린지] 생방송 동시시청자 30만 돌파', text: '바이럴 영상 확산으로 신규 겜블러들이 폭발적으로 유입되고 있습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.22, SLOT: 0.09 } },
  { title: '🎰 황금오리 엔터, 유명 K-POP 스타 초청 카지노 디너쇼 전석 매진', text: '엔터테인먼트 부문 티켓 판매 수익과 부가 호텔 매출이 급증했습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.15 } },
  { title: '🎰 메가 프로그레시브 잭팟 누적금 100억원 돌파로 전국적 배팅 열풍', text: '한 번만 당첨되면 인생 역전이 가능한 메가 잭팟에 전국 유저들이 몰리고 있습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.27, SLOT: 0.16 } },
  { title: '⚠️ 카지노 무료 음료 및 뷔페 페이백 이벤트로 일시적 마케팅 비용 증가', text: '대규모 고객 유치 이벤트로 단기 영업비용이 증가했으나 유저 유입 효과는 뚜렷합니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: -0.05 } },
  { title: '🎰 카지노 공정성 블록체인 검증 통과 100% 무결점 인증', text: '모든 게임 결과의 암호학적 무결성이 입증되어 유저 신뢰도가 최상위로 올랐습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.13 } },
  { title: '🎰 카지노 멤버십 다이아몬드 등급 리워드 캐시백 5% 도입', text: '충성도 높은 고액 배팅 유저들의 락인 효과로 일일 배팅 총액이 200% 증가했습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.16 } },
  { title: '🎰 황금오리 호텔 & 테마파크 복합 리조트 착공 발표', text: '카지노 부지 인근에 초대형 복합 테마파크를 조성하기로 결정했습니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.20, CHKN: 0.08 } },
  { title: '🎰 럭키 다이스 연속 10연승 기록자 탄생 및 기념 이벤트 진행', text: '주사위 대결에서 신화적인 10연승을 달성한 유저 탄생으로 커뮤니티가 들썩입니다.', eventType: 'CASINO_JACKPOT', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CASN', impactSector: '카지노 게이밍 & 엔터', impact: { CASN: 0.12 } },

  // 🏦 4. 덕스 중앙은행 & 파이낸스 (BANK) - 15개
  { title: '🏦 덕스 중앙은행, 커뮤니티 기준금리 인하 및 기본소득 예산 200% 증액', text: '덕스 중앙은행 총재가 시장 유동성 공급을 위해 긴급 지원금 규모를 파격 확대한다고 발표했습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { ALL: 0.06, BANK: 0.16, WTRD: 0.09, CHKN: 0.07 } },
  { title: '🏦 덕스 중앙은행, 정기 예금 금리 연 15% 특별 우대 상품 전격 출시', text: '이자 수익을 극대화하려는 유저들의 예금 입금이 1,000억 원을 돌파했습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.20, WTRD: 0.05 } },
  { title: '🏦 국제 금융 신용평가기관 최고 등급 AAA 획득', text: '철저한 자산 관리와 무차입 경영으로 최상의 금융 안정성을 공식 공인받았습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.18, ALL: 0.04 } },
  { title: '🏦 디지털 화폐(CBDC) 인프라 구축 및 초고속 계좌 이체 수수료 전면 면제', text: '서버 내 모든 금융 거래의 즉시 결제 처리 시스템이 정착되었습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.14, SCRP: 0.07 } },
  { title: '🏦 저신용 유저 대상 긴급 무담보 기본소득 펀드 100억원 조성', text: '파산 위기에 처한 개미 투자자 구제 금융을 가동하며 시장 소비력이 회복되었습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.13, ALL: 0.03 } },
  { title: '⚠️ 중앙은행 전산망 정기 보안 감사로 30분간 계좌 이체 일시 지연', text: '금융 보안 고도화 작업으로 인해 단기 거래량이 일시적으로 숨고르기에 들어갔습니다.', eventType: 'BANK_POLICY', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: -0.05 } },
  { title: '🏦 외환 보유액 및 비트코인 준비금 사상 최대치 돌파', text: '중앙은행 금고의 외환 및 가상자산 보유량이 최고치를 기록하며 지급준비율이 완벽해졌습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.19, CASN: 0.06 } },
  { title: '🏦 분기 이자 및 수수료 순이익 역대 최대 달성 공시', text: '대출과 예금의 성공적인 운용으로 순이자마진(NIM)이 사상 최고 수준을 기록했습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.17 } },
  { title: '🏦 덕스 중앙은행, 주주 대상 연 8.0% 고배당 지급 확정', text: '금융업종 최고 수준의 현금 배당을 결의하여 배당주 투자자들의 매수세가 쇄도합니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.22, WTRD: 0.07 } },
  { title: '🏦 모바일 뱅킹 원터치 입출금 UI 개편으로 일일 거래 건수 50만 건 돌파', text: '누구나 1초 만에 예금과 현금을 이체할 수 있는 간편 뱅킹이 호평을 받고 있습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.12 } },
  { title: '🏦 파산 방지 세이프티 가드 펀드 가동으로 악성 부실 채권 0% 달성', text: '선제적 리스크 관리로 대손충당금 환입액이 대규모 발생했습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.15 } },
  { title: '⚠️ 예금 이자 일괄 지급일 도래에 따른 단기 은행 현금 유출', text: '수많은 예금자들에게 이자를 지급하며 일시적인 유동성 조정이 발생했습니다.', eventType: 'BANK_POLICY', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: -0.06, CHKN: 0.05 } },
  { title: '🏦 덕스 투자증권 설립 인가 획득 및 위탁매매 수수료 0원 선언', text: '증권업 진출을 통해 주식 거래 고객을 대거 유치하고 시너지를 극대화합니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.21, WTRD: 0.09 } },
  { title: '🏦 중앙은행 총재 [서버 경제 안정과 지속 성장] 특별 담화 발표', text: '물가와 주가의 균형 발전을 위한 정책 로드맵을 발표하며 시장 신뢰를 견인했습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.11, ALL: 0.03 } },
  { title: '🏦 핀테크 오픈뱅킹 API 글로벌 연동 승인', text: '전 세계 금융 앱에서 덕스 은행 계좌를 직접 조회하고 송금할 수 있게 되었습니다.', eventType: 'BANK_POLICY', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'BANK', impactSector: '서버 기축 금융 & 은행', impact: { BANK: 0.14, SCRP: 0.08 } },

  // 🐱 5. 네코 에너지 & 냥코 랩스 (NEKO) - 15개
  { title: '🐱 네코 랩스, 상온 초전도 고양이 방석 & 냥코 양자 칩셋 개발 성공!', text: '네코 에너지가 고양이 꾹꾹이 파동을 이용해 무저항 상온 초전도체를 구현하는 칩셋을 공개했습니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.40, SCRP: 0.10 } },
  { title: '🐱 냥코 랩스, 츄르 추출 무한 에너지 퀀텀 배터리 시제품 발표', text: '츄르 1봉지로 전기차를 10만 km 주행할 수 있는 친환경 바이오 배터리 기술이 공개되었습니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.32, CHKN: 0.07 } },
  { title: '🐱 고양이 털 안 빠지는 퀀텀 정전기 방지 방석 세계 특허 취득', text: '집사들의 평생 숙원이었던 털 빠짐 문제를 양자 역학으로 완벽 해결했습니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.22 } },
  { title: '🐱 우주 탐사용 냥코 워프 드라이브 엔진 나사(NASA) 공동 연구 협약', text: '심우주 탐사선에 네코 랩스의 초전도 양자 엔진을 탑재하는 국제 프로젝트가 출범했습니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.28, WTRD: 0.08 } },
  { title: '⚠️ 연구소 실험 냥이들의 단체 낮잠으로 양자 연산 효율 일시 둔화', text: '오후 2시 단체 햇살 낮잠 타임으로 양자 슈퍼컴퓨터의 가동률이 잠시 주춤했습니다.', eventType: 'NEKO_SLEEP', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: -0.09 } },
  { title: '🐱 상온 초전도체 기가팩토리 1호 공장 완공 및 양산 개시', text: '연구 단계를 넘어 연간 100만 장의 초전도 웨이퍼를 양산할 수 있는 설비가 완공되었습니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.35, MINE: 0.12 } },
  { title: '🐱 고양이 뇌파 완벽 통역기 2.0 출시 및 앱스토어 1위 달성', text: '야옹 소리와 꼬리 흔들림을 99.9% 한국어로 번역하는 웨어러블 디바이스가 선풍적 인기를 끕니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.24 } },
  { title: '🐱 냥코 양자 암호화 통신 모듈 글로벌 군사 안보 표준 채택', text: '해킹이 원천 불가능한 양자 얽힘 통신 모듈을 국방부에 독점 공급합니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.27, SCRP: 0.11 } },
  { title: '⚠️ 캣닢 향 원료 공급 지연으로 일부 향기 배터리 라인 점검 진행', text: '유기농 캣닢 수확기 지연으로 단기 생산 일정이 소폭 조정되었습니다.', eventType: 'NEKO_SLEEP', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: -0.07 } },
  { title: '🐱 미래 에너지 혁신 대상 최고 과학기술 훈장 수훈', text: '인류 에너지 문제 해결에 기여한 공로로 세계적인 과학 기술상을 수상했습니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.18 } },
  { title: '🐱 냥코 인공광합성 효율 95% 달성으로 탄소 제로 공장 인증', text: '공기 중 이산화탄소를 흡수하여 고순도 산소와 청정에너지를 만드는 기술을 완성했습니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.23 } },
  { title: '🐱 냥코 초전도 무선 충전 패드 전 세계 자동차 표준 탑재', text: '주차장에 차를 대기만 하면 3분 만에 완충되는 초고속 양자 충전 패드가 상용화되었습니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.29, MINE: 0.08 } },
  { title: '⚠️ 캣타워 안전 점검으로 메인 연구실 1시간 출입 통제', text: '고양이들의 안전한 연구 환경 조성을 위한 시설 보강 작업이 진행되었습니다.', eventType: 'NEKO_SLEEP', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: -0.05 } },
  { title: '🐱 냥코 랩스, 글로벌 바이오 헬스케어 기업 인수합병(M&A) 성사', text: '고양이 유전자 분석을 통한 난치병 치료제 개발 파이프라인을 확보했습니다.', eventType: 'NEKO_QUANTUM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.26 } },
  { title: '🐱 네코 에너지, 영업이익 500% 폭증 및 주주 감사 코인 에어드랍', text: '폭발적인 기술 라이선스 로열티 수익을 바탕으로 역대 최대 실적을 달성했습니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'NEKO', impactSector: '초전도 양자 & 미래 에너지', impact: { NEKO: 0.33, BANK: 0.09 } },

  // 🍗 6. 황금닭 치킨 & 푸드 테크 (CHKN) - 15개
  { title: '🍗 황금닭 치킨, 심야 신메뉴 [마라뿌링클 콤보] 서버 전량 품절 사태', text: '주식 트레이더들과 카지노 유저들의 야식 주문 폭주로 황금닭 치킨 전 매장 원료육이 완판되었습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.18, BANK: 0.03 } },
  { title: '🍗 황금닭 치킨 배달 앱 평점 5.0 만점 달성 및 다운로드 1위', text: '15분 초고속 배달과 바삭한 육즙으로 배달 플랫폼 종합 순위 1위를 석권했습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.14 } },
  { title: '🍗 황금닭 순살 가라아게, 국제 우주 정거장 공식 우주식 선정', text: '무중력 상태에서도 바삭함을 유지하는 특허 진공 튀김 기술로 우주식품 인증을 받았습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.23, WTRD: 0.06 } },
  { title: '🍗 가성비 끝판왕 [1인 1닭 나홀로 세트] 출시 1주일 만에 100만 세트 판매', text: '1인 가구와 학생층을 겨냥한 실속형 메뉴가 폭발적인 매출을 견인하고 있습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.16 } },
  { title: '🍗 황금닭 치킨 프랜차이즈 1,000호점 돌파 기념 전 품목 20% 할인 대축제', text: '전국 가맹점 1,000호점을 달성하며 규모의 경제로 원가 경쟁력을 극대화했습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.20, ALL: 0.03 } },
  { title: '⚠️ 닭 사료용 수입 곡물가 인상으로 단기 원가 상승 부담 발생', text: '국제 곡물가 변동으로 원자재비가 소폭 증가했으나 신메뉴 확대로 마진을 방어 중입니다.', eventType: 'COST_PRESSURE', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: -0.07 } },
  { title: '🍗 국내산 100% 무항생제 닭다리 독점 공급망 확보로 원가 25% 절감', text: '대규모 스마트 양계장과 직계약 체결로 최상급 육질과 가격 경쟁력을 동시에 확보했습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.15 } },
  { title: '🍗 치킨무 국물 쏟아짐 방지 이지오픈 캡 세계 패키징 대상 수상', text: '작은 디테일의 고객 감동 혁신으로 브랜드 선호도가 200% 상승했습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.11 } },
  { title: '🍗 심야 야식 치킨 할인 쿠폰 서버 이벤트로 주문 트래픽 폭발', text: '디스코드 연동 쿠폰 봇 이벤트로 주말 매출이 역대 최고치를 갱신했습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.17, CASN: 0.05 } },
  { title: '⚠️ 국제 식용유 및 올리브유 가격 단기 급등으로 수익성 일시 압박', text: '기름값 상승에 대응하여 고효율 에어 튀김 기술을 선제적으로 도입하고 있습니다.', eventType: 'COST_PRESSURE', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: -0.06 } },
  { title: '🍗 48시간 지나도 바삭한 [크런치 하이퍼 튀김옷] 특허 등록', text: '눅눅해지지 않는 독보적인 튀김 배합비 특허로 해외 로열티 수출 계약을 맺었습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.19 } },
  { title: '🍗 K-치킨 열풍 타고 북미/동남아 글로벌 마스터 프랜차이즈 500개점 계약', text: '한류 열풍과 함께 해외 매장 개점이 가속화되며 글로벌 식품 기업으로 도약합니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.24, WTRD: 0.07 } },
  { title: '🍗 황금닭 수제 맥주 [치맥 스타] 론칭 및 편의점 입점 대박', text: '치킨과 찰떡궁합인 자체 수제 맥주가 편의점 수제맥주 판매 1위에 등극했습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.16 } },
  { title: '🍗 조류독감(AI) 완벽 방역 청정 농장 인증으로 시장 점유율 1위 굳히기', text: '철저한 바이오 방역 시스템으로 타사 대비 안정적인 공급망을 과시했습니다.', eventType: 'FOOD_SURPRISE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.13 } },
  { title: '🍗 황금닭 치킨, 분기 영업이익 300% 급증 및 1주당 1마리 치킨 교환권 배당', text: '주주들에게 현금 배당과 함께 분기별 치킨 무료 교환권을 지급하기로 결정했습니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CHKN', impactSector: '식음료 & 스테미나 푸드', impact: { CHKN: 0.22, BANK: 0.06 } },

  // ⚡ 7. 럭키세븐 다이아 복권 (SLOT) - 15개
  { title: '⚡ 럭키세븐 다이아 복권, 1등 당첨금 10억 누적에 복권 매진 돌풍', text: '1등 당첨자가 5회 연속 이월되며 럭키세븐 복권 위원회의 잭팟 누적금이 천문학적으로 치솟았습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.28, CASN: 0.07 } },
  { title: '⚡ 1,000원으로 긁는 [황금 다이아 즉석 스크래치 복권] 신규 발매 대히트', text: '웹과 모바일에서 즉석으로 긁어 최대 100배를 받는 스크래치 게임이 선풍적 인기를 끕니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.24, CASN: 0.10 } },
  { title: '⚡ 럭키세븐 복권 판매액 사상 최초 일일 500억원 돌파', text: '서버 내 인생역전 꿈을 품은 유저들의 복권 구매 행렬이 이어지고 있습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.26 } },
  { title: '⚡ 럭키 777 골든 티켓 스페셜 에디션 전량 한정 발매 완판', text: '희귀 다이아몬드 실물 경품이 걸린 한정판 복권이 판매 개시 10초 만에 완판되었습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.19 } },
  { title: '⚡ 복권 당첨 확률 투명 공개 블록체인 스마트 컨트랙트 적용', text: '조작이 불가능한 투명 추첨 시스템 도입으로 유저 신뢰도가 100%에 도달했습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.16, SCRP: 0.07 } },
  { title: '⚠️ 복권 발매 서버 네트워크 트래픽 초과로 15분간 긴급 대역폭 증설', text: '동시 구매자 폭증으로 인한 일시적 접속 지연이 있었으나 장비 증설로 해결되었습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: -0.06 } },
  { title: '⚡ 100만 번째 행운의 복권 구매자 탄생 및 1억원 축하금 증정', text: '100만 번 복권 발행 기념 이벤트로 커뮤니티 전역이 축제 분위기에 휩싸였습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.15, ALL: 0.02 } },
  { title: '⚡ 복권 수익금 50% 커뮤니티 기본소득 및 장학재단 환원 공시', text: '투명한 사회 환원 정책으로 공공성과 브랜드 가치가 크게 격상되었습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.14, BANK: 0.08 } },
  { title: '⚡ 연휴 맞이 [추석/설날 특별 대박 복권] 1등 당첨자 10명 동시 배출', text: '역대급 당첨자 탄생으로 복권 구매 열기가 다음 분기까지 지속될 전망입니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.22, CASN: 0.08 } },
  { title: '⚡ 모바일 원클릭 자동 번호 생성 AI [럭키 봇] 탑재', text: '빅데이터 기반 최적 번호 추천 기능이 유저들의 뜨거운 호응을 얻고 있습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.17, SCRP: 0.08 } },
  { title: '⚠️ 복권 인쇄 용지 공급 지연 해프닝으로 일부 오프라인 매장 지연', text: '특수 위조방지 용지 통관 지연으로 오프라인 판매가 반나절 지연되었습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: -0.05 } },
  { title: '⚡ 럭키세븐 다이아 복권 주가 액면분할 1:10 단행으로 개미 투자자 대거 유입', text: '주당 가격이 1,000원대로 저렴해지며 유동성이 5배 이상 폭발했습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.25 } },
  { title: '⚡ 럭키박스 구독 서비스 론칭 매월 미니 골드바 랜덤 증정', text: '정기 구독형 럭키박스 회원이 5만 명을 돌파하며 안정적 매출원을 확보했습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.18, MINE: 0.06 } },
  { title: '⚡ 럭키세븐 잭팟 777 기념 전 유저 무료 럭키 티켓 1장 증정 이벤트', text: '서버 유저 전체에게 무료 복권을 지급하며 접속자 수가 역대 최고를 찍었습니다.', eventType: 'LOTTERY_FEVER', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.13, ALL: 0.03 } },
  { title: '⚡ 럭키세븐 다이아 복권, 주당 순이익 400% 급증 특별 현금 배당 공시', text: '복권 판매 호조로 벌어들인 순이익을 주주들에게 전격 배당합니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'SLOT', impactSector: '복권 & 럭키박스', impact: { SLOT: 0.30, BANK: 0.08 } },

  // 🌐 8. 이지스크랩 데이터 테크 (SCRP) - 15개
  { title: '🌐 이지스크랩 데이터 테크, 초당 10만 건 분산 데이터 엔진 특허 취득', text: '이지스크랩이 전 세계 웹 데이터를 0.01초 만에 분석하여 시세와 로그를 스트리밍하는 독점 아키텍처 특허를 등록했습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.20, WTRD: 0.08 } },
  { title: '🌐 전 세계 50개국 초저지연 CDN 엣지 네트워크 서버망 증설 완료', text: '글로벌 어디서나 핑(Ping) 5ms 미만으로 접속 가능한 초고속 인프라를 완성했습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.18, WTRD: 0.06 } },
  { title: '🌐 글로벌 빅테크 기업과 500억원 규모 실시간 금융 빅데이터 공급 계약', text: '월가 헤지펀드와 글로벌 투자은행에 이지스크랩의 실시간 시장 데이터를 독점 공급합니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.28, BANK: 0.09 } },
  { title: '🌐 AI 빅데이터 고속 크롤링 & 실시간 감성 분석 파이프라인 3.0 출시', text: '뉴스 기사와 SNS 여론을 0.001초 만에 분석하여 주가 호재/악재를 판별하는 AI 엔진이 공개되었습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.23, NEKO: 0.08 } },
  { title: '🌐 데이터 센터 100% 수력 및 신재생 그린 에너지 전환 ESG 인증 획득', text: '친환경 인프라 구축으로 글로벌 ESG 펀드들의 매수세가 집중 유입되고 있습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.14 } },
  { title: '⚠️ 국제 해저 광케이블 일시 단선으로 해외 데이터 트래픽 우회 라우팅', text: '우회 경로를 통해 서비스는 정상 유지되었으나 단기 레이턴시가 소폭 상승했습니다.', eventType: 'TECH_INFRA', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: -0.08 } },
  { title: '🌐 이지스크랩 유료 API B2B 구독 기업 수 1만 개 사 돌파', text: '매월 고정적으로 유입되는 구독형 SaaS(Software as a Service) 매출이 300% 폭증했습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.22, BANK: 0.05 } },
  { title: '🌐 오픈소스 초고속 웹 스크래퍼 라이브러리 깃허브 스타 50,000개 돌파', text: '전 세계 개발자 커뮤니티에서 가장 사랑받는 데이터 도구로 등극했습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.16 } },
  { title: '🌐 분산 메모리 캐시 최적화로 웹사이트 응답 속도 70% 단축 성공', text: '차트 로딩과 로그 스트림 처리 속도가 눈에 띄게 빨라져 유저 경험이 극대화되었습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.15, WTRD: 0.05 } },
  { title: '🌐 국제 정보보호 관리체계 최고 등급 ISO 27001 / SOC2 Type II 인증', text: '완벽한 데이터 보안과 무결성을 인정받아 공공기관 납품 자격을 획득했습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.13 } },
  { title: '⚠️ 트래픽 폭증으로 인한 일시적 클라우드 인프라 긴급 확장 비용 지출', text: '예상치를 뛰어넘는 대량 트래픽 수용을 위해 서버 증설 비용이 단기 발생했습니다.', eventType: 'TECH_INFRA', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: -0.06 } },
  { title: '🌐 이지스크랩, 인공지능 전문 데이터 레이크 하우스 플랫폼 론칭', text: 'LLM 학습용 고품질 정제 데이터셋을 독점 공급하는 신규 플랫폼을 공개했습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.25, WTRD: 0.10 } },
  { title: '🌐 데이터 무중단 가동률 99.9999% 달성 기네스 세계 기록 등재', text: '5년간 단 1초의 다운타임도 없이 완벽한 인프라를 유지한 신화를 달성했습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.17 } },
  { title: '🌐 이지스크랩, 주주환원 1:3 무상증자 및 주당 배당금 50% 상향', text: '풍부한 잉여현금흐름(FCF)을 바탕으로 주주 가치 극대화 정책을 발표했습니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.21, BANK: 0.07 } },
  { title: '🌐 차세대 양자 내성 암호화(PQC) 데이터 전송 프로토콜 탑재', text: '양자 컴퓨터 시대에도 뚫리지 않는 최첨단 보안 암호화 통신망을 구축했습니다.', eventType: 'TECH_INFRA', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SCRP', impactSector: '빅데이터 & 고속 웹 인프라', impact: { SCRP: 0.18, NEKO: 0.09 } },

  // 🌍 9. 거시 경제 & 복합 시너지 이벤트 (MACRO) - 15개
  { title: '🌐 전 커뮤니티 대축제 개막 및 전 종목 동반 랠리 돌입', text: '서버 가입자 10만 명 돌파를 기념하여 전 종목에 강력한 매수 유동성이 공급되고 있습니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'ALL', impactSector: '시장 전반', impact: { ALL: 0.12, WTRD: 0.15, BANK: 0.15 } },
  { title: '🏛️ 정부 국부펀드, 우리 커뮤니티 8대 우량주 포트폴리오 전격 편입', text: '안정적인 8개 대표 기업의 지분을 국부펀드가 대량 매입하기로 공식 결정했습니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'ALL', impactSector: '시장 전반', impact: { ALL: 0.15, WTRD: 0.20, BANK: 0.18 } },
  { title: '⚡ 글로벌 가상자산 & 주식 시장 동반 유동성 대폭발 불장 진입', text: '기준금리 인하와 예금 확대에 힘입어 전 종목이 역대 최고가를 향해 질주합니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'ALL', impactSector: '시장 전반', impact: { ALL: 0.10, CASN: 0.15, SLOT: 0.18 } },
  { title: '📉 글로벌 금리 및 단기 채권 수익률 변동으로 건강한 숨고르기 조정', text: '과열된 증시를 식히는 건전한 단기 차익실현 매물이 출회되고 있습니다.', eventType: 'MACRO_SURGE', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'ALL', impactSector: '시장 전반', impact: { ALL: -0.05 } },
  { title: '🦆 월덕 지주사 & 냥코 랩스 & 이지스크랩, 3사 합작 초전도 AI 프로젝트 가동', text: '지주사의 자본, 냥코의 초전도체, 이지스크랩의 빅데이터가 결합된 드림팀이 출범했습니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'WTRD', impactSector: '첨단 기술 융합', impact: { WTRD: 0.25, NEKO: 0.30, SCRP: 0.25 } },
  { title: '🎰 황금오리 카지노 & 월덕 광산 & 럭키 복권, [골든 트라이앵글] 제휴', text: '채굴한 보석으로 카지노와 복권을 즐기고 당첨금을 즉시 정산하는 원스톱 생태계가 구축되었습니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'CASN', impactSector: '게이밍 & 채굴 연합', impact: { CASN: 0.22, MINE: 0.20, SLOT: 0.24 } },
  { title: '🏦 덕스 중앙은행 & 황금닭 치킨, [소상공인 치킨 지원 바우처] 전격 체결', text: '중앙은행 예치금을 통해 치킨 할인 바우처를 전 유저에게 지급하여 소비 진작에 나섭니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'CHKN', impactSector: '금융 & 소비재 제휴', impact: { CHKN: 0.18, BANK: 0.12 } },
  { title: '🌟 커뮤니티 상장 기업 전체 1분기 영업이익 합계 1조 원 돌파 신기록', text: '상장사 모두 흑자 경영을 달성하며 펀더멘털의 견고함을 입증했습니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'ALL', impactSector: '시장 전반', impact: { ALL: 0.09, WTRD: 0.14 } },

  // 🧠 10. 오리 인공지능 & 퀀텀 칩스 (AICH) - 10개
  { title: '🧠 오리 AI 칩스, 1nm 차세대 퀀텀 NPU 가속기 양산 성공 공시', text: '기존 GPU 대비 연산 속도 10배, 전력 소모 80% 감소한 혁신적 AI 칩셋 양산에 성공했습니다.', eventType: 'CHIP_TECH', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'AICH', impactSector: 'AI 반도체 & NPU 가속기', impact: { AICH: 0.32, SCRP: 0.12, WTRD: 0.08 } },
  { title: '🧠 글로벌 빅테크 기업에 1조 원 규모 AI 가속기 독점 공급 계약 체결', text: '초대형 데이터센터용 인공지능 칩셋 납품 계약을 체결하며 사상 최대 수주 잔고를 달성했습니다.', eventType: 'CHIP_TECH', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'AICH', impactSector: 'AI 반도체 & NPU 가속기', impact: { AICH: 0.28, BANK: 0.08 } },
  { title: '🧠 차세대 초고대역폭 메모리 HBM4 독자 패키징 수율 98% 달성', text: '업계 최고 수준의 반도체 수율을 확보하여 원가 경쟁력을 비약적으로 높였습니다.', eventType: 'CHIP_TECH', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'AICH', impactSector: 'AI 반도체 & NPU 가속기', impact: { AICH: 0.22 } },
  { title: '⚠️ 글로벌 파운드리 웨이퍼 원자재 공급 지연으로 단기 생산 차질 발생', text: '희귀 가스 통관 지연으로 반도체 조립 라인이 일시적으로 숨고르기에 들어갔습니다.', eventType: 'CHIP_TECH', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'AICH', impactSector: 'AI 반도체 & NPU 가속기', impact: { AICH: -0.08 } },
  { title: '🧠 오리 AI 칩스, 자율주행 특화 뉴로모픽 프로세서 칩 개발 완료', text: '인간 뇌신경망을 모방한 자율주행 차량용 초저지연 비전 칩셋을 공개했습니다.', eventType: 'CHIP_TECH', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'AICH', impactSector: 'AI 반도체 & NPU 가속기', impact: { AICH: 0.24, AUTO: 0.15 } },
  { title: '🧠 미국/유럽 주요 정부 인공지능 반도체 보조금 5,000억원 수령 확정', text: '정부 차원의 반도체 육성 펀드 지원 대상자로 선정되어 대규모 현금이 유입됩니다.', eventType: 'CHIP_TECH', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'AICH', impactSector: 'AI 반도체 & NPU 가속기', impact: { AICH: 0.20, BANK: 0.06 } },
  { title: '⚠️ 경쟁사 신제품 출시에 따른 반도체 단가 인하 경쟁 심화 우려', text: '시장 점유율 방어를 위해 단기 판가 조정에 들어가며 영업이익률이 일시 둔화되었습니다.', eventType: 'CHIP_TECH', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'AICH', impactSector: 'AI 반도체 & NPU 가속기', impact: { AICH: -0.06 } },
  { title: '🧠 세계 반도체 학회(ISSCC) 최우수 혁신 논문상 및 기술 대상 수상', text: '독자적인 3차원 적층 칩렛 기술로 전 세계 학계와 업계의 찬사를 받았습니다.', eventType: 'CHIP_TECH', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'AICH', impactSector: 'AI 반도체 & NPU 가속기', impact: { AICH: 0.16 } },
  { title: '🧠 오리 AI 칩스, 연간 순이익 300% 폭증 및 주당 특별 현금 배당 공시', text: '반도체 슈퍼사이클 도래에 힘입어 주주들에게 파격적인 현금 배당을 결의했습니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'AICH', impactSector: 'AI 반도체 & NPU 가속기', impact: { AICH: 0.26, BANK: 0.08 } },
  { title: '🧠 차세대 광자(Photonic) 연산 반도체 시제품 세계 최초 시연 성공', text: '전기 대신 빛으로 연산하는 차세대 포토닉스 칩셋 구동에 성공하며 기술 격차를 벌렸습니다.', eventType: 'CHIP_TECH', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'AICH', impactSector: 'AI 반도체 & NPU 가속기', impact: { AICH: 0.30, NEKO: 0.12 } },

  // 🚀 11. 덕스 에어로스페이스 & 방산 (SPAC) - 10개
  { title: '🚀 덕스 에어로스페이스, 정지궤도 초정밀 통신위성 1호기 발사 완전 성공', text: '자체 개발 우주 발사체로 인공위성을 정밀 궤도에 안착시키며 우주 강국으로 도약했습니다.', eventType: 'SPACE_LAUNCH', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'SPAC', impactSector: '우주항공 & 국방 방위산업', impact: { SPAC: 0.30, WTRD: 0.10, SCRP: 0.08 } },
  { title: '🚀 다국적 방위청과 8,000억원 규모 차세대 무인 방산 드론 체계 공급 계약', text: 'AI 자율비행 방산 드론 수주 계약을 체결하며 방산 수출 대박을 터뜨렸습니다.', eventType: 'SPACE_LAUNCH', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'SPAC', impactSector: '우주항공 & 국방 방위산업', impact: { SPAC: 0.27, BANK: 0.07 } },
  { title: '🚀 재사용 가능한 친환경 메탄 로켓 엔진 연소 시험 100회 무결점 통과', text: '스페이스X급 로켓 엔진 재사용 기술을 확보하여 발사 비용을 90% 절감했습니다.', eventType: 'SPACE_LAUNCH', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SPAC', impactSector: '우주항공 & 국방 방위산업', impact: { SPAC: 0.23, NEKO: 0.09 } },
  { title: '⚠️ 기상 악화로 인한 소형 시험 발사체 일정 1주일 연기 안내', text: '태풍 및 강풍으로 발사 카운트다운이 안전을 위해 순연되며 단기 관망세가 형성되었습니다.', eventType: 'SPACE_LAUNCH', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'SPAC', impactSector: '우주항공 & 국방 방위산업', impact: { SPAC: -0.07 } },
  { title: '🚀 달 기지 건설 프로젝트 [오리 아르테미스] 공식 탐사선 납품 업체 선정', text: '국제 우주정거장 및 달 궤도선 모듈 납품 계약을 체결하여 우주 개발의 주역이 되었습니다.', eventType: 'SPACE_LAUNCH', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SPAC', impactSector: '우주항공 & 국방 방위산업', impact: { SPAC: 0.25, MINE: 0.11 } },
  { title: '🚀 초음속 하이퍼소닉 방산 미사일 요격 방어 시스템 개발 완료', text: '국가 영공을 완벽 방어하는 최첨단 방공 레이더 및 요격 체계가 실전 배치되었습니다.', eventType: 'SPACE_LAUNCH', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SPAC', impactSector: '우주항공 & 국방 방위산업', impact: { SPAC: 0.19 } },
  { title: '⚠️ 발사대 지상 설비 밸브 부품 교체로 정기 보수 비용 발생', text: '안전성 강화를 위한 설비 유지보수 작업이 진행되었습니다.', eventType: 'SPACE_LAUNCH', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'SPAC', impactSector: '우주항공 & 국방 방위산업', impact: { SPAC: -0.05 } },
  { title: '🚀 글로벌 우주 인터넷 군집위성 60기 동시 궤도 투하 성공', text: '전 세계 오지에서도 1Gbps 속도로 통신이 가능한 저궤도 위성망 구축에 박차를 가합니다.', eventType: 'SPACE_LAUNCH', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'SPAC', impactSector: '우주항공 & 국방 방위산업', impact: { SPAC: 0.21, SCRP: 0.08 } },
  { title: '🚀 덕스 에어로스페이스, 순이익 60% 주주 환원 및 우주투어 탑승권 추첨', text: '주주총회를 통해 높은 배당과 주주 대상 준궤도 우주여행 티켓 이벤트를 발표했습니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SPAC', impactSector: '우주항공 & 국방 방위산업', impact: { SPAC: 0.18, BANK: 0.05 } },
  { title: '🚀 차세대 스텔스 복합소재 탄소섬유 외피 기술 미국 특허 등록', text: '레이더 전파를 99% 흡수하는 특수 스텔스 신소재 특허를 획득했습니다.', eventType: 'SPACE_LAUNCH', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SPAC', impactSector: '우주항공 & 국방 방위산업', impact: { SPAC: 0.16 } },

  // 🧬 12. 월덕 바이오 파마 (BIOX) - 10개
  { title: '🧬 월덕 바이오, 불로장생 오리 펩타이드 항암 신약 글로벌 임상 3상 대성공!', text: '말기 암 환자 대상 임상 3상에서 완치율 94%라는 기적적인 결과를 발표하며 전 세계 의학계를 뒤흔들었습니다.', eventType: 'BIO_TRIAL', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'BIOX', impactSector: '바이오 헬스케어 & 신약 개발', impact: { BIOX: 0.40, WTRD: 0.12, BANK: 0.08 } },
  { title: '🧬 글로벌 1위 제약사에 3조 원 규모 신약 기술수출(라이선스 아웃) 계약 체결', text: '계약금만 3,000억 원에 달하는 메가톤급 기술 수출 계약을 성사시켰습니다.', eventType: 'BIO_TRIAL', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'BIOX', impactSector: '바이오 헬스케어 & 신약 개발', impact: { BIOX: 0.35, BANK: 0.10 } },
  { title: '🧬 FDA(미국 식품의약국) 패스트트랙 신속 심사 품목 공식 지정', text: '혁신 치료제 지정으로 신약 출시 일정이 2년 이상 앞당겨질 전망입니다.', eventType: 'BIO_TRIAL', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'BIOX', impactSector: '바이오 헬스케어 & 신약 개발', impact: { BIOX: 0.26 } },
  { title: '⚠️ 임상 2상 투약 데이터 통계 보완 요청으로 승인 일정 일시 지연', text: '규제 당국의 추가 서류 제출 요청으로 단기 불확실성이 발생했으나 안전성에는 문제가 없습니다.', eventType: 'BIO_TRIAL', sentiment: 'BEAR', importance: 'HIGH', relatedStock: 'BIOX', impactSector: '바이오 헬스케어 & 신약 개발', impact: { BIOX: -0.12 } },
  { title: '🧬 유전자 가위(CRISPR) 기반 희귀 유전 질환 치료제 동물 시험 완치', text: '단 1회 투여로 선천성 유전 질환을 교정하는 획기적인 연구 결과가 네이처지에 실렸습니다.', eventType: 'BIO_TRIAL', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'BIOX', impactSector: '바이오 헬스케어 & 신약 개발', impact: { BIOX: 0.28 } },
  { title: '🧬 대규모 바이오 의약품 CDMO(위탁생산) 스마트 공장 완공 및 가동', text: '연간 20만 리터 규모의 첨단 항체 치료제 생산 시설이 본격 가동에 들어갔습니다.', eventType: 'BIO_TRIAL', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'BIOX', impactSector: '바이오 헬스케어 & 신약 개발', impact: { BIOX: 0.19 } },
  { title: '⚠️ 바이오 배양 배지 원료 수입가 상승으로 단기 연구개발비 지출 증가', text: '최고급 시약 구입으로 1회성 R&D 비용이 증가했습니다.', eventType: 'BIO_TRIAL', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'BIOX', impactSector: '바이오 헬스케어 & 신약 개발', impact: { BIOX: -0.06 } },
  { title: '🧬 줄기세포 기반 노화 역전 회춘 화장품 원료 특허 등록 및 완판', text: '의약품 기술을 접목한 더마 코스메틱 신제품이 출시 당일 품절되었습니다.', eventType: 'BIO_TRIAL', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'BIOX', impactSector: '바이오 헬스케어 & 신약 개발', impact: { BIOX: 0.17, LUXU: 0.10 } },
  { title: '🧬 월덕 바이오, 순이익 흑자 전환 기념 무상증자 1:2 전격 단행', text: '기술특례 상장에서 완전한 흑자 바이오 기업으로 탈바꿈하며 주주 가치를 높였습니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'BIOX', impactSector: '바이오 헬스케어 & 신약 개발', impact: { BIOX: 0.24, BANK: 0.06 } },
  { title: '🧬 만성 통증 1초 완화 나노 패치 유럽 CE 인증 획득', text: '부작용 없는 차세대 패치형 진통제가 유럽 전역 약국에 유통됩니다.', eventType: 'BIO_TRIAL', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'BIOX', impactSector: '바이오 헬스케어 & 신약 개발', impact: { BIOX: 0.15 } },

  // 💎 13. 황금오리 럭셔리 & 부티크 (LUXU) - 10개
  { title: '💎 황금오리 럭셔리, 최고급 한정판 다이아몬드 워치 100억원 옥션 낙찰', text: '전 세계 단 1피스만 제작된 플래티넘 다이아몬드 오리 투르비옹 시계가 신기록을 세웠습니다.', eventType: 'LUXURY_BOOM', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'LUXU', impactSector: '글로벌 명품 패션 & 하이엔드 쥬얼리', impact: { LUXU: 0.25, MINE: 0.10, CASN: 0.08 } },
  { title: '💎 파리/밀라노 패션위크 메인 오프닝 쇼 극찬 및 수주액 5,000억원 달성', text: '황금오리 오트쿠튀르 컬렉션이 글로벌 패션 에디터들의 만장일치 찬사를 받았습니다.', eventType: 'LUXURY_BOOM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'LUXU', impactSector: '글로벌 명품 패션 & 하이엔드 쥬얼리', impact: { LUXU: 0.22, WTRD: 0.06 } },
  { title: '💎 VIP 멤버십 전용 플래그십 하우스 오픈 및 대기자 1만 명 돌파', text: '초고액 자산가들의 명품 가방 및 쥬얼리 오픈런이 이어지며 영업이익률 45%를 달성했습니다.', eventType: 'LUXURY_BOOM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'LUXU', impactSector: '글로벌 명품 패션 & 하이엔드 쥬얼리', impact: { LUXU: 0.20, BANK: 0.05 } },
  { title: '⚠️ 최고급 이탈리아 가죽 통관 지연으로 일부 백 라인 출고 지연', text: '원자재 검수 강화로 프리미엄 백 출고가 며칠 늦어졌으나 품질에는 이상이 없습니다.', eventType: 'LUXURY_BOOM', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'LUXU', impactSector: '글로벌 명품 패션 & 하이엔드 쥬얼리', impact: { LUXU: -0.05 } },
  { title: '💎 황금오리 럭셔리, 전 품목 판매가 15% 기습 인상에도 수요 폭증', text: '명품의 베블런 효과(가격이 오를수록 과시욕으로 수요가 증가)로 매출이 2배 증가했습니다.', eventType: 'LUXURY_BOOM', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'LUXU', impactSector: '글로벌 명품 패션 & 하이엔드 쥬얼리', impact: { LUXU: 0.24 } },
  { title: '💎 K-팝 글로벌 톱스타 전원 브랜드 앰버서더 전속 계약 체결', text: '글로벌 Z세대 팬덤의 폭발적 관심으로 주얼리와 향수 라인이 품절 대란을 빚고 있습니다.', eventType: 'LUXURY_BOOM', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'LUXU', impactSector: '글로벌 명품 패션 & 하이엔드 쥬얼리', impact: { LUXU: 0.18, CASN: 0.06 } },
  { title: '⚠️ 명품 모조품(짝퉁) 단속 강화에 따른 일시적 법무 비용 지출', text: '브랜드 가치 수호를 위한 대대적 지식재산권 보호 소송을 전개하고 있습니다.', eventType: 'LUXURY_BOOM', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'LUXU', impactSector: '글로벌 명품 패션 & 하이엔드 쥬얼리', impact: { LUXU: -0.04 } },
  { title: '💎 글로벌 면세점 및 럭셔리 백화점 메인 로열 1층 입점 계약 독점 체결', text: '전 세계 주요 공항 및 최고급 백화점의 최상급 명당자리를 독점 확보했습니다.', eventType: 'LUXURY_BOOM', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'LUXU', impactSector: '글로벌 명품 패션 & 하이엔드 쥬얼리', impact: { LUXU: 0.16 } },
  { title: '💎 황금오리 럭셔리, 연간 배당 수익률 5.5% 확정 고배당주 등극', text: '막대한 현금 유입을 바탕으로 주주들에게 풍성한 결산 배당금을 지급합니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'LUXU', impactSector: '글로벌 명품 패션 & 하이엔드 쥬얼리', impact: { LUXU: 0.21, BANK: 0.07 } },
  { title: '💎 한정판 아트 콜라보레이션 에디션 발매 1분 만에 전 세계 서버 다운', text: '유명 현대 미술가와의 협업 리미티드 에디션이 중고 리셀가 500%를 기록했습니다.', eventType: 'LUXURY_BOOM', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'LUXU', impactSector: '글로벌 명품 패션 & 하이엔드 쥬얼리', impact: { LUXU: 0.17 } },

  // 🚗 14. 덕스 모빌리티 & 자율주행 (AUTO) - 10개
  { title: '🚗 덕스 모빌리티, 레벨 4 무인 완전 자율주행 로보택시 상용 면허 취득!', text: '운전자가 전혀 타지 않는 완전 무인 자율주행 택시 서비스가 시내 전역에서 본격 운행을 시작했습니다.', eventType: 'EV_AUTO', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'AUTO', impactSector: '자율주행 전기차 & 미래 모빌리티', impact: { AUTO: 0.32, AICH: 0.12, WTRD: 0.08 } },
  { title: '🚗 1회 충전 1,200km 주행 전고체 배터리 탑재 하이퍼 전기차 발표', text: '충전 시간 5분에 서울-부산을 왕복할 수 있는 꿈의 전기차가 전 세계의 이목을 집중시켰습니다.', eventType: 'EV_AUTO', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'AUTO', impactSector: '자율주행 전기차 & 미래 모빌리티', impact: { AUTO: 0.28, NEKO: 0.10 } },
  { title: '🚗 사전 예약 24시간 만에 10만 대 돌파 역대 최고 신차 기록 달성', text: '스타일리시한 미래형 유선형 디자인과 압도적 성능으로 사전 예약이 폭주했습니다.', eventType: 'EV_AUTO', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'AUTO', impactSector: '자율주행 전기차 & 미래 모빌리티', impact: { AUTO: 0.24, BANK: 0.06 } },
  { title: '⚠️ 배터리 팩 냉각 밸브 무상 소프트웨어 OTA 업데이트 실시', text: '선제적 안전 예방 조치로 무선 소프트웨어 패치를 진행하며 단기 비용이 발생했습니다.', eventType: 'EV_AUTO', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'AUTO', impactSector: '자율주행 전기차 & 미래 모빌리티', impact: { AUTO: -0.07 } },
  { title: '🚗 도심 항공 모빌리티(UAM) 플라잉 오리 택시 시범 비행 성공', text: '도로 정체를 피하는 수직이착륙 도심 항공 모빌리티 시범 비행을 성공리에 마쳤습니다.', eventType: 'EV_AUTO', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'AUTO', impactSector: '자율주행 전기차 & 미래 모빌리티', impact: { AUTO: 0.26, SPAC: 0.12 } },
  { title: '🚗 글로벌 자동차 1위 제조사와 2조 원 규모 자율주행 OS 라이선스 계약', text: '자체 개발한 무인 자율주행 운영체제를 완성차 업체에 독점 공급하기로 합의했습니다.', eventType: 'EV_AUTO', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'AUTO', impactSector: '자율주행 전기차 & 미래 모빌리티', impact: { AUTO: 0.22, SCRP: 0.08 } },
  { title: '⚠️ 차량용 반도체 리드타임 증가로 출고 대기 기간 소폭 연장', text: '공급망 다변화를 통해 생산 라인을 안정화하고 있습니다.', eventType: 'EV_AUTO', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'AUTO', impactSector: '자율주행 전기차 & 미래 모빌리티', impact: { AUTO: -0.05 } },
  { title: '🚗 친환경 태양광 루프 충전 시스템 세계 최초 전 차종 기본 탑재', text: '주행 중 햇빛만으로 매일 50km를 무료 주행할 수 있는 솔라루프 기술이 호평을 받습니다.', eventType: 'EV_AUTO', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'AUTO', impactSector: '자율주행 전기차 & 미래 모빌리티', impact: { AUTO: 0.17 } },
  { title: '🚗 덕스 모빌리티, 기가팩토리 생산 수율 95% 돌파 및 주주 배당 공시', text: '생산 효율 극대화로 분기 영업이익이 사상 최고치를 경신했습니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'AUTO', impactSector: '자율주행 전기차 & 미래 모빌리티', impact: { AUTO: 0.20, BANK: 0.05 } },
  { title: '🚗 초고속 무인 자율주행 레이싱 대회 월드 챔피언십 우승', text: '세계 정상급 인공지능 주행 알고리즘의 우수성을 레이싱 서킷에서 완벽 입증했습니다.', eventType: 'EV_AUTO', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'AUTO', impactSector: '자율주행 전기차 & 미래 모빌리티', impact: { AUTO: 0.15 } },
  { title: '🎁 전 종목 특별 분기 배당 주간 선포 및 자동 이자 지급 개시', text: '배당을 실시하는 모든 종목 보유자들에게 현금 배당이 계좌로 즉시 입금됩니다.', eventType: 'DIVIDEND_BONUS', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'ALL', impactSector: '시장 전반', impact: { ALL: 0.08, BANK: 0.15, WTRD: 0.12 } },
  { title: '🔥 숏스퀴즈 랠리 폭발! 공매도 세력 청산으로 전 종목 수직 상승', text: '하락에 배팅했던 악성 투기 세력들이 강제 청산당하며 주가가 수직 급등합니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'ALL', impactSector: '시장 전반', impact: { ALL: 0.16, SLOT: 0.25, NEKO: 0.28 } },
  { title: '🌐 커뮤니티 데이터 트래픽 월간 10억 뷰 돌파 신기록', text: '웹사이트와 디스코드 봇 이용량이 폭발적으로 늘어나며 디지털 경제 규모가 커졌습니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'SCRP', impactSector: '시장 전반', impact: { SCRP: 0.15, WTRD: 0.11 } },
  { title: '⚠️ 국제 원자재 수송로 기상 악화로 단기 물류비 소폭 상승', text: '악천후로 인한 일시적 물류 지연이 발생했으나 비축 재고로 차질 없이 공급 중입니다.', eventType: 'MACRO_SURGE', sentiment: 'BEAR', importance: 'NORMAL', relatedStock: 'MINE', impactSector: '시장 전반', impact: { MINE: -0.06, CHKN: -0.04 } },
  { title: '💎 자산가 랭킹 TOP 10 총자산 100조 원 돌파 축하 특별 펀드 결성', text: '상위 랭커들의 투자 수익 재투자로 증시 하방 지지력이 매우 강력해졌습니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'BANK', impactSector: '시장 전반', impact: { BANK: 0.14, ALL: 0.04 } },
  { title: '🚀 8대 기업 대표단 [지속 가능한 가상 경제 공동 선언문] 서명식', text: '투명 경영과 주주 환원, 지속 성장을 약속하는 선언을 발표하며 투자자 신뢰가 공고해졌습니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'NORMAL', relatedStock: 'ALL', impactSector: '시장 전반', impact: { ALL: 0.07 } },
  { title: '🎉 월덕 가상 주식 거래소 일일 거래대금 사상 최대 1조원 돌파', text: '활발한 손바뀜과 매수세가 맞물려 거래소 역사상 가장 뜨거운 거래량을 기록했습니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'URGENT', relatedStock: 'ALL', impactSector: '시장 전반', impact: { ALL: 0.13, BANK: 0.16, CASN: 0.15 } }
];

let currentRegimeIndex = 0;
let regimeCyclesLeft = 10;
let lastNews = null;
let historyCleanupCounter = 0;
let forcedRegimeIndex = null; // 자동 경제 조절 시스템에 의해 강제 지정된 국면 인덱스

// 📈 3분 주기 유저 상황 연동 주식 가격 변동 엔진
async function updateStockPrices() {
  const connection = await pool.getConnection();
  try {
    regimeCyclesLeft--;
    // 자동 경제 조절 시스템이 강제 국면을 지정한 경우 우선 적용
    if (forcedRegimeIndex !== null) {
      currentRegimeIndex = forcedRegimeIndex;
      regimeCyclesLeft = 3; // 3사이클 후 자동 해제
      forcedRegimeIndex = null;
    } else if (regimeCyclesLeft <= 0 || Math.random() < 0.20) {
      currentRegimeIndex = Math.floor(Math.random() * MARKET_REGIMES.length);
      regimeCyclesLeft = Math.floor(Math.random() * 8) + 8;
    }
    const currentRegime = MARKET_REGIMES[currentRegimeIndex];

    const [stocks] = await connection.query('SELECT * FROM stocks');
    if (stocks.length === 0) return;

    // 2. 📊 유저 실시간 경제 상황 & 거래량 (수요/공급) 분석
    const userTradeImpactMap = {};
    try {
      // 최근 1시간 동안의 유저 실거래량 (매수 vs 매도) 집계
      const txFilter = whereNotAdmin('user_id');
      const [txRows] = await connection.query(`
        SELECT stock_id, action, COALESCE(SUM(amount), 0) as total_amount, COALESCE(SUM(total_price), 0) as total_money
        FROM stock_transactions
        WHERE created_at >= NOW() - INTERVAL 1 HOUR
          AND ${txFilter.sql}
        GROUP BY stock_id, action
      `, txFilter.params);

      const buyMap = {};
      const sellMap = {};
      txRows.forEach(r => {
        const sid = r.stock_id;
        const money = Number(r.total_money || 0);
        if (r.action === 'BUY') buyMap[sid] = (buyMap[sid] || 0) + money;
        else if (r.action === 'SELL') sellMap[sid] = (sellMap[sid] || 0) + money;
      });

      stocks.forEach(s => {
        const sid = s.stock_id;
        const buys = buyMap[sid] || 0;
        const sells = sellMap[sid] || 0;
        const netMoney = buys - sells;
        const marketCap = Number(s.price) * 1000;
        let impact = netMoney / (marketCap * 2 || 1000000);
        impact = Math.max(-0.12, Math.min(0.12, impact));
        userTradeImpactMap[sid] = impact;
      });
    } catch (e) {}

    // 3. 👥 커뮤니티 전체 유저 총 유동성 지표 반영
    let communityLiquidityFactor = 0.0;
    try {
      const cashFilter = whereNotAdmin('discord_id');
      const [userSummary] = await connection.query(
        `SELECT AVG(cash) as avg_cash, AVG(bank) as avg_bank FROM users WHERE ${cashFilter.sql}`,
        cashFilter.params
      );
      if (userSummary.length > 0) {
        const avgTotal = Number(userSummary[0].avg_cash || 0) + Number(userSummary[0].avg_bank || 0);
        if (avgTotal > 1000000) communityLiquidityFactor = 0.02;
        else if (avgTotal < 50000) communityLiquidityFactor = -0.01;
      }
    } catch (e) {}
    
    // 50% 확률로 120개 중 랜덤 뉴스 이벤트 발생 및 DB 저장
    let eventImpactMap = {};
    lastNews = null;
    if (Math.random() < STOCK.NEWS_CHANCE) {
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
      const baseVolatility = parseFloat(stock.volatility || '0.04');
      const stockId = stock.stock_id;

      const regimeDrift = currentRegime.drift;
      const eventBoost = (eventImpactMap[stockId] || 0) + (eventImpactMap['ALL'] || 0);
      const userImpact = Math.max(-0.03, Math.min(0.03, (userTradeImpactMap[stockId] || 0) * 0.5));
      // 🪫 변동폭 축소: 사용자 요청으로 노이즈/드리프트 크기를 30%로 축소
      const adjustedVolatility = baseVolatility * currentRegime.volatilityFactor * 0.3;
      let noise = (Math.random() * 2 - 1) * adjustedVolatility;

      // 🛡️ 가격 이상 감지: 현재가가 24h 평균 대비 ±20% 이상 벌어지면 변동폭 추가 감쇠
      // (변동시간은 건드리지 않고 변동폭만 더 줄임)
      const prevHigh24 = BigInt(stock.high_24h || stock.price || 100);
      const prevLow24 = BigInt(stock.low_24h || stock.price || 100);
      let dampenFactor = 1.0;
      if (prevHigh24 > 0n && prevLow24 > 0n && prevHigh24 !== prevLow24) {
        const mid24h = (Number(prevHigh24) + Number(prevLow24)) / 2;
        if (mid24h > 0) {
          const deviation = (Number(currentPrice) - mid24h) / mid24h; // -1 ~ 1
          const absDev = Math.abs(deviation);
          if (absDev > 0.20) {
            // ±20% 이상 → 1/(1 + (absDev-0.2)*5) 만큼 감쇠 (ex: 30% → 0.4, 50% → 0.25)
            dampenFactor = 1 / (1 + (absDev - 0.2) * 5);
            if (dampenFactor < 0.1) dampenFactor = 0.1; // 최소 10%는 유지
          }
        }
      }
      noise *= dampenFactor;

      // 🌐 실제 거시경제 경기 사이클 및 금리 효과 연동
      let macroCycleBias = 0;
      try {
        const { MACRO, macroState } = require('./macroEconomics');
        const curCycle = MACRO.CYCLE_NAMES[macroState.cycleIndex];
        if (curCycle && typeof curCycle.stockBias === 'number') {
          macroCycleBias = curCycle.stockBias * 0.5; // 실시간 사이클 가중치
        }
      } catch (e) {}

      // 🌐 1. 거시 국면 배경 효과 (과도한 일괄 쏠림을 방지하여 ±0.5% 내외로 완만하게 반영)
      const macroBackground = Math.max(-0.006, Math.min(0.006, (regimeDrift * 0.15) + (macroCycleBias * 0.2) + (communityLiquidityFactor * 0.15)));

      // 🎲 2. 종목별 독립 등락 방향 & 고유 브라운 운동 (종목마다 독자적인 상승/하락 결정)
      // 국면에 따라 상승 확률이 45%~55% 사이로 미세하게 조정되며, 각 종목은 독립적으로 등락합니다.
      const bullChance = 0.50 + Math.max(-0.15, Math.min(0.15, regimeDrift * 2.0));
      const stockTrendSign = (Math.random() < bullChance ? 1 : -1);
      const individualWalk = stockTrendSign * (Math.random() * baseVolatility * 1.5);

      // 🎲 3. 20% 확률로 개별 종목 단독 호재/악재 미니 이벤트 발생 (-4% ~ +5%)
      let stockMicroShock = 0;
      if (Math.random() < 0.20) {
        const isGood = Math.random() < 0.5;
        stockMicroShock = isGood ? (Math.random() * 0.04 + 0.01) : -(Math.random() * 0.035 + 0.01);
      }

      // 🎲 4. 종합 델타 계산: 거시 배경 + 개별 변동 + 마이크로 호재/악재 + 유저 거래 충격 + 차익 실현
      const rawDelta = macroBackground + eventBoost + userImpact + profitTakingDrag + noise + individualWalk + stockMicroShock;
      const totalDelta = clampStockDelta(eventBoost, rawDelta);
      let newPrice = BigInt(Math.max(10, Math.round(Number(currentPrice) * (1 + totalDelta))));

      // 💡 틱마다 0% 정체를 방지하여 생생한 실시간 가격 변동 보장
      if (newPrice === currentPrice) {
        const nudge = Math.random() < 0.5 ? 1n : -1n;
        newPrice = currentPrice + nudge;
        if (newPrice < 10n) newPrice = 10n;
      }

      // 💡 초보자 입문주(SLOT)는 신규 가입자(정착금 10,000원)가 언제든 쉽게 매수할 수 있도록 50~500원 구간 안정 유지
      if (stockId === 'SLOT') {
        if (newPrice > 500n) newPrice = 500n;
        if (newPrice < 50n) newPrice = 50n;
      }

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
      const changeRateNum = currentPrice > 0n ? ((Number(diff) / Number(currentPrice)) * 100) : 0;
      const changeRate = changeRateNum.toFixed(2);
      
      // 🚨 15% 이상 급등락 시 서킷브레이커 태그 부착
      let circuitPrefix = '';
      if (Math.abs(changeRateNum) >= 15) {
        circuitPrefix = changeRateNum > 0 ? '🚨 [서킷브레이커 상한가 랠리] ' : '🚨 [서킷브레이커 급락 완화] ';
      }

      const userReason = userImpact !== 0 ? ` (유저 순${userImpact > 0 ? '매수' : '매도'} 반영)` : '';
      const reasonStr = lastNews ? `${circuitPrefix}[${lastNews.title}]${userReason}` : `${circuitPrefix}${currentRegime.name} 시황 변동${userReason}`;

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
    console.log(`📈 [월덕 가상 경제 엔진] 유저 상황 연동 주가 갱신 완료 (${currentRegime.name}) - ${stocks.length}개 종목${lastNews ? ` | 📢 공시: ${lastNews.title}` : ''}`);

    if (typeof global.__invalidateMarketCache === 'function') {
      global.__invalidateMarketCache();
    }

    // 📡 ⚡ Socket.IO 및 SSE 실시간 양방향 브로드캐스트 (연결된 모든 웹 클라이언트에 0초 즉시 push)
    const [latestStocks] = await pool.query('SELECT stock_id, name, price, prev_price, high_24h, low_24h, volume_24h, volatility FROM stocks');
    const updatePayload = {
      stocks: latestStocks.map(s => {
        const curP = Number(s.price);
        const prevP = Number(s.prev_price || s.price);
        const diffP = curP - prevP;
        const rateP = prevP > 0 ? (diffP / prevP) * 100 : 0;
        return {
          stock_id: s.stock_id,
          name: s.name,
          price: curP,
          prev_price: prevP,
          rate: rateP,
          diff: diffP,
          isUp: diffP >= 0,
          high_24h: Number(s.high_24h || curP),
          low_24h: Number(s.low_24h || curP),
          volume_24h: Number(s.volume_24h || 0),
          volatility: Number(s.volatility || 0.04)
        };
      }),
      regime: currentRegime,
      news: lastNews,
      timestamp: Date.now()
    };

    if (global.__io) {
      global.__io.emit('market:update', updatePayload);
      global.__io.emit('market:snapshot', updatePayload);
    }

    if (typeof global.__broadcastMarketUpdate === 'function') {
      global.__broadcastMarketUpdate();
    }

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

// 💰 정기 주식 배당금 자동 지급 엔진 (기업 영업이익 풀 기반 정산)
async function distributeStockDividends() {
  try {
    const [stocks] = await pool.query('SELECT stock_id, name, price, dividend_yield FROM stocks WHERE dividend_yield > 0');
    if (stocks.length === 0) return;

    for (const s of stocks) {
      const yieldRate = Number(s.dividend_yield || 0);

      // 기업 영업이익 풀 조회
      const [poolRows] = await pool.query(
        'SELECT earnings_pool FROM corporate_earnings WHERE stock_id = ? FOR UPDATE',
        [s.stock_id]
      ).catch(() => [[]]);
      let earningsPool = poolRows.length ? BigInt(poolRows[0].earnings_pool || 0) : 10000000n;
      if (earningsPool <= 0n) continue; // 이익 풀이 고갈된 기업은 배당 미지급

      const [holdings] = await pool.query(`
        SELECT us.user_id, us.amount, u.username, u.cash
        FROM user_stocks us
        JOIN users u ON us.user_id = u.discord_id
        WHERE us.stock_id = ? AND us.amount > 0
      `, [s.stock_id]);

      let totalStockDividend = 0n;

      for (const h of holdings) {
        const { unitsToAmountStr, amountToUnits } = require('./moneyScale');
        let dividendAmount = hourlyDividendForHolding(s.price, h.amount, yieldRate);
        if (dividendAmount <= 0n) continue;

        // 이익 풀 한도 내에서 지급
        if (dividendAmount > earningsPool) {
          dividendAmount = earningsPool;
        }
        if (dividendAmount <= 0n) break;

        earningsPool -= dividendAmount;
        totalStockDividend += dividendAmount;

        const beforeCash = BigInt(String(h.cash || 0).split('.')[0] || 0);
        await pool.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [dividendAmount.toString(), h.user_id]);
        const afterCash = beforeCash + dividendAmount;
        pushUserLive(h.user_id);

        try {
          const displayCount = unitsToAmountStr(amountToUnits(h.amount));
          await pool.query(`
            INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason)
            VALUES ('INFLOW_MINT', 'STOCK_DIVIDEND', ?, ?, ?, ?)
          `, [
            dividendAmount.toString(),
            h.user_id,
            afterCash.toString(),
            `💰 [${s.name}] 기업 이익금 기반 정기 배당금 수령 (${displayCount}주)`
          ]);
        } catch (e) {}
      }

      if (totalStockDividend > 0n) {
        await pool.query(`
          UPDATE corporate_earnings
          SET earnings_pool = ?, total_dividend_paid = total_dividend_paid + ?
          WHERE stock_id = ?
        `, [earningsPool.toString(), totalStockDividend.toString(), s.stock_id]).catch(() => {});
      }
    }
    console.log('💰 [정기 배당 엔진] 기업 이익 풀 기반 정밀 배당금 분배 완료');
  } catch (err) {
    console.error('❌ 배당금 지급 중 오류:', err);
  }
}

// 🔧 스마트 주가 조절 시스템 (Smart Stock Price Adjustment System)
async function adjustStockPrice(stockId, targetPrice, reason = '관리자/시스템 가격 조절') {
  const { safeBigInt } = require('./money');
  const newPrice = safeBigInt(targetPrice);
  if (newPrice < 10n) throw new Error('주가는 최소 10원 이상이어야 합니다.');

  const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
  if (stocks.length === 0) throw new Error(`종목 [${stockId}]을 찾을 수 없습니다.`);

  const s = stocks[0];
  const oldPrice = BigInt(s.price);

  await pool.query('UPDATE stocks SET prev_price = price, price = ?, updated_at = NOW() WHERE stock_id = ?', [newPrice.toString(), stockId]);
  await pool.query('INSERT INTO stock_history (stock_id, price) VALUES (?, ?)', [stockId, newPrice.toString()]);

  const diff = newPrice - oldPrice;
  const rate = oldPrice > 0n ? ((Number(diff) / Number(oldPrice)) * 100).toFixed(2) : '0.00';

  try {
    await pool.query(`
      INSERT INTO stock_price_logs (stock_id, stock_name, prev_price, new_price, change_rate, diff, regime, reason)
      VALUES (?, ?, ?, ?, ?, ?, '가격조절시스템', ?)
    `, [stockId, s.name, oldPrice.toString(), newPrice.toString(), rate, diff.toString(), reason]);
  } catch (e) {}

  if (global.__io) {
    const [latestStocks] = await pool.query('SELECT stock_id, name, price, prev_price, high_24h, low_24h, volume_24h, volatility FROM stocks');
    global.__io.emit('market:update', {
      stocks: latestStocks.map(st => {
        const cp = Number(st.price);
        const pp = Number(st.prev_price || st.price);
        return {
          stock_id: st.stock_id,
          name: st.name,
          price: cp,
          prev_price: pp,
          rate: pp > 0 ? ((cp - pp) / pp) * 100 : 0,
          high_24h: Number(st.high_24h || cp),
          low_24h: Number(st.low_24h || cp),
          volume_24h: Number(st.volume_24h || 0),
          volatility: Number(st.volatility || 0.04)
        };
      }),
      timestamp: Date.now()
    });
  }

  if (typeof global.__broadcastMarketUpdate === 'function') {
    if (typeof global.__invalidateMarketCache === 'function') global.__invalidateMarketCache();
    setTimeout(global.__broadcastMarketUpdate, 150);
  }

  return { stockId, name: s.name, oldPrice, newPrice, rate, diff };
}

// 🔧 전 종목 일괄 비율 조절 (예: +10% 펌핑 or -10% 완화)
async function adjustAllStocksRatio(percentMultiplier, reason = '시장 전체 유동성 조절') {
  const [stocks] = await pool.query('SELECT * FROM stocks');
  const results = [];
  for (const s of stocks) {
    const { safeBigInt } = require('./money');
    const { mulRate } = require('./moneyScale');
    const cur = safeBigInt(s.price);
    const delta = mulRate(cur, Number(percentMultiplier) / 100, 6);
    const target = cur + delta;
    const res = await adjustStockPrice(s.stock_id, target < 10n ? 10n : target, reason);
    results.push(res);
  }
  return results;
}

let currentStockIntervalSec = parseInt(process.env.STOCK_TICK_INTERVAL_SEC || '30', 10);

function getStockIntervalSec() {
  return currentStockIntervalSec;
}

function setStockIntervalSec(sec) {
  const parsed = parseInt(sec, 10);
  if (!Number.isInteger(parsed) || parsed < 3 || parsed > 3600) {
    throw new Error('주식 변동 주기는 3초에서 3600초 사이여야 합니다.');
  }
  currentStockIntervalSec = parsed;
  return currentStockIntervalSec;
}

function startStockEngine(intervalMs = 30000, client = null) {
  console.log(`🚀 [월덕 가상 경제 엔진] 가동 시작 (기본 변동 주기: ${currentStockIntervalSec}초, 이벤트 풀: ${NEWS_EVENTS.length}개)`);

  function getNextTickDelay() {
    return currentStockIntervalSec * 1000;
  }

  // 첫 갱신은 부팅 후 3초
  setTimeout(() => {
    updateStockPrices();
  }, 3000);

  // 📈 자기 재스케줄링 루프: 경제 상황별 랜덤 변동
  function scheduleNextStockTick() {
    const delay = getNextTickDelay(intervalMs);
    setTimeout(() => {
      try { updateStockPrices(); } catch (e) { console.error('[StockEngine] updateStockPrices 실패:', e); }
      scheduleNextStockTick();
    }, delay);
  }
  scheduleNextStockTick();

  // 📋 지정가 주문 자동 체결 루프 (주가 갱신 주기와 동일하게)
  let limitOrderClient = client;
  function runLimitOrders() {
    try {
      const { processPendingOrders, expirePendingOrders } = require('./limitOrderEngine');
      processPendingOrders(limitOrderClient).catch(() => {});
    } catch (e) {}
  }
  setTimeout(runLimitOrders, 5000); // 부팅 5초 후 첫 실행
  setInterval(runLimitOrders, intervalMs);

  // 📋 만료 주문 처리 (30분 주기)
  setInterval(() => {
    try {
      const { expirePendingOrders } = require('./limitOrderEngine');
      expirePendingOrders().catch(() => {});
    } catch (e) {}
  }, 30 * 60 * 1000);

  // 1시간마다 주식 보유자 대상 자동 배당금 지급
  setInterval(distributeStockDividends, 60 * 60 * 1000);
  // 30분마다 상장적격성 심사 및 상장폐지/정리매매 프로세스 점검
  setInterval(checkAndProcessDelistings, 30 * 60 * 1000);

  // 외부에서 client를 주입할 수 있는 함수
  startStockEngine.setClient = (c) => { limitOrderClient = c; };
}


// 🏢 신규 IPO 상장 대기 기업 풀 (기업 순환 경제)
const IPO_CANDIDATE_POOL = [
  { stock_id: 'QBIT', name: '퀀텀 딥러닝 (QBIT)', price: 3500, sector: '양자컴퓨팅/AI', description: '초전도 큐비트 양자 연산 가속기와 차세대 딥러닝 칩셋을 생산하는 딥테크 기업', volatility: 0.08, pe_ratio: 35.0, dividend_yield: 1.8 },
  { stock_id: 'ROBO', name: '월덕 로보틱스 (ROBO)', price: 4800, sector: '로봇/휴머노이드', description: '채굴장 무인화 로봇 및 서빙 자동화 메카트로닉스를 독점 제조하는 기업', volatility: 0.06, pe_ratio: 28.0, dividend_yield: 2.2 },
  { stock_id: 'AERO', name: '덕스 스페이스 (AERO)', price: 8200, sector: '우주/항공', description: '성층권 통신 위성과 궤도 자원 탐사 셔틀을 개발하는 민간 우주 발사체 기업', volatility: 0.09, pe_ratio: 42.0, dividend_yield: 1.2 },
  { stock_id: 'NANO', name: '냥코 바이오랩 (NANO)', price: 2900, sector: '바이오/신약', description: '유전자 편집 치료제와 안티에이징 항노화 펩타이드 특허를 보유한 바이오벤처', volatility: 0.10, pe_ratio: 22.0, dividend_yield: 1.5 },
  { stock_id: 'GRID', name: '하이퍼 에너지 (GRID)', price: 6100, sector: '신재생/에너지', description: '차세대 전고체 배터리와 스마트 마이크로그리드 전력망 인프라 전문 기업', volatility: 0.05, pe_ratio: 18.0, dividend_yield: 3.5 },
  { stock_id: 'META', name: '메타 오리 스튜디오 (META)', price: 1900, sector: '엔터/메타버스', description: '가상현실 월드 플랫폼 및 3D 아바타 NFT 콘텐츠를 제작하는 크리에이티브 스튜디오', volatility: 0.07, pe_ratio: 25.0, dividend_yield: 2.0 }
];

/**
 * 🛡️ 주가 안정화 & 영구 상장 보장 관리 엔진 (30분 주기)
 * - 🚫 상장폐지 제도 전면 폐지: 어떤 종목도 강제 상장폐지되지 않으며 유저 주식 자산 100% 영구 보존!
 * - ⚡ 주가 과열 시: 자동 액면분할 (1:5, 1:10) 및 자회사 인적분할(Spin-off)로만 적정 주가 안정화
 * - 🔄 기존 비정상 상태 종목: 전원 ACTIVE 정상 거래 상태로 자동 복구
 */
async function checkAndProcessDelistings() {
  try {
    // 1. 🏛️ 모든 종목을 ACTIVE 정상 거래 상태로 무조건 유지/복구 (상장폐지 전면 폐지)
    await pool.query("UPDATE stocks SET status = 'ACTIVE', delisted_at = NULL, liquidation_price = 0 WHERE status != 'ACTIVE'");

    const [stocks] = await pool.query("SELECT * FROM stocks");
    for (const s of stocks) {
      const price = Number(s.price || 0);

      // ── [1. 🛡️ 주가 과열 자동 안정화: 액면분할 & 자회사 인적분할 (주가 150만원 돌파 시)] ──
      if (price >= 1500000) {
        try {
          const [activeCountRows] = await pool.query("SELECT COUNT(*) AS cnt FROM stocks WHERE status = 'ACTIVE'");
          const activeCount = activeCountRows[0]?.cnt || 10;

          // 종목 수가 적고 신사업 테마가 가능한 경우 ➔ 40% 확률로 자회사 인적분할(Spin-off)
          const canSpinOff = activeCount < 20 && Math.random() < 0.40;
          if (canSpinOff) {
            const candidateSuffixes = ['AI', 'TECH', 'LAB', 'BIO', 'SYS', 'ROB', 'NEXT', 'PAY'];
            const suf = candidateSuffixes[Math.floor(Math.random() * candidateSuffixes.length)];
            const newCode = (s.stock_id + suf).slice(0, 8);

            const [exist] = await pool.query('SELECT stock_id FROM stocks WHERE stock_id = ? LIMIT 1', [newCode]);
            if (!exist.length) {
              const newName = `${s.name.split(' ')[0]} ${suf} 신성장 테크`;
              await executeSpinOff(s.stock_id, newCode, newName, 0.40, '첨단혁신', `주가 ${price.toLocaleString()}원 과열 방지 및 미래 신사업 전문화를 위한 인적분할 신규 상장`);
              continue;
            }
          }

          // 그 외의 경우 ➔ 1:5 또는 1:10 액면분할로 주가를 낮추고 유저 주식 수를 비례 증가시켜 안정화
          const splitRatio = price >= 4000000 ? 10 : 5;
          await executeStockSplit(s.stock_id, splitRatio, `주가 ${price.toLocaleString()}원 과열 진화 및 적정 거래 유동성 공급을 위한 1:${splitRatio} 전격 액면분할`);
          continue;
        } catch (splitErr) {
          console.error(`[자동 주가 안정화(분할) 오류] ${s.stock_id}:`, splitErr);
        }
      }
    }
  } catch (err) {
    console.error('❌ [주가 안정화 점검 오류]:', err);
  }
}

/**
 * 💥 상장폐지 기능 (거래소 정책에 의해 영구 폐지 및 보호됨)
 */
async function executeDelisting(stockId, reason = '상장폐지 불가', liquidationPricePerShare = 0n) {
  console.log(`🛡️ [상장폐지 차단] 거래소 영구 상장 보장 정책에 따라 ${stockId} 종목의 상장폐지가 원천 차단되었습니다.`);
  return {
    success: false,
    message: '거래소 규정에 의해 상장폐지 제도가 전면 폐지되었으며 모든 종목의 영구 상장이 보장됩니다.'
  };
}

/**
 * 🎉 상장폐지 종목 전격 재상장 (Relisting / Re-IPO)
 */
async function relistStock(stockId, options = {}) {
  const { formatMoney } = require('./formatters');
  const { safeBigInt } = require('./money');

  const sId = String(stockId || '').toUpperCase().trim();
  const [sRows] = await pool.query('SELECT * FROM stocks WHERE stock_id = ? LIMIT 1', [sId]);
  if (!sRows.length) throw new Error(`[${sId}] 종목을 찾을 수 없습니다.`);
  const stock = sRows[0];

  const rawPrice = options.price ? safeBigInt(options.price) : (safeBigInt(stock.price) > 100n ? safeBigInt(stock.price) : 1000n);
  const reason = String(options.reason || '기업 구조조정 성공 및 재무 건전성 회복에 따른 전격 재상장').trim();

  // 1. 상태를 ACTIVE로 복구하고 주가 및 지표 갱신
  await pool.query(`
    UPDATE stocks
    SET status = 'ACTIVE',
        price = ?,
        prev_price = ?,
        high_24h = ?,
        low_24h = ?,
        volume_24h = 0,
        delisted_at = NULL,
        liquidation_price = 0,
        updated_at = NOW()
    WHERE stock_id = ?
  `, [
    rawPrice.toString(),
    rawPrice.toString(),
    rawPrice.toString(),
    rawPrice.toString(),
    sId
  ]);

  // 2. 증시 공시 등록
  const title = `🎉 [기업 회생 & 전격 재상장 공시] ${stock.name} (${sId}) 거래소 재상장 승인!`;
  const content = `한국거래소 공시: [${stock.name}] 기업이 ${reason} 사유로 상장폐지 처분을 딛고 기준가 ${formatMoney(rawPrice)}원에 성공적으로 재상장(Relisting)되었습니다. 금일부터 웹 및 디스코드에서 정상 거래가 재개됩니다.`;

  await pool.query(`
    INSERT INTO market_news_feed (title, content, event_type, impact_sector, related_stock, impact_rate, sentiment, importance)
    VALUES (?, ?, 'STOCK_RELISTED', ?, ?, 0.50, 'BULL', 'URGENT')
  `, [title, content, stock.sector || '재상장', sId]);

  if (typeof global.__invalidateMarketCache === 'function') {
    global.__invalidateMarketCache();
  }

  console.log(`🎉 [재상장 완료] ${stock.name} (${sId}) 재상장가: ${formatMoney(rawPrice)}`);

  return {
    success: true,
    stockId: sId,
    stockName: stock.name,
    price: rawPrice.toString(),
    priceFormatted: formatMoney(rawPrice),
    sector: stock.sector,
    reason
  };
}

/**
 * ⚡ 주식 액면분할 (Stock Split) 시스템
 * - 주가: 1 / splitRatio 로 감소
 * - 모든 주주 보유 주식 수: splitRatio 배 증가
 * - 주주 총 자산 가치 및 매수 원금 100% 보존
 */
async function executeStockSplit(stockId, splitRatio = 2, reason = '유동성 공급 및 거래 활성화') {
  const { formatMoney } = require('./formatters');
  const { safeBigInt } = require('./money');
  const { amountToUnits, unitsToAmountStr } = require('./moneyScale');

  const sId = String(stockId || '').toUpperCase().trim();
  const ratio = Math.max(2, Math.min(100, parseInt(splitRatio, 10) || 2));

  const [sRows] = await pool.query('SELECT * FROM stocks WHERE stock_id = ? LIMIT 1', [sId]);
  if (!sRows.length) throw new Error(`[${sId}] 종목을 찾을 수 없습니다.`);
  const stock = sRows[0];

  const oldPrice = safeBigInt(stock.price);
  const oldPrevPrice = safeBigInt(stock.prev_price || stock.price);
  const ratioBig = BigInt(ratio);

  const newPrice = oldPrice / ratioBig > 10n ? oldPrice / ratioBig : 10n;
  const newPrevPrice = oldPrevPrice / ratioBig > 10n ? oldPrevPrice / ratioBig : 10n;
  const newHigh24 = safeBigInt(stock.high_24h || oldPrice) / ratioBig;
  const newLow24 = safeBigInt(stock.low_24h || oldPrice) / ratioBig;

  // 1. 주가 테이블 갱신
  await pool.query(`
    UPDATE stocks
    SET price = ?,
        prev_price = ?,
        high_24h = ?,
        low_24h = ?,
        updated_at = NOW()
    WHERE stock_id = ?
  `, [
    newPrice.toString(),
    newPrevPrice.toString(),
    newHigh24 > 10n ? newHigh24.toString() : '10',
    newLow24 > 10n ? newLow24.toString() : '10',
    sId
  ]);

  // 2. 👥 해당 주식을 보유한 모든 유저의 보유 수량을 SQL 레벨에서 정확히 ratio배로 일괄 증가
  const [holders] = await pool.query('SELECT user_id, amount, total_spent FROM user_stocks WHERE stock_id = ? AND amount > 0', [sId]);
  await pool.query('UPDATE user_stocks SET amount = amount * ? WHERE stock_id = ?', [ratio, sId]);

  // 3. 📈 차트 왜곡 방지를 위한 과거 주가 히스토리 수정주가(Adjusted Historical Price) 소급 적용 & 거래량 조정
  try {
    await pool.query('UPDATE stock_history SET price = GREATEST(10, FLOOR(price / ?)) WHERE stock_id = ?', [ratio, sId]);
    await pool.query('UPDATE stocks SET volume_24h = volume_24h * ? WHERE stock_id = ?', [ratio, sId]);
  } catch (adjErr) {}

  // 4. 증시 공시 등록
  const title = `⚡ [액면분할 공시] ${stock.name} (${sId}) 1:${ratio} 주식 액면분할 단행!`;
  const content = `한국거래소 공시: [${stock.name}] 종목이 ${reason} 사유로 1주당 ${ratio}주 비율의 액면분할(Stock Split)을 완료하였습니다. 주가는 기존 ${formatMoney(oldPrice)}원에서 ${formatMoney(newPrice)}원으로 분할되었으며, 기존 주주(${holders.length}명)의 보유 주식 수는 ${ratio}배로 자동 무상 배정(평단가 1/${ratio}로 하향)되었습니다.`;

  await pool.query(`
    INSERT INTO market_news_feed (title, content, event_type, impact_sector, related_stock, impact_rate, sentiment, importance)
    VALUES (?, ?, 'STOCK_SPLIT', ?, ?, 0.15, 'BULL', 'URGENT')
  `, [title, content, stock.sector || '액면분할', sId]);

  if (typeof global.__invalidateMarketCache === 'function') {
    global.__invalidateMarketCache();
  }

  // 5. 📡 실시간 양방향 브로드캐스트 (주가 및 전 유저 잔고/포트폴리오 즉시 동기화)
  if (global.__io) {
    global.__io.emit('stock:split', {
      stockId: sId,
      ratio,
      oldPrice: oldPrice.toString(),
      newPrice: newPrice.toString()
    });
  }

  console.log(`⚡ [액면분할 완료] ${stock.name} (${sId}) 1:${ratio} 분할 (주가: ${formatMoney(oldPrice)} -> ${formatMoney(newPrice)}, 주주: ${holders.length}명)`);

  return {
    success: true,
    stockId: sId,
    stockName: stock.name,
    ratio,
    oldPrice: oldPrice.toString(),
    newPrice: newPrice.toString(),
    oldPriceFormatted: formatMoney(oldPrice),
    newPriceFormatted: formatMoney(newPrice),
    affectedUsers: holders.length,
    reason
  };
}

/**
 * 🏢 기업 인적분할 (Corporate Spin-off) 시스템
 * - 모회사(A)에서 신설회사(B)를 분할 상장
 * - 분할 비율 (예: 0.4 ➔ 신설회사 40%, 모회사 60% 가치)
 * - 모회사(A) 주가 = 기존가 * (1 - ratio)
 * - 신설회사(B) 주가 = 기존가 * ratio
 * - 기존 모회사 주주 전원에게 보유 수량 1:1 지분율대로 신설회사(B) 주식 무상 자동 배정!
 * - 주주의 총 투자 평가액 100% 완벽 보존
 */
async function executeSpinOff(parentStockId, newStockId, newStockName, splitRatio = 0.4, newSector = null, reason = '사업부문 전문화 및 기업가치 극대화') {
  const { formatMoney } = require('./formatters');
  const { safeBigInt } = require('./money');

  const pId = String(parentStockId || '').toUpperCase().trim();
  const nId = String(newStockId || '').toUpperCase().trim();
  const nName = String(newStockName || '').trim();
  const ratio = Math.max(0.1, Math.min(0.9, parseFloat(splitRatio) || 0.4)); // 10% ~ 90%

  if (!pId || !nId || !nName) {
    throw new Error('모회사 코드, 신설 종목코드, 신설 종목명을 모두 입력해야 합니다.');
  }

  if (pId === nId) {
    throw new Error('모회사와 신설회사의 종목코드는 달라야 합니다.');
  }

  // 1. 모회사 조회
  const [pRows] = await pool.query('SELECT * FROM stocks WHERE stock_id = ? LIMIT 1', [pId]);
  if (!pRows.length) throw new Error(`모회사 [${pId}] 종목을 찾을 수 없습니다.`);
  const parent = pRows[0];

  // 2. 신설 종목코드 중복 검사
  const [existRows] = await pool.query('SELECT stock_id FROM stocks WHERE stock_id = ? LIMIT 1', [nId]);
  if (existRows.length > 0) {
    throw new Error(`신설 종목코드 [${nId}]가 이미 거래소에 존재합니다. 다른 코드를 사용하세요.`);
  }

  const oldParentPrice = safeBigInt(parent.price);
  const oldParentPrevPrice = safeBigInt(parent.prev_price || parent.price);

  // 모회사와 신설 자회사 가격 배분 (합계는 기존가와 100% 동일)
  const ratioInt = BigInt(Math.round(ratio * 10000));
  const newChildPrice = (oldParentPrice * ratioInt) / 10000n > 10n ? (oldParentPrice * ratioInt) / 10000n : 10n;
  const newParentPrice = (oldParentPrice - newChildPrice) > 10n ? (oldParentPrice - newChildPrice) : 10n;

  const childPrevPrice = (oldParentPrevPrice * ratioInt) / 10000n > 10n ? (oldParentPrevPrice * ratioInt) / 10000n : 10n;
  const parentPrevPrice = (oldParentPrevPrice - childPrevPrice) > 10n ? (oldParentPrevPrice - childPrevPrice) : 10n;

  const childSector = newSector || parent.sector || '신성장';

  // 3. 모회사 주가 조정
  await pool.query(`
    UPDATE stocks
    SET price = ?,
        prev_price = ?,
        high_24h = ?,
        low_24h = ?,
        updated_at = NOW()
    WHERE stock_id = ?
  `, [
    newParentPrice.toString(),
    parentPrevPrice.toString(),
    newParentPrice.toString(),
    newParentPrice.toString(),
    pId
  ]);

  // 4. 신설회사 신규 상장
  await pool.query(`
    INSERT INTO stocks (
      stock_id, name, sector, price, prev_price,
      high_24h, low_24h, volume_24h, dividend_yield,
      volatility, status, description, pe_ratio, market_cap
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, 0, ?,
      ?, 'ACTIVE', ?, 20.0, ?
    )
  `, [
    nId,
    nName,
    childSector,
    newChildPrice.toString(),
    childPrevPrice.toString(),
    newChildPrice.toString(),
    newChildPrice.toString(),
    parent.dividend_yield || 0.02,
    parent.volatility || 0.05,
    `${parent.name} 기업 인적분할 신설 테크 상장사`,
    (newChildPrice * 1000000n).toString()
  ]);

  // 5. 👥 기존 모회사 주주 전원에게 신설회사 주식 1:1 지분율 무상 배정
  const [holders] = await pool.query('SELECT user_id, amount, total_spent FROM user_stocks WHERE stock_id = ? AND amount > 0', [pId]);
  for (const h of holders) {
    const shareAmt = String(h.amount);
    await pool.query(`
      INSERT INTO user_stocks (user_id, stock_id, amount, total_spent)
      VALUES (?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount)
    `, [h.user_id, nId, shareAmt]);
  }

  // 6. 증시 공시 등록
  const title = `🏢 [인적분할 신규상장] ${parent.name}(${pId}) ➔ ${nName}(${nId}) 분할 상장!`;
  const content = `한국거래소 공시: [${parent.name}] 기업이 ${reason} 사유로 핵심 사업부를 분할하여 [${nName} (${nId})]을 신규 상장하였습니다. (가치분할: 존속 ${100 - Math.round(ratio*100)}% / 신설 ${Math.round(ratio*100)}%)\n기존 ${parent.name} 주주(${holders.length}명) 전원에게 보유 수량과 동일한 1:1 비율로 [${nName}] 신주가 무상 배정 입고되었습니다.`;

  await pool.query(`
    INSERT INTO market_news_feed (title, content, event_type, impact_sector, related_stock, impact_rate, sentiment, importance)
    VALUES (?, ?, 'STOCK_SPINOFF', ?, ?, 0.25, 'BULL', 'URGENT')
  `, [title, content, childSector, nId]);

  if (typeof global.__invalidateMarketCache === 'function') {
    global.__invalidateMarketCache();
  }

  // 7. 실시간 소켓 브로드캐스트
  if (global.__io) {
    global.__io.emit('stock:spinoff', {
      parentStockId: pId,
      newStockId: nId,
      newStockName: nName,
      ratio,
      parentNewPrice: newParentPrice.toString(),
      childNewPrice: newChildPrice.toString()
    });
  }

  console.log(`🏢 [인적분할 완료] ${parent.name}(${pId}) ➔ ${nName}(${nId}) (가치: ${formatMoney(newParentPrice)} + ${formatMoney(newChildPrice)}, 주주: ${holders.length}명 배정)`);

  return {
    success: true,
    parentStockId: pId,
    parentName: parent.name,
    parentNewPrice: newParentPrice.toString(),
    parentNewPriceFormatted: formatMoney(newParentPrice),
    newStockId: nId,
    newStockName: nName,
    newStockPrice: newChildPrice.toString(),
    newStockPriceFormatted: formatMoney(newChildPrice),
    splitRatio: ratio,
    affectedUsers: holders.length,
    reason
  };
}

/**
 * 🚀 신규 혁신 기업 IPO 공모 상장 (빈자리 자동 충원)
 */
async function launchNewIPOStock(customStock = null) {
  const { formatMoney } = require('./formatters');

  let candidate = customStock;
  if (!candidate) {
    // 기존 활성 종목 ID 목록
    const [active] = await pool.query("SELECT stock_id FROM stocks WHERE status != 'DELISTED'");
    const activeIds = new Set(active.map(r => r.stock_id));

    // 미상장된 IPO 후보 선택
    candidate = IPO_CANDIDATE_POOL.find(c => !activeIds.has(c.stock_id));
  }

  if (!candidate) {
    console.log('ℹ️ [IPO 상장] 대기 중인 신규 IPO 후보가 없습니다.');
    return null;
  }

  // 데이터베이스에 신규 종목 등록 (또는 재상장)
  await pool.query(`
    INSERT INTO stocks 
      (stock_id, name, price, prev_price, volatility, sector, description, high_24h, low_24h, volume_24h, market_cap, pe_ratio, dividend_yield, status, delisted_at, liquidation_price)
    VALUES 
      (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'ACTIVE', NULL, 0)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      price = VALUES(price),
      prev_price = VALUES(prev_price),
      volatility = VALUES(volatility),
      sector = VALUES(sector),
      description = VALUES(description),
      high_24h = VALUES(high_24h),
      low_24h = VALUES(low_24h),
      market_cap = VALUES(market_cap),
      pe_ratio = VALUES(pe_ratio),
      dividend_yield = VALUES(dividend_yield),
      status = 'ACTIVE',
      delisted_at = NULL,
      liquidation_price = 0
  `, [
    candidate.stock_id,
    candidate.name,
    candidate.price,
    candidate.price,
    candidate.volatility || 0.06,
    candidate.sector || '신규상장',
    candidate.description || '신규 공모 상장 기업',
    candidate.price,
    candidate.price,
    candidate.price * 1000000,
    candidate.pe_ratio || 25.0,
    candidate.dividend_yield || 2.0
  ]);

  // 증시 공시 속보 등록
  const title = `🚀 [신규 IPO 상장 공시] 혁신 기업 ${candidate.name} (${candidate.stock_id}) 거래소 신규 상장!`;
  const content = `한국거래소 공시: 차세대 성장 유망 기업 [${candidate.name}]이 공모가 ${formatMoney(candidate.price)}원에 성공적으로 신규 상장되었습니다. (${candidate.sector} - ${candidate.description})`;

  await pool.query(`
    INSERT INTO market_news_feed (title, content, event_type, impact_sector, related_stock, impact_rate, sentiment, importance)
    VALUES (?, ?, 'STOCK_IPO', ?, ?, 0.35, 'BULL', 'URGENT')
  `, [title, content, candidate.sector, candidate.stock_id]);

  console.log(`🚀 [신규 IPO 상장] ${candidate.name} (${candidate.stock_id}) 상장 완료 (공모가: ${candidate.price}원)`);

  return candidate;
}

/**
 * 👑 관리자 커스텀 주식 신규 상장/추가
 */
async function createCustomStock(options = {}) {
  const { formatMoney } = require('./formatters');
  const { safeBigInt } = require('./money');

  const stockId = String(options.stockId || '').toUpperCase().trim();
  const name = String(options.name || '').trim();
  const rawPrice = safeBigInt(options.price || 1000);
  const sector = String(options.sector || '신규상장').trim();
  const description = String(options.description || '관리자 신규 상장 기업').trim();
  const volatility = Math.max(0.01, Math.min(0.20, Number(options.volatility || 0.06)));
  const peRatio = Number(options.peRatio || 20.0);
  const dividendYield = Number(options.dividendYield || 2.5);

  if (!stockId || stockId.length < 2 || stockId.length > 10) {
    throw new Error('종목코드는 2~10자 영문 대문자여야 합니다. (예: GOOGL, SAM, DUCK)');
  }
  if (!name || name.length < 2) {
    throw new Error('종목명을 2자 이상 입력해주세요.');
  }
  if (rawPrice < 10n) {
    throw new Error('공모가는 최소 10원 이상이어야 합니다.');
  }

  // DB 등록
  await pool.query(`
    INSERT INTO stocks 
      (stock_id, name, price, prev_price, volatility, sector, description, high_24h, low_24h, volume_24h, market_cap, pe_ratio, dividend_yield, status, delisted_at, liquidation_price)
    VALUES 
      (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'ACTIVE', NULL, 0)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      price = VALUES(price),
      prev_price = VALUES(prev_price),
      volatility = VALUES(volatility),
      sector = VALUES(sector),
      description = VALUES(description),
      high_24h = VALUES(high_24h),
      low_24h = VALUES(low_24h),
      market_cap = VALUES(market_cap),
      pe_ratio = VALUES(pe_ratio),
      dividend_yield = VALUES(dividend_yield),
      status = 'ACTIVE',
      delisted_at = NULL,
      liquidation_price = 0
  `, [
    stockId,
    name,
    rawPrice.toString(),
    rawPrice.toString(),
    volatility,
    sector,
    description,
    rawPrice.toString(),
    rawPrice.toString(),
    (rawPrice * 1000000n).toString(),
    peRatio,
    dividendYield
  ]);

  // 🏢 기업 영업이익 풀 자동 초기화 (배당금 및 실물 경제 연동)
  await pool.query(`
    INSERT INTO corporate_earnings (stock_id, earnings_pool, total_revenue, total_dividend_paid)
    VALUES (?, 10000000, 0, 0)
    ON DUPLICATE KEY UPDATE earnings_pool = earnings_pool;
  `, [stockId]).catch(() => {});

  // 증시 공시 등록
  const title = `👑 [관리자 특례 신규 상장] ${name} (${stockId}) 거래소 신규 상장 공시!`;
  const content = `거래소 공시: 관리자 직권 특례 상장으로 신규 기업 [${name}]이 공모가 ${formatMoney(rawPrice)}원에 상장되었습니다. (${sector} - ${description})`;

  await pool.query(`
    INSERT INTO market_news_feed (title, content, event_type, impact_sector, related_stock, impact_rate, sentiment, importance)
    VALUES (?, ?, 'STOCK_IPO', ?, ?, 0.40, 'BULL', 'URGENT')
  `, [title, content, sector, stockId]);

  console.log(`👑 [관리자 커스텀 신규 상장] ${name} (${stockId}) 공모가: ${formatMoney(rawPrice)}`);

  return {
    stockId,
    name,
    price: rawPrice.toString(),
    priceFormatted: formatMoney(rawPrice),
    sector,
    description,
    volatility,
    peRatio,
    dividendYield
  };
}

function getCurrentMarketRegime() {
  return MARKET_REGIMES[currentRegimeIndex] || MARKET_REGIMES[0];
}

/**
 * 🌐 거시경제 국면에 따른 주식 매수 한도 배율 (Dynamic Regime Buy Limit Multiplier)
 * - 🚀 SUPER_BULL / BOOM: 2.0x (유동성 파티 한도 200% 대폭 확대)
 * - 📈 BULL: 1.5x (경기 확장기 150% 확대)
 * - ⚖️ NORMAL: 1.0x (표준 한도 100%)
 * - 📉 RECESSION: 0.7x (경기 침체 70% 긴축)
 * - 🌪️ CRASH: 0.5x (금융 위기 50% 안전 보호)
 */
function getRegimeBuyLimitMultiplier() {
  const regime = getCurrentMarketRegime();
  if (!regime) return { multiplier: 1.0, policyName: '표준 한도 (100%)', regimeName: '정상 경기' };
  
  if (regime.type === 'SUPER_BULL' || regime.id === 'BOOM') {
    return { multiplier: 2.0, policyName: '🚀 대호황기 유동성 특수 매수 한도 2배(200%) 확대', regimeName: regime.name };
  }
  if (regime.type === 'BULL' || regime.drift > 0) {
    return { multiplier: 1.5, policyName: '📈 경기 확장기 매수 한도 1.5배(150%) 완화', regimeName: regime.name };
  }
  if (regime.type === 'CRASH') {
    return { multiplier: 0.5, policyName: '🌪️ 금융위기 투자자 보호 매수 한도 50% 긴축', regimeName: regime.name };
  }
  if (regime.type === 'RECESSION' || regime.drift < 0) {
    return { multiplier: 0.7, policyName: '📉 경기 침체기 투기 과열 방지 매수 한도 70% 축소', regimeName: regime.name };
  }
  return { multiplier: 1.0, policyName: '⚖️ 정상 시장 표준 매수 한도 (100%)', regimeName: regime.name };
}

/**
 * 📊 종목별 고유 기초 최대 매수 한도 (Base Max Shares per Stock)
 * - 초저가 동전주 (< 1,000원): 1,000만 주
 * - 중저가 일반주 (1,000원 ~ 10,000원): 200만 주
 * - 고가 혁신주 (10,000원 ~ 100,000원): 50만 주
 * - 초고가 대형주 (100,000원 ~ 100만원): 10만 주
 * - 황제주 (100만원 이상): 2만 주
 */
function getStockBaseBuyLimit(stock) {
  if (typeof stock === 'object' && stock && stock.max_buy_limit != null && Number(stock.max_buy_limit) > 0) {
    return Number(stock.max_buy_limit);
  }
  const price = typeof stock === 'object' ? Number(stock.price || 0) : Number(stock || 0);
  if (price < 1000) return 10000000;       // 1,000만 주
  if (price < 10000) return 2000000;       // 200만 주
  if (price < 100000) return 500000;       // 50만 주
  if (price < 1000000) return 100000;      // 10만 주
  return 20000;                            // 2만 주
}

/**
 * 🎯 경제 상황 연동 종목별 실시간 1회 최대 구매 한도 계산 (Max Stock Purchase Limit)
 */
function getStockMaxBuyLimit(stock) {
  const baseShares = getStockBaseBuyLimit(stock);
  const { multiplier, policyName, regimeName } = getRegimeBuyLimitMultiplier();
  const maxShares = Math.max(10, Math.floor(baseShares * multiplier));
  const maxUnits = BigInt(maxShares) * 10000n; // 소수점 4자리 유닛 단위
  const isCustom = typeof stock === 'object' && stock && stock.max_buy_limit != null && Number(stock.max_buy_limit) > 0;

  return {
    baseShares,
    multiplier,
    maxShares,
    maxUnits,
    maxSharesText: maxShares.toLocaleString('ko-KR') + '주',
    policyName,
    regimeName,
    isCustom
  };
}

/**
 * 👑 관리자 종목별 1회 최대 구매 한도 직접 설정/초기화
 */
async function setStockCustomBuyLimit(stockId, maxLimit) {
  const sId = String(stockId || '').toUpperCase().trim();
  const [stocks] = await pool.query('SELECT stock_id, name, price FROM stocks WHERE stock_id = ?', [sId]);
  if (!stocks.length) {
    throw new Error(`존재하지 않는 주식 종목코드입니다: [${sId}]`);
  }

  const limitVal = maxLimit === null || maxLimit === undefined || maxLimit === '' || Number(maxLimit) <= 0
    ? null
    : Math.floor(Number(maxLimit));

  await pool.query('UPDATE stocks SET max_buy_limit = ? WHERE stock_id = ?', [limitVal, sId]);

  const stock = stocks[0];
  stock.max_buy_limit = limitVal;
  const buyLimitInfo = getStockMaxBuyLimit(stock);

  console.log(`👑 [관리자 한도 설정] [${stock.name}(${sId})] 최대 매수 한도 ➔ ${limitVal ? limitVal.toLocaleString() + '주 (커스텀)' : '주가 기반 자동'}`);

  return {
    stockId: sId,
    stockName: stock.name,
    customLimit: limitVal,
    buyLimitInfo
  };
}

// 자동 경제 조절 시스템에서 호출 - 시장 국면 강제 변경
function setMarketRegime(index) {
  if (index === null || index === undefined || index === '') {
    forcedRegimeIndex = null;
    return;
  }
  const n = Number(index);
  if (Number.isInteger(n) && n >= 0 && n < MARKET_REGIMES.length) {
    currentRegimeIndex = n;
    forcedRegimeIndex = n;
    regimeCyclesLeft = 3;
    console.log(`🔧 [시장국면] 즉시 전환: ${MARKET_REGIMES[n].name}`);
  }
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
  distributeStockDividends,
  adjustStockPrice,
  adjustAllStocksRatio,
  startStockEngine,
  checkAndProcessDelistings,
  executeDelisting,
  relistStock,
  executeStockSplit,
  executeSpinOff,
  launchNewIPOStock,
  createCustomStock,
  getCurrentMarketRegime,
  setMarketRegime,
  getStockBaseBuyLimit,
  getRegimeBuyLimitMultiplier,
  getStockMaxBuyLimit,
  setStockCustomBuyLimit,
  getLastNews,
  getRecentNewsFeed,
  getStockIntervalSec,
  setStockIntervalSec,
  MARKET_REGIMES,
  NEWS_EVENTS,
  IPO_CANDIDATE_POOL
};
