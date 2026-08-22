'use strict';

/**
 * 🏛️ 월덕 경제 밸런스 단일 기준 (Economy Balance 2.0)
 * 
 * 인플레이션 억제 및 실물 경제 순환 구조:
 * 1. 신규 통화 발행 캡 (출석, 10분 일하기, 1일 1회 저소득 지원금, 6시간 오프라인 상한)
 * 2. 복리 이자 합리화 (하루 0.1%)
 * 3. 생산적 소비처 (사업 유지비 15%, 주식 거래 수수료 0.3%, 1일 1회 부유세)
 * 4. 카지노 준비금(Reserve) 기반 지급 & 95% RTP
 */
const { safeBigInt } = require('./money');

const BANK = {
  DAILY_RATE: 0.001, // 하루 0.1%
  HOURLY_RATE: 0.001 / 24, // 시간당 약 0.00416%
  LABEL: '하루 0.1% (시간당 0.0042%)',
  get PER_MINUTE_RATE() {
    return this.HOURLY_RATE / 60;
  }
};

// 대출: 예금 담보, 만기 24시간
const LOAN = {
  LTV: 0.5,                 // 예금의 50%까지
  DAILY_RATE: 0.003,        // 하루 0.3%
  HOURLY_RATE: 0.003 / 24,
  LABEL: '하루 0.3%',
  TERM_HOURS: 24,
  MINT_SHARE: 0.10,         // 국고 부족 시 신규 발행 상한 (10%)
  INTEREST_CAP: 0.5,        // 이자는 원금의 50%를 넘지 않음
  CREDIT: [1, 0.5, 0.25],   // 연체 0/1/2회+ 한도 배율
  get PER_MINUTE_RATE() {
    return this.HOURLY_RATE / 60;
  }
};

const CLICKER = {
  POWER_PER_LEVEL: 15, // 클릭당 기본 15원 (밸런스 너프)
  CRIT_CHANCE: 0.05,  // 크리티컬 확률 5%
  CRIT_MULT: 2.0,     // 크리티컬 배율 2배
  MAX_CLICKS_PER_REQUEST: 100,
  MIN_MS_PER_CLICK: 40,
  POWER_COST_PER_LEVEL: 10000,
  AUTO_PER_LEVEL_PER_SEC: 1, // 자동채굴 초당 1원
  AUTO_COST_BASE: 20000,
  OFFLINE_CAP_MIN: 6 * 60, // 최대 6시간(360분) 오프라인 채굴 누적
  BONUS_TURN_CHANCE: 0.05
};

const SUBSIDY = {
  COOLDOWN_MS: 24 * 60 * 60 * 1000, // 24시간 1회
  AMOUNT: 2000,                      // 2,000원
  MAX_NET_WORTH: 20000,              // 순자산 20,000원 이하만 신청 가능
  LABEL: '1일 1회 2,000원 (순자산 2만원 이하 대상)'
};

const DAILY = {
  MIN_REWARD: 3000,
  MAX_REWARD: 5000,
  COOLDOWN_MS: 24 * 60 * 60 * 1000
};

const WORK = {
  COOLDOWN_MS: 10 * 60 * 1000, // 10분 쿨다운
  BASE_MIN: 500,
  BASE_MAX: 1500,
  FATIGUE_WINDOW_MS: 60 * 60 * 1000, // 1시간 내 연속 작업 시 피로도 발생
  MAX_FATIGUE_PENALTY: 0.40 // 최대 40% 보상 감소
};

