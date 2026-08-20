/**
 * 가상 토토 경기 생성·자동 정산
 */
const { pool } = require('../config/database');
const { safeBigInt, parseBetAmount, computePayout, withUserLock, applyCashDelta, getUserCash, casinoTooSmallMessage } = require('./money');
const { formatMoney } = require('./formatters');
const { ensureCasinoTables, afterCasinoSettle } = require('./casinoLoop');
const { getOrCreateUser } = require('../config/database');
const { totoCall } = require('./gameShow');

const SPORTS = [
  {
    id: '축구',
    pairs: [
      ['서울FC', '부산유나이티드'], ['인천타이거', '대구윙즈'],
      ['수원블루', '전주그린'], ['울산호랑이', '광주썬']
    ]
  },
  {
    id: '농구',
    pairs: [
      ['한강나이츠', '한라빅스'], ['낙동독스', '백두베어스'],
      ['한라썬스', '동해웨이브']
    ]
  },
  {
    id: '롤',
    pairs: [
      ['월덕즈', '네코킹즈'], ['스크랩GC', '치킨스'],
      ['마인크루', '슬롯팩']
    ]
  },
  {
    id: '발로란트',
    pairs: [
      ['바이퍼즈', '제트윙'], ['레이나', '세이지']
    ]
  }
];

let started = false;

function randOdds() {
  const home = Math.round((1.55 + Math.random() * 1.6) * 100) / 100;
  const away = Math.round((1.55 + Math.random() * 1.6) * 100) / 100;
  const draw = Math.round((2.6 + Math.random() * 1.4) * 100) / 100;
  return { home, draw, away };
}

function pickResult(oddsHome, oddsDraw, oddsAway) {
  const wHome = 1 / Number(oddsHome);
  const wDraw = 1 / Number(oddsDraw);
  const wAway = 1 / Number(oddsAway);
  const t = wHome + wDraw + wAway;
  const r = Math.random() * t;
  if (r < wHome) return 'home';
  if (r < wHome + wDraw) return 'draw';
  return 'away';
}

async function fillOpenMatches() {
  await ensureCasinoTables();
  const [open] = await pool.query("SELECT COUNT(*) AS c FROM toto_matches WHERE status = 'open'");
  const need = Math.max(0, 6 - Number(open[0].c || 0));
  for (let i = 0; i < need; i++) {
    const sport = SPORTS[Math.floor(Math.random() * SPORTS.length)];
    const pair = sport.pairs[Math.floor(Math.random() * sport.pairs.length)];
    const odds = randOdds();
    const life = 90 + Math.floor(Math.random() * 90);
    await pool.query(`
      INSERT INTO toto_matches (sport, home_name, away_name, odds_home, odds_draw, odds_away, status, settle_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', DATE_ADD(NOW(), INTERVAL ? SECOND))
    `, [sport.id, pair[0], pair[1], odds.home, odds.draw, odds.away, life]);
  }
}

