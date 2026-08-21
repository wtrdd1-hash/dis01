/**
 * 🏦 경제 & 클리커 & 은행 & 지원금 라우트 모듈
 */
const express = require('express');
const { pool, getOrCreateUser } = require('../../config/database');
const { formatMoney } = require('../../utils/formatters');
const config = require('../../config/config');
const { getDynamicSettings } = require('../../utils/economyBalancer');
const { getPublicTaxView } = require('../../utils/taxEngine');
const {
  getPublicLoanView,
  quoteLoan,
  borrowLoan,
  repayLoan,
  getLockedCollateral
} = require('../../utils/loanEngine');
const { safeBigInt, withUserLock, applyCashDelta, applyBankTransfer, isAllInAmount, tryClaimCooldown } = require('../../utils/money');
const { sendPublicError } = require('../httpSafe');
const { pushUserLive } = require('../../utils/liveSync');
const { applyGenreReward, rewardPercentForGenre } = require('../../utils/mineGenres');
const {
  SAME_PIXEL_MAX,
  normalizeHits,
  applySamePixelGuard,
  normalizeMinerId,
  claimMinerSlot
} = require('../../utils/clickGuard');
const {
  rollClickBatch,
  clickPower,
  powerUpgradeCost,
  autoPerSec,
  autoUpgradeCost,
  computeNetWorth,
  evalStockValue,
  subsidyStatus,
  allowedClicksInWindow,
  SUBSIDY,
  STOCK_VALUE_SQL,
  CLICKER
} = require('../../utils/economyBalance');

const clickClock = new Map();
const clickGuard = new Map();
const minerSlots = new Map();

function pruneClickMaps(now) {
  if (clickClock.size < 4000 && clickGuard.size < 4000 && minerSlots.size < 4000) return;
  const expire = now - 15 * 60 * 1000;
  for (const [id, t] of clickClock) {
    if (typeof t === 'number' && t < expire) clickClock.delete(id);
  }
  for (const [id, st] of clickGuard) {
    if (!st || Number(st.at) < expire) clickGuard.delete(id);
  }
  for (const [id, st] of minerSlots) {
    if (!st || Number(st.at) < expire) minerSlots.delete(id);
  }
}

function emptyClickResult(userData, dropped, blocked) {
  return {
    success: true,
    clicks: 0,
    dropped: dropped || 0,
    blocked: blocked || null,
    earned: '0',
    earnedCash: 0,
    critCount: 0,
    newCash: String(userData.cash),
    totalClicks: String(userData.total_clicks || 0),
    samePixelMax: SAME_PIXEL_MAX
  };
}

