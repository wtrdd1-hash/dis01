/**
 * 👑 관리자 전용 웹 관제 & 보안 & 조작 라우트 모듈
 */
const express = require('express');
const { pool, getOrCreateUser } = require('../../config/database');
const { formatMoney } = require('../../utils/formatters');
const { logAdminAction } = require('../../utils/logger');
const { getSecurityStats, banIp, unbanIp } = require('../security');
const config = require('../../config/config');

function safeBigInt(val) {
  if (val === null || val === undefined || val === '') return 0n;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(Math.floor(val));
  if (typeof val === 'string') {
    const floatVal = parseFloat(val.replace(/[,원\s]/g, ''));
    if (isNaN(floatVal)) return 0n;
    return BigInt(Math.floor(floatVal));
  }
  return 0n;
}

function createAdminRoutes(getSessionUser) {
  const router = express.Router();

  // 관리자 권한 미들웨어
  const requireAdmin = (req, res, next) => {
    const session = getSessionUser(req);
    if (!session || !config.isAdmin(session.id)) {
      return res.status(403).json({ success: false, error: '관리자 전용 권한이 필요합니다.' });
    }
    req.adminSession = session;
    next();
  };

  router.use(requireAdmin);

  // 유저 ID, 멘션, 닉네임 자동 해석 헬퍼
  async function resolveTargetUser(inputStr) {
    if (!inputStr) return null;
    const cleaned = String(inputStr).trim().replace(/<@!?>/g, '').replace(/[@<>\s]/g, '');
    if (!cleaned) return null;

    if (/^\d{16,22}$/.test(cleaned)) {
      return await getOrCreateUser(cleaned);
    }

    const [rows] = await pool.query(
      'SELECT * FROM users WHERE discord_id = ? OR username = ? OR username LIKE ? ORDER BY id DESC LIMIT 1',
      [cleaned, cleaned, `%${cleaned}%`]
    );
    if (rows && rows.length > 0) return rows[0];

    if (/^\d+$/.test(cleaned)) {
      return await getOrCreateUser(cleaned);
    }
    return null;
  }

  // 1. 유저 돈 지급 (/admin_give 웹 버전)
  router.post('/action/give', async (req, res) => {
    const session = req.adminSession;
    const { userId, amount, reason } = req.body;
    if (!userId || amount === undefined || amount === null || String(amount).trim() === '') {
      return res.status(400).json({ success: false, error: '유저 ID(또는 닉네임)와 금액을 입력하세요.' });
    }

    const parsedAmount = safeBigInt(amount);
    if (parsedAmount <= 0n) return res.status(400).json({ success: false, error: '금액은 1원 이상이어야 합니다.' });

    try {
      const targetUser = await resolveTargetUser(userId);
      if (!targetUser) return res.status(404).json({ success: false, error: `유저 '${userId}'를 찾을 수 없습니다.` });

      const targetId = targetUser.discord_id;
      const targetName = targetUser.username || `유저_${targetId.slice(-4)}`;
      const beforeCash = safeBigInt(targetUser.cash);
      const afterCash = beforeCash + parsedAmount;

      await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [afterCash.toString(), targetId]);

      await pool.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'ADMIN_GIVE', ?, ?, ?, ?)
      `, [targetId, targetName, parsedAmount.toString(), beforeCash.toString(), afterCash.toString(), `👑 [웹 관리자 지급] +${formatMoney(parsedAmount)} (사유: ${reason || '관리자 수동 지급'})`]);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_GIVE_MONEY', targetId, { amount: parsedAmount.toString(), targetName, reason: reason || '관리자 수동 지급' }, req);

      return res.json({ success: true, message: `✅ [@${targetName}]님에게 ${formatMoney(parsedAmount)}이 성공적으로 지급되었습니다! (잔액: ${formatMoney(afterCash)})` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 2. 유저 돈 회수 (/admin_take 웹 버전)
  router.post('/action/take', async (req, res) => {
    const session = req.adminSession;
    const { userId, amount, reason } = req.body;
    if (!userId || amount === undefined || amount === null || String(amount).trim() === '') {
      return res.status(400).json({ success: false, error: '유저 ID(또는 닉네임)와 금액을 입력하세요.' });
    }

    const parsedAmount = safeBigInt(amount);
    if (parsedAmount <= 0n) return res.status(400).json({ success: false, error: '금액은 1원 이상이어야 합니다.' });

    try {
      const targetUser = await resolveTargetUser(userId);
      if (!targetUser) return res.status(404).json({ success: false, error: `유저 '${userId}'를 찾을 수 없습니다.` });

      const targetId = targetUser.discord_id;
      const targetName = targetUser.username || `유저_${targetId.slice(-4)}`;
      const beforeCash = safeBigInt(targetUser.cash);
      const afterCash = beforeCash > parsedAmount ? beforeCash - parsedAmount : 0n;

      await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [afterCash.toString(), targetId]);

      await pool.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'ADMIN_TAKE', ?, ?, ?, ?)
      `, [targetId, targetName, parsedAmount.toString(), beforeCash.toString(), afterCash.toString(), `👑 [웹 관리자 회수] -${formatMoney(parsedAmount)} (사유: ${reason || '관리자 수동 회수'})`]);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_TAKE_MONEY', targetId, { amount: parsedAmount.toString(), targetName, reason: reason || '관리자 수동 회수' }, req);

      return res.json({ success: true, message: `✅ [@${targetName}]님의 자금 ${formatMoney(parsedAmount)}이 회수되었습니다. (잔액: ${formatMoney(afterCash)})` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 3. 유저 데이터 초기화 (/admin_reset 웹 버전)
  router.post('/action/reset', async (req, res) => {
    const session = req.adminSession;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: '유저 ID(또는 닉네임)를 입력하세요.' });

    try {
      const targetUser = await resolveTargetUser(userId);
      if (!targetUser) return res.status(404).json({ success: false, error: `유저 '${userId}'를 찾을 수 없습니다.` });

      const targetId = targetUser.discord_id;
      const targetName = targetUser.username || `유저_${targetId.slice(-4)}`;

      await pool.query(`
        UPDATE users 
        SET cash = ?, bank = 0, clicker_level = 1, auto_miner_level = 0, total_clicks = 0,
            daily_streak = 0, last_daily = NULL, last_work = NULL, last_subsidy = NULL
        WHERE discord_id = ?
      `, [config.initialBalance || 10000, targetId]);

      await pool.query('DELETE FROM user_stocks WHERE user_id = ?', [targetId]);
      await logAdminAction(session.id, session.username || '관리자', 'WEB_RESET_USER', targetId, { targetName }, req);

      return res.json({ success: true, message: `✅ [@${targetName}]님의 모든 경제/주식 데이터가 초기화되었습니다.` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 4. 주가 강제 조작 (/admin_stock 웹 버전)
  router.post('/action/stock-price', async (req, res) => {
    const session = req.adminSession;
    const { stockId, price } = req.body;
    if (!stockId || !price) return res.status(400).json({ success: false, error: '종목 ID와 가격을 입력하세요.' });

    try {
      const { adjustStockPrice } = require('../../utils/stockEngine');
      const result = await adjustStockPrice(stockId, price, `관리자(@${session.username}) 웹 수동 조절`);
      await logAdminAction(session.id, session.username || '관리자', 'WEB_SET_STOCK_PRICE', stockId, { oldPrice: result.oldPrice.toString(), newPrice: result.newPrice.toString() }, req);

      return res.json({ success: true, message: `✅ [${result.name}] 주가가 ${formatMoney(result.newPrice)} (${result.rate}%) 으로 조절되었습니다.` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 4-1. 전 종목 일괄 비율 조절 (+10%, -10%, +20% 등)
  router.post('/action/stock-adjust-ratio', async (req, res) => {
    const session = req.adminSession;
    const { percent } = req.body;
    const pct = parseFloat(percent);
    if (isNaN(pct)) return res.status(400).json({ success: false, error: '조절할 비율(%)을 입력하세요.' });

    try {
      const { adjustAllStocksRatio } = require('../../utils/stockEngine');
      const results = await adjustAllStocksRatio(pct, `관리자(@${session.username}) 전종목 ${pct > 0 ? '+' : ''}${pct}% 일괄 조절`);
      await logAdminAction(session.id, session.username || '관리자', 'WEB_SET_ALL_STOCKS_RATIO', 'ALL', { percent: pct }, req);

      return res.json({ success: true, message: `✅ 전 종목 ${pct > 0 ? '+' : ''}${pct}% 일괄 가격 조절이 완료되었습니다. (${results.length}개 종목)` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 5. 시장 국면 강제 변경 (/admin_regime 웹 버전)
  router.post('/action/market-regime', async (req, res) => {
    const session = req.adminSession;
    const { regimeIndex } = req.body;
    const idx = parseInt(regimeIndex, 10);
    if (isNaN(idx)) return res.status(400).json({ success: false, error: '국면 번호를 선택하세요.' });

    try {
      const stockEngine = require('../../utils/stockEngine');
      stockEngine.setMarketRegime(idx);
      const targetRegime = stockEngine.MARKET_REGIMES[idx];
      await logAdminAction(session.id, session.username || '관리자', 'WEB_SET_REGIME', 'MARKET', { regime: targetRegime ? targetRegime.name : 'Unknown' }, req);

      return res.json({ success: true, message: `✅ 시장 국면이 [${targetRegime ? targetRegime.name : idx}] (으)로 강제 변경되었습니다!` });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 6. 보안 현황 조회
  router.get('/security', async (req, res) => {
    try {
      const stats = getSecurityStats();
      const [recentEvents] = await pool.query(`
        SELECT ip, event_type, path, reason, country, country_name, created_at
        FROM security_events
        ORDER BY created_at DESC
        LIMIT 50
      `);
      return res.json({ success: true, stats, recentEvents });
    } catch (e) {
      return res.json({ success: true, stats: getSecurityStats(), recentEvents: [] });
    }
  });

  // 7. IP 수동 차단 & 해제
  router.post('/security/ban', async (req, res) => {
    const { ip, reason, durationMinutes } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP 필요' });
    banIp(ip, reason || '관리자 수동 차단', Number(durationMinutes) || 1440);
    return res.json({ success: true, message: `${ip} 차단 완료` });
  });

  router.post('/security/unban', async (req, res) => {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP 필요' });
    const ok = unbanIp(ip);
    return res.json({ success: ok, message: ok ? `${ip} 차단 해제` : `${ip}는 차단 목록에 없음` });
  });

  // 8. 도박 이력 롤백 API
  router.post('/rollback/gambling/:logId', async (req, res) => {
    const session = req.adminSession;
    const { logId } = req.params;
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [logs] = await connection.query('SELECT * FROM gambling_logs WHERE id = ? FOR UPDATE', [logId]);
      if (logs.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, error: '해당 도박 이력을 찾을 수 없습니다.' });
      }

      const log = logs[0];
      if (log.is_rolled_back) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: '이미 롤백 처리된 이력입니다.' });
      }

      const [users] = await connection.query('SELECT cash FROM users WHERE discord_id = ? FOR UPDATE', [log.user_id]);
      if (users.length === 0) {
        await connection.rollback();
        return res.status(404).json({ success: false, error: '대상 유저를 찾을 수 없습니다.' });
      }

      const currentCash = BigInt(users[0].cash);
      const profit = BigInt(log.profit);
      const newCash = currentCash - profit;
      if (newCash < 0n) {
        await connection.rollback();
        return res.status(400).json({ success: false, error: '롤백 적용 시 유저의 현금이 음수가 되어 처리할 수 없습니다.' });
      }

      await connection.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), log.user_id]);
      await connection.query('UPDATE gambling_logs SET is_rolled_back = 1, rolled_back_at = NOW() WHERE id = ?', [logId]);
      await connection.commit();

      await logAdminAction(session.id, session.username || '관리자', 'ROLLBACK_GAMBLING', log.user_id, { logId, profit: profit.toString(), beforeCash: currentCash.toString(), afterCash: newCash.toString() }, req);

      return res.json({
        success: true,
        message: `✅ 로그 #${logId} (${log.game}) 롤백 완료! 유저 잔액이 ${formatMoney(currentCash)} ➔ ${formatMoney(newCash)} 으로 복구되었습니다.`
      });
    } catch (e) {
      await connection.rollback();
      return res.status(500).json({ success: false, error: e.message });
    } finally {
      connection.release();
    }
  });

  return router;
}

module.exports = { createAdminRoutes };