async function settleDueMatches() {
  await ensureCasinoTables();
  const [due] = await pool.query("SELECT * FROM toto_matches WHERE status = 'open' AND settle_at <= NOW()");
  for (const match of due) {
    const result = pickResult(match.odds_home, match.odds_draw, match.odds_away);
    await pool.query('UPDATE toto_matches SET status = ?, result = ? WHERE id = ?', ['settled', result, match.id]);
    const [tickets] = await pool.query("SELECT * FROM toto_tickets WHERE match_id = ? AND status = 'open'", [match.id]);
    for (const ticket of tickets) {
      const won = ticket.pick === result;
      const odds = result === 'home' ? match.odds_home : result === 'draw' ? match.odds_draw : match.odds_away;
      const bet = safeBigInt(ticket.amount);
      const payout = won ? computePayout(bet, Number(odds)) : 0n;
      const profit = payout - bet;
      await withUserLock(ticket.user_id, async () => {
        const before = await getUserCash(ticket.user_id);
        let newCash = before;
        if (payout > 0n) newCash = await applyCashDelta(ticket.user_id, payout);
        await pool.query(
          'UPDATE toto_tickets SET status = ?, payout = ? WHERE id = ?',
          [won ? 'won' : 'lost', payout.toString(), ticket.id]
        );
        try {
          await pool.query(`
            INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            ticket.user_id, '토토', bet.toString(), payout.toString(), profit.toString(),
            before.toString(), newCash.toString(),
            JSON.stringify({ matchId: match.id, pick: ticket.pick, result, odds: Number(odds) })
          ]);
        } catch (e) {}
        let username = '';
        try {
          const u = await getOrCreateUser(ticket.user_id);
          username = u.username || '';
        } catch (e) {}
        await afterCasinoSettle({
          userId: ticket.user_id,
          username,
          game: '토토',
          bet,
          payout,
          profit,
          isWin: won,
          isTie: false,
          multiplier: won ? Number(odds) : 0,
          newCash,
          details: { matchId: match.id, result }
        });
      }).catch((err) => console.error('[toto] 정산 실패', err.message));
    }
  }
}

async function listOpenMatches() {
  await ensureCasinoTables();
  const [rows] = await pool.query(
    "SELECT * FROM toto_matches WHERE status IN ('open','settled') ORDER BY id DESC LIMIT 12"
  );
  return rows.map((m) => {
    const remainSec = m.status === 'open'
      ? Math.max(0, Math.floor((new Date(m.settle_at).getTime() - Date.now()) / 1000))
      : 0;
    const match = {
      id: m.id,
      sport: m.sport,
      home: m.home_name,
      away: m.away_name,
      oddsHome: Number(m.odds_home),
      oddsDraw: Number(m.odds_draw),
      oddsAway: Number(m.odds_away),
      status: m.status,
      result: m.result,
      settleAt: m.settle_at,
      remainSec
    };
    match.call = totoCall(match);
    return match;
  });
}

async function placeTotoBet(session, matchId, pick, rawBet) {
  const allowed = ['home', 'draw', 'away'];
  if (!allowed.includes(pick)) {
    const err = new Error('home / draw / away 중 하나를 고르세요.');
    err.status = 400;
    throw err;
  }
  return withUserLock(session.id, async () => {
    const [matches] = await pool.query('SELECT * FROM toto_matches WHERE id = ?', [matchId]);
    if (!matches.length || matches[0].status !== 'open') {
      const err = new Error('이미 마감된 경기입니다.');
      err.status = 400;
      throw err;
    }
    const user = await getOrCreateUser(session.id, session.username, session.avatar);
    const cash = safeBigInt(user.cash);
    const bet = parseBetAmount(rawBet, cash, 1000n);
    const tooSmall = casinoTooSmallMessage(rawBet, cash, bet);
    if (tooSmall) {
      const err = new Error(tooSmall);
      err.status = 400;
      throw err;
    }
    if (cash < bet) {
      const err = new Error(`현금이 부족합니다. (보유 ${formatMoney(cash)})`);
      err.status = 400;
      throw err;
    }
    const newCash = await applyCashDelta(session.id, -bet);
    await pool.query(
      'INSERT INTO toto_tickets (user_id, match_id, pick, amount, status) VALUES (?, ?, ?, ?, ?)',
      [session.id, matchId, pick, bet.toString(), 'open']
    );
    return {
      success: true,
      matchId,
      pick,
      bet: bet.toString(),
      newCash: newCash.toString(),
      message: `${matches[0].home_name} vs ${matches[0].away_name} 배팅 완료`
    };
  });
}

async function forceSettleMatch(matchId, result) {
  const allowed = ['home', 'draw', 'away'];
  if (result && !allowed.includes(result)) {
    const err = new Error('결과는 home / draw / away 입니다.');
    err.status = 400;
    throw err;
  }
  const [rows] = await pool.query('SELECT * FROM toto_matches WHERE id = ?', [matchId]);
  if (!rows.length) {
    const err = new Error('경기가 없습니다.');
    err.status = 404;
    throw err;
  }
  if (rows[0].status !== 'open') {
    const err = new Error('이미 정산된 경기입니다.');
    err.status = 400;
    throw err;
  }
  await pool.query('UPDATE toto_matches SET settle_at = NOW() WHERE id = ?', [matchId]);
  if (result) {
    // settleDueMatches 가 랜덤으로 덮지 않게 바로 지정
    await pool.query("UPDATE toto_matches SET status = 'open', result = NULL WHERE id = ?", [matchId]);
    const match = rows[0];
    match.result = result;
    await pool.query('UPDATE toto_matches SET status = ?, result = ? WHERE id = ?', ['settled', result, matchId]);
    const [tickets] = await pool.query("SELECT * FROM toto_tickets WHERE match_id = ? AND status = 'open'", [matchId]);
    for (const ticket of tickets) {
      const won = ticket.pick === result;
      const odds = result === 'home' ? match.odds_home : result === 'draw' ? match.odds_draw : match.odds_away;
      const bet = safeBigInt(ticket.amount);
      const payout = won ? computePayout(bet, Number(odds)) : 0n;
      const profit = payout - bet;
      await withUserLock(ticket.user_id, async () => {
        const before = await getUserCash(ticket.user_id);
        let newCash = before;
        if (payout > 0n) newCash = await applyCashDelta(ticket.user_id, payout);
        await pool.query('UPDATE toto_tickets SET status = ?, payout = ? WHERE id = ?', [won ? 'won' : 'lost', payout.toString(), ticket.id]);
        try {
          await pool.query(`
            INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [ticket.user_id, '토토', bet.toString(), payout.toString(), profit.toString(), before.toString(), newCash.toString(), JSON.stringify({ matchId, pick: ticket.pick, result, forced: true })]);
        } catch (e) {}
        await afterCasinoSettle({
          userId: ticket.user_id, username: '', game: '토토', bet, payout, profit, isWin: won, isTie: false, multiplier: won ? Number(odds) : 0, newCash, details: { matchId, result }
        });
      }).catch(() => {});
    }
    return { id: matchId, result };
  }
  await settleDueMatches();
  return { id: matchId, result: 'auto' };
}

function startTotoEngine() {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      await settleDueMatches();
      await fillOpenMatches();
    } catch (e) {
      console.error('[toto] 엔진', e.message);
    }
  };
  tick();
  setInterval(tick, 15000).unref();
}

module.exports = {
  startTotoEngine,
  listOpenMatches,
  placeTotoBet,
  forceSettleMatch,
  fillOpenMatches,
  settleDueMatches
};
