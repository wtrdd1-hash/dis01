'use strict';

const { safeBigInt, parseBetAmount, computePayout, withUserLock, applyCashDelta, casinoTooSmallMessage } = require('../../utils/money');
const { formatMoney } = require('../../utils/formatters');
const { scaleGambleMultiplier } = require('../../utils/economyBalance');
const { afterCasinoSettle } = require('../../utils/casinoLoop');
const UserModel = require('../../models/UserModel');
const LedgerModel = require('../../models/LedgerModel');
const { assertLoanPlayAllowed } = require('../../utils/loanEngine');

class GameFacade {
  /**
   * 카지노 & 미니게임 공통 정산 파사드
   */
  static async settleGame(session, rawBet, defaultBet = 1000n, playFn) {
    if (!session || !session.id) {
      const err = new Error('Discord 로그인이 필요합니다.');
      err.status = 401;
      throw err;
    }

    return withUserLock(session.id, async () => {
      // 1. 대출 연체 상태 확인
      await assertLoanPlayAllowed(session.id);

      // 2. 유저 잔액 및 배팅 금액 검증
      const user = await UserModel.findById(session.id, session.username, session.avatar);
      const userCash = safeBigInt(user.cash);
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

      // 3. 게임 엔진 실행
      const outcome = playFn(betAmount);
      const multiplier = outcome.skipPayoutScale
        ? (Number(outcome.multiplier) || 0)
        : scaleGambleMultiplier(outcome.multiplier);

      const payout = computePayout(betAmount, multiplier);
      const profit = payout - betAmount;

      // 4. 화폐 잔액 정산 (원자적 업데이트)
      const isWin = profit > 0n;
      const newCash = await applyCashDelta(session.id, profit, {
        logType: 'CASINO_' + String(outcome.game || 'GAME').toUpperCase() + (isWin ? '_WIN' : '_BET'),
        description: `🎰 카지노 [${outcome.game || '게임'}] ${isWin ? `승리 (+${formatMoney(profit)})` : `패배 (-${formatMoney(betAmount)})`}`
      });

      // 5. 감사 로그 저장
      await LedgerModel.logGambling(
        session.id,
        outcome.game,
        betAmount,
        payout,
        profit,
        userCash,
        newCash,
        outcome.details || {}
      );

      // 6. 카지노 루프 (잭팟, 연승 보너스, 해피아워)
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
}

module.exports = GameFacade;