// 사업: 6시간 오프라인 수금 상한 및 15% 유지보수 비용 적용
const BUSINESS = {
  MAX_LEVEL: 10,
  MAX_STAFF: 5,
  MAX_HQ: 5,
  COLLECT_CAP_MIN: 6 * 60,  // 최대 6시간 적립
  MAINTENANCE_RATE: 0.15,   // 사업 유지비 & 운영비 (매출의 15% 국고 귀속/소각)
  UPGRADE_GROWTH: 1.65,
  INCOME_GROWTH: 1.15,
  SELL_RATE: 0.5,
  STAFF_BONUS: 0.08,
  STAFF_WAGE_RATE: 0.05,
  STAFF_HIRE_RATE: 0.25,
  HQ_BONUS: 0.03,
  HQ_BASE_COST: 1000000,
  COLLECT_EVENT_CHANCE: 0.06,
  CATALOG: [
    { key: 'store', name: '골목 편의점', emoji: '🏪', blurb: '야식과 담배를 파는 동네 가게', cost: 50000, incomePerMin: 25, requires: null },
    { key: 'farm', name: '월덕 농장', emoji: '🌾', blurb: '오리 모이와 채소를 키운다', cost: 120000, incomePerMin: 55, requires: 'store' },
    { key: 'cafe', name: '월덕 카페', emoji: '☕', blurb: '광장 옆 단골 카페', cost: 200000, incomePerMin: 90, requires: 'store' },
    { key: 'chicken', name: '황금닭 치킨', emoji: '🍗', blurb: '야식 타임 국민 프랜차이즈', cost: 800000, incomePerMin: 320, requires: 'cafe' },
    { key: 'exchange', name: '덕스 환전소', emoji: '💱', blurb: '현금과 예금을 돌리는 창구', cost: 1500000, incomePerMin: 550, requires: 'chicken' },
    { key: 'mine', name: '광산 하청', emoji: '⛏️', blurb: '월덕 광업 하청 채굴장', cost: 2000000, incomePerMin: 700, requires: 'farm' },
    { key: 'hotel', name: '오리 호텔', emoji: '🏨', blurb: '광장 방문객을 받는 숙소', cost: 3500000, incomePerMin: 1150, requires: 'chicken' },
    { key: 'casino', name: '카지노 지점', emoji: '🎰', blurb: '슬롯과 룰렛을 돌리는 지점', cost: 5000000, incomePerMin: 1600, requires: 'exchange' },
    { key: 'news', name: '덕뉴스 방송국', emoji: '📺', blurb: '시세 속보를 내보내는 방송국', cost: 8000000, incomePerMin: 2300, requires: 'casino' },
    { key: 'data', name: '이지스크랩 센터', emoji: '🌐', blurb: '시세 데이터를 파는 센터', cost: 15000000, incomePerMin: 4000, requires: 'mine' },
    { key: 'lab', name: '냥코 연구소', emoji: '🔬', blurb: '양자 실험으로 부가가치를 낸다', cost: 25000000, incomePerMin: 6200, requires: 'data' },
    { key: 'mall', name: '월덕 타운몰', emoji: '🏬', blurb: '모든 점포가 모인 복합몰', cost: 40000000, incomePerMin: 9000, requires: 'lab' }
  ]
};

const TAX = {
  WEALTH_TAX_THRESHOLD: 10000000n, // 1,000만원 초과분에 대해서만 부유세 부과
  WEALTH_TAX_DAILY_RATE: 0.002,    // 하루 0.2% (기본 공제 후)
  TRADE_FEE_RATE: 0.003            // 주식 거래 수수료 0.3%
};

function findBusiness(key) {
  return BUSINESS.CATALOG.find((item) => item.key === key) || null;
}

function businessBaseIncome(def, level) {
  const lv = Math.max(1, Math.min(BUSINESS.MAX_LEVEL, Number(level) || 1));
  return Math.floor(Number(def.incomePerMin) * Math.pow(BUSINESS.INCOME_GROWTH, lv - 1));
}

function getRegimeBusinessMultiplier() {
  try {
    const { getCurrentMarketRegime } = require('./stockEngine');
    const regime = getCurrentMarketRegime();
    if (!regime) return 1.0;
    if (regime.type === 'SUPER_BULL' || regime.id === 'BOOM') return 1.30;
    if (regime.type === 'BULL' || regime.drift > 0) return 1.12;
    if (regime.type === 'CRASH') return 0.75;
    if (regime.type === 'RECESSION' || regime.drift < 0) return 0.88;
    return 1.0;
  } catch (e) {
    return 1.0;
  }
}

