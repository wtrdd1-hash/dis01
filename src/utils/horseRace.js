/**
 * 월덕 그랑프리 경마 — 단승/복승/연승/복연승/쌍승 + 시간대별 주로
 */
const HORSES = [
  { id: 1, name: '황금번개', displayName: '1번 황금번개', odds: 2.0, color: '#fbbf24', weight: 42, emoji: '⚡' },
  { id: 2, name: '질풍노도', displayName: '2번 질풍노도', odds: 3.0, color: '#38bdf8', weight: 28, emoji: '🌪️' },
  { id: 3, name: '다크호스', displayName: '3번 다크호스', odds: 5.0, color: '#a855f7', weight: 16, emoji: '🖤' },
  { id: 4, name: '월덕스피릿', displayName: '4번 월덕스피릿', odds: 8.0, color: '#f43f5e', weight: 9, emoji: '🦆' },
  { id: 5, name: '로또잭팟', displayName: '5번 로또잭팟', odds: 15.0, color: '#ec4899', weight: 5, emoji: '💎' }
];

const HORSE_BET_MODES = {
  win: { id: 'win', name: '단승', desc: '1착만 맞히면 적중', picks: 1 },
  place: { id: 'place', name: '복승', desc: '1착 또는 2착', picks: 1 },
  show: { id: 'show', name: '연승', desc: '1·2·3착 안에 들면 적중', picks: 1 },
  quinella: { id: 'quinella', name: '복연승', desc: '1·2착 두 마리를 순서 없이', picks: 2 },
  exacta: { id: 'exacta', name: '쌍승', desc: '1착·2착을 순서대로', picks: 2 }
};

const HORSE_CONDITIONS = [
  { id: 'sunny', name: '맑음', emoji: '☀️', desc: '표준 잔디 주로. 정배당이 힘을 냅니다.', mods: { 1: 1.08, 2: 1.04, 3: 0.96, 4: 0.95, 5: 0.92 } },
  { id: 'rain', name: '우천', emoji: '🌧️', desc: '미끄러운 주로. 지구력·복병마가 유리합니다.', mods: { 1: 0.84, 2: 0.90, 3: 1.18, 4: 1.14, 5: 0.88 } },
  { id: 'wind', name: '강풍', emoji: '💨', desc: '맞바람. 가벼운 발의 질주마가 앞섭니다.', mods: { 1: 1.06, 2: 1.18, 3: 0.92, 4: 0.88, 5: 0.94 } },
  { id: 'mud', name: '진흙', emoji: '🟤', desc: '힘겨루기. 다크호스와 월덕스피릿이 각성합니다.', mods: { 1: 0.78, 2: 0.86, 3: 1.24, 4: 1.22, 5: 1.08 } },
  { id: 'night', name: '야간', emoji: '🌙', desc: '일요 야간경주. 고배당 말이 컨디션 최고입니다.', mods: { 1: 0.90, 2: 0.94, 3: 1.06, 4: 1.16, 5: 1.32 } }
];

const HOUSE_RTP = 0.82;

