/**
 * 🎰 카지노 & 미니게임 라우트 모듈 (슬롯, 동전, 주사위, 복권, 경마)
 */
const express = require('express');
const { pool, getOrCreateUser } = require('../../config/database');
const { formatMoney } = require('../../utils/formatters');
const { parseBetAmount, computePayout, withUserLock, applyCashDelta, safeBigInt, getUserCash, casinoTooSmallMessage } = require('../../utils/money');
const { sendPublicError } = require('../httpSafe');
const {
  openAndHoldBet,
  updateSession,
  claimSession,
  refundUser
} = require('../../utils/blackjackStore');
const pokerStore = require('../../utils/pokerStore');
const pokerEngine = require('../../utils/pokerEngine');
const sevenPokerStore = require('../../utils/sevenPokerStore');
const sevenPokerEngine = require('../../utils/sevenPokerEngine');
const {
  spinSlot,
  scratchLottery,
  flipCoin,
  COIN_WIN_MULT,
  DICE_WIN_MULT,
  scaleGambleMultiplier,
  spinRoulette,
  rollHighLow,
  createBlackjackDeck,
  blackjackScore,
  formatBlackjackCard,
  dealerPlayBlackjack
} = require('../../utils/economyBalance');
const { afterCasinoSettle } = require('../../utils/casinoLoop');
const { runHorseRace, publicRaceCard, publicHorse, validateHorseBet } = require('../../utils/horseRace');
const {
  slotFlavor,
  coinFlavor,
  diceFlavor,
  lotteryFlavor,
  rouletteFlavor,
  highlowFlavor
} = require('../../utils/gameShow');

const blackjackTables = new Map();
const pokerTables = new Map();
const sevenPokerTables = new Map();
const BJ_TTL_MS = 15 * 60 * 1000;
const PK_TTL_MS = 15 * 60 * 1000;

function isBlackjackExpired(table) {
  return Date.now() - (table.updatedAt || 0) > BJ_TTL_MS;
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, table] of blackjackTables.entries()) {
    if (!table || table.status !== 'playing') {
      blackjackTables.delete(userId);
      continue;
    }
    if (now - (table.updatedAt || 0) <= BJ_TTL_MS) continue;
    withUserLock(userId, async () => {
      const current = blackjackTables.get(userId);
      if (!current || current.status !== 'playing') return;
      if (!isBlackjackExpired(current)) return;
      blackjackTables.delete(userId);
      await refundUser(userId, 'ttl');
    }).catch((err) => {
      console.error('[blackjack] 만료 환불 실패:', err);
    });
  }
}, 60 * 1000).unref();

function isPokerExpired(table) {
  return Date.now() - (table.updatedAt || 0) > PK_TTL_MS;
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, table] of pokerTables.entries()) {
    if (!table || table.status !== 'playing') {
      pokerTables.delete(userId);
      continue;
    }
    if (now - (table.updatedAt || 0) <= PK_TTL_MS) continue;
    withUserLock(userId, async () => {
      const current = pokerTables.get(userId);
      if (!current || current.status !== 'playing') return;
      if (!isPokerExpired(current)) return;
      pokerTables.delete(userId);
      await pokerStore.refundUser(userId, 'ttl');
    }).catch((err) => {
      console.error('[poker] 만료 환불 실패:', err);
    });
  }
}, 60 * 1000).unref();

function isSevenPokerExpired(table) {
  return Date.now() - (table.updatedAt || 0) > PK_TTL_MS;
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, table] of sevenPokerTables.entries()) {
    if (!table || table.status !== 'playing') {
      sevenPokerTables.delete(userId);
      continue;
    }
    if (now - (table.updatedAt || 0) <= PK_TTL_MS) continue;
    withUserLock(userId, async () => {
      const current = sevenPokerTables.get(userId);
      if (!current || current.status !== 'playing') return;
      if (!isSevenPokerExpired(current)) return;
      sevenPokerTables.delete(userId);
      await sevenPokerStore.refundUser(userId, 'ttl');
    }).catch((err) => {
      console.error('[seven-poker] 만료 환불 실패:', err);
    });
  }
}, 60 * 1000).unref();