function businessWagePerMin(def, level, staff) {
  const st = Math.max(0, Math.min(BUSINESS.MAX_STAFF, Number(staff) || 0));
  if (st <= 0) return 0;
  return st * Math.max(1, Math.floor(businessBaseIncome(def, level) * BUSINESS.STAFF_WAGE_RATE));
}

function businessIncomePerMin(def, level, staff, hqLevel) {
  const st = Math.max(0, Math.min(BUSINESS.MAX_STAFF, Number(staff) || 0));
  const hq = Math.max(0, Math.min(BUSINESS.MAX_HQ, Number(hqLevel) || 0));
  const base = businessBaseIncome(def, level);
  const regimeMult = getRegimeBusinessMultiplier();
  const gross = Math.floor(base * (1 + BUSINESS.STAFF_BONUS * st) * (1 + BUSINESS.HQ_BONUS * hq) * regimeMult);
  const netBeforeMaintenance = Math.max(0, gross - businessWagePerMin(def, level, st));
  // 15% 유지비 제외 실수령액
  return Math.floor(netBeforeMaintenance * (1 - BUSINESS.MAINTENANCE_RATE));
}

function businessUpgradeCost(def, currentLevel) {
  const lv = Math.max(1, Number(currentLevel) || 1);
  return Math.floor(Number(def.cost) * Math.pow(BUSINESS.UPGRADE_GROWTH, lv));
}

function businessStaffHireCost(def, currentStaff) {
  const st = Math.max(0, Number(currentStaff) || 0);
  return Math.floor(Number(def.cost) * BUSINESS.STAFF_HIRE_RATE * (st + 1));
}

function businessHqCost(hqLevel) {
  const lv = Math.max(0, Number(hqLevel) || 0);
  return Math.floor(BUSINESS.HQ_BASE_COST * Math.pow(2, lv));
}

function businessPending(def, level, lastCollectAt, nowMs, staff, hqLevel, elapsedSec) {
  let elapsedMin = 0;
  if (typeof elapsedSec === 'number' && !isNaN(elapsedSec)) {
    elapsedMin = Math.max(0, elapsedSec / 60);
  } else {
    const last = lastCollectAt ? new Date(lastCollectAt).getTime() : (nowMs || Date.now());
    elapsedMin = Math.max(0, ((nowMs || Date.now()) - last) / 60000);
  }
  if (elapsedMin < 1) return 0;
  const capped = Math.min(BUSINESS.COLLECT_CAP_MIN, elapsedMin);
  return Math.floor(businessIncomePerMin(def, level, staff, hqLevel) * capped);
}

const STOCK = {
  MAX_EVENT_IMPACT: 0.03,
  MAX_TICK_DELTA: 0.035,
  NEWS_CHANCE: 0.15,
  HOURS_PER_YEAR: 365 * 24
};

const SLOT_SYMBOLS = ['🍒', '🍋', '🍇', '🍉', '🔔', '💎', '7️⃣'];
const LOTTERY_SYMBOLS = ['💰', '🦆', '💎', '7️⃣', '💣', '⭐'];
const {
  HORSES,
  pickHorseWinner,
  findHorse
} = require('./horseRace');

const COIN_WIN_MULT = 1.9;
const DICE_WIN_MULT = 1.9;

function clickPower(level) {
  return Math.max(1, Number(level) || 1) * CLICKER.POWER_PER_LEVEL;
}

function powerUpgradeCost(level) {
  return Math.max(1, Number(level) || 1) * CLICKER.POWER_COST_PER_LEVEL;
}

function autoPerSec(level) {
  return Math.max(0, Number(level) || 0) * CLICKER.AUTO_PER_LEVEL_PER_SEC;
}

function autoUpgradeCost(level) {
  return (Math.max(0, Number(level) || 0) + 1) * CLICKER.AUTO_COST_BASE;
}

