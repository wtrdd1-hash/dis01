/**
 * 한국형 세븐포커 (7카드 스터드) vs 딜러.
 * 3스트리트(2장 숨김+1장 오픈) 후 4·5·6 오픈, 7번째는 숨김.
 * 최선 5장 족보, 팟 승자 전액.
 */
const poker = require('./pokerEngine');

const STREET_KO = {
  third: '3스트리트',
  fourth: '4스트리트',
  fifth: '5스트리트',
  sixth: '6스트리트',
  seventh: '7스트리트',
  showdown: '쇼다운'
};
const GAME_NAME = '세븐포커';

function toBig(v) { return poker.toBig(v); }
function potOf(table) { return toBig(table.playerCommitted) + toBig(table.dealerCommitted); }
function callAmountOf(table) {
  const n = toBig(table.pendingCall);
  return n > 0n ? n : toBig(table.unit);
}

function allCards(hole, up) {
  return (hole || []).concat(up || []);
}

function layoutViews(hole, up, hideHole) {
  const holeViews = (hole || []).map((c, i) => {
    if (hideHole) return { t: '🂠', c: 'black', k: 'h' + i, d: true };
    return Object.assign(poker.cardView(c), { d: true });
  });
  const upViews = (up || []).map((c) => Object.assign(poker.cardView(c), { d: false }));
  return holeViews.slice(0, 2).concat(upViews, holeViews.slice(2));
}

function padSlots(views) {
  const out = views.slice();
  while (out.length < 7) {
    out.push({ t: '·', c: 'black', k: 'e' + out.length, empty: true });
  }
  return out;
}

function studStrength(hole, up) {
  const cards = allCards(hole, up);
  if (cards.length >= 5) {
    const ev = poker.bestHand(cards);
    const k0 = (ev.kickers[0] || 2) - 2;
    return Math.max(0.04, Math.min(0.99, (ev.cat + k0 / 12) / 10));
  }
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const maxN = Math.max(0, ...Object.values(counts));
  const hi = ranks[0] || 2;
  if (maxN >= 3) return 0.62 + (hi - 2) / 12 * 0.2;
  if (maxN === 2) return 0.38 + (hi - 2) / 12 * 0.22;
  const suited = cards.length >= 2 && cards.every((c) => c.s === cards[0].s);
  let s = 0.08 + (hi - 2) / 12 * 0.28;
  if (suited) s += 0.05;
  return Math.max(0.04, Math.min(0.72, s));
}

function pickMood() {
  const keys = Object.keys(poker.MOODS);
  return poker.MOODS[keys[Math.floor(Math.random() * keys.length)]];
}

function noisy(mood, value) {
  return value + (Math.random() * 2 - 1) * mood.noise;
}

function createHand(unitRaw) {
  const unit = toBig(unitRaw);
  const deck = poker.makeDeck();
  const playerHole = [deck.pop(), deck.pop()];
  const dealerHole = [deck.pop(), deck.pop()];
  const playerUp = [deck.pop()];
  const dealerUp = [deck.pop()];
  const mood = pickMood();
  return {
    deck,
    playerHole,
    dealerHole,
    playerUp,
    dealerUp,
    street: 'third',
    toAct: 'player',
    facingBet: false,
    unit,
    playerCommitted: unit,
    dealerCommitted: unit,
    pendingCall: 0n,
    moodId: mood.id,
    status: 'playing',
    lastLine: mood.name + ' 딜러. 3스트리트입니다.',
    updatedAt: Date.now()
  };
}

function dealUp(table) {
  table.playerUp.push(table.deck.pop());
  table.dealerUp.push(table.deck.pop());
}

function dealRiver(table) {
  table.playerHole.push(table.deck.pop());
  table.dealerHole.push(table.deck.pop());
}

function nextStreet(table) {
  if (table.street === 'third') {
    dealUp(table);
    table.street = 'fourth';
    table.lastLine = '4스트리트';
  } else if (table.street === 'fourth') {
    dealUp(table);
    table.street = 'fifth';
    table.lastLine = '5스트리트';
  } else if (table.street === 'fifth') {
    dealUp(table);
    table.street = 'sixth';
    table.lastLine = '6스트리트';
  } else if (table.street === 'sixth') {
    dealRiver(table);
    table.street = 'seventh';
    table.lastLine = '7스트리트';
  } else {
    return showdown(table);
  }
  table.facingBet = false;
  table.pendingCall = 0n;
  table.toAct = 'player';
  return { done: false };
}

function runout(table) {
  while (table.status === 'playing' && table.street !== 'seventh') {
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
  const p = poker.bestHand(allCards(table.playerHole, table.playerUp));
  const d = poker.bestHand(allCards(table.dealerHole, table.dealerUp));
  const cmp = poker.compareEval(p, d);
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
  const mood = poker.MOODS[table.moodId] || poker.MOODS.tight;
  const s = noisy(mood, studStrength(table.dealerHole, table.dealerUp));
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
  const mood = poker.MOODS[table.moodId] || poker.MOODS.tight;
  const s = noisy(mood, studStrength(table.dealerHole, table.dealerUp));
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
    const err = new Error('진행 중인 세븐포커가 없습니다.');
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
  const pCards = allCards(table.playerHole, table.playerUp);
  const pEval = pCards.length >= 5 ? poker.bestHand(pCards) : null;
  const winKeys = {};
  if (table.status === 'done' && table.playerEval && Array.isArray(table.playerEval.cards)) {
    for (const c of table.playerEval.cards) winKeys[poker.cardKey(c)] = true;
  }
  const playerViews = padSlots(layoutViews(table.playerHole, table.playerUp, false));
  const dealerViews = padSlots(layoutViews(table.dealerHole, table.dealerUp, hide));
  return {
    game: GAME_NAME,
    status: table.status,
    street: table.street,
    streetName: STREET_KO[table.street] || table.street,
    mood: (poker.MOODS[table.moodId] || poker.MOODS.tight).name,
    moodId: table.moodId,
    unit: unit.toString(),
    pot: potOf(table).toString(),
    playerCommitted: toBig(table.playerCommitted).toString(),
    dealerCommitted: toBig(table.dealerCommitted).toString(),
    player: playerViews.map((v) => v.t),
    dealer: dealerViews.map((v) => v.t),
    playerViews,
    dealerViews,
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
  return poker.settleAmounts(table);
}

function logDetails(table) {
  return {
    street: table.street,
    playerHole: table.playerHole,
    playerUp: table.playerUp,
    dealerHole: table.dealerHole,
    dealerUp: table.dealerUp,
    playerHand: table.playerEval ? table.playerEval.name : '',
    dealerHand: table.dealerEval ? table.dealerEval.name : '',
    handRank: table.playerEval ? handRankOf(table.playerEval) : '',
    mood: table.moodId,
    outcome: table.outcome || null
  };
}

module.exports = {
  GAME_NAME,
  STREET_KO,
  createHand,
  applyPlayerAction,
  publicState,
  settleAmounts,
  logDetails,
  toBig,
  potOf,
  hydrate: poker.hydrate,
  cloneTable: poker.cloneTable
};
