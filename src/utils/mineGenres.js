/**
 * 채굴 장르 정의. 클릭 수익 공식은 economyBalance.CLICKER 를 그대로 쓴다.
 */
const GENRES = [
  {
    id: 'classic',
    name: '보석 연타',
    emoji: '💎',
    unlockCost: 0,
    rewardPercent: 100,
    tag: '기본',
    desc: '보석을 연타해서 현금을 법니다.',
    hint: '큰 보석을 누르세요. 8% 확률 2배 크리티컬!',
    flavor: '광맥에서 원석을 캐냈다'
  },
  {
    id: 'shaft',
    name: '갱도 탐험',
    emoji: '⛏️',
    unlockCost: 5000,
    rewardPercent: 110,
    tag: '탐험',
    desc: '층을 내려가며 바위를 깹니다.',
    hint: '바위를 눌러 갱도를 파고 드세요.',
    flavor: '갱도 암반을 부쉈다'
  },
  {
    id: 'mole',
    name: '두더지 광맥',
    emoji: '🐹',
    unlockCost: 6000,
    rewardPercent: 115,
    tag: '아케이드',
    desc: '구멍에서 튀어나오는 광석만 때립니다.',
    hint: '올라온 두더지·보석만 누르세요. 빈 구멍은 안 됩니다.',
    flavor: '두더지 광맥을 채굴했다'
  },
  {
    id: 'catch',
    name: '낙하 원석',
    emoji: '🪨',
    unlockCost: 8000,
    rewardPercent: 120,
    tag: '아케이드',
    desc: '떨어지는 광석을 받아 채굴합니다.',
    hint: '떨어지는 원석을 터치하세요.',
    flavor: '낙하 원석을 받아냈다'
  },
  {
    id: 'match',
    name: '원석 짝맞추기',
    emoji: '🃏',
    unlockCost: 10000,
    rewardPercent: 130,
    tag: '퍼즐',
    desc: '같은 원석 두 장을 맞춰 채굴합니다.',
    hint: '카드 두 장을 뒤집으세요. 짝이 맞을 때만 채굴됩니다.',
    flavor: '원석 짝을 찾아냈다'
  },
  {
    id: 'drill',
    name: '드릴 타이밍',
    emoji: '🔩',
    unlockCost: 12000,
    rewardPercent: 135,
    tag: '리듬',
    desc: '게이지 스위트스팟에 맞춰 굴착합니다.',
    hint: '바늘이 초록 구간에 올 때 누르세요. 성공 시 기본 광산보다 35% 더 받습니다.',
    flavor: '드릴이 암반을 관통했다'
  },
  {
    id: 'cart',
    name: '광차 적재',
    emoji: '🛒',
    unlockCost: 16000,
    rewardPercent: 145,
    tag: '타이밍',
    desc: '지나가는 광차가 초록 구간에 올 때 싣습니다.',
    hint: '광차가 초록 구간에 들어왔을 때만 누르세요.',
    flavor: '광차에 원석을 실었다'
  },
  {
    id: 'ocean',
    name: '해저 채굴',
    emoji: '🌊',
    unlockCost: 18000,
    rewardPercent: 150,
    tag: '테마',
    desc: '해저 광맥과 기포를 탭합니다.',
    hint: '떠오르는 해저 광물을 누르세요.',
    flavor: '해저 광맥을 채취했다'
  },
  {
    id: 'ice',
    name: '빙하 깨기',
    emoji: '🧊',
    unlockCost: 24000,
    rewardPercent: 165,
    tag: '연타',
    desc: '얼음 층을 깨고 속에 든 원석을 꺼냅니다.',
    hint: '얼음을 연타하세요. 깨지면 원석이 나옵니다.',
    flavor: '빙하 속 원석을 꺼냈다'
  },
  {
    id: 'space',
    name: '우주 소행성',
    emoji: '🪐',
    unlockCost: 25000,
    rewardPercent: 170,
    tag: '액션',
    desc: '떠다니는 운석을 탭해서 채굴합니다.',
    hint: '움직이는 소행성을 터치하세요.',
    flavor: '소행성 조각을 채굴했다'
  },
  {
    id: 'oil',
    name: '원유 시추',
    emoji: '🛢️',
    unlockCost: 35000,
    rewardPercent: 185,
    tag: '시추',
    desc: '유정을 두드려 원유를 뽑습니다.',
    hint: '시추탑을 연타하세요. 유정이 차오릅니다.',
    flavor: '유정에서 원유를 뽑았다'
  },
  {
    id: 'lava',
    name: '용암 건지기',
    emoji: '🌋',
    unlockCost: 38000,
    rewardPercent: 195,
    tag: '액션',
    desc: '식기 전에 용암 위 광석을 건집니다.',
    hint: '잠깐 떠오르는 광석을 빨리 누르세요. 식으면 사라집니다.',
    flavor: '용암에서 광석을 건졌다'
  },
  {
    id: 'vein',
    name: '광맥 따라가기',
    emoji: '🧭',
    unlockCost: 48000,
    rewardPercent: 215,
    tag: '리듬',
    desc: '빛나는 칸만 따라가며 광맥을 이습니다.',
    hint: '노란 칸만 누르세요. 다른 칸은 인정되지 않습니다.',
    flavor: '광맥 줄기를 이었다'
  },
  {
    id: 'crypto',
    name: '해시 채굴',
    emoji: '🖥️',
    unlockCost: 50000,
    rewardPercent: 225,
    tag: '가상',
    desc: '블록을 탭해 해시레이트를 올립니다. 가상 연출이며 실제 암호화폐가 아닙니다.',
    hint: '빛나는 블록을 누르세요. 실제 코인이 아닙니다.',
    flavor: '가상 블록을 채굴했다'
  }
];