function rollClickBatch(level, rawCount) {
  const clicks = Math.min(
    CLICKER.MAX_CLICKS_PER_REQUEST,
    Math.max(1, parseInt(rawCount, 10) || 1)
  );
  let mult = 1.0;
  try {
    const { getDynamicSettings } = require('./economyBalancer');
    const dyn = getDynamicSettings();
    if (dyn && Number.isFinite(Number(dyn.clickerYieldMultiplier))) {
      mult = Number(dyn.clickerYieldMultiplier);
    }
  } catch (e) {}

  const base = Math.max(1, Math.floor(clickPower(level) * mult));
  let earned = 0;
  let crits = 0;
  for (let i = 0; i < clicks; i++) {
    if (Math.random() < CLICKER.CRIT_CHANCE) {
      earned += base * CLICKER.CRIT_MULT;
      crits += 1;
    } else {
      earned += base;
    }
  }
  return { clicks, earned, crits, power: base };
}

function evalStockValue(amount, price) {
  const { mulPriceAmount } = require('./moneyScale');
  try {
    return mulPriceAmount(price, amount);
  } catch (e) {
    return 0n;
  }
}

function sumHoldingValue(rows) {
  let total = 0n;
  if (!rows) return total;
  for (const row of rows) {
    total += evalStockValue(row.amount, row.price);
  }
  return total;
}

function computeNetWorth(cash, bank, stockVal) {
  return safeBigInt(cash) + safeBigInt(bank) + safeBigInt(stockVal);
}

function netWorthPercents(cash, bank, stockVal) {
  const c = safeBigInt(cash);
  const b = safeBigInt(bank);
  const s = safeBigInt(stockVal);
  const t = c + b + s;
  if (t <= 0n) return { cash: 0, bank: 0, stock: 0 };
  const cashPct = Number((c * 100n) / t);
  const bankPct = Number((b * 100n) / t);
  return { cash: cashPct, bank: bankPct, stock: Math.max(0, 100 - cashPct - bankPct) };
}

const NET_WORTH_SQL = `(CAST(u.cash AS DECIMAL(65,0)) + CAST(u.bank AS DECIMAL(65,0)) + CAST(ROUND(COALESCE((SELECT SUM(us.amount * s.price) FROM user_stocks us JOIN stocks s ON us.stock_id = s.stock_id WHERE us.user_id = u.discord_id AND us.amount > 0), 0)) AS DECIMAL(65,0)))`;
const STOCK_VALUE_SQL = `CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0))`;

function clampStockDelta(eventDelta, rawDelta) {
  const sum = Number(eventDelta || 0) + Number(rawDelta || 0);
  return Math.max(-STOCK.MAX_TICK_DELTA, Math.min(STOCK.MAX_TICK_DELTA, sum));
}

function hourlyDividendForHolding(price, amount, yieldPercent) {
  const { mulPriceAmount } = require('./moneyScale');
  const val = mulPriceAmount(price, amount);
  if (val <= 0n) return 0n;
  const yearly = (val * BigInt(Math.round((Number(yieldPercent) || 0) * 100))) / 10000n;
  return yearly / BigInt(STOCK.HOURS_PER_YEAR || (365 * 24));
}

function scaleGambleMultiplier(baseMult) {
  let dynMult = 1.0;
  try {
    const { getDynamicSettings } = require('./economyBalancer');
    const dyn = getDynamicSettings();
    if (dyn && Number.isFinite(Number(dyn.gamblePayoutMultiplier))) {
      dynMult = Number(dyn.gamblePayoutMultiplier);
    }
  } catch (e) {}
  return baseMult * dynMult;
}

function flipCoin(choice) {
  const outcome = Math.random() < 0.5 ? '앞' : '뒤';
  const won = choice === outcome;
  return { outcome, won, multiplier: won ? COIN_WIN_MULT : 0 };
}

