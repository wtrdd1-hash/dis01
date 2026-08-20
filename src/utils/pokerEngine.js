/**
 * 텍사스 홀덤 vs 딜러 (헤즈업 리밋).
 * 팟은 플레이어 실차감 + 딜러(하우스) 매칭 칩.
 */
const SUITS = [
  { id: 0, mark: '♠', color: 'black' },
  { id: 1, mark: '♥', color: 'red' },
  { id: 2, mark: '♦', color: 'red' },
  { id: 3, mark: '♣', color: 'black' }
];
const RANK_MARK = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: '10', 9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2' };
const HAND_NAMES = [
  '하이카드',
  '원페어',
  '투페어',
  '트리플',
  '스트레이트',
  '플러시',
  '풀하우스',
  '포카드',
  '스트레이트 플러시',
  '로열 플러시'
];
const STREET_KO = {
  preflop: '프리플롭',
  flop: '플롭',
  turn: '턴',
  river: '리버',
  showdown: '쇼다운'
};
const MOODS = {
  tight: { id: 'tight', name: '신중', fold: 0.28, bet: 0.70, noise: 0.05 },
  loose: { id: 'loose', name: '느슨', fold: 0.16, bet: 0.48, noise: 0.10 },
  aggro: { id: 'aggro', name: '공격', fold: 0.10, bet: 0.36, noise: 0.08 }
};

function toBig(v) {
  if (typeof v === 'bigint') return v;
  try { return BigInt(String(v || '0').split('.')[0] || '0'); } catch (e) { return 0n; }
}

function formatCard(card) {
  if (!card) return '🂠';
  return RANK_MARK[card.r] + SUITS[card.s].mark;
}

function cardColor(card) {
  if (!card) return 'black';
  return SUITS[card.s].color;
}

function cardKey(card) {
  if (!card) return '';
  return String(card.r) + '-' + String(card.s);
}

function cardView(card) {
  return {
    t: formatCard(card),
    c: cardColor(card),
    k: cardKey(card)
  };
}

function makeDeck() {
  const deck = [];
  for (let s = 0; s < 4; s += 1) {
    for (let r = 2; r <= 14; r += 1) deck.push({ r, s });
  }
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

function combinations(arr, k) {
  const out = [];
  function rec(start, acc) {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < arr.length; i += 1) {
      acc.push(arr[i]);
      rec(i + 1, acc);
      acc.pop();
    }
  }
  rec(0, []);
  return out;
}

function straightHighFromSet(set) {
  const seq = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2];
  for (let i = 0; i <= seq.length - 5; i += 1) {
    const slice = seq.slice(i, i + 5);
    if (slice.every((r) => set.has(r))) return slice[0];
  }
  if ([14, 5, 4, 3, 2].every((r) => set.has(r))) return 5;
  return 0;
}

function evaluate5(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const suits = cards.map((c) => c.s);
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.keys(counts)
    .map((k) => ({ r: Number(k), n: counts[k] }))
    .sort((a, b) => b.n - a.n || b.r - a.r);
  const flush = suits.every((s) => s === suits[0]);
  const uniq = [...new Set(ranks)];
  const sHigh = straightHighFromSet(new Set(uniq));
  const isStraight = sHigh > 0;
  const isRoyal = flush && isStraight && sHigh === 14;
  const kick = (n) => groups.filter((g) => g.n === n).map((g) => g.r);

  if (isRoyal) return { cat: 9, kickers: [14], name: HAND_NAMES[9], cards };
  if (flush && isStraight) return { cat: 8, kickers: [sHigh], name: HAND_NAMES[8], cards };
  if (groups[0].n === 4) return { cat: 7, kickers: [groups[0].r, kick(1)[0]], name: HAND_NAMES[7], cards };
  if (groups[0].n === 3 && groups[1] && groups[1].n >= 2) {
    return { cat: 6, kickers: [groups[0].r, groups[1].r], name: HAND_NAMES[6], cards };
  }
  if (flush) return { cat: 5, kickers: ranks, name: HAND_NAMES[5], cards };
  if (isStraight) return { cat: 4, kickers: [sHigh], name: HAND_NAMES[4], cards };
  if (groups[0].n === 3) return { cat: 3, kickers: [groups[0].r, ...kick(1)], name: HAND_NAMES[3], cards };
  if (groups[0].n === 2 && groups[1] && groups[1].n === 2) {
    const pairs = kick(2);
    const high = Math.max(pairs[0], pairs[1]);
    const low = Math.min(pairs[0], pairs[1]);
    return { cat: 2, kickers: [high, low, kick(1)[0]], name: HAND_NAMES[2], cards };
  }
  if (groups[0].n === 2) return { cat: 1, kickers: [groups[0].r, ...kick(1)], name: HAND_NAMES[1], cards };
  return { cat: 0, kickers: ranks, name: HAND_NAMES[0], cards };
}

