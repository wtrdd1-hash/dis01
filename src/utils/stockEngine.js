const { pool } = require('../config/database');

// 우리 커뮤니티 가상 경제 시황 국면 (Custom Community Economic Regimes)
const MARKET_REGIMES = [
  { name: '🦆 월덕 경제 번영기 (Duck Prosperity)', drift: 0.03, volatilityFactor: 1.0, desc: '서버 커뮤니티 활동과 채굴, 카지노 이용이 활발해지며 전 종목 매수세가 우세합니다.' },
  { name: '📉 가상 시장 조정기 (Market Cooldown)', drift: -0.02, volatilityFactor: 1.1, desc: '차익 실현 매물 출회와 자산 보수적 운용으로 단기 조정 국면에 진입했습니다.' },
  { name: '⚖️ 안정적 박스권 횡보 (Stable Sideways)', drift: 0.00, volatilityFactor: 0.7, desc: '예금과 실물 소비가 균형을 이루며 주가가 안정적인 가격대를 형성하고 있습니다.' },
  { name: '🔥 카지노 & 광산 대박 랠리 (Jackpot Boom)', drift: 0.04, volatilityFactor: 1.4, desc: '광산에서 초희귀 원석이 대량 출토되고 카지노 잭팟 열풍으로 투기적 매수세가 폭발합니다.' },
  { name: '🚀 냥코 양자 퀀텀 폭등 (Neko Quantum Surge)', drift: 0.05, volatilityFactor: 1.6, desc: '네코 랩스의 신비한 고양이 에너지 기술 발표로 첨단 테마주들이 폭등세를 주도합니다.' },
  { name: '🏦 중앙은행 유동성 무제한 살포 (Bank Liquidity)', drift: 0.04, volatilityFactor: 1.2, desc: '덕스 중앙은행의 지원금 확대와 예금 금리 우대로 풍부한 유동성이 증시로 유입됩니다.' },
  { name: '🌟 메가 서포터즈 슈퍼사이클 (Mega Supercycle)', drift: 0.06, volatilityFactor: 1.8, desc: '전 세계 디스코드 유저 유입과 대형 기관 투자가 몰리며 전 종목 역사적 신고가를 돌파합니다.' }
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
  { title: '🌟 커뮤니티 상장 기업 전체 1분기 영업이익 합계 1조 원 돌파 신기록', text: '8개 상장사 모두 흑자 경영을 달성하며 펀더멘털의 견고함을 입증했습니다.', eventType: 'MACRO_SURGE', sentiment: 'BULL', importance: 'HIGH', relatedStock: 'ALL', impactSector: '시장 전반', impact: { ALL: 0.09, WTRD: 0.14 } },
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

// 📈 3분 주기 가상 주식 가격 변동 엔진
async function updateStockPrices() {
  const connection = await pool.getConnection();
  try {
    regimeCyclesLeft--;
    if (regimeCyclesLeft <= 0 || Math.random() < 0.20) {
      currentRegimeIndex = Math.floor(Math.random() * MARKET_REGIMES.length);
      regimeCyclesLeft = Math.floor(Math.random() * 8) + 8;
    }
    const currentRegime = MARKET_REGIMES[currentRegimeIndex];

    const [stocks] = await connection.query('SELECT * FROM stocks');
    
    // 50% 확률로 120개 중 랜덤 뉴스 이벤트 발생 및 DB 저장
    let eventImpactMap = {};
    lastNews = null;
    if (Math.random() < 0.50) {
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
      const changeRateNum = currentPrice > 0n ? ((Number(diff) / Number(currentPrice)) * 100) : 0;
      const changeRate = changeRateNum.toFixed(2);
      
      // 🚨 15% 이상 급등락 시 서킷브레이커 태그 부착
      let circuitPrefix = '';
      if (Math.abs(changeRateNum) >= 15) {
        circuitPrefix = changeRateNum > 0 ? '🚨 [서킷브레이커 상한가 랠리] ' : '🚨 [서킷브레이커 급락 완화] ';
      }

      const reasonStr = lastNews ? `${circuitPrefix}[${lastNews.title}]` : `${circuitPrefix}${currentRegime.name} 시황 변동`;

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

// 💰 정기 주식 배당금 자동 지급 엔진 (1시간 주기 or 배당 이벤트 시 실행)
async function distributeStockDividends() {
  try {
    const [stocks] = await pool.query('SELECT stock_id, name, price, dividend_yield FROM stocks WHERE dividend_yield > 0');
    if (stocks.length === 0) return;

    for (const s of stocks) {
      const yieldRate = Number(s.dividend_yield || 0) / 100;
      const hourlyDividendPerShare = BigInt(Math.max(1, Math.floor((Number(s.price) * yieldRate) / 24)));

      const [holdings] = await pool.query(`
        SELECT us.user_id, us.amount, u.username, u.cash
        FROM user_stocks us
        JOIN users u ON us.user_id = u.discord_id
        WHERE us.stock_id = ? AND us.amount > 0
      `, [s.stock_id]);

      for (const h of holdings) {
        const shareCount = BigInt(h.amount);
        const dividendAmount = hourlyDividendPerShare * shareCount;
        if (dividendAmount <= 0n) continue;

        const beforeCash = BigInt(h.cash || 0);
        const afterCash = beforeCash + dividendAmount;

        await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [afterCash.toString(), h.user_id]);

        try {
          await pool.query(`
            INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
            VALUES (?, ?, 'DIVIDEND', ?, ?, ?, ?)
          `, [
            h.user_id, h.username || `유저_${h.user_id.slice(-4)}`, dividendAmount.toString(),
            beforeCash.toString(), afterCash.toString(),
            `💰 [${s.name}] 보유 주식(${shareCount}주) 정기 배당금 수령 (+${dividendAmount.toLocaleString()}원)`
          ]);
        } catch (e) {}
      }
    }
    console.log('💰 [정기 배당 엔진] 주주 대상 배당금 자동 분배 완료');
  } catch (err) {
    console.error('❌ 배당금 지급 중 오류:', err);
  }
}

function startStockEngine(intervalMs = 180000) {
  console.log(`🚀 [월덕 가상 경제 엔진] 가동 시작 (갱신 주기: ${intervalMs / 1000}초, 이벤트 풀: ${NEWS_EVENTS.length}개)`);
  setTimeout(() => {
    updateStockPrices();
  }, 3000);
  setInterval(updateStockPrices, intervalMs);

  // 1시간마다 주식 보유자 대상 자동 배당금 지급
  setInterval(distributeStockDividends, 60 * 60 * 1000);
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
  distributeStockDividends,
  startStockEngine,
  getCurrentMarketRegime,
  getLastNews,
  getRecentNewsFeed,
  MARKET_REGIMES,
  NEWS_EVENTS
};
