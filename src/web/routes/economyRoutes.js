/**
 * 🏦 경제 & 클리커 & 은행 & 지원금 라우트 모듈
 */
const express = require('express');
const { pool, getOrCreateUser } = require('../../config/database');
const { formatMoney } = require('../../utils/formatters');
const config = require('../../config/config');

function createEconomyRoutes(getSessionUser) {
  const router = express.Router();

  // 1. 클리커 수동 클릭 채굴
  router.post('/clicker/click', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const clicks = Math.min(Math.max(parseInt(req.body.clicks, 10) || 1, 1), 20);
    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const clickerLevel = userData.clicker_level || 1;
    const earned = BigInt(clicks * (10 + (clickerLevel - 1) * 15));
    const newCash = BigInt(userData.cash || 0) + earned;

    await pool.query('UPDATE users SET cash = ?, total_clicks = total_clicks + ? WHERE discord_id = ?', [
      newCash.toString(), clicks, session.id
    ]);

    return res.json({ success: true, earned: earned.toString(), newCash: newCash.toString(), clicks });
  });

  // 2. 클리커 레벨 강화
  router.post('/clicker/upgrade', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { type } = req.body;
    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const userCash = BigInt(userData.cash || 0);

    if (type === 'clicker') {
      const clickerLevel = (userData.clicker_level || 1) + 1;
      const cost = BigInt(Math.floor(1000 * Math.pow(1.5, clickerLevel - 2)));
      if (userCash < cost) return res.status(400).json({ success: false, error: `현금이 부족합니다! (필요: ${formatMoney(cost)})` });

      const newCash = userCash - cost;
      await pool.query('UPDATE users SET cash = ?, clicker_level = ? WHERE discord_id = ?', [newCash.toString(), clickerLevel, session.id]);
      return res.json({
        success: true,
        newCash: newCash.toString(),
        newLevel: clickerLevel,
        message: `🔨 클릭 파워 Lv.${clickerLevel} 강화 완료! (클릭당 +${formatMoney(clickerLevel * 10)})`
      });
    } else if (type === 'auto') {
      const autoLevel = (userData.auto_miner_level || 0) + 1;
      const cost = BigInt(Math.floor(3000 * Math.pow(1.6, autoLevel - 1)));
      if (userCash < cost) return res.status(400).json({ success: false, error: `현금이 부족합니다! (필요: ${formatMoney(cost)})` });

      const newCash = userCash - cost;
      await pool.query('UPDATE users SET cash = ?, auto_miner_level = ? WHERE discord_id = ?', [newCash.toString(), autoLevel, session.id]);
      return res.json({
        success: true,
        newCash: newCash.toString(),
        newLevel: autoLevel,
        message: `🤖 자동 채굴 봇 Lv.${autoLevel} 가동! (초당 +${formatMoney(autoLevel * 15)})`
      });
    }
    return res.status(400).json({ success: false, error: '유효하지 않은 업그레이드 유형입니다.' });
  });

  // 3. 일일 출석체크
  router.post('/economy/daily', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const now = new Date();
    const lastDaily = userData.last_daily ? new Date(userData.last_daily) : null;

    if (lastDaily) {
      const diffHours = (now - lastDaily) / (1000 * 60 * 60);
      if (diffHours < 24) {
        const remainHours = Math.ceil(24 - diffHours);
        return res.status(400).json({ success: false, error: `이미 오늘 출석을 완료했습니다! (다음 출석까지 약 ${remainHours}시간 남음)` });
      }
    }

    let streak = userData.daily_streak || 0;
    if (lastDaily && (now - lastDaily) / (1000 * 60 * 60) <= 48) {
      streak += 1;
    } else {
      streak = 1;
    }

    const baseReward = 50000n;
    const streakBonus = BigInt(Math.min(streak * 5000, 100000));
    const totalReward = baseReward + streakBonus;

    const beforeCash = BigInt(userData.cash || 0);
    const newCash = beforeCash + totalReward;

    await pool.query('UPDATE users SET cash = ?, daily_streak = ?, last_daily = NOW() WHERE discord_id = ?', [
      newCash.toString(), streak, session.id
    ]);

    try {
      await pool.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'DAILY', ?, ?, ?, ?)
      `, [session.id, session.username, totalReward.toString(), beforeCash.toString(), newCash.toString(), `일일 출석체크 (+${streak}일 연속 보너스)`]);
    } catch (e) {}

    return res.json({
      success: true,
      reward: totalReward.toString(),
      streak,
      newCash: newCash.toString(),
      message: `🎉 출석체크 성공! +${formatMoney(totalReward)} 지급 완료!`
    });
  });

  // 4. 정부 기본소득 & 무일푼 긴급 구제 지원금
  router.post('/economy/subsidy', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const now = new Date();
    const userCash = BigInt(userData.cash || 0);
    const isBroke = userCash === 0n;

    if (!isBroke) {
      const lastSubsidy = userData.last_subsidy ? new Date(userData.last_subsidy) : null;
      if (lastSubsidy) {
        const diffMs = now - lastSubsidy;
        const cooldownMs = 10 * 60 * 1000;
        if (diffMs < cooldownMs) {
          const remainSecTotal = Math.ceil((cooldownMs - diffMs) / 1000);
          const remainMin = Math.floor(remainSecTotal / 60);
          const remainSec = remainSecTotal % 60;
          return res.status(400).json({
            success: false,
            error: `지원금 신청 쿨타임 대기 중입니다! (다음 신청까지 약 ${remainMin}분 ${remainSec}초 남음)\n💡 현금이 0원일 때는 쿨타임 없이 언제든 즉시 지원금을 받으실 수 있습니다.`
          });
        }
      }
    }

    const subsidyAmount = isBroke ? 50000n : 30000n;
    const newCash = userCash + subsidyAmount;

    await pool.query('UPDATE users SET cash = ?, last_subsidy = NOW() WHERE discord_id = ?', [newCash.toString(), session.id]);

    try {
      await pool.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'SUBSIDY', ?, ?, ?, ?)
      `, [session.id, session.username, subsidyAmount.toString(), userCash.toString(), newCash.toString(), isBroke ? '무일푼 무제한 긴급 구제 지원금' : '정부 긴급 기본소득 구제 지원금']);
    } catch (e) {}

    return res.json({
      success: true,
      subsidy: subsidyAmount.toString(),
      isBroke,
      newCash: newCash.toString(),
      message: isBroke
        ? `🚨 무일푼 긴급 구제 지원금 +${formatMoney(subsidyAmount)} 즉시 지급 완료!`
        : `🏛️ 정부 긴급 기본소득 +${formatMoney(subsidyAmount)} 지급 완료!`
    });
  });

  // 5. 덕스 중앙은행 입출금
  router.post('/economy/bank', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });

    const { action, amount } = req.body;
    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    let userCash = BigInt(userData.cash || 0);
    let userBank = BigInt(userData.bank || 0);

    let amt = 0n;
    if (typeof amount === 'string' && amount.toLowerCase() === 'all') {
      amt = action === 'deposit' ? userCash : userBank;
    } else {
      amt = BigInt(amount || 0);
    }

    if (amt <= 0n) return res.status(400).json({ success: false, error: '이체 금액은 1원 이상이어야 합니다.' });

    if (action === 'deposit') {
      if (userCash < amt) return res.status(400).json({ success: false, error: '보유 현금이 부족합니다.' });
      userCash -= amt;
      userBank += amt;
    } else if (action === 'withdraw') {
      if (userBank < amt) return res.status(400).json({ success: false, error: '은행 예금이 부족합니다.' });
      userBank -= amt;
      userCash += amt;
    } else {
      return res.status(400).json({ success: false, error: '유효하지 않은 은행 업무입니다.' });
    }

    await pool.query('UPDATE users SET cash = ?, bank = ? WHERE discord_id = ?', [
      userCash.toString(), userBank.toString(), session.id
    ]);

    try {
      await pool.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'BANK', ?, ?, ?, ?)
      `, [session.id, session.username, amt.toString(), userData.cash.toString(), userCash.toString(), action === 'deposit' ? `은행에 ${formatMoney(amt)} 입금` : `은행에서 ${formatMoney(amt)} 출금`]);
    } catch (e) {}

    return res.json({
      success: true,
      action,
      amount: amt.toString(),
      cash: userCash.toString(),
      bank: userBank.toString(),
      message: action === 'deposit' ? `🏦 은행에 ${formatMoney(amt)} 입금 완료!` : `💵 은행에서 ${formatMoney(amt)} 출금 완료!`
    });
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
        const amt = Number(sr.amount);
        const pr = BigInt(sr.price);
        totalStockVal += BigInt(Math.floor(Number(pr) * amt));
        holdings[sr.stock_id] = amt;
      });

      const cash = BigInt(u.cash || 0);
      const bank = BigInt(u.bank || 0);
      const netWorth = cash + bank + totalStockVal;

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
        holdings
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  return router;
}

module.exports = { createEconomyRoutes };