function hashString(value) {
  let h = 2166136261;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seoulHourKey() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const grab = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${grab('year')}${grab('month')}${grab('day')}-${grab('hour')}`;
}

function getHourlyCondition() {
  const key = seoulHourKey();
  const idx = hashString(key) % HORSE_CONDITIONS.length;
  return HORSE_CONDITIONS[idx];
}

function houseOdds(probability, minOdds, maxOdds) {
  const p = Number(probability);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const fair = HOUSE_RTP / p;
  // 최소 배당을 맞추면 +EV가 되는 시장은 열어두지 않는다.
  if (fair < minOdds) return 0;
  let odds = Math.round(fair * 10) / 10;
  odds = Math.min(maxOdds, Math.max(minOdds, odds));
  if (odds * p >= 0.99) {
    odds = Math.floor((0.98 / p) * 10) / 10;
  }
  if (odds < minOdds) return 0;
  return odds;
}

function finishingProbs(horses) {
  const total = horses.reduce((sum, h) => sum + h.liveWeight, 0);
  const p1 = {};
  const p2 = {};
  const p3 = {};
  for (const h of horses) {
    p1[h.id] = 0;
    p2[h.id] = 0;
    p3[h.id] = 0;
  }
  if (total <= 0) return { p1, p2, p3, total: 0 };
  for (const a of horses) {
    const pa = a.liveWeight / total;
    p1[a.id] += pa;
    const total2 = total - a.liveWeight;
    if (total2 <= 0) continue;
    for (const b of horses) {
      if (b.id === a.id) continue;
      const pb = pa * (b.liveWeight / total2);
      p2[b.id] += pb;
      const total3 = total2 - b.liveWeight;
      if (total3 <= 0) continue;
      for (const c of horses) {
        if (c.id === a.id || c.id === b.id) continue;
        p3[c.id] += pb * (c.liveWeight / total3);
      }
    }
  }
  return { p1, p2, p3, total };
}

function getHorseBetOdds(card, mode, horseId, horseId2) {
  const normalized = normalizeMode(mode);
  const source = card || getRaceCard();
  if (normalized === 'quinella' || normalized === 'exacta') {
    return exoticOdds(source, horseId, horseId2, normalized === 'exacta');
  }
  const horse = (source.horses || []).find((h) => h.id === Number(horseId));
  if (!horse) return 0;
  if (normalized === 'place') return Number(horse.placeOdds) || 0;
  if (normalized === 'show') return Number(horse.showOdds) || 0;
  return Number(horse.winOdds) || 0;
}

function closedMarketError(spec) {
  return { error: `${spec.name} 배당이 마감된 선택입니다. 단승이나 다른 말을 골라주세요.` };
}

function validateHorseBet({ mode, horseId, horseId2, card }) {
  const normalized = normalizeMode(mode);
  const spec = HORSE_BET_MODES[normalized];
  const pick1 = findHorse(horseId);
  if (!pick1) {
    return { error: '출전마를 선택해주세요 (1~5번).' };
  }
  if (spec.picks === 2) {
    const pick2 = findHorse(horseId2);
    if (!pick2) {
      return { error: `${spec.name}은 두 마리를 선택해야 합니다.` };
    }
    if (pick1.id === pick2.id) {
      return { error: `${spec.name}은 서로 다른 두 마리를 선택해야 합니다.` };
    }
  }
  const odds = getHorseBetOdds(card, normalized, horseId, horseId2);
  if (!(odds > 1)) {
    return closedMarketError(spec);
  }
  return { ok: true, mode: normalized, odds };
}

function publicHorse(horse) {
  if (!horse) return null;
  return {
    id: horse.id,
    name: horse.displayName || horse.name,
    shortName: horse.name,
    emoji: horse.emoji,
    color: horse.color,
    winOdds: horse.winOdds,
    placeOdds: horse.placeOdds,
    showOdds: horse.showOdds
  };
}

function findHorse(id) {
  return HORSES.find((h) => h.id === Number(id)) || null;
}

function normalizeMode(raw) {
  const key = String(raw || 'win').toLowerCase();
  return HORSE_BET_MODES[key] ? key : 'win';
}

function getRaceCard() {
  const condition = getHourlyCondition();
  const horses = HORSES.map((h) => {
    const liveWeight = h.weight * (condition.mods[h.id] || 1);
    return { ...h, liveWeight };
  });
  const { p1, p2, p3, total } = finishingProbs(horses);

  for (const h of horses) {
    const winP = p1[h.id] || 0;
    const placeP = winP + (p2[h.id] || 0);
    const showP = placeP + (p3[h.id] || 0);
    h.winOdds = houseOdds(winP, 1.4, 40);
    h.placeOdds = houseOdds(placeP, 1.05, 20);
    h.showOdds = houseOdds(showP, 1.02, 12);
  }

  return { condition, horses, totalWeight: total, hourKey: seoulHourKey() };
}

function publicRaceCard(card) {
  const source = card || getRaceCard();
  const quinella = {};
  const exacta = {};
  for (const a of source.horses) {
    for (const b of source.horses) {
      if (a.id === b.id) continue;
      exacta[`${a.id}-${b.id}`] = exoticOdds(source, a.id, b.id, true);
      if (a.id < b.id) {
        quinella[`${a.id}-${b.id}`] = exoticOdds(source, a.id, b.id, false);
      }
    }
  }
  return {
    hourKey: source.hourKey,
    condition: {
      id: source.condition.id,
      name: source.condition.name,
      emoji: source.condition.emoji,
      desc: source.condition.desc
    },
    modes: Object.values(HORSE_BET_MODES),
    horses: source.horses.map(publicHorse),
    pairOdds: { quinella, exacta }
  };
}

function simulateRace(card) {
  const remaining = (card.horses || []).map((h) => ({ ...h }));
  const ranking = [];
  while (remaining.length > 0) {
    const total = remaining.reduce((sum, h) => sum + h.liveWeight, 0);
    let rand = Math.random() * total;
    let idx = remaining.length - 1;
    for (let i = 0; i < remaining.length; i++) {
      if (rand < remaining[i].liveWeight) {
        idx = i;
        break;
      }
      rand -= remaining[i].liveWeight;
    }
    ranking.push(remaining.splice(idx, 1)[0]);
  }
  return ranking;
}

function pairProbability(card, idA, idB, ordered) {
  const a = card.horses.find((h) => h.id === Number(idA));
  const b = card.horses.find((h) => h.id === Number(idB));
  if (!a || !b || a.id === b.id) return 0;
  const t = card.totalWeight;
  const pA = a.liveWeight / t;
  const pB = b.liveWeight / t;
  const pBGivenA = b.liveWeight / Math.max(0.0001, t - a.liveWeight);
  const pAGivenB = a.liveWeight / Math.max(0.0001, t - b.liveWeight);
  if (ordered) return pA * pBGivenA;
  return pA * pBGivenA + pB * pAGivenB;
}

function exoticOdds(card, idA, idB, ordered) {
  const p = pairProbability(card, idA, idB, ordered);
  if (p <= 0) return 0;
  const cap = ordered ? 80 : 45;
  const min = ordered ? 4 : 2.4;
  return houseOdds(p, min, cap);
}

function flavorText(ranking, condition, result) {
  const first = ranking[0];
  const second = ranking[1];
  const third = ranking[2];
  const lines = [
    `${condition.emoji} ${condition.name} 주로, ${first.emoji} ${first.name}가 마지막 직선에서 빠져나갔습니다!`,
    `결승선 직전 ${second.emoji} ${second.name}가 추격했지만 ${first.emoji} ${first.name}가 한 발 앞섰습니다.`,
    `3착은 ${third.emoji} ${third.name}. 중위권 다툼이 뜨거웠습니다.`,
    result && result.isWin
      ? `배당판이 터졌습니다! ${result.modeName} 적중!`
      : `아쉬운 한 끝. 다음 레이스 배당을 노려보세요.`
  ];
  return lines.join(' ');
}

function settleHorseBet({ mode, horseId, horseId2, ranking, card }) {
  const normalized = normalizeMode(mode);
  const spec = HORSE_BET_MODES[normalized];
  const first = ranking[0];
  const second = ranking[1];
  const third = ranking[2];
  const pick1 = findHorse(horseId);
  if (!pick1) {
    return { error: '출전마를 선택해주세요 (1~5번).' };
  }

  if (spec.picks === 2) {
    const pick2 = findHorse(horseId2);
    if (!pick2) {
      return { error: `${spec.name}은 두 마리를 선택해야 합니다.` };
    }
    if (pick1.id === pick2.id) {
      return { error: `${spec.name}은 서로 다른 두 마리를 선택해야 합니다.` };
    }

    if (normalized === 'quinella') {
      const top = [first.id, second.id].sort();
      const pick = [pick1.id, pick2.id].sort();
      const isWin = top[0] === pick[0] && top[1] === pick[1];
      const multiplier = exoticOdds(card, pick1.id, pick2.id, false);
      return {
        mode: normalized,
        modeName: spec.name,
        isWin,
        multiplier,
        pick1,
        pick2
      };
    }

    const isWin = first.id === pick1.id && second.id === pick2.id;
    return {
      mode: normalized,
      modeName: spec.name,
      isWin,
      multiplier: exoticOdds(card, pick1.id, pick2.id, true),
      pick1,
      pick2
    };
  }

  const horse = card.horses.find((h) => h.id === pick1.id) || pick1;
  if (normalized === 'place') {
    const isWin = first.id === pick1.id || second.id === pick1.id;
    return { mode: normalized, modeName: spec.name, isWin, multiplier: horse.placeOdds, pick1, pick2: null };
  }
  if (normalized === 'show') {
    const isWin = first.id === pick1.id || second.id === pick1.id || third.id === pick1.id;
    return { mode: normalized, modeName: spec.name, isWin, multiplier: horse.showOdds, pick1, pick2: null };
  }

  return {
    mode: 'win',
    modeName: spec.name,
    isWin: first.id === pick1.id,
    multiplier: horse.winOdds,
    pick1,
    pick2: null
  };
}

function runHorseRace({ mode, horseId, horseId2 }) {
  const card = getRaceCard();
  const picked = validateHorseBet({ mode, horseId, horseId2, card });
  if (picked.error) return picked;
  const ranking = simulateRace(card);
  const settled = settleHorseBet({ mode, horseId, horseId2, ranking, card });
  if (settled.error) return settled;
  if (!(Number(settled.multiplier) > 1)) {
    return closedMarketError(HORSE_BET_MODES[settled.mode] || HORSE_BET_MODES.win);
  }
  return {
    ...settled,
    card,
    ranking,
    flavor: flavorText(ranking, card.condition, settled)
  };
}

function pickHorseWinner() {
  return simulateRace(getRaceCard())[0];
}

module.exports = {
  HORSES,
  HORSE_BET_MODES,
  HORSE_CONDITIONS,
  findHorse,
  validateHorseBet,
  getHorseBetOdds,
  pickHorseWinner,
  getRaceCard,
  publicRaceCard,
  publicHorse,
  simulateRace,
  runHorseRace,
  normalizeMode
};