function compareEval(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const n = Math.max(a.kickers.length, b.kickers.length);
  for (let i = 0; i < n; i += 1) {
    const av = a.kickers[i] || 0;
    const bv = b.kickers[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function bestHand(cards) {
  if (!cards || cards.length < 5) return { cat: -1, kickers: [], name: '미완성', cards: cards || [] };
  if (cards.length === 5) return evaluate5(cards);
  let best = null;
  for (const five of combinations(cards, 5)) {
    const ev = evaluate5(five);
    if (!best || compareEval(ev, best) > 0) best = ev;
  }
  return best;
}

function preflopStrength(hole) {
  const a = hole[0];
  const b = hole[1];
  const hi = Math.max(a.r, b.r);
  const lo = Math.min(a.r, b.r);
  const pair = a.r === b.r;
  const suited = a.s === b.s;
  const gap = hi - lo;
  let s = (hi - 2) / 12 * 0.42 + (lo - 2) / 12 * 0.18;
  if (pair) s = 0.54 + (hi - 2) / 12 * 0.42;
  if (suited) s += 0.06;
  if (gap === 1) s += 0.05;
  else if (gap === 2) s += 0.02;
  if (hi === 14 && lo >= 10) s += 0.08;
  return Math.max(0.05, Math.min(0.98, s));
}

function handStrength(hole, board) {
  if (!board || board.length < 3) return preflopStrength(hole);
  const ev = bestHand(hole.concat(board));
  const k0 = (ev.kickers[0] || 2) - 2;
  return Math.max(0.04, Math.min(0.99, (ev.cat + k0 / 12) / 10));
}

function pickMood() {
  const keys = Object.keys(MOODS);
  return MOODS[keys[Math.floor(Math.random() * keys.length)]];
}

function noisy(mood, value) {
  return value + (Math.random() * 2 - 1) * mood.noise;
}

function serializeTable(table) {
  return JSON.stringify(table, (_, val) => (typeof val === 'bigint' ? val.toString() : val));
}

function hydrate(raw) {
  const t = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(serializeTable(raw || {}));
  t.unit = toBig(t.unit);
  t.playerCommitted = toBig(t.playerCommitted);
  t.dealerCommitted = toBig(t.dealerCommitted);
  t.pendingCall = toBig(t.pendingCall || 0);
  t.deck = Array.isArray(t.deck) ? t.deck : [];
  t.player = Array.isArray(t.player) ? t.player : [];
  t.dealer = Array.isArray(t.dealer) ? t.dealer : [];
  t.board = Array.isArray(t.board) ? t.board : [];
  t.updatedAt = t.updatedAt || Date.now();
  t.status = t.status || 'playing';
  return t;
}

function cloneTable(table) {
  return hydrate(serializeTable(table));
}

function createHand(unitRaw) {
  const unit = toBig(unitRaw);
  const deck = makeDeck();
  const player = [deck.pop(), deck.pop()];
  const dealer = [deck.pop(), deck.pop()];
  const mood = pickMood();
  return {
    deck,
    player,
    dealer,
    board: [],
    street: 'preflop',
    toAct: 'player',
    facingBet: false,
    unit,
    playerCommitted: unit,
    dealerCommitted: unit,
    pendingCall: 0n,
    moodId: mood.id,
    status: 'playing',
    lastLine: mood.name + ' 딜러. 프리플롭입니다.',
    updatedAt: Date.now()
  };
}

function potOf(table) {
  return toBig(table.playerCommitted) + toBig(table.dealerCommitted);
}

function callAmountOf(table) {
  const n = toBig(table.pendingCall);
  return n > 0n ? n : toBig(table.unit);
}

function nextStreet(table) {
  if (table.street === 'preflop') {
    table.board.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
    table.street = 'flop';
    table.lastLine = '플롭';
  } else if (table.street === 'flop') {
    table.board.push(table.deck.pop());
    table.street = 'turn';
    table.lastLine = '턴';
  } else if (table.street === 'turn') {
    table.board.push(table.deck.pop());
    table.street = 'river';
    table.lastLine = '리버';
  } else {
    return showdown(table);
  }
  table.facingBet = false;
  table.pendingCall = 0n;
  table.toAct = 'player';
  return { done: false };
}

function runout(table) {
  while (table.status === 'playing' && (table.street !== 'river' || table.board.length < 5)) {
    if (table.street === 'river' && table.board.length >= 5) break;
    const r = nextStreet(table);
    if (r && r.done) return r;
  }
  if (table.status === 'playing') return showdown(table);
  return { done: true, outcome: table.outcome };
}

function showdown(table) {
  table.street = 'showdown';
  table.status = 'done';
  table.facingBet = false;
  table.pendingCall = 0n;
  table.toAct = 'none';
  const p = bestHand(table.player.concat(table.board));
  const d = bestHand(table.dealer.concat(table.board));
  const cmp = compareEval(p, d);
  table.playerEval = p;
  table.dealerEval = d;
  if (cmp > 0) {
    table.outcome = 'win';
    table.lastLine = '쇼다운 승 · ' + p.name;
  } else if (cmp < 0) {
    table.outcome = 'lose';
    table.lastLine = '쇼다운 패 · 딜러 ' + d.name;
  } else {
    table.outcome = 'tie';
    table.lastLine = '스플릿 · ' + p.name;
  }
  return { done: true, outcome: table.outcome };
}

function dealerFacesBet(table) {
  const mood = MOODS[table.moodId] || MOODS.tight;
  const s = noisy(mood, handStrength(table.dealer, table.board));
  const need = callAmountOf(table);
  const unit = toBig(table.unit);
  const foldLine = need > unit ? mood.fold * 0.55 : mood.fold;
  if (s < foldLine) {
    table.status = 'done';
    table.outcome = 'win';
    table.street = 'showdown';
    table.toAct = 'none';
    table.facingBet = false;
    table.pendingCall = 0n;
    table.lastLine = '딜러 폴드. 팟을 가져갑니다.';
    return { done: true, outcome: 'win' };
  }
  table.dealerCommitted = toBig(table.dealerCommitted) + need;
  table.pendingCall = 0n;
  table.facingBet = false;
  table.lastLine = '딜러 콜';
  return nextStreet(table);
}

function dealerAfterCheck(table) {
  const mood = MOODS[table.moodId] || MOODS.tight;
  const s = noisy(mood, handStrength(table.dealer, table.board));
  if (s >= mood.bet) {
    const unit = toBig(table.unit);
    table.dealerCommitted = toBig(table.dealerCommitted) + unit;
    table.facingBet = true;
    table.toAct = 'player';
    table.pendingCall = unit;
    table.lastLine = '딜러 벳';
    return { done: false };
  }
  table.lastLine = '딜러 체크';
  return nextStreet(table);
}

function applyPlayerAction(table, action, cashLeftRaw) {
  if (!table || table.status !== 'playing') {
    const err = new Error('진행 중인 포커가 없습니다.');
    err.status = 400;
    throw err;
  }
  const cashLeft = toBig(cashLeftRaw);
  const unit = toBig(table.unit);
  const act = String(action || '').toLowerCase();

  if (act === 'fold') {
    table.status = 'done';
    table.outcome = 'lose';
    table.street = 'showdown';
    table.toAct = 'none';
    table.lastLine = '폴드';
    return { done: true, outcome: 'lose', added: 0n };
  }

  if (act === 'check') {
    if (table.facingBet) {
      const err = new Error('벳이 들어와 있습니다. 콜·폴드·올인만 됩니다.');
      err.status = 400;
      throw err;
    }
    return Object.assign({ added: 0n }, dealerAfterCheck(table));
  }

  if (act === 'call') {
    if (!table.facingBet) {
      const err = new Error('콜할 벳이 없습니다. 체크 또는 벳을 하세요.');
      err.status = 400;
      throw err;
    }
    const need = callAmountOf(table);
    if (cashLeft < need) {
      const err = new Error('콜 금액이 부족합니다. 올인 또는 폴드하세요.');
      err.status = 400;
      throw err;
    }
    table.playerCommitted = toBig(table.playerCommitted) + need;
    table.facingBet = false;
    table.pendingCall = 0n;
    table.lastLine = '콜';
    return Object.assign({ added: need }, nextStreet(table));
  }

  if (act === 'bet') {
    if (table.facingBet) {
      const err = new Error('이미 벳이 있습니다. 콜·폴드·올인만 됩니다.');
      err.status = 400;
      throw err;
    }
    if (cashLeft < unit) {
      const err = new Error('벳 금액이 부족합니다. 올인 또는 체크하세요.');
      err.status = 400;
      throw err;
    }
    table.playerCommitted = toBig(table.playerCommitted) + unit;
    table.pendingCall = unit;
    table.lastLine = '벳';
    return Object.assign({ added: unit }, dealerFacesBet(table));
  }

  if (act === 'allin') {
    if (cashLeft <= 0n) {
      const err = new Error('올인할 현금이 없습니다.');
      err.status = 400;
      throw err;
    }
    const shove = cashLeft;
    table.playerCommitted = toBig(table.playerCommitted) + shove;
    if (table.facingBet) {
      const need = callAmountOf(table);
      if (shove < need) {
        const unmatched = need - shove;
        const dc = toBig(table.dealerCommitted);
        table.dealerCommitted = dc > unmatched ? dc - unmatched : 0n;
        table.facingBet = false;
        table.pendingCall = 0n;
        table.lastLine = '올인(숏)';
        return Object.assign({ added: shove }, runout(table));
      }
      table.facingBet = false;
      const extra = shove - need;
      table.pendingCall = extra;
      if (extra > 0n) {
        const r = dealerFacesBet(table);
        if (r.done) return Object.assign({ added: shove }, r);
        return Object.assign({ added: shove }, runout(table));
      }
      table.lastLine = '올인 콜';
      return Object.assign({ added: shove }, runout(table));
    }
    table.pendingCall = shove;
    table.lastLine = '올인';
    const r = dealerFacesBet(table);
    if (r.done) return Object.assign({ added: shove }, r);
    return Object.assign({ added: shove }, runout(table));
  }

  const err = new Error('알 수 없는 행동입니다.');
  err.status = 400;
  throw err;
}

function handRankOf(ev) {
  if (!ev || ev.cat < 0) return '';
  return ev.cat === 9 ? 'royal_flush' : ev.name;
}

function publicState(table, hideDealer, cashLeftRaw) {
  const hide = hideDealer !== false && table.status === 'playing';
  const cashLeft = toBig(cashLeftRaw);
  const unit = toBig(table.unit);
  const facing = !!table.facingBet;
  const playing = table.status === 'playing';
  const need = callAmountOf(table);
  const pEval = table.board.length >= 3 ? bestHand(table.player.concat(table.board)) : null;
  const winKeys = {};
  if (table.status === 'done' && table.playerEval && Array.isArray(table.playerEval.cards)) {
    for (const c of table.playerEval.cards) winKeys[cardKey(c)] = true;
  }
  return {
    game: '포커',
    status: table.status,
    street: table.street,
    streetName: STREET_KO[table.street] || table.street,
    mood: (MOODS[table.moodId] || MOODS.tight).name,
    moodId: table.moodId,
    unit: unit.toString(),
    pot: potOf(table).toString(),
    playerCommitted: toBig(table.playerCommitted).toString(),
    dealerCommitted: toBig(table.dealerCommitted).toString(),
    player: table.player.map(formatCard),
    dealer: hide ? ['🂠', '🂠'] : table.dealer.map(formatCard),
    board: table.board.map(formatCard),
    playerViews: table.player.map(cardView),
    dealerViews: hide ? [{ t: '🂠', c: 'black', k: 'h1' }, { t: '🂠', c: 'black', k: 'h2' }] : table.dealer.map(cardView),
    boardViews: table.board.map(cardView),
    winKeys: Object.keys(winKeys),
    facingBet: facing,
    toAct: table.toAct,
    callAmount: facing ? need.toString() : '0',
    betAmount: unit.toString(),
    allinAmount: cashLeft.toString(),
    can: {
      fold: playing,
      check: playing && !facing,
      call: playing && facing && cashLeft >= need,
      bet: playing && !facing && cashLeft >= unit,
      allin: playing && cashLeft > 0n
    },
    playerHand: pEval && pEval.cat >= 0 ? pEval.name : '',
    dealerHand: (!hide && table.dealerEval) ? table.dealerEval.name : '',
    handRank: table.playerEval ? handRankOf(table.playerEval) : '',
    outcome: table.outcome || null,
    message: table.lastLine,
    royal: !!(table.outcome === 'win' && table.playerEval && table.playerEval.cat === 9)
  };
}

function settleAmounts(table) {
  const playerCommitted = toBig(table.playerCommitted);
  const pot = potOf(table);
  if (table.outcome === 'win') {
    return { payout: pot, profit: pot - playerCommitted, isWin: true, isTie: false };
  }
  if (table.outcome === 'tie') {
    return { payout: playerCommitted, profit: 0n, isWin: false, isTie: true };
  }
  return { payout: 0n, profit: -playerCommitted, isWin: false, isTie: false };
}

function logDetails(table) {
  return {
    street: table.street,
    player: table.player,
    dealer: table.dealer,
    board: table.board,
    playerHand: table.playerEval ? table.playerEval.name : '',
    dealerHand: table.dealerEval ? table.dealerEval.name : '',
    handRank: table.playerEval ? handRankOf(table.playerEval) : '',
    mood: table.moodId,
    outcome: table.outcome || null
  };
}

module.exports = {
  SUITS,
  HAND_NAMES,
  STREET_KO,
  MOODS,
  formatCard,
  cardColor,
  cardKey,
  cardView,
  makeDeck,
  combinations,
  evaluate5,
  bestHand,
  compareEval,
  createHand,
  applyPlayerAction,
  publicState,
  settleAmounts,
  potOf,
  toBig,
  hydrate,
  cloneTable,
  serializeTable,
  logDetails,
  callAmountOf
};