function rollHighLow(choice) {
  const roll = Math.floor(Math.random() * 100) + 1;
  let won = false;
  let multiplier = 0;

  // 1~100 주사위: 90 이상 3.5배, 60 이상 1.8배, 60 미만 꽝
  if (roll >= 90) {
    won = true;
    multiplier = 3.5;
  } else if (roll >= 60) {
    won = true;
    multiplier = 1.8;
  } else {
    won = false;
    multiplier = 0;
  }

  // 선택형(high/low) 배팅도 호환 지원
  if (choice === 'high') {
    won = roll >= 51;
    multiplier = won ? DICE_WIN_MULT : 0;
  } else if (choice === 'low') {
    won = roll <= 50;
    multiplier = won ? DICE_WIN_MULT : 0;
  }

  return { roll, isWin: won, won, multiplier };
}

function spinRoulette(betTypeOrChoice, betValue) {
  const number = Math.floor(Math.random() * 37); // 0-36
  const isRed = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36].includes(number);
  const color = number === 0 ? 'GREEN' : (isRed ? 'RED' : 'BLACK');
  const emoji = color === 'GREEN' ? '🟢' : (color === 'RED' ? '🔴' : '⚫');

  let won = false;
  let multiplier = 0;
  const winMult = color === 'GREEN' ? 15 : 2;

  // 단일 인자 호출 (예: spinRoulette('RED') or spinRoulette('BLACK'))
  if (!betValue && typeof betTypeOrChoice === 'string') {
    const uc = betTypeOrChoice.toUpperCase();
    if (['RED', 'BLACK', 'GREEN'].includes(uc)) {
      won = uc === color;
      multiplier = won ? winMult : 0;
      return { number, color, emoji, winMult, isWin: won, won, multiplier };
    }
  }

  const betType = betTypeOrChoice;
  if (betType === 'color' && String(betValue).toUpperCase() === color) {
    won = true;
    multiplier = color === 'GREEN' ? 35 : 1.95;
  } else if (betType === 'number' && Number(betValue) === number) {
    won = true;
    multiplier = 35;
  } else if (betType === 'even' && number > 0 && number % 2 === 0) {
    won = true;
    multiplier = 1.95;
  } else if (betType === 'odd' && number % 2 === 1) {
    won = true;
    multiplier = 1.95;
  }
  return { number, color, emoji, winMult, isWin: won, won, multiplier };
}

