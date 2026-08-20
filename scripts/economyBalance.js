/**
 * 월덕 경제 밸런스 단일 기준.
 * 현금 + 예금 + 주식평가액 = 순자산.
 * 웹과 디스코드 명령은 여기 숫자만 쓴다.
 */
const { safeBigInt } = require('./money');

const BANK = {
  HOURLY_RATE: 0.0005, // 시간당 0.05%
  LABEL: '시간당 0.05%',
  get PER_MINUTE_RATE() {
    return this.HOURLY_RATE / 60;
  }
};

// 대출: 예금 담보, 예금 이자보다 비싸게, 만기 후 담보 회수
const LOAN = {
  LTV: 0.5,                 // 예금의 50%까지
  HOURLY_RATE: 0.0015,      // 시간당 0.15%
  LABEL: '시간당 0.15%',
  TERM_HOURS: 24,
  MINT_SHARE: 0.20,         // 국고 부족 시 신규 발행 상한(해당 대출의 20%)
  INTEREST_CAP: 1,          // 이자는 원래 원금의 100%를 넘지 않음
  CREDIT: [1, 0.5, 0.25],   // 연체 0/1/2회+ 한도 배율
  get PER_MINUTE_RATE() {
    return this.HOURLY_RATE / 60;
  }
};

const CLICKER = {
  POWER_PER_LEVEL: 10,
  CRIT_CHANCE: 0.10,
  CRIT_MULT: 3,
  MAX_CLICKS_PER_REQUEST: 200,
  MIN_MS_PER_CLICK: 25,
  POWER_COST_PER_LEVEL: 4500,
  AUTO_PER_LEVEL_PER_SEC: 15,
  AUTO_COST_BASE: 12000,
  BONUS_TURN_CHANCE: 0.10
};

const SUBSIDY = {
  BROKE_COOLDOWN_MS: 1 * 60 * 1000,
  NORMAL_COOLDOWN_MS: 5 * 60 * 1000,
  BROKE_AMOUNT: 10000,
  NORMAL_AMOUNT: 5000,
  BROKE_LIQUID: 10000,
  WEALTH_CAP: 500000
};

// 사업: 수금형 패시브. 회수 기간을 클리커보다 길게 잡아 인플레를 억제한다.
const BUSINESS = {
  MAX_LEVEL: 10,
  MAX_STAFF: 5,
  MAX_HQ: 5,
  COLLECT_CAP_MIN: 8 * 60,
  UPGRADE_GROWTH: 1.55,
  INCOME_GROWTH: 1.22,
  SELL_RATE: 0.6,
  STAFF_BONUS: 0.12,
  STAFF_WAGE_RATE: 0.04,
  STAFF_HIRE_RATE: 0.18,
  HQ_BONUS: 0.06,
  HQ_BASE_COST: 500000,
  COLLECT_EVENT_CHANCE: 0.08,
  CATALOG: [
    { key: 'store', name: '골목 편의점', emoji: '🏪', blurb: '야식과 담배를 파는 동네 가게', cost: 50000, incomePerMin: 80, requires: null },
    { key: 'farm', name: '월덕 농장', emoji: '🌾', blurb: '오리 모이와 채소를 키운다', cost: 120000, incomePerMin: 170, requires: 'store' },
    { key: 'cafe', name: '월덕 카페', emoji: '☕', blurb: '광장 옆 단골 카페', cost: 200000, incomePerMin: 280, requires: 'store' },
    { key: 'chicken', name: '황금닭 치킨', emoji: '🍗', blurb: '야식 타임 국민 프랜차이즈', cost: 800000, incomePerMin: 1000, requires: 'cafe' },
    { key: 'exchange', name: '덕스 환전소', emoji: '💱', blurb: '현금과 예금을 돌리는 창구', cost: 1500000, incomePerMin: 1700, requires: 'chicken' },
    { key: 'mine', name: '광산 하청', emoji: '⛏️', blurb: '월덕 광업 하청 채굴장', cost: 2000000, incomePerMin: 2200, requires: 'farm' },
    { key: 'hotel', name: '오리 호텔', emoji: '🏨', blurb: '광장 방문객을 받는 숙소', cost: 3500000, incomePerMin: 3600, requires: 'chicken' },
    { key: 'casino', name: '카지노 지점', emoji: '🎰', blurb: '슬롯과 룰렛을 돌리는 지점', cost: 5000000, incomePerMin: 5000, requires: 'exchange' },
    { key: 'news', name: '덕뉴스 방송국', emoji: '📺', blurb: '시세 속보를 내보내는 방송국', cost: 8000000, incomePerMin: 7200, requires: 'casino' },
    { key: 'data', name: '이지스크랩 센터', emoji: '🌐', blurb: '시세 데이터를 파는 센터', cost: 15000000, incomePerMin: 13000, requires: 'mine' },
    { key: 'lab', name: '냥코 연구소', emoji: '🔬', blurb: '양자 실험으로 부가가치를 낸다', cost: 25000000, incomePerMin: 20000, requires: 'data' },
    { key: 'mall', name: '월덕 타운몰', emoji: '🏬', blurb: '모든 점포가 모인 복합몰', cost: 40000000, incomePerMin: 28000, requires: 'lab' }
  ]
};

