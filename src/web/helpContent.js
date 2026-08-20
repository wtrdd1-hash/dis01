'use strict';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CATS = [
  { id: 'all', label: '전체' },
  { id: 'start', label: '시작' },
  { id: 'money', label: '자산' },
  { id: 'stock', label: '주식' },
  { id: 'earn', label: '수익' },
  { id: 'casino', label: '카지노' },
  { id: 'hot', label: '핫게임' },
  { id: 'arcade', label: '아케이드' },
  { id: 'discord', label: '명령어' },
  { id: 'faq', label: 'FAQ' }
];

const ARTICLES = [
  {
    id: 'start',
    cat: 'start',
    title: '시작하기',
    keywords: '처음 로그인 디스코드 가입 화면 채널',
    go: { tab: 'tab-stocks', label: '주식 시장으로' },
    blocks: [
      { type: 'p', text: '월덕은 디스코드 봇과 연동되는 가상 경제입니다. 현금·예금·주식은 모두 게임용 가상 돈이며 환전되지 않습니다.' },
      { type: 'ol', items: [
        '오른쪽 자산 칸 또는 상단에서 Discord로 로그인합니다.',
        '왼쪽 채널(#주식-시장, #사업, #카지노 등)을 눌러 화면을 바꿉니다.',
        '오른쪽에서 현금·예금·주식·순자산을 확인합니다.',
        '출석·지원금·은행은 자산 칸의 빠른 버튼으로 쓸 수 있습니다.'
      ] },
      { type: 'note', text: '상단 ? 또는 키보드 ? 로 도움말 창이 열립니다. 창 안에서 / 를 누르면 검색됩니다. 위치·크기·투명도는 새로고침 후에도 유지됩니다.' }
    ]
  },
  {
    id: 'screen',
    cat: 'start',
    title: '화면 구성',
    keywords: '사이드바 레일 채널 지갑 모바일 메뉴',
    blocks: [
      { type: 'ul', items: [
        '맨 왼쪽 아이콘: 채널을 빠르게 전환합니다.',
        '# 채널 목록: 경제·커뮤니티·게임 메뉴입니다.',
        '가운데: 선택한 채널의 본문입니다.',
        '오른쪽: 내 자산과 출석·지원금·은행입니다. 좁은 화면에서는 상단 ₩ 버튼으로 엽니다.',
        '하단 LIVE WIN: 최근 카지노 당첨 소식입니다.',
        '설정: 왼쪽 아래 톱니바퀴, 프로필의 설정 탭, 또는 상단 반달 아이콘에서 테마·GUI 모드·밀도를 바꿉니다.'
      ] }
    ]
  },
  {
    id: 'networth',
    cat: 'money',
    title: '현금 · 예금 · 주식 · 순자산',
    keywords: '지갑 순자산 현금 예금 주식 평가액 계산',
    blocks: [
      { type: 'p', text: '순자산 = 현금 + 예금 + 주식 평가액입니다. 카지노·채굴 보상은 현금으로 들어옵니다.' },
      { type: 'ul', items: [
        '현금: 매수·배팅·강화에 바로 쓰는 돈입니다.',
        '예금: 은행에 넣어 둔 돈입니다. 이자가 붙고, 주식 매수·카지노에는 바로 쓰이지 않습니다.',
        '주식: 보유 수량 × 현재가의 합입니다. 팔기 전에는 현금이 아닙니다.'
      ] },
      { type: 'note', text: '지원금 자격은 순자산(현금+예금+주식)으로 봅니다. 현금만 비워 두고 예금·주식에 돈을 옮겨도 한도에 걸립니다.' }
    ]
  },
  {
    id: 'tax',
    cat: 'money',
    title: '세금 · 국고',
    keywords: '세금 거래세 송금세 자산세 국고 세율 고자산',
    blocks: [
      { type: 'p', text: '경제가 과열되거나 빈부격차가 클 때만 세율이 올라갑니다. 걷힌 돈은 누구에게도 지급되지 않고 국고로 흡수되어 시중 통화량이 줄어듭니다. 관리자 계정은 면제입니다.' },
      { type: 'ul', items: [
        '거래세: 주식 매수·매도 대금에 붙습니다. 매수는 대금+세금, 매도는 대금-세금입니다.',
        '송금세: 일반 유저끼리 /송금 할 때만 붙습니다. 받는 사람은 전액을 받고, 보내는 사람이 세금까지 냅니다.',
        '자산세: 세율이 있을 때, 현금+예금이 기준을 넘는 유저의 현금·예금에서 10분마다 조금 걷습니다. 주식 평가액은 순자산·순위에는 들어가지만 자산세 발동에는 쓰지 않습니다. 회당 유동자산의 0.20%를 넘지 않습니다.',
        '세율은 최대 15%입니다. 경제가 안정되면 0%로 돌아갑니다.',
        '다음 자산세 시각과 예상 회수액은 오른쪽 자산 칸, 주식 상단, /지갑에 나옵니다.',
        '관리자가 세율을 잠그면 자동 조절이 덮지 않습니다. 걷힌 돈 중 돌려주지 않은 분은 국고에 남습니다.'
      ] },
      { type: 'note', text: '현재 세율은 #주식-시장 상단과 오른쪽 자산 칸에 표시됩니다. 0%면 세금이 붙지 않습니다.' }
    ]
  },
  {
    id: 'bank',
    cat: 'money',
    title: '은행 예금',
    keywords: '은행 저금 인출 이자 금리 대출 상환 담보 연체',
    go: { action: 'openBankModal', label: '은행 열기' },
    blocks: [
      { type: 'p', text: '자산 칸의 은행 버튼으로 저금·인출·대출합니다. 디스코드에서는 /은행 저금, /은행 인출, /은행 대출, /은행 상환, /은행 정보를 씁니다.' },
      { type: 'ul', items: [
        '예금 이자는 시간당 0.05%입니다. 1분마다 나눠 지급됩니다.',
        '예: 예금 10만 원이면 한 시간에 약 50원입니다.',
        '1원 미만 이자는 모아 두었다가 1원이 되면 지급됩니다.',
        '대출은 일반 유저만, 한 번에 1건입니다. 예금의 50%까지(연체하면 한도가 줄어듭니다).',
        '대출 이자는 시간당 0.15%이고 만기는 24시간입니다. 조기상환하면 그때까지 붙은 이자만 냅니다.',
        '빌린 원금만큼의 2배 예금이 담보로 잠깁니다. 담보 예금에도 예금 이자는 붙습니다.',
        '재원은 국고를 먼저 쓰고, 부족하면 해당 대출의 최대 20%만 새로 발행합니다. 이자는 국고로 들어갑니다.',
        '만기에 못 갚으면 담보 예금(부족하면 현금)에서 회수합니다. 연체 중에는 카지노와 주식 매수를 쓸 수 없습니다.'
      ] }
    ]
  },
  {
    id: 'daily',
    cat: 'earn',
    title: '출석',
    keywords: '출석체크 출석 보상 연속 스트릭',
    go: { action: 'claimDailyReward', label: '출석하기' },
    blocks: [
      { type: 'p', text: '하루에 한 번 받을 수 있습니다. 웹 자산 칸의 출석 버튼 또는 디스코드 /출석.' },
      { type: 'ul', items: [
        '기본 보상 3,000원.',
        '연속 출석 1일마다 +500원 보너스.',
        '카지노 일일 미션의 출석 항목과도 연동됩니다.'
      ] }
    ]
  },
  {
    id: 'subsidy',
    cat: 'earn',
    title: '지원금',
    keywords: '지원금 기본소득 가난 긴급 쿨타임',
    go: { action: 'claimSubsidyReward', label: '지원금 신청' },
    blocks: [
      { type: 'p', text: '순자산이 5만 원 미만일 때만 2,000원을 받을 수 있습니다.' },
      { type: 'ul', items: [
        '현금+예금이 1,000원 미만이면 긴급 지원: 2분 쿨타임.',
        '그 외 대상자는 10분 쿨타임.',
        '순자산 5만 원 이상이면 신청이 거절됩니다.'
      ] }
    ]
  },
  {
    id: 'clicker',
    cat: 'earn',
    title: '채굴 (클릭커)',
    keywords: '채굴 클릭커 골드 자동봇 강화',
    go: { tab: 'tab-clicker', label: '채굴장 열기' },
    blocks: [
      { type: 'p', text: '#채굴에서 보석을 누르면 현금을 법니다. 장르를 바꿔도 클릭 수익 공식은 같고, 디스코드 /클리커와 수치가 같습니다.' },
      { type: 'ul', items: [
        '클릭 1회: 채굴기 레벨 × 10원.',
        '치명타: 10% 확률로 3배.',
        '장르 14종. 기본 보석 연타 외에 두더지·짝맞추기·광차·빙하·용암·광맥 따라가기 같은 미니게임이 있습니다.',
        '보석 연타는 기본 개방. 다른 장르는 현금으로 한 번 해금하면 계속 유지됩니다.',
        '일부 장르는 타이밍·짝·빛나는 칸이 맞을 때만 채굴로 인정됩니다. 연출만 다르고 인정된 클릭의 수익 공식은 같습니다.',
        '자동봇: 레벨 × 초당 15원. 켜 두면 접속 중 계속 들어옵니다.',
        '채굴기 강화 비용: 현재 레벨 × 4,500원.',
        '자동봇 구매 비용: (자동봇 레벨 + 1) × 12,000원.'
      ] }
    ]
  },
  {
    id: 'business',
    cat: 'earn',
    title: '사업 · 점포',
    keywords: '사업 점포 개업 알바 고용 본사 자동수금 수금 매각',
    go: { tab: 'tab-business', label: '사업 채널로' },
    blocks: [
      { type: 'p', text: '#사업에서 점포를 개업하면 시간이 지날수록 수익이 쌓입니다. 디스코드 /사업 과 같은 지갑을 씁니다. 사업 장부가액은 순자산에 넣지 않습니다.' },
      { type: 'ul', items: [
        '선행 개업: 편의점 → 농장/카페처럼 앞 점포가 있어야 다음 점포가 열립니다.',
        '알바: 점포당 최대 5명. 매출이 오르지만 급여가 빠집니다.',
        '본사: 점포가 1곳 이상일 때 올릴 수 있습니다. 레벨마다 전체 매출 +6%. 최대 5.',
        '자동 수금: 본사 1레벨부터. 켜 두면 1분마다 현금으로 들어옵니다.',
        '수동 수금: 8% 확률로 대박(+20%) 또는 비수기(-10%). 자동 수금에는 없습니다.',
        '오프라인 수익은 최대 8시간분. 매각은 투자금 60%와 대기 수익입니다.',
        '뒤에 이어진 점포가 있으면 앞 점포는 매각할 수 없습니다.'
      ] }
    ]
  },
  {
    id: 'work-pay',
    cat: 'earn',
    title: '일하기 · 송금',
    keywords: '일하기 알바 송금 이체 친구',
    blocks: [
      { type: 'p', text: '이 두 가지는 웹이 아니라 디스코드 명령입니다.' },
      { type: 'ul', items: [
        '/일하기: 10분마다 한 번. 급여는 상황마다 약 1,000~15,000원.',
        '/송금: 다른 유저에게 최소 1,000원. 금액은 5만, 1억, 500양처럼 단위로 적을 수 있습니다. 봇·자기 자신에게는 보낼 수 없습니다.',
        '일반 유저끼리 송금할 때 세율이 있으면 보내는 사람이 송금세를 냅니다. 받는 사람은 입력한 금액을 그대로 받습니다. 관리자가 한쪽이면 세금이 없습니다.'
      ] }
    ]
  },
  {
    id: 'stocks',
    cat: 'stock',
    title: '주식 시장',
    keywords: '주식 매수 매도 차트 포트폴리오 시세',
    go: { tab: 'tab-stocks', label: '주식 시장으로' },
    blocks: [
      { type: 'ol', items: [
        '#주식-시장에서 종목을 누르거나 매수/매도를 고릅니다.',
        '수량을 입력하고 주문합니다. 전량 매도도 가능합니다.',
        '스파크라인(작은 그래프)을 누르면 상세 차트와 기업 설명을 봅니다.',
        '보유 종목은 로그인 시 본문 위 포트폴리오에 나옵니다.'
      ] },
      { type: 'ul', items: [
        '매수는 현금만 사용합니다. 예금은 먼저 인출해야 합니다.',
        '세율이 있으면 매수는 대금+거래세, 매도는 대금-거래세입니다. 전량 매수는 세금을 남기고 삽니다.',
        '시세는 주기적으로 갱신됩니다. 상단 초시계와 ↻ 버튼으로 확인할 수 있습니다.',
        '#시장-뉴스에 종목·시장 공시가 올라옵니다.'
      ] }
    ]
  },
  {
    id: 'casino',
    cat: 'casino',
    title: '카지노 기본',
    keywords: '카지노 배팅 잭팟 미션 연승 VIP 행운의시간',
    go: { tab: 'tab-casino', label: '카지노 열기' },
    blocks: [
      { type: 'p', text: '게임 돈입니다. 기대값은 하우스에 조금 기울어 있습니다. 최소 배팅은 보통 1,000원입니다.' },
      { type: 'ul', items: [
        '잭팟: 배팅액의 2%가 팟에 쌓입니다. 플레이어에게 추가로 깎이지 않습니다. 팟 3만 원 이상일 때 낮은 확률로 터집니다.',
        '행운의시간: 한국 시간 20:00–21:00. 승리 이익의 +10%.',
        '5연승 이상: 승리 이익의 +3%.',
        '오늘 미션: 슬롯 5회, 3승, 3만 원 배팅, 게임 3종, 출석. 보상은 소액입니다.',
        'VIP 일일: 누적 배팅 10만/100만/1,000만/1억 → 브론즈 200 · 실버 500 · 골드 1,000 · 다이아 2,000원.',
        '사운드는 카지노 화면에서 켜고 끌 수 있습니다.',
        '대출이 연체되면 카지노와 주식 매수가 막힙니다. 은행에서 먼저 갚으세요.'
      ] }
    ]
  },
  {
    id: 'casino-games',
    cat: 'casino',
    title: '카지노 게임 배당',
    keywords: '슬롯 동전 주사위 복권 룰렛 블랙잭 하이로우 포커 세븐포커',
    go: { tab: 'tab-casino', label: '카지노 열기' },
    blocks: [
      { type: 'ul', items: [
        '슬롯: 7️⃣ 트리플 50배, 💎 20배, 벨·기타 트리플 10배, 페어 1.5배.',
        '동전: 앞/뒤 맞히면 1.9배.',
        '주사위: 딜러보다 높으면 1.9배, 무승부 환불.',
        '복권: 💎 40배, 7️⃣ 20배, 🦆 12배, 💰 8배, 기타 트리플 4배, 페어 1.2배.',
        '룰렛: 레드·블랙 각 약 47%에 2배, 그린 약 6%에 15배.',
        '블랙잭: 승 2배, 블랙잭 2.5배, 푸시 환불. 딜러는 16에서 히트. 딜 시점에 배팅금이 먼저 빠집니다.',
        '포커: 텍사스 홀덤 vs 딜러. 시작 시 양쪽이 유닛(블라인드)을 팟에 넣고, 승자가 팟을 가져갑니다. 스트리트마다 체크·벳·콜·폴드·올인. 로열 플러시로 이기면 잭팟 추가 기회.',
        '세븐포커: 7카드 스터드 vs 딜러. 3장(2장 숨김+1장 오픈) 후 4·5·6 오픈, 7번째는 숨김. 최선 5장 족보. 팟 승자 전액. 로열 플러시 승 시 잭팟 추가 기회.',
        '하이로우: 1~100. 60 이상 1.8배, 90 이상 3.5배.'
      ] }
    ]
  },
  {
    id: 'hot',
    cat: 'hot',
    title: '핫게임',
    keywords: '토토 크래시 마인즈 플링코 mines crash plinko',
    go: { tab: 'tab-hot', label: '핫게임 열기' },
    blocks: [
      { type: 'ul', items: [
        '토토: 가상 경기. 2~3분마다 자동 정산. 배당은 경기마다 다릅니다.',
        '크래시: 배율이 오르다 터집니다. 터지기 전에 탈출해야 합니다.',
        '마인즈: 지뢰를 피해 칸을 엽니다. 지뢰 수(3/5/8/10)를 고를 수 있습니다. 언제든 탈출로 정산.',
        '플링코: 공을 떨어뜨려 칸 배율을 받습니다. 로우·미디엄·하이 위험도.'
      ] }
    ]
  },
  {
    id: 'arcade',
    cat: 'arcade',
    title: '아케이드 모드',
    keywords: '아케이드 레벨 XP 해금 네온 하이롤러 잭팟시어터',
    go: { tab: 'tab-arcade', label: '아케이드 열기' },
    blocks: [
      { type: 'p', text: '원래 카지노·핫게임·경마는 그대로 있습니다. 아케이드는 같은 게임을 다른 화면으로 보여주는 모드입니다. 배당과 정산 API는 기존과 같습니다.' },
      { type: 'ul', items: [
        '경험치: 예전에 번 도박 이익, 경제 수령(출석·지원금·알바 등), 누적 배팅, 승리 횟수, 채굴 클릭이 모두 들어갑니다.',
        '레벨 1 클래식 홀, 2 네온 슬롯, 3 크래시 아레나, 4 마인즈 연구소, 5 플링코 파티, 6 토토 스타디움, 7 나이트 레이스, 8 하이롤러(최소 1만), 10 잭팟 시어터.',
        '잠긴 모드는 카드에 Lv.X 해금으로 표시됩니다. 로그인하면 과거 이력이 바로 반영됩니다.',
        '만렙에서 환생하면 화면 레벨이 1로 돌아가고, 만렙까지 쓴 XP만 차감됩니다. 남은 XP는 다음 회차로 이월됩니다. RP +10, 칭호 「회귀자」.',
        '환생 상점과 세계 포탈은 창이 열립니다. RP로 세계·칭호를 사고, 포탈에서 고른 세계로 아케이드 화면 색이 바뀝니다.'
      ] }
    ]
  },
  {
    id: 'horse',
    cat: 'hot',
    title: '경마',
    keywords: '경마 말 배당 그랑프리 단승 복승 연승 복연승 쌍승',
    go: { tab: 'tab-horse', label: '경마장 열기' },
    blocks: [
      { type: 'p', text: '월덕 그랑프리는 시간대마다 주로 날씨(맑음·우천·강풍·진흙·야간)가 바뀌고, 그에 따라 말의 컨디션과 배당이 움직입니다. 디스코드는 /경마 로 같은 배팅을 할 수 있습니다.' },
      { type: 'ul', items: [
        '단승: 1착만 맞히면 적중 (고배당)',
        '복승: 고른 말이 1착 또는 2착',
        '연승: 고른 말이 1~3착 안에 들면 적중',
        '복연승: 1·2착 두 마리를 순서 없이',
        '쌍승: 1착과 2착을 순서대로 (최대 약 80배)'
      ] }
    ]
  },
  {
    id: 'chat',
    cat: 'start',
    title: '광장 채팅',
    keywords: '광장 채팅 메시지 플로팅',
    go: { tab: 'tab-chat', label: '광장 열기' },
    blocks: [
      { type: 'p', text: '#광장에서 실시간으로 이야기할 수 있습니다. 로그인해야 글을 쓸 수 있습니다.' },
      { type: 'ul', items: [
        '오른쪽 아래 # 버튼으로 다른 화면에서도 광장을 띄울 수 있습니다.',
        '관리자와 본인 메시지는 삭제할 수 있습니다.',
        '순자산 순위는 #자산-순위 채널입니다. 일반 유저와 관리자 계정은 따로 집계됩니다.'
      ] }
    ]
  },
  {
    id: 'inquiry',
    cat: 'start',
    title: '문의',
    keywords: '문의 고객센터 버그 복구 건의 스크린샷',
    go: { action: 'openInquiryModal', label: '문의하기' },
    blocks: [
      { type: 'p', text: '오류·복구·건의는 1:1 문의로 남기면 관리자에게 전달됩니다.' },
      { type: 'ul', items: [
        '페이지 아래 문의하기, 또는 프로필의 내 문의.',
        'PNG/JPEG 스크린샷을 붙일 수 있습니다.',
        '답변은 웹 내 문의 목록과 디스코드 DM으로 올 수 있습니다.',
        '디스코드에서는 /문의 도 있습니다.'
      ] }
    ]
  },
  {
    id: 'discord',
    cat: 'discord',
    title: '디스코드 명령어',
    keywords: '슬래시 명령어 봇 /지갑 /출석',
    blocks: [
      { type: 'p', text: '서버에서 / 를 치면 봇 명령이 나옵니다. 웹과 같은 지갑을 씁니다.' },
      { type: 'ul', items: [
        '경제: /지갑 /출석 /지원금 /송금 /은행 /일하기 /사업 /순위 /클리커',
        '주식: /주식시세 /주식차트 /주식매수 /주식매도 /포트폴리오',
        '도박: /도박 /슬롯 /동전 /블랙잭 /룰렛 /경마 /토토 /크래시',
        '유틸: /문의 /말하기 /tts /핑 /도움말'
      ] }
    ]
  },
  {
    id: 'faq-money',
    cat: 'faq',
    title: 'FAQ · 돈이 안 들어와요',
    keywords: '잔고 반영 안됨 새로고침 로그인',
    blocks: [
      { type: 'ul', items: [
        '로그인이 풀렸는지 확인하세요. 재시작하면 세션이 끊길 수 있습니다.',
        '화면 숫자를 새로고침해 보세요. 상단 ↻ 또는 페이지 새로고침.',
        '예금으로 넣어 둔 돈은 현금 칸에 보이지 않습니다. 인출해야 매수·배팅에 씁니다.',
        '블랙잭은 딜을 누르는 순간 배팅금이 빠집니다. 중간에 나가도 세션이 남아 있으면 재접속 후 이어지거나 환불됩니다.',
        '포커도 딜과 벳·콜·올인 시점에 현금이 빠집니다. 미종료 핸드는 이어가거나, 서버 재시작 시 환불됩니다.',
        '세븐포커도 같습니다. 딜·벳·콜·올인 때 현금이 빠지고, 미종료 핸드는 이어가거나 재시작 시 환불됩니다.'
      ] }
    ]
  },
  {
    id: 'faq-subsidy',
    cat: 'faq',
    title: 'FAQ · 지원금·출석이 거절돼요',
    keywords: '지원금 거절 출석 이미 완료 쿨타임',
    blocks: [
      { type: 'ul', items: [
        '출석은 하루에 한 번입니다. 다음 출석까지 남은 시간이 안내됩니다.',
        '지원금은 순자산 5만 원 미만만 됩니다. 주식 평가액도 순자산에 들어갑니다.',
        '같은 버튼을 연타하면 쿨타임에 걸릴 수 있습니다. 안내 메시지를 확인하세요.',
        '세율이 있을 때 주식 거래·송금에서 현금이 조금 더 빠질 수 있습니다. 자산 칸의 세금 안내를 확인하세요.'
      ] }
    ]
  },
  {
    id: 'faq-virtual',
    cat: 'faq',
    title: 'FAQ · 실제 돈인가요?',
    keywords: '환전 현금화 도박 실제돈 가상',
    blocks: [
      { type: 'p', text: '아닙니다. 월덕의 원·주식·카지노 배팅은 디스코드 게임용 가상 데이터입니다. 입금·출금·환전 기능은 없습니다.' }
    ]
  }
];

