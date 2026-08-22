/**
 * 카지노 루프 + 핫게임 API
 */
const express = require('express');
const { getOrCreateUser } = require('../../config/database');
const { pool } = require('../../config/database');
const { formatMoney } = require('../../utils/formatters');
const { parseBetAmount, computePayout, withUserLock, applyCashDelta, safeBigInt, casinoTooSmallMessage } = require('../../utils/money');
const { sendPublicError } = require('../httpSafe');
const {
  getLoopState,
  claimMission,
  claimVipDaily,
  adminSetJackpot,
  adminSetHappyOverride,
  afterCasinoSettle,
  getPot
} = require('../../utils/casinoLoop');
const { listOpenMatches, placeTotoBet, forceSettleMatch } = require('../../utils/totoEngine');
const { publicState, placeCrashBet, cashoutCrash } = require('../../utils/crashEngine');
const { minesMultiplier, makeMineField, dropPlinko } = require('../../utils/hotGames');
const { getArcadeState, ackArcadeLevel, doRebirth, buyArcadeItem, switchArcadeWorld, listRebirthRanks } = require('../../utils/arcadeProgress');
const config = require('../../config/config');

const mineTables = new Map();

function createCasinoLoopRoutes(getSessionUser) {
  const router = express.Router();

  function requireMember(req, res) {
    const sess = getSessionUser(req);
    if (!sess) {
      res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
      return null;
    }
    if (sess.guest) {
      res.status(403).json({
        success: false,
        guest: true,
        error: '지금 비로그인으로 게임 중입니다. 이 기능은 Discord 로그인 후 이용할 수 있습니다.'
      });
      return null;
    }
    return sess;
  }

  router.get('/state', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const session = getSessionUser(req);
      const data = await getLoopState(session && session.id, session && session.username);
      return res.json({ success: true, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.get('/winners', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
      const data = await getLoopState(null);
      return res.json({ success: true, winners: data.winners, jackpot: data.jackpot, happyHour: data.happyHour });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/mission/claim', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const session = requireMember(req, res);
    if (!session) return;
    try {
      const data = await withUserLock(session.id, () => claimMission(session.id, String(req.body?.key || '')));
      return res.json({ success: true, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/vip/claim', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const session = requireMember(req, res);
    if (!session) return;
    try {
      const data = await withUserLock(session.id, () => claimVipDaily(session.id));
      return res.json({ success: true, vipClaimed: true, remainSec: 3600, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.get('/arcade', async (req, res) => {
    try {
      const session = getSessionUser(req);
      const data = await getArcadeState(session && session.id);
      return res.json({ success: true, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/arcade/ack-level', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const data = await ackArcadeLevel(session.id, req.body?.level);
      return res.json({ success: true, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/arcade/rebirth', async (req, res) => {
    const session = requireMember(req, res);
    if (!session) return;
    try {
      const data = await withUserLock(session.id, () => doRebirth(session.id));
      return res.json({ success: true, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/arcade/shop', async (req, res) => {
    const session = requireMember(req, res);
    if (!session) return;
    try {
      const data = await withUserLock(session.id, () => buyArcadeItem(session.id, String(req.body?.kind || ''), String(req.body?.id || '')));
      return res.json({ success: true, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/arcade/world', async (req, res) => {
    const session = requireMember(req, res);
    if (!session) return;
    try {
      const data = await withUserLock(session.id, () => switchArcadeWorld(session.id, String(req.body?.world || ''), !!req.body?.back));
      return res.json({ success: true, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.get('/arcade/ranks', async (req, res) => {
    try {
      const ranks = await listRebirthRanks(20);
      return res.json({ success: true, ranks });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  // 🎮 보석 맞추기 퍼즐 (3블록 매치) 점수 정산 및 골드 지급
  router.post('/arcade/match-reward', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const rawScore = parseInt(req.body?.score, 10) || 0;
    if (rawScore <= 0) {
      return res.status(400).json({ success: false, error: '정산할 퍼즐 점수가 없습니다.' });
    }

    const validScore = Math.min(100000, rawScore);
    const rewardAmt = BigInt(validScore * 10);

    try {
      const { applyCashDelta } = require('../../utils/money');
      const { formatMoney } = require('../../utils/formatters');
      const afterCash = await applyCashDelta(session.id, rewardAmt, {
        logType: 'ARCADE_MATCH3_REWARD',
        description: `💎 3블록 보석 맞추기 퍼즐 (${validScore.toLocaleString()}점) 골드 보상 지급`
      });

      return res.json({
        success: true,
        score: validScore,
        reward: rewardAmt.toString(),
        rewardFormatted: formatMoney(rewardAmt),
        afterCash: afterCash.toString(),
        message: `🎉 3블록 보석 퍼즐 정산 완료! (+${formatMoney(rewardAmt)} 입금)`
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/toto', async (req, res) => {
    try {
      const matches = await listOpenMatches();
      return res.json({ success: true, matches });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/toto/bet', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const { assertLoanPlayAllowed } = require('../../utils/loanEngine');
      await assertLoanPlayAllowed(session.id);
      const data = await placeTotoBet(session, Number(req.body?.matchId), String(req.body?.pick || ''), req.body?.bet);
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.get('/crash', (req, res) => {
    return res.json({ success: true, ...publicState() });
  });

  router.post('/crash/bet', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const { assertLoanPlayAllowed } = require('../../utils/loanEngine');
      await assertLoanPlayAllowed(session.id);
      const data = await placeCrashBet(session, req.body?.bet, req.body?.autoAt);
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/crash/cashout', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const data = await cashoutCrash(session);
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/mines/start', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const data = await withUserLock(session.id, async () => {
        const { assertLoanPlayAllowed } = require('../../utils/loanEngine');
        await assertLoanPlayAllowed(session.id);
        if (mineTables.has(session.id)) {
          const err = new Error('이미 진행 중인 마인즈가 있습니다.');
          err.status = 409;
          throw err;
        }
        const user = await getOrCreateUser(session.id, session.username, session.avatar);
        const cash = safeBigInt(user.cash);
        const bet = parseBetAmount(req.body?.bet, cash, 1000n);
        const mines = Math.min(10, Math.max(3, parseInt(req.body?.mines, 10) || 5));
        const tooSmall = casinoTooSmallMessage(req.body?.bet, cash, bet);
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
        const field = makeMineField(mines);
        const newCash = await applyCashDelta(session.id, -bet);
        mineTables.set(session.id, {
          ...field,
          bet,
          revealed: [],
          status: 'playing',
          balanceBefore: cash
        });
        return {
          success: true,
          mines,
          revealed: [],
          multiplier: 1,
          newCash: newCash.toString(),
          message: `지뢰 ${mines}개. 타일을 열고 탈출하세요.`
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/mines/reveal', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const data = await withUserLock(session.id, async () => {
        const table = mineTables.get(session.id);
        if (!table || table.status !== 'playing') {
          const err = new Error('진행 중인 마인즈가 없습니다.');
          err.status = 400;
          throw err;
        }
        const idx = parseInt(req.body?.index, 10);
        if (!Number.isInteger(idx) || idx < 0 || idx > 24) {
          const err = new Error('잘못된 칸입니다.');
          err.status = 400;
          throw err;
        }
        if (table.revealed.includes(idx)) {
          return { success: true, revealed: table.revealed, multiplier: minesMultiplier(table.mines, table.revealed.length), boom: false };
        }
        if (table.bombs.includes(idx)) {
          table.status = 'dead';
          mineTables.delete(session.id);
          const profit = -table.bet;
          try {
            await pool.query(`
              INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [session.id, '마인즈', table.bet.toString(), '0', profit.toString(), table.balanceBefore.toString(), (await require('../../utils/money').getUserCash(session.id)).toString(), JSON.stringify({ boom: idx, mines: table.mines })]);
          } catch (e) {}
          const cash = await require('../../utils/money').getUserCash(session.id);
          await afterCasinoSettle({
            userId: session.id, username: session.username, game: '마인즈',
            bet: table.bet, payout: 0n, profit, isWin: false, isTie: false, multiplier: 0, newCash: cash, details: { boom: idx }
          });
          return {
            success: true,
            boom: true,
            index: idx,
            bombs: table.bombs,
            isWin: false,
            payout: '0',
            profit: profit.toString(),
            newCash: cash.toString(),
            message: '지뢰! 배팅금을 잃었습니다.'
          };
        }
        table.revealed.push(idx);
        const mult = minesMultiplier(table.mines, table.revealed.length);
        return { success: true, boom: false, index: idx, revealed: table.revealed, multiplier: mult };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/mines/cashout', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const data = await withUserLock(session.id, async () => {
        const table = mineTables.get(session.id);
        if (!table || table.status !== 'playing') {
          const err = new Error('진행 중인 마인즈가 없습니다.');
          err.status = 400;
          throw err;
        }
        if (!table.revealed.length) {
          const err = new Error('최소 한 칸은 연 뒤에 탈출하세요.');
          err.status = 400;
          throw err;
        }
        const mult = minesMultiplier(table.mines, table.revealed.length);
        const payout = computePayout(table.bet, mult);
        const profit = payout - table.bet;
        mineTables.delete(session.id);
        const newCash = await applyCashDelta(session.id, payout);
        try {
          await pool.query(`
            INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [session.id, '마인즈', table.bet.toString(), payout.toString(), profit.toString(), table.balanceBefore.toString(), newCash.toString(), JSON.stringify({ revealed: table.revealed.length, mines: table.mines, mult })]);
        } catch (e) {}
        const extra = await afterCasinoSettle({
          userId: session.id, username: session.username, game: '마인즈',
          bet: table.bet, payout, profit, isWin: profit > 0n, isTie: false, multiplier: mult, newCash, details: { mult }
        });
        return {
          success: true,
          isWin: profit > 0n,
          multiplier: extra.happyHour ? mult : mult,
          payout: payout.toString(),
          profit: profit.toString(),
          newCash: extra.newCash || newCash.toString(),
          bombs: table.bombs,
          message: `${mult}배 탈출! +${formatMoney(profit)}`,
          jackpotHit: extra.jackpotHit
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/plinko', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const data = await withUserLock(session.id, async () => {
        const { assertLoanPlayAllowed } = require('../../utils/loanEngine');
        await assertLoanPlayAllowed(session.id);
        const user = await getOrCreateUser(session.id, session.username, session.avatar);
        const cash = safeBigInt(user.cash);
        const bet = parseBetAmount(req.body?.bet, cash, 1000n);
        const tooSmall = casinoTooSmallMessage(req.body?.bet, cash, bet);
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
        const drop = dropPlinko(String(req.body?.risk || 'med'));
        const payout = computePayout(bet, drop.multiplier);
        const profit = payout - bet;
        const newCash = await applyCashDelta(session.id, profit);
        try {
          await pool.query(`
            INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [session.id, '플링코', bet.toString(), payout.toString(), profit.toString(), cash.toString(), newCash.toString(), JSON.stringify(drop)]);
        } catch (e) {}
        const extra = await afterCasinoSettle({
          userId: session.id, username: session.username, game: '플링코',
          bet, payout, profit, isWin: profit > 0n, isTie: profit === 0n, multiplier: drop.multiplier, newCash, details: drop
        });
        return {
          success: true,
          isWin: profit > 0n,
          ...drop,
          payout: payout.toString(),
          profit: profit.toString(),
          newCash: extra.newCash || newCash.toString(),
          message: `${drop.multiplier}배 버킷! ${profit >= 0n ? '+' : ''}${formatMoney(profit)}`,
          jackpotHit: extra.jackpotHit,
          nearMiss: extra.nearMiss
        };
      });
      return res.json(data);
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.get('/admin', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자만 가능합니다.' });
    }
    try {
      const pot = await getPot();
      const matches = await listOpenMatches();
      return res.json({ success: true, pot, matches });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/admin/jackpot', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자만 가능합니다.' });
    }
    try {
      const jackpot = await adminSetJackpot(req.body?.amount);
      return res.json({ success: true, jackpot: String(jackpot) });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/admin/happy-hour', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자만 가능합니다.' });
    }
    try {
      const mode = await adminSetHappyOverride(req.body?.mode);
      return res.json({ success: true, mode });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/admin/toto-settle', async (req, res) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자만 가능합니다.' });
    }
    try {
      const data = await forceSettleMatch(Number(req.body?.matchId), req.body?.result || null);
      return res.json({ success: true, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  return router;
}

module.exports = { createCasinoLoopRoutes };