const WEATHERS = [
  { id: 'clear', emoji: '☀️', label: '맑음' },
  { id: 'gold', emoji: '✨', label: '황금비' },
  { id: 'fog', emoji: '🌫️', label: '갱도 안개' },
  { id: 'quake', emoji: '🌋', label: '암반 진동' },
  { id: 'aurora', emoji: '🌌', label: '오로라' },
  { id: 'storm', emoji: '⚡', label: '전기 폭풍' }
];

const BADGES = [
  { id: 'legend', min: 50000, name: '전설 광부', emoji: '👑' },
  { id: 'master', min: 10000, name: '장인', emoji: '🏅' },
  { id: 'skilled', min: 1000, name: '숙련', emoji: '⭐' },
  { id: 'rookie', min: 100, name: '신입', emoji: '🪨' },
  { id: 'none', min: 0, name: '견습', emoji: '🌱' }
];

const DEFAULT_GENRE = 'classic';
const DEPTH_PER_CLICKS = 25;
const MEGA_CRIT_MIN = 8;
const ANNOUNCE_USER_COOLDOWN_MS = 90 * 1000;
const ANNOUNCE_GLOBAL_COOLDOWN_MS = 20 * 1000;

function listGenres() {
  return GENRES.map((g) => ({ ...g }));
}

function getGenre(id) {
  return GENRES.find((g) => g.id === String(id || '')) || GENRES[0];
}

function normalizeGenre(id) {
  const found = GENRES.find((g) => g.id === String(id || ''));
  return found ? found.id : DEFAULT_GENRE;
}

function rewardPercentForGenre(id) {
  const genre = getGenre(id);
  return Math.max(100, Math.floor(Number(genre.rewardPercent) || 100));
}

function applyGenreReward(amount, genreId) {
  const percent = rewardPercentForGenre(genreId);
  if (typeof amount === 'bigint') {
    if (amount <= 0n) return 0n;
    return (amount * BigInt(percent)) / 100n;
  }
  const base = Math.max(0, Math.floor(Number(amount) || 0));
  if (base <= 0) return 0;
  return Math.max(1, Math.floor((base * percent) / 100));
}

function currentWeather() {
  const idx = Math.floor(Date.now() / 480000) % WEATHERS.length;
  return { ...WEATHERS[idx] };
}

function badgeForClicks(clicks) {
  const n = Math.max(0, Number(clicks) || 0);
  return BADGES.find((b) => n >= b.min) || BADGES[BADGES.length - 1];
}

function depthForClicks(clicks) {
  return Math.floor(Math.max(0, Number(clicks) || 0) / DEPTH_PER_CLICKS);
}

function publicGenreList() {
  return GENRES.map((g) => ({
    id: g.id,
    name: g.name,
    emoji: g.emoji,
    unlockCost: g.unlockCost,
    rewardMultiplier: g.rewardPercent / 100,
    rewardBonusPercent: g.rewardPercent - 100,
    tag: g.tag,
    desc: g.desc,
    hint: g.hint
  }));
}

module.exports = {
  GENRES,
  WEATHERS,
  BADGES,
  DEFAULT_GENRE,
  DEPTH_PER_CLICKS,
  MEGA_CRIT_MIN,
  ANNOUNCE_USER_COOLDOWN_MS,
  ANNOUNCE_GLOBAL_COOLDOWN_MS,
  listGenres,
  getGenre,
  normalizeGenre,
  rewardPercentForGenre,
  applyGenreReward,
  currentWeather,
  badgeForClicks,
  depthForClicks,
  publicGenreList
};