function renderBlocks(blocks) {
  return (blocks || []).map((b) => {
    if (b.type === 'p') return `<p>${escapeHtml(b.text)}</p>`;
    if (b.type === 'note') return `<p class="help-note">${escapeHtml(b.text)}</p>`;
    if (b.type === 'ol' || b.type === 'ul') {
      const tag = b.type;
      const items = (b.items || []).map((it) => `<li>${escapeHtml(it)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    return '';
  }).join('');
}

function renderGo(go) {
  if (!go) return '';
  if (go.tab) {
    return `<button type="button" class="help-go" data-help-tab="${escapeHtml(go.tab)}">${escapeHtml(go.label)}</button>`;
  }
  if (go.action) {
    return `<button type="button" class="help-go" data-help-action="${escapeHtml(go.action)}">${escapeHtml(go.label)}</button>`;
  }
  return '';
}

function renderHelpInnerHtml() {
  const chips = CATS.map((c, i) => (
    `<button type="button" class="help-chip${i === 0 ? ' active' : ''}" data-help-cat="${escapeHtml(c.id)}" @click="setCat('${escapeHtml(c.id)}')">${escapeHtml(c.label)}</button>`
  )).join('');

  const cards = ARTICLES.map((a, i) => {
    const search = [a.title, a.keywords, ...(a.blocks || []).flatMap((b) => {
      if (b.text) return [b.text];
      return b.items || [];
    })].join(' ');
    return `
      <article class="help-card${i === 0 ? ' open' : ''}" data-help-id="${escapeHtml(a.id)}" data-help-cat="${escapeHtml(a.cat)}" data-help-search="${escapeHtml(search)}">
        <button type="button" class="help-card-head" aria-expanded="${i === 0 ? 'true' : 'false'}" @click="toggleCard($event.currentTarget)">
          <span>${escapeHtml(a.title)}</span>
          <span class="help-caret">▾</span>
        </button>
        <div class="help-card-body">
          ${renderBlocks(a.blocks)}
          ${renderGo(a.go)}
        </div>
      </article>`;
  }).join('');

  return `
      <div class="help-page" x-data="helpGuide()">
        <div class="help-hero">
          <h2>사용법</h2>
          <p>가상 경제 · 주식 · 카지노. 창을 드래그하거나 모서리에서 크기를 조절할 수 있습니다.</p>
          <label class="help-search-wrap">
            <span class="help-search-icon">⌕</span>
            <input type="search" id="help-search" class="help-search" placeholder="검색 (예: 지원금, 슬롯, 출석)" maxlength="80" autocomplete="off" x-model="q" @input="filter()">
          </label>
        </div>
        <div class="help-chips" id="help-chips">${chips}</div>
        <div class="help-list" id="help-list">${cards}</div>
        <p class="help-empty" id="help-empty" x-show="noneVisible">검색 결과가 없습니다. 다른 단어로 찾아보세요.</p>
      </div>`;
}

function renderHelpTabHtml() {
  return `<div id="tab-help" class="tab-pane">${renderHelpInnerHtml()}</div>`;
}

module.exports = { renderHelpTabHtml, renderHelpInnerHtml, HELP_CATS: CATS, HELP_ARTICLES: ARTICLES };