function findBusiness(key) {
  return BUSINESS.CATALOG.find((item) => item.key === key) || null;
}

function businessBaseIncome(def, level) {
  const lv = Math.max(1, Math.min(BUSINESS.MAX_LEVEL, Number(level) || 1));
  return Math.floor(Number(def.incomePerMin) * Math.pow(BUSINESS.INCOME_GROWTH, lv - 1));
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
  const gross = Math.floor(base * (1 + BUSINESS.STAFF_BONUS * st) * (1 + BUSINESS.HQ_BONUS * hq));
  return Math.max(0, gross - businessWagePerMin(def, level, st));
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

function businessPending(def, level, lastCollectAt, nowMs, staff, hqLevel) {
  const last = lastCollectAt ? new Date(lastCollectAt).getTime() : nowMs;
  const elapsedMin = Math.max(0, (nowMs - last) / 60000);
  const capped = Math.min(BUSINESS.COLLECT_CAP_MIN, elapsedMin);
  return Math.floor(businessIncomePerMin(def, level, staff, hqLevel) * capped);
}

const STOCK = {
  MAX_EVENT_IMPACT: 0.06,
  MAX_TICK_DELTA: 0.08,
  NEWS_CHANCE: 0.20,
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
  const base = clickPower(level);
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

function subsidyStatus(cash, bank, stockVal) {
  const liquid = safeBigInt(cash) + safeBigInt(bank);
  const net = liquid + safeBigInt(stockVal);
  const isBroke = liquid < BigInt(SUBSIDY.BROKE_LIQUID);
  const eligible = net < BigInt(SUBSIDY.WEALTH_CAP);
  return { liquid, net, isBroke, eligible };
}

function allowedClicksInWindow(requested, elapsedMs) {
  const want = Math.min(
    CLICKER.MAX_CLICKS_PER_REQUEST,
    Math.max(1, parseInt(requested, 10) || 1)
  );
  const elapsed = Number(elapsedMs);
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  const byTime = Math.floor(elapsed / CLICKER.MIN_MS_PER_CLICK);
  return Math.min(want, Math.max(0, byTime));
}

const STOCK_VALUE_SQL = 'CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0))';
const NET_WORTH_SQL = '(CAST(u.cash AS DECIMAL(65,0)) + CAST(u.bank AS DECIMAL(65,0)) + ' + STOCK_VALUE_SQL + ')';

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function spinSlot() {
  const s1 = pickRandom(SLOT_SYMBOLS);
  const s2 = pickRandom(SLOT_SYMBOLS);
  const s3 = pickRandom(SLOT_SYMBOLS);
  let multiplier = 0;
  if (s1 === s2 && s2 === s3) {
    if (s1 === '7️⃣') multiplier = 50;
    else if (s1 === '💎') multiplier = 20;
    else if (s1 === '🔔') multiplier = 10;
    else multiplier = 10;
  } else if (s1 === s2 || s2 === s3 || s1 === s3) {
    multiplier = 1.5;
  }
  return { reels: [s1, s2, s3], multiplier, isWin: multiplier > 0 };
}

function scratchLottery() {
  const r1 = pickRandom(LOTTERY_SYMBOLS);
  const r2 = pickRandom(LOTTERY_SYMBOLS);
  const r3 = pickRandom(LOTTERY_SYMBOLS);
  let multiplier = 0;
  if (r1 === r2 && r2 === r3) {
    if (r1 === '💎') multiplier = 40;
    else if (r1 === '7️⃣') multiplier = 20;
    else if (r1 === '🦆') multiplier = 12;
    else if (r1 === '💰') multiplier = 8;
    else multiplier = 4;
  } else if (r1 === r2 || r2 === r3 || r1 === r3) {
    multiplier = 1.2;
  }
  return { symbols: [r1, r2, r3], multiplier, isWin: multiplier > 0 };
}

function spinRoulette() {
  const rand = Math.floor(Math.random() * 100);
  if (rand < 6) return { color: 'GREEN', emoji: '🟢 GREEN', winMult: 15 };
  if (rand < 53) return { color: 'RED', emoji: '🔴 RED', winMult: 2 };
  return { color: 'BLACK', emoji: '⚫ BLACK', winMult: 2 };
}

function flipCoin() {
  return { result: Math.random() < 0.5 ? '앞면' : '뒷면' };
}

function rollHighLow() {
  const roll = Math.floor(Math.random() * 100) + 1;
  let multiplier = 0;
  if (roll >= 90) multiplier = 3.5;
  else if (roll >= 60) multiplier = 1.8;
  return { roll, multiplier, isWin: multiplier > 0 };
}

const BJ_SUITS = ['♠', '♥', '♦', '♣'];
const BJ_VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createBlackjackDeck() {
  const deck = [];
  for (const suit of BJ_SUITS) {
    for (const value of BJ_VALUES) {
      deck.push({ suit, value });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function blackjackScore(cards) {
  let score = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.value === 'A') {
      aces += 1;
      score += 11;
    } else if (['K', 'Q', 'J'].includes(card.value)) {
      score += 10;
    } else {
      score += parseInt(card.value, 10);
    }
  }
  while (score > 21 && aces > 0) {
    score -= 10;
    aces -= 1;
  }
  return score;
}

function formatBlackjackCard(card) {
  return `${card.suit}${card.value}`;
}

function dealerPlayBlackjack(deck, dealerHand) {
  while (blackjackScore(dealerHand) < 17) {
    dealerHand.push(deck.pop());
  }
  return dealerHand;
}

function getGamblePayoutMultiplier() {
  try {
    const { getDynamicSettings } = require('./economyBalancer');
    const dyn = getDynamicSettings();
    const mult = Number(dyn && dyn.gamblingPayoutMultiplier);
    if (Number.isFinite(mult) && mult > 0) return mult;
  } catch (e) {}
  return 1;
}

function scaleGambleMultiplier(baseMult) {
  const base = Number(baseMult);
  if (!Number.isFinite(base) || base <= 0) return 0;
  if (base === 1) return 1;
  const scaled = base * getGamblePayoutMultiplier();
  if (!Number.isFinite(scaled) || scaled <= 0) return 0;
  return scaled;
}

function clampStockDelta(eventBoost, totalDelta) {
  const event = Math.max(-STOCK.MAX_EVENT_IMPACT, Math.min(STOCK.MAX_EVENT_IMPACT, Number(eventBoost) || 0));
  const total = event + (Number(totalDelta) || 0) - (Number(eventBoost) || 0);
  return Math.max(-STOCK.MAX_TICK_DELTA, Math.min(STOCK.MAX_TICK_DELTA, total));
}

function hourlyDividendPerShare(price, dividendYield) {
  const yieldRate = Number(dividendYield || 0) / 100;
  if (yieldRate <= 0) return 0;
  return (Number(price) * yieldRate) / STOCK.HOURS_PER_YEAR;
}

function hourlyDividendForHolding(price, amount, dividendYield) {
  const yieldNum = Number(dividendYield || 0);
  if (!Number.isFinite(yieldNum) || yieldNum <= 0) return 0n;
  const { amountToUnits } = require('./moneyScale');
  const p = safeBigInt(price);
  const units = amountToUnits(amount);
  const yieldBps = BigInt(Math.round(yieldNum * 100));
  if (p <= 0n || units <= 0n || yieldBps <= 0n) return 0n;
  return (p * units * yieldBps) / (100000000n * BigInt(STOCK.HOURS_PER_YEAR));
}

module.exports = {
  BANK,
  LOAN,
  CLICKER,
  SUBSIDY,
  BUSINESS,
  STOCK,
  HORSES,
  COIN_WIN_MULT,
  DICE_WIN_MULT,
  SLOT_SYMBOLS,
  LOTTERY_SYMBOLS,
  clickPower,
  powerUpgradeCost,
  autoPerSec,
  autoUpgradeCost,
  rollClickBatch,
  evalStockValue,
  sumHoldingValue,
  computeNetWorth,
  netWorthPercents,
  subsidyStatus,
  allowedClicksInWindow,
  NET_WORTH_SQL,
  STOCK_VALUE_SQL,
  spinSlot,
  scratchLottery,
  spinRoulette,
  flipCoin,
  pickHorseWinner,
  findHorse,
  rollHighLow,
  createBlackjackDeck,
  blackjackScore,
  formatBlackjackCard,
  dealerPlayBlackjack,
  getGamblePayoutMultiplier,
  scaleGambleMultiplier,
  clampStockDelta,
  hourlyDividendPerShare,
  hourlyDividendForHolding,
  findBusiness,
  businessIncomePerMin,
  businessUpgradeCost,
  businessPending,
  businessStaffHireCost,
  businessHqCost,
  businessWagePerMin
};