function createEconomyRoutes(getSessionUser) {
  const router = express.Router();

  // 1. 클리커 수동 클릭 채굴
  router.post('/clicker/click', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    // 프론트는 { count }를 보내고 있었는데 기존 코드는 req.body.clicks만 읽어서
    // 연타 배치가 항상 1클릭으로 처리되는 문제가 있었다. 두 이름 모두 호환한다.
    const rawClicks = req.body?.count ?? req.body?.clicks;

    try {
      return await withUserLock(session.id, async () => {
        const userData = await getOrCreateUser(session.id, session.username, session.avatar);
        const clickerLevel = Number(userData.clicker_level || 1);
        const now = Date.now();
        pruneClickMaps(now);
        const minerId = normalizeMinerId(req.body?.wid);
        const claimed = claimMinerSlot(minerSlots.get(session.id), minerId, now);
        if (claimed.slot) minerSlots.set(session.id, claimed.slot);
        if (!claimed.ok) {
          return res.json(emptyClickResult(userData, 0, claimed.reason));
        }
        const hits = normalizeHits(req.body?.hits, CLICKER.MAX_CLICKS_PER_REQUEST);
        const requested = Math.min(
          hits.length,
          Math.max(0, parseInt(rawClicks, 10) || hits.length)
        );
        const prev = clickClock.get(session.id) || 0;
        const elapsed = prev === 0 ? CLICKER.MIN_MS_PER_CLICK * CLICKER.MAX_CLICKS_PER_REQUEST : (now - prev);
        clickClock.set(session.id, now);

        if (requested <= 0) {
          return res.json(emptyClickResult(userData, 0));
        }

        const allowed = allowedClicksInWindow(requested, elapsed);
        if (allowed <= 0) {
          return res.json(emptyClickResult(userData, 0));
        }

        const guarded = applySamePixelGuard(clickGuard.get(session.id), hits.slice(0, allowed), allowed);
        clickGuard.set(session.id, guarded.state);
        const paidClicks = guarded.paid;

        if (paidClicks <= 0) {
          return res.json(emptyClickResult(userData, guarded.dropped));
        }

        // 보상 장르는 클라이언트 값이 아니라 서버에 저장된 현재 선택값으로 확정한다.
        // 잠긴 고배율 장르를 요청 본문만 바꿔 사용하는 것을 막는다.
        const mine = require('../../utils/mineService');
        const genreId = await mine.getSelectedGenre(session.id);
        const genreRewardPercent = rewardPercentForGenre(genreId);

        // ⚡ 드릴 강화 & 오버클럭 버프 연동
        let drillBonusMult = 1.0;
        try {
          const { getDrillEquipment } = require('../../utils/enhancementEngine');
          const drill = await getDrillEquipment(session.id);
          if (drill && drill.bonusPercent > 0) {
            drillBonusMult += drill.bonusPercent / 100;
          }
        } catch (e) {}

        const rolled = rollClickBatch(clickerLevel, paidClicks);
        const clicks = rolled.clicks;
        const drillAdjusted = BigInt(Math.max(1, Math.floor(rolled.earned * drillBonusMult)));
        const earnedCash = applyGenreReward(drillAdjusted, genreId);
        const critCount = rolled.crits;

        await pool.query(
          'UPDATE users SET cash = cash + ? WHERE discord_id = ?',
          [earnedCash.toString(), session.id]
        );

        // total_clicks 기록
        try {
          await pool.query(
            'UPDATE users SET total_clicks = total_clicks + ? WHERE discord_id = ?',
            [clicks, session.id]
          );
        } catch (e) {}

        const [rows] = await pool.query(
          'SELECT cash, COALESCE(total_clicks, 0) AS total_clicks FROM users WHERE discord_id = ? LIMIT 1',
          [session.id]
        );

        if (rows.length === 0) {
          return res.status(404).json({ success: false, error: '유저 정보를 찾을 수 없습니다.' });
        }

        try {
          await mine.recordClicks(
            session.id,
            genreId,
            clicks,
            req.body?.combo,
            req.body?.depth
          );
          await mine.maybeAnnounceMega({
            userId: session.id,
            username: session.username,
            avatar: session.avatar,
            genreId,
            critCount,
            earned: Number(earnedCash)
          });
        } catch (e) {}

        pushUserLive(session.id);

        return res.json({
          success: true,
          clicks,
          dropped: guarded.dropped,
          blocked: null,
          earned: String(earnedCash),
          earnedCash: Number(earnedCash),
          critCount,
          genre: genreId,
          rewardMultiplier: genreRewardPercent / 100,
          newCash: String(rows[0].cash),
          totalClicks: String(rows[0].total_clicks || 0),
          samePixelMax: SAME_PIXEL_MAX
        });
      });
    } catch (err) {
      console.error('❌ [/api/clicker/click] 클릭 채굴 처리 오류:', err);
      return res.status(500).json({ success: false, error: '클릭 처리 중 오류가 발생했습니다.' });
    }
  });

  // 2. 클리커 & 자동 채굴 업그레이드
  router.post('/clicker/upgrade', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { type } = req.body;
    try {
      return await withUserLock(session.id, async () => {
        const userData = await getOrCreateUser(session.id, session.username, session.avatar);
        let clickerLevel = userData.clicker_level || 1;
        let autoLevel = userData.auto_miner_level || 0;

        if (type === 'clicker' || type === 'power') {
          const cost = safeBigInt(powerUpgradeCost(clickerLevel));
          const newCash = await applyCashDelta(session.id, -cost);
          clickerLevel += 1;
          await pool.query('UPDATE users SET clicker_level = ? WHERE discord_id = ?', [clickerLevel, session.id]);
          pushUserLive(session.id);
          return res.json({
            success: true,
            message: `🔨 클릭 파워 Lv.${clickerLevel} 강화 완료! (클릭당 +${formatMoney(clickPower(clickerLevel))})`,
            newCash: newCash.toString(),
            clickerLevel
          });
        } else if (type === 'auto') {
          const cost = safeBigInt(autoUpgradeCost(autoLevel));
          const newCash = await applyCashDelta(session.id, -cost);
          autoLevel += 1;
          await pool.query('UPDATE users SET auto_miner_level = ? WHERE discord_id = ?', [autoLevel, session.id]);
          pushUserLive(session.id);
          return res.json({
            success: true,
            message: `🤖 자동 채굴 봇 Lv.${autoLevel} 가동! (초당 +${formatMoney(autoPerSec(autoLevel))})`,
            newCash: newCash.toString(),
            autoLevel
          });
        }
        return res.json({ success: false, error: '유효하지 않은 업그레이드 유형입니다.' });
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_CASH') {
        return res.json({ success: false, error: '현금이 부족합니다!' });
      }
      return sendPublicError(res, err);
    }
  });

  // 3. 일일 출석체크
  router.post('/economy/daily', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      return await withUserLock(session.id, async () => {
        const userData = await getOrCreateUser(session.id, session.username, session.avatar);
        const now = new Date();
        const lastDaily = userData.last_daily ? new Date(userData.last_daily) : null;
        const cooldownMs = 24 * 60 * 60 * 1000;
        const streakResetMs = 48 * 60 * 60 * 1000;

        if (lastDaily) {
          const diffMs = now.getTime() - lastDaily.getTime();
          if (diffMs < cooldownMs) {
            const remainHours = Math.ceil((cooldownMs - diffMs) / (1000 * 60 * 60));
            return res.status(400).json({ success: false, error: `이미 오늘 출석을 완료했습니다! (다음 출석까지 약 ${remainHours}시간 남음)` });
          }
        }

        let streak = userData.daily_streak || 0;
        if (lastDaily && (now.getTime() - lastDaily.getTime() > streakResetMs)) {
          streak = 0;
        }
        streak += 1;

        const cappedStreak = Math.min(streak, 10);
        const streakBonus = (cappedStreak - 1) * (config.dailyStreakBonus || 500);
        let mult = 1.0;
        try {
          const dyn = getDynamicSettings();
          if (dyn && dyn.dailyRewardMultiplier) mult = dyn.dailyRewardMultiplier;
        } catch (e) {}

        const baseReward = (config.dailyReward || 3000) + streakBonus;
        const totalReward = BigInt(Math.max(100, Math.round(baseReward * mult)));

        const claimed = await tryClaimCooldown(session.id, 'last_daily', cooldownMs, { daily_streak: streak });
        if (!claimed) {
          return res.status(400).json({ success: false, error: '이미 오늘 출석을 완료했습니다!' });
        }

        const { grantTreasurySubsidy } = require('../../utils/taxEngine');
        const subResult = await grantTreasurySubsidy(session.id, session.username, totalReward, `🏛️ [국고 출석 보상] ${streak}일 연속 출석`);
        const newCash = subResult.newCash;
        const newTreasury = subResult.newTreasury;

        try { require('../../utils/casinoLoop').markDailyMission(session.id); } catch (e) {}

        return res.json({
          success: true,
          reward: totalReward.toString(),
          streak,
          newCash: newCash.toString(),
          treasury: newTreasury ? newTreasury.toString() : '0',
          message: `🎉 국고 출석체크 성공! +${formatMoney(totalReward)} 국고 지급 완료! (${streak}일 연속, 국고 잔액: ${formatMoney(newTreasury)})`
        });
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: '출석 처리 중 오류가 발생했습니다.' });
    }
  });

  // 4. 정부 기본소득 & 무일푼 긴급 구제 지원금
  router.post('/economy/subsidy', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    try {
      return await withUserLock(session.id, async () => {
        const userData = await getOrCreateUser(session.id, session.username, session.avatar);
        const now = new Date();
        const userCash = safeBigInt(userData.cash);
        const userBank = safeBigInt(userData.bank);
        const [stockSum] = await pool.query(`
          SELECT ${STOCK_VALUE_SQL} AS v
          FROM user_stocks us
          JOIN stocks s ON us.stock_id = s.stock_id
          WHERE us.user_id = ? AND us.amount > 0
        `, [session.id]);
        const stockVal = safeBigInt(stockSum[0]?.v);
        const netWorth = userCash + userBank + stockVal;
        if (netWorth > BigInt(SUBSIDY.MAX_NET_WORTH)) {
          return res.status(400).json({
            success: false,
            error: `기초 생활 지원금은 순자산 ${formatMoney(SUBSIDY.MAX_NET_WORTH)} 이하인 유저만 신청 가능합니다. (현재 순자산: ${formatMoney(netWorth)})`
          });
        }

        const lastSubsidy = userData.last_subsidy ? new Date(userData.last_subsidy) : null;
        const cooldownMs = SUBSIDY.COOLDOWN_MS;
        if (lastSubsidy) {
          const diffMs = now - lastSubsidy;
          if (diffMs < cooldownMs) {
            const remainHours = Math.ceil((cooldownMs - diffMs) / (1000 * 60 * 60));
            return res.status(400).json({
              success: false,
              error: `지원금은 하루 1회만 신청하실 수 있습니다! (다음 신청까지 약 ${remainHours}시간 남음)`
            });
          }
        }

        const subsidyAmount = safeBigInt(SUBSIDY.AMOUNT);
        const claimed = await tryClaimCooldown(session.id, 'last_subsidy', cooldownMs);
        if (!claimed) {
          return res.status(400).json({ success: false, error: '지원금은 하루 1회만 신청하실 수 있습니다!' });
        }

        const { grantTreasurySubsidy } = require('../../utils/taxEngine');
        const subResult = await grantTreasurySubsidy(session.id, session.username, subsidyAmount, '🏛️ [기초 생활 지원금] 정부 긴급 지원금 수령');
        const newCash = subResult.newCash;
        const newTreasury = subResult.newTreasury;

        return res.json({
          success: true,
          subsidy: subsidyAmount.toString(),
          isBroke,
          newCash: newCash.toString(),
          treasury: newTreasury ? newTreasury.toString() : '0',
          message: isBroke
            ? `🚨 무일푼 긴급 구제 지원금 +${formatMoney(subsidyAmount)} 국고 지급 완료! (국고 잔액: ${formatMoney(newTreasury)}, 2분 쿨타임)`
            : `🏛️ 정부 긴급 기본소득 +${formatMoney(subsidyAmount)} 국고 지급 완료! (국고 잔액: ${formatMoney(newTreasury)})`
        });
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: '지원금 처리 중 오류가 발생했습니다.' });
    }
  });

  // 5. 덕스 중앙은행 입출금
  router.post('/economy/bank', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { action, amount } = req.body;
    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const userCash = safeBigInt(userData.cash);
    const userBank = safeBigInt(userData.bank);
    let locked = 0n;
    try { locked = await getLockedCollateral(session.id); } catch (e) {}
    const freeBank = userBank > locked ? userBank - locked : 0n;

    let amt = 0n;
    if (isAllInAmount(amount)) {
      amt = action === 'deposit' ? userCash : freeBank;
    } else {
      const { parseMoneyInput } = require('../../utils/moneyScale');
      try {
        const parsed = parseMoneyInput(amount, action === 'deposit' ? userCash : freeBank);
        amt = typeof parsed === 'bigint' ? parsed : safeBigInt(amount);
      } catch (e) {
        if (e && e.code === 'MONEY_OVERFLOW') {
          return res.status(400).json({ success: false, error: e.message });
        }
        throw e;
      }
    }

    if (amt <= 0n) return res.status(400).json({ success: false, error: '이체 금액은 1원 이상이어야 합니다.' });
    if (action !== 'deposit' && action !== 'withdraw') {
      return res.status(400).json({ success: false, error: '유효하지 않은 은행 업무입니다.' });
    }
    if (action === 'withdraw' && amt > freeBank) {
      return res.status(400).json({
        success: false,
        error: locked > 0n
          ? `담보로 묶인 예금 ${formatMoney(locked)}은 인출할 수 없습니다. 대출을 먼저 갚으세요.`
          : '은행 예금이 부족합니다.'
      });
    }

    let moved;
    try {
      moved = await withUserLock(session.id, async () => {
        return action === 'deposit'
          ? await applyBankTransfer(session.id, -amt, amt)
          : await applyBankTransfer(session.id, amt, -amt);
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_FUNDS') {
        return res.status(400).json({ success: false, error: action === 'deposit' ? '보유 현금이 부족합니다.' : '은행 예금이 부족합니다.' });
      }
      if (err.code === 'COLLATERAL_LOCKED') {
        return res.status(400).json({ success: false, error: err.message });
      }
      if (err.code === 'MONEY_OVERFLOW') {
        return res.status(400).json({ success: false, error: err.message });
      }
      throw err;
    }
    const afterCash = moved.cash;
    const afterBank = moved.bank;

    try {
      await pool.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'BANK', ?, ?, ?, ?)
      `, [session.id, session.username, amt.toString(), userCash.toString(), afterCash.toString(), action === 'deposit' ? `은행에 ${formatMoney(amt)} 입금` : `은행에서 ${formatMoney(amt)} 출금`]);
    } catch (e) {}

    return res.json({
      success: true,
      action,
      amount: amt.toString(),
      cash: afterCash.toString(),
      bank: afterBank.toString(),
      message: action === 'deposit' ? `🏦 은행에 ${formatMoney(amt)} 입금 완료!` : `💵 은행에서 ${formatMoney(amt)} 출금 완료!`
    });
  });

  // 5-1. 🔍 송금 대상 유저 검색 API
  router.get('/economy/users/search', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const q = String(req.query.q || '').trim();
    if (!q || q.length < 1) {
      return res.json({ success: true, users: [] });
    }

    try {
      const [rows] = await pool.query(
        `SELECT discord_id, username, avatar, cash, bank 
         FROM users 
         WHERE discord_id != ? AND (username LIKE ? OR discord_id LIKE ?)
         LIMIT 8`,
        [session.id, `%${q}%`, `%${q}%`]
      );

      const users = rows.map(u => ({
        id: u.discord_id,
        username: u.username || `유저_${String(u.discord_id).slice(-4)}`,
        avatar: u.avatar ? (u.avatar.startsWith('http') ? u.avatar : `https://cdn.discordapp.com/avatars/${u.discord_id}/${u.avatar}.png`) : null
      }));

      return res.json({ success: true, users });
    } catch (e) {
      return res.status(500).json({ success: false, error: '유저 검색 중 오류가 발생했습니다.' });
    }
  });

  // 5-2. 💸 송금 수수료 사전 견적 API
  router.post('/economy/transfer/quote', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { targetUserId, amount } = req.body;
    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const userCash = safeBigInt(userData.cash);

    let payAmount = 0n;
    if (isAllInAmount(amount)) {
      payAmount = userCash;
    } else {
      const { parseMoneyInput } = require('../../utils/moneyScale');
      try {
        const parsed = parseMoneyInput(amount, userCash);
        payAmount = typeof parsed === 'bigint' ? parsed : safeBigInt(amount);
      } catch (e) {
        return res.status(400).json({ success: false, error: e.message || '금액 형식이 올바르지 않습니다.' });
      }
    }

    const { quoteTransferTax } = require('../../utils/taxEngine');
    const taxQuote = quoteTransferTax(session.id, targetUserId || 'GUEST', payAmount);

    return res.json({
      success: true,
      amount: payAmount.toString(),
      amountFormatted: formatMoney(payAmount),
      tax: taxQuote.tax.toString(),
      taxFormatted: formatMoney(taxQuote.tax),
      rate: taxQuote.rate,
      rateText: `${(taxQuote.rate * 100).toFixed(1)}%`,
      totalDebit: (payAmount + taxQuote.tax).toString(),
      totalDebitFormatted: formatMoney(payAmount + taxQuote.tax),
      exempt: taxQuote.exempt,
      canPay: userCash >= (payAmount + taxQuote.tax)
    });
  });

  // 5-3. 💸 유저 간 실시간 자금 송금 API
  router.post('/economy/transfer', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { targetUserId, amount, memo } = req.body;
    const recipientId = String(targetUserId || '').trim();

    if (!recipientId) {
      return res.status(400).json({ success: false, error: '돈을 받을 상대방의 ID 또는 닉네임을 지정하세요.' });
    }
    if (recipientId === session.id) {
      return res.status(400).json({ success: false, error: '자기 자신에게는 송금할 수 없습니다.' });
    }

    try {
      return await withUserLock(session.id, async () => {
        return await withUserLock(recipientId, async () => {
          const senderData = await getOrCreateUser(session.id, session.username, session.avatar);
          const [recRows] = await pool.query('SELECT * FROM users WHERE discord_id = ? LIMIT 1', [recipientId]);
          
          if (!recRows || recRows.length === 0) {
            return res.status(404).json({ success: false, error: '받는 유저 계정을 찾을 수 없습니다.' });
          }
          const recipientData = recRows[0];
          const recipientName = recipientData.username || `유저_${recipientId.slice(-4)}`;

          const senderCash = safeBigInt(senderData.cash);
          let payAmount = 0n;

          if (isAllInAmount(amount)) {
            payAmount = senderCash;
          } else {
            const { parseMoneyInput } = require('../../utils/moneyScale');
            try {
              const parsed = parseMoneyInput(amount, senderCash);
              payAmount = typeof parsed === 'bigint' ? parsed : safeBigInt(amount);
            } catch (e) {
              return res.status(400).json({ success: false, error: e.message || '금액 형식이 올바르지 않습니다.' });
            }
          }

          if (payAmount < 1000n) {
            return res.status(400).json({ success: false, error: '최소 송금 금액은 1,000원 이상이어야 합니다.' });
          }

          const { quoteTransferTax, applyDebitWithTax } = require('../../utils/taxEngine');
          const taxQuote = quoteTransferTax(session.id, recipientId, payAmount);
          const totalNeed = payAmount + taxQuote.tax;

          if (senderCash < totalNeed) {
            return res.status(400).json({
              success: false,
              error: `보유 현금이 부족합니다! (필요: ${formatMoney(totalNeed)}, 현재 현금: ${formatMoney(senderCash)})`
            });
          }

          // 1. 송금자 현금 및 세금 차감
          const paid = await applyDebitWithTax(
            session.id,
            session.username,
            payAmount,
            taxQuote.tax,
            'TAX_TRANSFER',
            `유저 송금세 → @${recipientName} (${recipientId})`
          );

          // 2. 수취인에게 현금 지급
          const newRecipientCash = await applyCashDelta(recipientId, payAmount, {
            logType: 'TRANSFER_RECEIVE',
            description: `💸 [@${session.username} 님으로부터 송금 입금] +${formatMoney(payAmount)}${memo ? ` (메모: ${memo})` : ''}`
          });

          // 3. 경제 이체 로그 기록
          await pool.query(`
            INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
            VALUES (?, ?, 'TRANSFER_SEND', ?, ?, ?, ?)
          `, [
            session.id,
            session.username,
            payAmount.toString(),
            senderCash.toString(),
            paid.after.toString(),
            `💸 [@${recipientName} 님에게 송금] -${formatMoney(payAmount)}${taxQuote.tax > 0n ? ` (송금세: ${formatMoney(taxQuote.tax)})` : ''}${memo ? ` (메모: ${memo})` : ''}`
          ]);

          pushUserLive(session.id);
          pushUserLive(recipientId);

          return res.json({
            success: true,
            recipientName,
            recipientId,
            amount: payAmount.toString(),
            amountFormatted: formatMoney(payAmount),
            tax: taxQuote.tax.toString(),
            taxFormatted: formatMoney(taxQuote.tax),
            newSenderCash: paid.after.toString(),
            newSenderCashFormatted: formatMoney(paid.after),
            message: `💸 @${recipientName} 님에게 ${formatMoney(payAmount)} 송금을 완료했습니다!${taxQuote.tax > 0n ? ` (송금세: ${formatMoney(taxQuote.tax)})` : ''}`
          });
        });
      });
    } catch (err) {
      console.error('❌ 송금 처리 오류:', err);
      return res.status(500).json({ success: false, error: '송금 처리 중 오류가 발생했습니다.' });
    }
  });

  function loanFail(res, err) {
    const status = Number(err && err.status) || 400;
    return res.status(status).json({ success: false, error: (err && err.message) || '대출 처리에 실패했습니다.' });
  }

  router.get('/economy/loan', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const quote = await quoteLoan(session.id, req.query && req.query.amount);
      return res.json({ success: true, ...quote, loan: quote.active || null });
    } catch (err) {
      if (err.code === 'ADMIN_EXEMPT') {
        return res.json({
          success: true,
          eligible: false,
          exempt: true,
          maxBorrow: '0',
          amount: '0',
          loan: null,
          message: err.message
        });
      }
      return loanFail(res, err);
    }
  });

  router.post('/economy/loan', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const loan = await borrowLoan(session.id, session.username, req.body && req.body.amount);
      return res.json({
        success: true,
        loan,
        cash: loan.cash,
        bank: loan.bank,
        message: `대출 ${formatMoney(loan.principal)}을 받았습니다. 담보 ${formatMoney(loan.collateral)}이 예금에서 잠깁니다.`
      });
    } catch (err) {
      return loanFail(res, err);
    }
  });

  router.post('/economy/loan/repay', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const loan = await repayLoan(session.id, session.username, req.body && req.body.amount);
      const remain = loan.hasLoan ? formatMoney(loan.debt) : '0원';
      return res.json({
        success: true,
        loan,
        cash: loan.cash,
        bank: loan.bank,
        message: loan.hasLoan ? `일부 상환했습니다. 남은 채무 ${remain}` : '대출을 모두 갚았습니다. 담보가 풀렸습니다.'
      });
    } catch (err) {
      return loanFail(res, err);
    }
  });

  // 6. 🔄 실시간 유저 자산/경제 상태 요약 API (비동기 자동 동기화용)
  router.get('/user/summary', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.json({ success: false, loggedIn: false });

    try {
      const [userRows] = await pool.query('SELECT cash, bank, clicker_level, auto_miner_level, daily_streak FROM users WHERE discord_id = ?', [session.id]);
      if (userRows.length === 0) return res.json({ success: false, loggedIn: false });

      const u = userRows[0];
      const [stockRows] = await pool.query(`
        SELECT us.stock_id, us.amount, s.price
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.user_id = ?
      `, [session.id]);

      let totalStockVal = 0n;
      const holdings = {};
      stockRows.forEach(sr => {
        totalStockVal += evalStockValue(sr.amount, sr.price);
        holdings[sr.stock_id] = String(sr.amount);
      });

      const cash = safeBigInt(u.cash);
      const bank = safeBigInt(u.bank);
      const netWorth = computeNetWorth(cash, bank, totalStockVal);

      return res.json({
        success: true,
        loggedIn: true,
        cash: cash.toString(),
        bank: bank.toString(),
        stockVal: totalStockVal.toString(),
        netWorth: netWorth.toString(),
        clickerLevel: u.clicker_level || 1,
        autoLevel: u.auto_miner_level || 0,
        streak: u.daily_streak || 0,
        holdings,
        tax: await getPublicTaxView(session.id),
        loan: await getPublicLoanView(session.id)
      });
    } catch (e) {
      return sendPublicError(res, e);
    }
  });

  return router;
}

setInterval(() => {
  const cutoff = Date.now() - 60 * 1000;
  for (const [id, ts] of clickClock.entries()) {
    if (!ts || ts < cutoff) clickClock.delete(id);
  }
}, 5 * 60 * 1000).unref();

module.exports = { createEconomyRoutes };
