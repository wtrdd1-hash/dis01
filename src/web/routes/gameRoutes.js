/**
 * 🎰 카지노 & 미니게임 라우트 모듈 (슬롯, 동전, 주사위, 복권, 경마)
 */
const express = require('express');
const { pool, getOrCreateUser } = require('../../config/database');
const { formatMoney } = require('../../utils/formatters');

function createGameRoutes(getSessionUser) {
  const router = express.Router();

  // 1. 슬롯머신
  router.post('/slot', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { bet } = req.body;
    const betAmount = BigInt(bet || 1000);
    if (betAmount < 1000n) return res.status(400).json({ success: false, error: '최소 배팅금액은 1,000원입니다.' });

    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const userCash = BigInt(userData.cash || 0);
    if (userCash < betAmount) {
      return res.status(400).json({ success: false, error: `보유 현금이 부족합니다! (필요: ${formatMoney(betAmount)}, 보유: ${formatMoney(userCash)})` });
    }

    const symbols = ['🍒', '🍋', '🍇', '🍉', '🔔', '💎', '7️⃣'];
    const s1 = symbols[Math.floor(Math.random() * symbols.length)];
    const s2 = symbols[Math.floor(Math.random() * symbols.length)];
    const s3 = symbols[Math.floor(Math.random() * symbols.length)];

    let multiplier = 0.0;
    if (s1 === s2 && s2 === s3) {
      if (s1 === '7️⃣') multiplier = 50.0;
      else if (s1 === '💎') multiplier = 20.0;
      else multiplier = 10.0;
    } else if (s1 === s2 || s2 === s3 || s1 === s3) {
      multiplier = 1.5;
    }

    const payout = BigInt(Math.floor(Number(betAmount) * multiplier));
    const isWin = multiplier > 0;
    const profit = isWin ? payout - betAmount : -betAmount;
    const newCash = userCash + profit;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), session.id]);

    try {
      await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, '슬롯머신', ?, ?, ?, ?, ?, ?)
      `, [session.id, betAmount.toString(), payout.toString(), profit.toString(), userCash.toString(), newCash.toString(), JSON.stringify({ slots: [s1, s2, s3], multiplier })]);
    } catch (e) {}

    return res.json({
      success: true,
      slots: [s1, s2, s3],
      isWin,
      multiplier,
      payout: payout.toString(),
      profit: profit.toString(),
      newCash: newCash.toString(),
      message: isWin
        ? `🎉 슬롯머신 적중! [${s1} | ${s2} | ${s3}] (${multiplier}배) +${formatMoney(payout)} 획득!`
        : `💀 슬롯머신 꽝! [${s1} | ${s2} | ${s3}] -${formatMoney(betAmount)}`
    });
  });

  // 2. 동전 뒤집기
  router.post('/coinflip', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { choice, bet } = req.body;
    const betAmount = BigInt(bet || 1000);
    if (betAmount < 1000n) return res.status(400).json({ success: false, error: '최소 배팅금액은 1,000원입니다.' });

    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const userCash = BigInt(userData.cash || 0);
    if (userCash < betAmount) {
      return res.status(400).json({ success: false, error: `보유 현금이 부족합니다! (필요: ${formatMoney(betAmount)}, 보유: ${formatMoney(userCash)})` });
    }

    const result = Math.random() < 0.5 ? '앞면' : '뒷면';
    const isWin = choice === result;
    const payout = isWin ? BigInt(Math.floor(Number(betAmount) * 1.95)) : 0n;
    const profit = isWin ? payout - betAmount : -betAmount;
    const newCash = userCash + profit;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), session.id]);

    try {
      await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, '동전뒤집기', ?, ?, ?, ?, ?, ?)
      `, [session.id, betAmount.toString(), payout.toString(), profit.toString(), userCash.toString(), newCash.toString(), JSON.stringify({ choice, result, isWin })]);
    } catch (e) {}

    return res.json({
      success: true,
      result,
      isWin,
      payout: payout.toString(),
      profit: profit.toString(),
      newCash: newCash.toString(),
      message: isWin
        ? `🎉 동전 적중! [${result}] (+${formatMoney(profit)})`
        : `💀 동전 실패! [${result}] (-${formatMoney(betAmount)})`
    });
  });

  // 3. 주사위 대결
  router.post('/dice', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { bet } = req.body;
    const betAmount = BigInt(bet || 1000);
    if (betAmount < 1000n) return res.status(400).json({ success: false, error: '최소 배팅금액은 1,000원입니다.' });

    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const userCash = BigInt(userData.cash || 0);
    if (userCash < betAmount) {
      return res.status(400).json({ success: false, error: `보유 현금이 부족합니다! (필요: ${formatMoney(betAmount)}, 보유: ${formatMoney(userCash)})` });
    }

    const u1 = Math.floor(Math.random() * 6) + 1;
    const u2 = Math.floor(Math.random() * 6) + 1;
    const userTotal = u1 + u2;

    const b1 = Math.floor(Math.random() * 6) + 1;
    const b2 = Math.floor(Math.random() * 6) + 1;
    const botTotal = b1 + b2;

    let multiplier = 0.0;
    let resultText = '';
    if (userTotal > botTotal) {
      multiplier = 1.95;
      resultText = `🎉 승리! 나(${userTotal}) vs 딜러(${botTotal}) (+${formatMoney(BigInt(Math.floor(Number(betAmount) * 0.95)))})`;
    } else if (userTotal === botTotal) {
      multiplier = 1.0;
      resultText = `🤝 무승부! 나(${userTotal}) vs 딜러(${botTotal}) (배팅금 전액 환불)`;
    } else {
      multiplier = 0.0;
      resultText = `💀 패배! 나(${userTotal}) vs 딜러(${botTotal}) (-${formatMoney(betAmount)})`;
    }

    const payout = BigInt(Math.floor(Number(betAmount) * multiplier));
    const profit = payout - betAmount;
    const newCash = userCash + profit;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), session.id]);

    try {
      await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, '주사위대결', ?, ?, ?, ?, ?, ?)
      `, [session.id, betAmount.toString(), payout.toString(), profit.toString(), userCash.toString(), newCash.toString(), JSON.stringify({ userDice: [u1, u2], botDice: [b1, b2], userTotal, botTotal })]);
    } catch (e) {}

    return res.json({
      success: true,
      userDice: [u1, u2],
      botDice: [b1, b2],
      userTotal,
      botTotal,
      isWin: userTotal > botTotal,
      isTie: userTotal === botTotal,
      payout: payout.toString(),
      profit: profit.toString(),
      newCash: newCash.toString(),
      message: resultText
    });
  });

  // 4. 즉석 복권
  router.post('/lottery', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { bet } = req.body;
    const betAmount = BigInt(bet || 2000);
    if (betAmount < 1000n) return res.status(400).json({ success: false, error: '최소 배팅금액은 1,000원입니다.' });

    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const userCash = BigInt(userData.cash || 0);
    if (userCash < betAmount) {
      return res.status(400).json({ success: false, error: `보유 현금이 부족합니다! (필요: ${formatMoney(betAmount)}, 보유: ${formatMoney(userCash)})` });
    }

    const lottoSymbols = ['💰', '🦆', '💎', '7️⃣', '💣', '⭐'];
    const r1 = lottoSymbols[Math.floor(Math.random() * lottoSymbols.length)];
    const r2 = lottoSymbols[Math.floor(Math.random() * lottoSymbols.length)];
    const r3 = lottoSymbols[Math.floor(Math.random() * lottoSymbols.length)];

    let multiplier = 0.0;
    if (r1 === r2 && r2 === r3) {
      if (r1 === '💎') multiplier = 100.0;
      else if (r1 === '7️⃣') multiplier = 50.0;
      else if (r1 === '🦆') multiplier = 30.0;
      else if (r1 === '💰') multiplier = 20.0;
      else multiplier = 10.0;
    } else if (r1 === r2 || r2 === r3 || r1 === r3) {
      multiplier = 2.0;
    }

    const payout = BigInt(Math.floor(Number(betAmount) * multiplier));
    const isWin = multiplier > 0;
    const profit = isWin ? payout - betAmount : -betAmount;
    const newCash = userCash + profit;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), session.id]);

    try {
      await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, '즉석복권', ?, ?, ?, ?, ?, ?)
      `, [session.id, betAmount.toString(), payout.toString(), profit.toString(), userCash.toString(), newCash.toString(), JSON.stringify({ symbols: [r1, r2, r3], multiplier })]);
    } catch (e) {}

    return res.json({
      success: true,
      symbols: [r1, r2, r3],
      isWin,
      multiplier,
      payout: payout.toString(),
      profit: profit.toString(),
      newCash: newCash.toString(),
      message: isWin
        ? `🎉 복권 당첨! [${r1} | ${r2} | ${r3}] (${multiplier}배) +${formatMoney(payout)}!`
        : `💀 복권 꽝! [${r1} | ${r2} | ${r3}] -${formatMoney(betAmount)}`
    });
  });

  // 5. 실시간 경마
  const HORSES = [
    { id: 1, name: '1번 황금번개', odds: 2.0, color: '#fbbf24', weight: 40 },
    { id: 2, name: '2번 질풍노도', odds: 3.0, color: '#38bdf8', weight: 28 },
    { id: 3, name: '3번 다크호스', odds: 5.0, color: '#a855f7', weight: 17 },
    { id: 4, name: '4번 월덕스피릿', odds: 8.0, color: '#f43f5e', weight: 10 },
    { id: 5, name: '5번 로또잭팟', odds: 15.0, color: '#ec4899', weight: 5 }
  ];

  router.post('/horse-race', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { horseId, amount } = req.body;
    const chosenHorseId = parseInt(horseId, 10);
    const betAmount = BigInt(amount || 1000);

    const chosenHorse = HORSES.find(h => h.id === chosenHorseId);
    if (!chosenHorse) return res.status(400).json({ success: false, error: '유효한 말을 선택해주세요 (1~5번).' });
    if (betAmount < 1000n) return res.status(400).json({ success: false, error: '최소 배팅금액은 1,000원입니다.' });

    const userData = await getOrCreateUser(session.id, session.username, session.avatar);
    const userCash = BigInt(userData.cash || 0);
    if (userCash < betAmount) {
      return res.status(400).json({ success: false, error: `보유 현금(${formatMoney(userCash)})이 부족합니다.` });
    }

    const totalWeight = HORSES.reduce((sum, h) => sum + h.weight, 0);
    let rand = Math.random() * totalWeight;
    let winner = HORSES[0];
    for (const h of HORSES) {
      if (rand < h.weight) {
        winner = h;
        break;
      }
      rand -= h.weight;
    }

    const isWin = (winner.id === chosenHorse.id);
    const payout = isWin ? BigInt(Math.floor(Number(betAmount) * winner.odds)) : 0n;
    const profit = isWin ? (payout - betAmount) : -betAmount;
    const newCash = userCash + profit;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), session.id]);

    try {
      await pool.query(`
        INSERT INTO gambling_logs (user_id, game, bet, payout, profit, balance_before, balance_after, details)
        VALUES (?, '월덕경마', ?, ?, ?, ?, ?, ?)
      `, [session.id, betAmount.toString(), payout.toString(), profit.toString(), userCash.toString(), newCash.toString(), JSON.stringify({ chosen: chosenHorse.name, winner: winner.name, isWin, odds: winner.odds })]);
    } catch (e) {}

    return res.json({
      success: true,
      chosenHorse: { id: chosenHorse.id, name: chosenHorse.name },
      winner: { id: winner.id, name: winner.name },
      odds: winner.odds,
      isWin,
      bet: betAmount.toString(),
      payout: payout.toString(),
      profit: profit.toString(),
      newCash: newCash.toString()
    });
  });

  return router;
}

module.exports = { createGameRoutes };