const BJ_SUITS = ['♠', '♥', '♦', '♣'];
const BJ_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createBlackjackDeck() {
  const deck = [];
  for (const s of BJ_SUITS) {
    for (const r of BJ_RANKS) {
      deck.push(`${s}${r}`);
    }
  }
  // Fisher-Yates 셔플
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function parseCardRank(card) {
  if (!card || card === '🂠') return '';
  if (typeof card === 'object' && card.value) return card.value;
  const str = String(card).trim();
  return str.replace(/^[♠️♥️♦️♣️♠♥♦♣]/, '');
}

function blackjackScore(cards) {
  if (!Array.isArray(cards)) return 0;
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (!c || c === '🂠') continue;
    const rank = parseCardRank(c);
    if (rank === 'A') {
      aces += 1;
      total += 11;
    } else if (['K', 'Q', 'J', '10'].includes(rank)) {
      total += 10;
    } else {
      const num = parseInt(rank, 10);
      total += isNaN(num) ? 10 : num;
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function formatBlackjackCard(card) {
  if (!card || card === '🂠') return '🂠';
  if (typeof card === 'object' && card.suit && card.value) {
    return `${card.suit}${card.value}`;
  }
  return String(card);
}

function dealerPlayBlackjack(deck, dealerHand) {
  while (blackjackScore(dealerHand) < 17 && deck.length > 0) {
    dealerHand.push(deck.pop());
  }
}

function spinSlot() {
  const s1 = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  const s2 = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  const s3 = SLOT_SYMBOLS[Math.floor(Math.random() * SLOT_SYMBOLS.length)];
  const line = [s1, s2, s3];
  
  let multiplier = 0;
  let won = false;
  if (s1 === s2 && s2 === s3) {
    won = true;
    if (s1 === '7️⃣') multiplier = 50;
    else if (s1 === '💎') multiplier = 25;
    else if (s1 === '🔔') multiplier = 15;
    else multiplier = 8;
  } else if (s1 === s2 || s2 === s3 || s1 === s3) {
    won = true;
    multiplier = 1.5;
  }
  return { line, reels: line, slots: line, displayReels: line, isWin: won, won, multiplier };
}

function scratchLottery() {
  const s1 = LOTTERY_SYMBOLS[Math.floor(Math.random() * LOTTERY_SYMBOLS.length)];
  const s2 = LOTTERY_SYMBOLS[Math.floor(Math.random() * LOTTERY_SYMBOLS.length)];
  const s3 = LOTTERY_SYMBOLS[Math.floor(Math.random() * LOTTERY_SYMBOLS.length)];
  const symbols = [s1, s2, s3];
  
  let multiplier = 0;
  let won = false;
  if (s1 === s2 && s2 === s3) {
    won = true;
    if (s1 === '7️⃣') multiplier = 77;
    else if (s1 === '💎') multiplier = 30;
    else if (s1 === '💰') multiplier = 20;
    else if (s1 === '🦆') multiplier = 15;
    else multiplier = 10;
  } else if (s1 === s2 || s2 === s3 || s1 === s3) {
    won = true;
    multiplier = 2.0;
  }
  return { symbols, reels: symbols, displayReels: symbols, isWin: won, won, multiplier };
}

function subsidyStatus(cash, bank, stockVal) {
  const net = computeNetWorth(cash, bank, stockVal);
  const eligible = net <= BigInt(SUBSIDY.MAX_NET_WORTH);
  return {
    net,
    eligible,
    isBroke: (safeBigInt(cash) + safeBigInt(bank)) < 5000n
  };
}

function allowedClicksInWindow(requested, elapsedMs) {
  if (Array.isArray(requested)) {
    const now = arguments[1] || Date.now();
    const windowMs = arguments[2] || 1000;
    const maxHits = arguments[3] || 25;
    const cutoff = now - windowMs;
    const recent = requested.filter(t => t >= cutoff);
    return recent.length < maxHits ? (maxHits - recent.length) : 0;
  }
  const req = Math.max(0, parseInt(requested, 10) || 0);
  if (req <= 0) return 0;
  const ms = Math.max(CLICKER.MIN_MS_PER_CLICK, Number(elapsedMs) || CLICKER.MIN_MS_PER_CLICK);
  const maxPossible = Math.max(1, Math.floor(ms / CLICKER.MIN_MS_PER_CLICK) * 2);
  return Math.min(req, maxPossible, CLICKER.MAX_CLICKS_PER_REQUEST);
}

module.exports = {
  BANK,
  LOAN,
  CLICKER,
  SUBSIDY,
  DAILY,
  WORK,
  TAX,
  BUSINESS,
  STOCK,
  SLOT_SYMBOLS,
  LOTTERY_SYMBOLS,
  HORSES,
  COIN_WIN_MULT,
  DICE_WIN_MULT,
  NET_WORTH_SQL,
  STOCK_VALUE_SQL,
  clampStockDelta,
  hourlyDividendForHolding,
  scaleGambleMultiplier,
  flipCoin,
  rollHighLow,
  spinRoulette,
  spinSlot,
  scratchLottery,
  createBlackjackDeck,
  blackjackScore,
  formatBlackjackCard,
  dealerPlayBlackjack,
  subsidyStatus,
  allowedClicksInWindow,
  findBusiness,
  businessBaseIncome,
  businessWagePerMin,
  businessIncomePerMin,
  businessUpgradeCost,
  businessStaffHireCost,
  businessHqCost,
  businessPending,
  pickHorseWinner,
  findHorse,
  clickPower,
  powerUpgradeCost,
  autoPerSec,
  autoUpgradeCost,
  rollClickBatch,
  evalStockValue,
  sumHoldingValue,
  computeNetWorth,
  netWorthPercents
};