function createGameRoutes(getSessionUser) {
  const router = express.Router();

  async function settleGame(session, rawBet, defaultBet, playFn) {
    return withUserLock(session.id, async () => {
      const { assertLoanPlayAllowed } = require('../../utils/loanEngine');
      await assertLoanPlayAllowed(session.id);
      const userData = await getOrCreateUser(session.id, session.username, session.avatar);
      const userCash = safeBigInt(userData.cash);
      const betAmount = parseBetAmount(rawBet, userCash, defaultBet);
      const tooSmall = casinoTooSmallMessage(rawBet, userCash, betAmount);
      if (tooSmall) {
        const err = new Error(tooSmall);
        err.status = 400;
        throw err;
      }
      if (userCash < betAmount) {
        const err = new Error(`보유 현금이 부족합니다! (필요: ${formatMoney(betAmount)}, 보유: ${formatMoney(userCash)})`);
        err.status = 400;
        throw err;
      }

      const outcome = playFn(betAmount);
      const multiplier = outcome.skipPayoutScale
        ? (Number(outcome.multiplier) || 0)
        : scaleGambleMultiplier(outcome.multiplier);
      const payout = computePayout(betAmount, multiplier);
      const profit = payout - betAmount;
      const newCash = await applyCashDelta(session.id, profit);

      try {
        await pool.query(`
          INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          session.id,
          outcome.game,
          betAmount.toString(),
          payout.toString(),
          profit.toString(),
          userCash.toString(),
          newCash.toString(),
          JSON.stringify(outcome.details || {})
        ]);
      } catch (e) {}

      const loop = await afterCasinoSettle({
        userId: session.id,
        username: session.username,
        game: outcome.game,
        bet: betAmount,
        payout,
        profit,
        isWin: outcome.isWin,
        isTie: outcome.isTie || false,
        multiplier,
        newCash,
        details: outcome.details || {}
      });

      return {
        ...outcome.payload,
        success: true,
        isWin: outcome.isWin,
        isTie: outcome.isTie || false,
        multiplier,
        payout: payout.toString(),
        profit: profit.toString(),
        newCash: loop.newCash || newCash.toString(),
        message: outcome.message,
        extraPayout: loop.extraPayout,
        jackpotHit: loop.jackpotHit,
        happyHour: loop.happyHour,
        winStreak: loop.winStreak,
        nearMiss: loop.nearMiss,
        displayReels: loop.displayReels,
        loop: loop.loop
      };
    });
  }

  router.post('/slot', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await settleGame(session, req.body?.bet, 1000n, (betAmount) => {
        const spun = spinSlot();
        const [s1, s2, s3] = spun.reels;
        const flavor = slotFlavor(spun.reels, spun.multiplier, spun.isWin);
        return {
          game: '슬롯머신',
          multiplier: spun.multiplier,
          isWin: spun.isWin,
          details: { slots: spun.reels, multiplier: spun.multiplier },
          payload: { slots: spun.reels, reels: spun.reels, flavor },
          message: spun.isWin
            ? `🎉 슬롯머신 적중! [${s1} | ${s2} | ${s3}] (${spun.multiplier}배) +${formatMoney(computePayout(betAmount, spun.multiplier))} 획득!`
            : `💀 슬롯머신 꽝! [${s1} | ${s2} | ${s3}] -${formatMoney(betAmount)}`
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/plinko', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });
    try {
      const risk = String(req.body?.risk || 'medium');
      const mults = (risk === 'high' || risk === 'hi')
        ? [55.0, 15.0, 6.0, 2.2, 0.7, 0.4, 0.3, 0.4, 0.7, 2.2, 6.0, 15.0, 55.0]
        : (risk === 'low' || risk === 'lo')
        ? [8.8, 4.0, 2.5, 1.4, 1.1, 0.8, 0.7, 0.8, 1.1, 1.4, 2.5, 4.0, 8.8]
        : [24.0, 8.0, 4.5, 1.8, 0.9, 0.6, 0.5, 0.6, 0.9, 1.8, 4.5, 8.0, 24.0];
      const slotIndex = Math.floor(Math.random() * mults.length);
      const mult = mults[slotIndex];

      const data = await settleGame(session, req.body?.bet || req.body?.amount, 1000n, (betAmount) => {
        const isWin = mult >= 1.0;
        return {
          game: '플링코',
          multiplier: mult,
          isWin,
          details: { slotIndex, multiplier: mult, risk },
          payload: { slotIndex, multiplier: mult, risk },
          message: isWin
            ? `🔴 플링코 적중! [슬롯 ${slotIndex + 1}] (${mult}배) +${formatMoney(computePayout(betAmount, mult))}`
            : `🔴 플링코 불발 [슬롯 ${slotIndex + 1}] (${mult}배) -${formatMoney(betAmount)}`
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/mines/cashout', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });
    try {
      const mult = Math.max(1.0, Number(req.body?.multiplier) || 1.0);
      const data = await settleGame(session, req.body?.bet || req.body?.amount, 1000n, (betAmount) => {
        return {
          game: '마인즈5x5',
          multiplier: mult,
          isWin: true,
          details: { multiplier: mult },
          payload: { multiplier: mult },
          message: `💣 마인즈 캐시아웃 성공! (${mult}배) +${formatMoney(computePayout(betAmount, mult))}`
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/coinflip', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const rawChoice = req.body?.choice;
      const choice = (rawChoice === 'front' || rawChoice === '앞면' || rawChoice === '앞') ? '앞' : '뒤';
      const data = await settleGame(session, req.body?.bet, 1000n, (betAmount) => {
        const flipped = flipCoin(choice);
        const result = flipped.outcome;
        const isWin = flipped.won;
        const multiplier = isWin ? COIN_WIN_MULT : 0;
        const profit = isWin ? (computePayout(betAmount, multiplier) - betAmount) : -betAmount;
        const flavor = coinFlavor(choice, result, isWin);
        return {
          game: '동전뒤집기',
          multiplier,
          isWin,
          details: { choice, result, isWin },
          payload: { result, coinResult: result, flavor, outcome: result },
          message: isWin
            ? `🎉 동전 적중! [${result}] (+${formatMoney(profit)})`
            : `💀 동전 실패! [${result}] (-${formatMoney(betAmount)})`
        };
      });
      return res.json(data);
    } catch (err) {
      console.error('❌ [/api/game/coinflip] 동전뒤집기 오류:', err);
      return sendPublicError(res, err);
    }
  });

  router.post('/dice', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await settleGame(session, req.body?.bet, 1000n, (betAmount) => {
        const u1 = Math.floor(Math.random() * 6) + 1;
        const u2 = Math.floor(Math.random() * 6) + 1;
        const b1 = Math.floor(Math.random() * 6) + 1;
        const b2 = Math.floor(Math.random() * 6) + 1;
        const userTotal = u1 + u2;
        const botTotal = b1 + b2;

        let multiplier = 0;
        let resultText = '';
        const isWin = userTotal > botTotal;
        const isTie = userTotal === botTotal;
        if (isWin) {
          multiplier = DICE_WIN_MULT;
          resultText = `🎉 승리! 나(${userTotal}) vs 딜러(${botTotal}) (+${formatMoney(computePayout(betAmount, DICE_WIN_MULT - 1))})`;
        } else if (isTie) {
          multiplier = 1;
          resultText = `🤝 무승부! 나(${userTotal}) vs 딜러(${botTotal}) (배팅금 전액 환불)`;
        } else {
          resultText = `💀 패배! 나(${userTotal}) vs 딜러(${botTotal}) (-${formatMoney(betAmount)})`;
        }
        const flavor = diceFlavor(userTotal, botTotal, isWin, isTie);

        return {
          game: '주사위대결',
          multiplier,
          isWin,
          isTie,
          details: { userDice: [u1, u2], botDice: [b1, b2], userTotal, botTotal },
          payload: { userDice: [u1, u2], botDice: [b1, b2], userTotal, botTotal, flavor },
          message: resultText
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/lottery', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await settleGame(session, req.body?.bet, 1000n, (betAmount) => {
        const scratched = scratchLottery();
        const [r1, r2, r3] = scratched.symbols;
        const flavor = lotteryFlavor(scratched.symbols, scratched.multiplier, scratched.isWin);
        return {
          game: '즉석복권',
          multiplier: scratched.multiplier,
          isWin: scratched.isWin,
          symbols: scratched.symbols,
          displayReels: scratched.symbols,
          details: { symbols: scratched.symbols, multiplier: scratched.multiplier },
          payload: { symbols: scratched.symbols, displayReels: scratched.symbols, flavor },
          message: scratched.isWin
            ? `🎉 복권 당첨! [${r1} | ${r2} | ${r3}] (${scratched.multiplier}배) +${formatMoney(computePayout(betAmount, scratched.multiplier))}!`
            : `💀 복권 꽝! [${r1} | ${r2} | ${r3}] -${formatMoney(betAmount)}`
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.get('/horse-card', (req, res) => {
    return res.json({ success: true, ...publicRaceCard() });
  });

  router.post('/horse-race', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const picked = validateHorseBet({
        mode: req.body?.mode,
        horseId: req.body?.horseId,
        horseId2: req.body?.horseId2
      });
      if (picked.error) {
        return res.status(400).json({ success: false, error: picked.error });
      }

      const data = await settleGame(session, req.body?.amount ?? req.body?.bet, 1000n, (betAmount) => {
        const raced = runHorseRace({
          mode: req.body?.mode,
          horseId: req.body?.horseId,
          horseId2: req.body?.horseId2
        });
        if (raced.error) {
          const err = new Error(raced.error);
          err.status = 400;
          throw err;
        }
        const rankingPublic = raced.ranking.map((h, idx) => ({
          ...publicHorse(h),
          place: idx + 1
        }));
        return {
          game: '월덕경마',
          skipPayoutScale: true,
          multiplier: raced.isWin ? raced.multiplier : 0,
          isWin: raced.isWin,
          details: {
            mode: raced.mode,
            modeName: raced.modeName,
            condition: raced.card.condition.id,
            chosen: raced.pick1.displayName,
            chosen2: raced.pick2 ? raced.pick2.displayName : null,
            winner: raced.ranking[0].displayName,
            second: raced.ranking[1].displayName,
            third: raced.ranking[2].displayName,
            isWin: raced.isWin,
            odds: raced.multiplier
          },
          payload: {
            mode: raced.mode,
            modeName: raced.modeName,
            condition: publicRaceCard(raced.card).condition,
            ranking: rankingPublic,
            chosenHorse: publicHorse(raced.pick1),
            chosenHorse2: raced.pick2 ? publicHorse(raced.pick2) : null,
            winner: publicHorse(raced.ranking[0]),
            second: publicHorse(raced.ranking[1]),
            third: publicHorse(raced.ranking[2]),
            odds: raced.multiplier,
            flavor: raced.flavor,
            bet: betAmount.toString()
          },
          message: raced.isWin
            ? `🎉 ${raced.modeName} 적중! ${raced.multiplier}배`
            : `${raced.modeName} 불발 · 1착 ${raced.ranking[0].displayName}`
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/roulette', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const choice = String(req.body?.color || '').toUpperCase();
      if (!['RED', 'BLACK', 'GREEN'].includes(choice)) {
        return res.status(400).json({ success: false, error: 'RED, BLACK, GREEN 중 하나를 고르세요.' });
      }
      const data = await settleGame(session, req.body?.bet, 1000n, () => {
        const spun = spinRoulette(choice);
        const isWin = choice === spun.color;
        const flavor = rouletteFlavor(choice, spun.color, spun.emoji, isWin);
        return {
          game: '룰렛',
          multiplier: isWin ? spun.winMult : 0,
          isWin,
          details: { choice, result: spun.color },
          payload: { result: spun.color, emoji: spun.emoji, flavor, choice },
          message: isWin
            ? `적중 ${spun.emoji} (${spun.winMult}배)`
            : `빗나감 ${spun.emoji}`
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/highlow', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await settleGame(session, req.body?.bet, 1000n, () => {
        const rolled = rollHighLow();
        const flavor = highlowFlavor(rolled.roll, rolled.multiplier, rolled.isWin);
        return {
          game: '하이로우',
          multiplier: rolled.multiplier,
          isWin: rolled.isWin,
          details: { roll: rolled.roll, multiplier: rolled.multiplier },
          payload: { roll: rolled.roll, flavor },
          message: rolled.isWin
            ? `${rolled.roll} — ${rolled.multiplier}배`
            : `${rolled.roll} — 꽝`
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  function publicBjState(table, hideDealer) {
    return {
      player: table.player.map(formatBlackjackCard),
      dealer: hideDealer
        ? [formatBlackjackCard(table.dealer[0]), '🂠']
        : table.dealer.map(formatBlackjackCard),
      playerScore: blackjackScore(table.player),
      dealerScore: hideDealer ? blackjackScore([table.dealer[0]]) : blackjackScore(table.dealer),
      status: table.status
    };
  }

  async function settleBlackjack(session, table, multiplier, message) {
    const betAmount = table.bet;
    const scaled = multiplier > 0 ? scaleGambleMultiplier(multiplier) : 0;
    const payout = computePayout(betAmount, scaled);
    const claimed = await claimSession(session.id, 'settled');
    table.status = 'done';
    blackjackTables.delete(session.id);
    if (!claimed) {
      const { getUserCash } = require('../../utils/money');
      const cash = await getUserCash(session.id);
      return {
        success: true,
        isWin: false,
        isTie: true,
        multiplier: 0,
        payout: '0',
        profit: '0',
        newCash: cash.toString(),
        message: '진행 중이던 블랙잭이 이미 환불되어 정산하지 않았습니다.',
        ...publicBjState(table, false)
      };
    }
    const newCash = await applyCashDelta(session.id, payout);
    const profit = payout - betAmount;
    try {
      await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        session.id,
        '블랙잭',
        betAmount.toString(),
        payout.toString(),
        profit.toString(),
        (table.balanceBefore || 0n).toString(),
        newCash.toString(),
        JSON.stringify({ player: table.player, dealer: table.dealer, multiplier: scaled })
      ]);
    } catch (e) {}
    const loop = await afterCasinoSettle({
      userId: session.id,
      username: session.username,
      game: '블랙잭',
      bet: betAmount,
      payout,
      profit,
      isWin: profit > 0n,
      isTie: profit === 0n,
      multiplier: scaled,
      newCash,
      details: { player: table.player, dealer: table.dealer }
    });
    return {
      success: true,
      isWin: profit > 0n,
      isTie: profit === 0n,
      multiplier: scaled,
      payout: payout.toString(),
      profit: profit.toString(),
      newCash: loop.newCash || newCash.toString(),
      message,
      extraPayout: loop.extraPayout,
      jackpotHit: loop.jackpotHit,
      ...publicBjState(table, false)
    };
  }

  async function requirePlayingTable(sessionId) {
    let table = blackjackTables.get(sessionId);
    if (!table || table.status !== 'playing') {
      try {
        const [rows] = await pool.query(
          'SELECT * FROM blackjack_sessions WHERE user_id = ? AND status = "playing" LIMIT 1',
          [String(sessionId)]
        );
        if (rows.length > 0 && rows[0].state_json) {
          const state = JSON.parse(rows[0].state_json);
          table = {
            deck: state.deck,
            player: state.player,
            dealer: state.dealer,
            bet: safeBigInt(rows[0].bet),
            status: 'playing',
            balanceBefore: safeBigInt(rows[0].balance_before),
            updatedAt: state.updatedAt || Date.now()
          };
          blackjackTables.set(sessionId, table);
        }
      } catch (e) {}
    }
    if (!table || table.status !== 'playing') {
      const err = new Error('진행 중인 블랙잭이 없습니다.');
      err.status = 400;
      throw err;
    }
    if (isBlackjackExpired(table)) {
      blackjackTables.delete(sessionId);
      await refundUser(sessionId, 'ttl');
      const err = new Error('블랙잭 세션이 만료되어 배팅금이 반환되었습니다.');
      err.status = 410;
      throw err;
    }
    table.updatedAt = Date.now();
    return table;
  }

  router.post('/blackjack/start', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await withUserLock(session.id, async () => {
        const { assertLoanPlayAllowed } = require('../../utils/loanEngine');
        await assertLoanPlayAllowed(session.id);
        if (blackjackTables.has(session.id)) {
          const current = blackjackTables.get(session.id);
          if (isBlackjackExpired(current)) {
            blackjackTables.delete(session.id);
            await refundUser(session.id, 'ttl');
          } else {
            const err = new Error('이미 진행 중인 블랙잭이 있습니다.');
            err.status = 409;
            throw err;
          }
        } else {
          // DB 잔존 세션 확인 (비정상 종료 세션 자동 환불 후 새 게임 허용)
          try {
            const [openRows] = await pool.query(
              'SELECT * FROM blackjack_sessions WHERE user_id = ? AND status = "playing" LIMIT 1',
              [String(session.id)]
            );
            if (openRows.length > 0) {
              await refundUser(session.id, 'stuck_session_cleanup');
            }
          } catch (e) {}
        }
        const userData = await getOrCreateUser(session.id, session.username, session.avatar);
        const userCash = safeBigInt(userData.cash);
        const betAmount = parseBetAmount(req.body?.bet, userCash, 1000n);
        const tooSmall = casinoTooSmallMessage(req.body?.bet, userCash, betAmount);
        if (tooSmall) {
          const err = new Error(tooSmall);
          err.status = 400;
          throw err;
        }
        if (userCash < betAmount) {
          const err = new Error(`보유 현금이 부족합니다! (필요: ${formatMoney(betAmount)}, 보유: ${formatMoney(userCash)})`);
          err.status = 400;
          throw err;
        }

        const deck = createBlackjackDeck();
        const player = [deck.pop(), deck.pop()];
        const dealer = [deck.pop(), deck.pop()];
        const table = { deck, player, dealer, bet: betAmount, status: 'playing', balanceBefore: userCash, updatedAt: Date.now() };
        await openAndHoldBet(session.id, 'web', betAmount, userCash, {
          player,
          dealer,
          deck,
          updatedAt: table.updatedAt
        });
        const pScore = blackjackScore(player);
        const dScore = blackjackScore(dealer);

        if (pScore === 21 && dScore === 21) {
          return settleBlackjack(session, table, 1, '양쪽 블랙잭 — 푸시');
        }
        if (pScore === 21) {
          return settleBlackjack(session, table, 2.5, '블랙잭 2.5배');
        }
        blackjackTables.set(session.id, table);
        return {
          success: true,
          ...publicBjState(table, true),
          newCash: (userCash - betAmount).toString(),
          message: '히트 또는 스탠드'
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/blackjack/hit', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await withUserLock(session.id, async () => {
        const table = await requirePlayingTable(session.id);
        table.player.push(table.deck.pop());
        await updateSession(session.id, {
          state: { player: table.player, dealer: table.dealer, deck: table.deck, updatedAt: table.updatedAt }
        });
        const score = blackjackScore(table.player);
        if (score > 21) {
          return settleBlackjack(session, table, 0, `버스트 ${score}`);
        }
        if (score === 21) {
          dealerPlayBlackjack(table.deck, table.dealer);
          const dScore = blackjackScore(table.dealer);
          if (dScore > 21 || score > dScore) return settleBlackjack(session, table, 2, `21 vs ${dScore}`);
          if (score === dScore) return settleBlackjack(session, table, 1, '푸시');
          return settleBlackjack(session, table, 0, `21 vs ${dScore}`);
        }
        return { success: true, ...publicBjState(table, true), message: `${score}점` };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/blackjack/stand', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await withUserLock(session.id, async () => {
        const table = await requirePlayingTable(session.id);
        dealerPlayBlackjack(table.deck, table.dealer);
        const pScore = blackjackScore(table.player);
        const dScore = blackjackScore(table.dealer);
        if (dScore > 21) return settleBlackjack(session, table, 2, `딜러 버스트 ${dScore}`);
        if (pScore > dScore) return settleBlackjack(session, table, 2, `${pScore} vs ${dScore}`);
        if (pScore === dScore) return settleBlackjack(session, table, 1, '푸시');
        return settleBlackjack(session, table, 0, `${pScore} vs ${dScore}`);
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  function persistPokerState(userId, table) {
    return pokerStore.updateSession(userId, { state: table });
  }

  async function restorePokerTable(userId) {
    let table = pokerTables.get(userId);
    if (table) return table;
    const row = await pokerStore.getPlaying(userId);
    if (!row) return null;
    if (!row.state_json) {
      await pokerStore.refundUser(userId, 'corrupt');
      return null;
    }
    try {
      let raw = row.state_json;
      if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
      table = pokerEngine.hydrate(raw);
      table.balanceBefore = pokerEngine.toBig(row.balance_before);
      table.updatedAt = table.updatedAt || Date.now();
      pokerTables.set(userId, table);
      return table;
    } catch (e) {
      await pokerStore.refundUser(userId, 'corrupt');
      return null;
    }
  }

  async function settlePoker(session, table) {
    const settled = pokerEngine.settleAmounts(table);
    const details = pokerEngine.logDetails(table);
    const claimed = await pokerStore.claimSession(session.id, 'settled');
    table.status = 'done';
    pokerTables.delete(session.id);
    if (!claimed) {
      const cash = await getUserCash(session.id);
      return {
        success: true,
        isWin: false,
        isTie: true,
        multiplier: 0,
        payout: '0',
        profit: '0',
        newCash: cash.toString(),
        message: '진행 중이던 포커가 이미 환불되어 정산하지 않았습니다.',
        ...pokerEngine.publicState(table, false, cash)
      };
    }
    const newCash = await applyCashDelta(session.id, settled.payout);
    try {
      await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        session.id,
        '포커',
        claimed.bet.toString(),
        settled.payout.toString(),
        settled.profit.toString(),
        (table.balanceBefore || claimed.balanceBefore || 0n).toString(),
        newCash.toString(),
        JSON.stringify(details)
      ]);
    } catch (e) {}
    const loop = await afterCasinoSettle({
      userId: session.id,
      username: session.username,
      game: '포커',
      bet: claimed.bet,
      payout: settled.payout,
      profit: settled.profit,
      isWin: settled.isWin,
      isTie: settled.isTie,
      multiplier: settled.isWin ? 2 : (settled.isTie ? 1 : 0),
      newCash,
      details
    });
    const cashLeft = pokerEngine.toBig(loop.newCash || newCash);
    return {
      success: true,
      isWin: settled.isWin,
      isTie: settled.isTie,
      multiplier: settled.isWin ? 2 : (settled.isTie ? 1 : 0),
      payout: settled.payout.toString(),
      profit: settled.profit.toString(),
      newCash: loop.newCash || newCash.toString(),
      extraPayout: loop.extraPayout,
      jackpotHit: loop.jackpotHit,
      message: table.lastLine,
      ...pokerEngine.publicState(table, false, cashLeft)
    };
  }

  router.post('/poker/start', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await withUserLock(session.id, async () => {
        const { assertLoanPlayAllowed } = require('../../utils/loanEngine');
        await assertLoanPlayAllowed(session.id);
        const existing = await restorePokerTable(session.id);
        if (existing && existing.status === 'done') {
          return settlePoker(session, existing);
        }
        if (existing && existing.status === 'playing') {
          const cash = await getUserCash(session.id);
          return {
            success: true,
            resumed: true,
            newCash: cash.toString(),
            message: existing.lastLine || '진행 중인 핸드를 이어갑니다.',
            ...pokerEngine.publicState(existing, true, cash)
          };
        }
        const userData = await getOrCreateUser(session.id, session.username, session.avatar);
        const userCash = safeBigInt(userData.cash);
        const unit = parseBetAmount(req.body?.bet, userCash, 1000n);
        if (unit < 1000n) {
          const err = new Error('최소 유닛(블라인드)은 1,000원입니다.');
          err.status = 400;
          throw err;
        }
        if (userCash < unit) {
          const err = new Error(`보유 현금이 부족합니다! (필요: ${formatMoney(unit)}, 보유: ${formatMoney(userCash)})`);
          err.status = 400;
          throw err;
        }
        const table = pokerEngine.createHand(unit);
        table.balanceBefore = userCash;
        await pokerStore.openAndHoldBet(session.id, 'web', unit, userCash, table);
        pokerTables.set(session.id, table);
        await persistPokerState(session.id, table);
        const cashLeft = userCash - unit;
        return {
          success: true,
          newCash: cashLeft.toString(),
          ...pokerEngine.publicState(table, true, cashLeft)
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/poker/act', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await withUserLock(session.id, async () => {
        const table = await restorePokerTable(session.id);
        if (!table) {
          const err = new Error('진행 중인 포커가 없습니다.');
          err.status = 400;
          throw err;
        }
        if (table.status === 'done') {
          return settlePoker(session, table);
        }
        if (isPokerExpired(table)) {
          pokerTables.delete(session.id);
          await pokerStore.refundUser(session.id, 'ttl');
          const err = new Error('포커 세션이 만료되어 배팅금이 반환되었습니다.');
          err.status = 410;
          throw err;
        }
        table.updatedAt = Date.now();
        const cashLeft = await getUserCash(session.id);
        const clone = pokerEngine.cloneTable(table);
        clone.balanceBefore = table.balanceBefore;
        const result = pokerEngine.applyPlayerAction(clone, req.body?.action, cashLeft);
        if (result.added > 0n) {
          await pokerStore.increaseBet(session.id, result.added);
        }
        clone.updatedAt = Date.now();
        pokerTables.set(session.id, clone);
        await persistPokerState(session.id, clone);
        if (result.done) {
          return settlePoker(session, clone);
        }
        const nextCash = cashLeft - result.added;
        return {
          success: true,
          message: clone.lastLine,
          ...pokerEngine.publicState(clone, true, nextCash)
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  function persistSevenPokerState(userId, table) {
    return sevenPokerStore.updateSession(userId, { state: table });
  }

  async function restoreSevenPokerTable(userId) {
    let table = sevenPokerTables.get(userId);
    if (table) return table;
    const row = await sevenPokerStore.getPlaying(userId);
    if (!row) return null;
    if (!row.state_json) {
      await sevenPokerStore.refundUser(userId, 'corrupt');
      return null;
    }
    try {
      let raw = row.state_json;
      if (Buffer.isBuffer(raw)) raw = raw.toString('utf8');
      table = sevenPokerEngine.hydrate(raw);
      table.balanceBefore = sevenPokerEngine.toBig(row.balance_before);
      table.updatedAt = table.updatedAt || Date.now();
      sevenPokerTables.set(userId, table);
      return table;
    } catch (e) {
      await sevenPokerStore.refundUser(userId, 'corrupt');
      return null;
    }
  }

  async function settleSevenPoker(session, table) {
    const settled = sevenPokerEngine.settleAmounts(table);
    const details = sevenPokerEngine.logDetails(table);
    const claimed = await sevenPokerStore.claimSession(session.id, 'settled');
    table.status = 'done';
    sevenPokerTables.delete(session.id);
    if (!claimed) {
      const cash = await getUserCash(session.id);
      return {
        success: true,
        isWin: false,
        isTie: true,
        multiplier: 0,
        payout: '0',
        profit: '0',
        newCash: cash.toString(),
        message: '진행 중이던 세븐포커가 이미 환불되어 정산하지 않았습니다.',
        ...sevenPokerEngine.publicState(table, false, cash)
      };
    }
    const newCash = await applyCashDelta(session.id, settled.payout);
    try {
      await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        session.id,
        '세븐포커',
        claimed.bet.toString(),
        settled.payout.toString(),
        settled.profit.toString(),
        (table.balanceBefore || claimed.balanceBefore || 0n).toString(),
        newCash.toString(),
        JSON.stringify(details)
      ]);
    } catch (e) {}
    const loop = await afterCasinoSettle({
      userId: session.id,
      username: session.username,
      game: '세븐포커',
      bet: claimed.bet,
      payout: settled.payout,
      profit: settled.profit,
      isWin: settled.isWin,
      isTie: settled.isTie,
      multiplier: settled.isWin ? 2 : (settled.isTie ? 1 : 0),
      newCash,
      details
    });
    const cashLeft = sevenPokerEngine.toBig(loop.newCash || newCash);
    return {
      success: true,
      isWin: settled.isWin,
      isTie: settled.isTie,
      multiplier: settled.isWin ? 2 : (settled.isTie ? 1 : 0),
      payout: settled.payout.toString(),
      profit: settled.profit.toString(),
      newCash: loop.newCash || newCash.toString(),
      extraPayout: loop.extraPayout,
      jackpotHit: loop.jackpotHit,
      message: table.lastLine,
      ...sevenPokerEngine.publicState(table, false, cashLeft)
    };
  }

  router.post('/seven-poker/start', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await withUserLock(session.id, async () => {
        const { assertLoanPlayAllowed } = require('../../utils/loanEngine');
        await assertLoanPlayAllowed(session.id);
        const existing = await restoreSevenPokerTable(session.id);
        if (existing && existing.status === 'done') {
          return settleSevenPoker(session, existing);
        }
        if (existing && existing.status === 'playing') {
          const cash = await getUserCash(session.id);
          return {
            success: true,
            resumed: true,
            newCash: cash.toString(),
            message: existing.lastLine || '진행 중인 핸드를 이어갑니다.',
            ...sevenPokerEngine.publicState(existing, true, cash)
          };
        }
        const userData = await getOrCreateUser(session.id, session.username, session.avatar);
        const userCash = safeBigInt(userData.cash);
        const unit = parseBetAmount(req.body?.bet, userCash, 1000n);
        if (unit < 1000n) {
          const err = new Error('최소 유닛(블라인드)은 1,000원입니다.');
          err.status = 400;
          throw err;
        }
        if (userCash < unit) {
          const err = new Error(`보유 현금이 부족합니다! (필요: ${formatMoney(unit)}, 보유: ${formatMoney(userCash)})`);
          err.status = 400;
          throw err;
        }
        const table = sevenPokerEngine.createHand(unit);
        table.balanceBefore = userCash;
        await sevenPokerStore.openAndHoldBet(session.id, 'web', unit, userCash, table);
        sevenPokerTables.set(session.id, table);
        await persistSevenPokerState(session.id, table);
        const cashLeft = userCash - unit;
        return {
          success: true,
          newCash: cashLeft.toString(),
          ...sevenPokerEngine.publicState(table, true, cashLeft)
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/seven-poker/act', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    try {
      const data = await withUserLock(session.id, async () => {
        const table = await restoreSevenPokerTable(session.id);
        if (!table) {
          const err = new Error('진행 중인 세븐포커가 없습니다.');
          err.status = 400;
          throw err;
        }
        if (table.status === 'done') {
          return settleSevenPoker(session, table);
        }
        if (isSevenPokerExpired(table)) {
          sevenPokerTables.delete(session.id);
          await sevenPokerStore.refundUser(session.id, 'ttl');
          const err = new Error('세븐포커 세션이 만료되어 배팅금이 반환되었습니다.');
          err.status = 410;
          throw err;
        }
        table.updatedAt = Date.now();
        const cashLeft = await getUserCash(session.id);
        const clone = sevenPokerEngine.cloneTable(table);
        clone.balanceBefore = table.balanceBefore;
        const result = sevenPokerEngine.applyPlayerAction(clone, req.body?.action, cashLeft);
        if (result.added > 0n) {
          await sevenPokerStore.increaseBet(session.id, result.added);
        }
        clone.updatedAt = Date.now();
        sevenPokerTables.set(session.id, clone);
        await persistSevenPokerState(session.id, clone);
        if (result.done) {
          return settleSevenPoker(session, clone);
        }
        const nextCash = cashLeft - result.added;
        return {
          success: true,
          message: clone.lastLine,
          ...sevenPokerEngine.publicState(clone, true, nextCash)
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  return router;
}

module.exports = { createGameRoutes };
