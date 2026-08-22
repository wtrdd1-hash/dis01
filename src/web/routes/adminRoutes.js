function isHtmlRequest(req) {
  const accept = String(req && req.headers && req.headers.accept || '');
  return !req.xhr && accept.includes('text/html') && !accept.includes('application/json') && req.query.format !== 'json';
}
/**
 * 👑 관리자 전용 웹 관제 & 보안 & 조작 라우트 모듈
 */
const express = require('express');
const { pool, getOrCreateUser } = require('../../config/database');
const { formatMoney } = require('../../utils/formatters');
const { parseAdminMoney } = require('../../utils/moneyScale');
const { logAdminAction } = require('../../utils/logger');
const { getSecurityStats, banIp, unbanIp, getBannedIpsList, getWhitelistedIpsList, addIpToWhitelist, removeIpFromWhitelist } = require('../security');
const { lookupIp, getFlagEmoji, isValidIp } = require('../../utils/geoIp');
const config = require('../../config/config');
const { pushUserLive } = require('../../utils/liveSync');
const { NET_WORTH_SQL } = require('../../utils/economyBalance');
const {
  getTaxOverview,
  previewCollectFromUser,
  collectFromUser,
  previewWealthTax,
  collectWealthTax,
  previewFlatCollect,
  collectFlatFromAll,
  refundFromTreasury,
  withdrawTreasuryByAdmin,
  previewSettleRefund,
  settleTaxRefund
} = require('../../utils/taxEngine');
const { setTaxPolicyOverride } = require('../../utils/economyBalancer');
const { listLoansAdmin, adminForceLoan, closeLoansOnReset } = require('../../utils/loanEngine');
const { isValidStockId } = require('../../utils/sanitize');
const { jsonSafe } = require('../httpSafe');
const {
  safeBigInt,
  isAllInAmount,
  parseGambleBet,
  withUserLock,
  applyCashGiveLocked,
  applyCashTakeClamped
} = require('../../utils/money');

const WEALTH_FROM = `
  FROM users u
  LEFT JOIN user_stocks us ON u.discord_id = us.user_id
  LEFT JOIN stocks s ON us.stock_id = s.stock_id
`;

const WEALTH_SELECT = `
  SELECT
    u.discord_id,
    u.username,
    u.cash,
    u.bank,
    CAST(ROUND(COALESCE(SUM(us.amount * s.price), 0)) AS DECIMAL(65,0)) AS stock_val,
    ${NET_WORTH_SQL} AS net_worth
  ${WEALTH_FROM}
`;

function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function clipReason(raw, fallback) {
  const text = String(raw || '').trim().slice(0, 200);
  return text || fallback;
}

function serializeBannedList() {
  return getBannedIpsList().map((ban) => {
    const geo = ban.ip ? lookupIp(ban.ip) : null;
    return {
      ip: ban.ip,
      reason: ban.reason || '-',
      remainingMinutes: ban.remainingMinutes,
      bannedAt: ban.bannedAt || '-',
      flag: (geo && geo.flag) || '🌐',
      countryName: (geo && geo.countryName) || '-'
    };
  });
}

function securityPayload(extra) {
  const stats = getSecurityStats();
  return Object.assign({
    success: true,
    stats,
    bannedIps: serializeBannedList()
  }, extra || {});
}

function serializeWealth(row) {
  if (!row) return null;
  const cash = safeBigInt(row.cash);
  const bank = safeBigInt(row.bank);
  const stockVal = safeBigInt(row.stock_val);
  const netWorth = safeBigInt(row.net_worth);
  return {
    discordId: String(row.discord_id),
    username: row.username || '알수없음',
    cash: cash.toString(),
    bank: bank.toString(),
    stockVal: stockVal.toString(),
    netWorth: netWorth.toString(),
    cashText: formatMoney(cash),
    bankText: formatMoney(bank),
    stockText: formatMoney(stockVal),
    netText: formatMoney(netWorth),
    isAdmin: config.isAdmin(row.discord_id),
    cohort: config.isAdmin(row.discord_id) ? 'admin' : 'user'
  };
}

async function getWealthRow(discordId) {
  const [rows] = await pool.query(
    `${WEALTH_SELECT}
     WHERE u.discord_id = ?
     GROUP BY u.discord_id, u.username, u.cash, u.bank
     LIMIT 1`,
    [discordId]
  );
  return serializeWealth(rows[0] || null);
}

function extractSnowflake(inputStr) {
  const raw = String(inputStr || '').trim();
  const mention = raw.match(/^<@!?(\d{16,22})>$/);
  if (mention) return mention[1];
  const digits = raw.replace(/[@\s]/g, '');
  if (/^\d{16,22}$/.test(digits)) return digits;
  return null;
}

async function resolveTargetUser(inputStr, { createIfMissing = false } = {}) {
  const raw = String(inputStr || '').trim();
  if (!raw) return { status: 400, error: '유저 ID 또는 닉네임을 입력하세요.' };

  const snowflake = extractSnowflake(raw);
  if (snowflake) {
    const [rows] = await pool.query('SELECT * FROM users WHERE discord_id = ? LIMIT 1', [snowflake]);
    if (rows[0]) return { user: rows[0] };
    if (createIfMissing) {
      const created = await getOrCreateUser(snowflake);
      return { user: created };
    }
    return { status: 404, error: `유저 '${snowflake}'를 찾을 수 없습니다.` };
  }

  const nick = raw.replace(/^@+/, '').trim();
  if (!nick) return { status: 400, error: '유저 ID 또는 닉네임을 입력하세요.' };

  const [exact] = await pool.query(
    'SELECT * FROM users WHERE username = ? ORDER BY created_at DESC LIMIT 5',
    [nick]
  );
  if (exact.length === 1) return { user: exact[0] };
  if (exact.length > 1) {
    return {
      status: 400,
      error: `닉네임 '${nick}'이 여러 명입니다. Discord ID를 입력하세요.`
    };
  }

  const [fuzzy] = await pool.query(
    `SELECT * FROM users
     WHERE username LIKE ? ESCAPE '\\\\'
     ORDER BY created_at DESC
     LIMIT 5`,
    [`%${escapeLike(nick)}%`]
  );
  if (fuzzy.length === 1) return { user: fuzzy[0] };
  if (fuzzy.length > 1) {
    const names = fuzzy.map((u) => `@${u.username} (${u.discord_id})`).join(', ');
    return {
      status: 400,
      error: `여러 유저가 검색됩니다: ${names}. Discord ID를 입력하세요.`
    };
  }
  return { status: 404, error: `유저 '${nick}'를 찾을 수 없습니다.` };
}

// 트랜잭션 헬퍼 - 풀에서 연결 가져와 BEGIN/COMMIT/ROLLBACK 관리
async function withTransaction(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (err) {
    await connection.rollback().catch(() => {});
    throw err;
  } finally {
    connection.release();
  }
}

// DELETE 직후 affectedRows를 다시 조회 (MySQL 특성상 직접 사용 불가)
async function getAffectedRows(connection, tableName) {
  try {
    // 방금 DELETE한 row count를 얻기 위해 ROW_COUNT() 사용
    const [rows] = await connection.query('SELECT ROW_COUNT() AS c');
    return rows[0] ? Number(rows[0].c) || 0 : 0;
  } catch (e) {
    return 0;
  }
}

function createAdminRoutes(getSessionUser) {
  const router = express.Router();

  const requireAdmin = async (req, res, next) => {
    const session = getSessionUser(req);
    const { isAdminAsync } = require('../../utils/adminAuth');
    const isAdm = session ? (config.isAdmin(session.id) || await isAdminAsync(session.id)) : false;
    if (!session || !isAdm) {
      return res.status(403).json({ success: false, error: '관리자 전용 권한이 필요합니다.' });
    }
    req.adminSession = session;
    next();
  };

  router.use(requireAdmin);

  const confirmationPaths = new Set([
    '/tax/collect',
    '/tax/policy',
    '/tax/policy/auto',
    '/tax/refund',
    '/tax/settle',
    '/loans/force',
    '/action/give',
    '/action/take',
    '/action/user-edit',
    '/action/reset',
    '/action/stock-price',
    '/action/stock-adjust-ratio',
    '/action/market-regime',
    '/security/ban',
    '/security/unban'
  ]);

  router.use((req, res, next) => {
    const requiresConfirmation = req.method === 'POST' && (
      confirmationPaths.has(req.path) || req.path.startsWith('/rollback/gambling/')
    );
    if (requiresConfirmation && (!req.body || req.body.confirm !== true)) {
      return res.status(400).json({ success: false, error: '확인 후 다시 실행하세요.' });
    }
    next();
  });

  router.get('/tax', async (req, res, next) => {
    if (isHtmlRequest(req)) return next();
    try {
      const tax = await getTaxOverview();
      return res.json(jsonSafe({ success: true, tax }));
    } catch (e) {
      return res.status(500).json({ success: false, error: '세금 현황을 불러오지 못했습니다.' });
    }
  });

  function taxFail(res, err, fallback) {
    const status = err.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(status).json({ success: false, error: err.message || fallback });
  }

  router.post('/tax/preview', async (req, res) => {
    try {
      const kind = String(req.body.kind || '');
      if (kind === 'user') {
        const resolved = await resolveTargetUser(req.body.userId, { createIfMissing: false });
        if (!resolved.user) return res.status(resolved.status || 404).json({ success: false, error: resolved.error });
        const preview = await previewCollectFromUser(resolved.user.discord_id, req.body.mode, req.body.value);
        return res.json({ success: true, preview });
      }
      if (kind === 'wealth') {
        return res.json({ success: true, preview: await previewWealthTax() });
      }
      if (kind === 'flat') {
        return res.json({ success: true, preview: await previewFlatCollect(req.body.mode, req.body.value) });
      }
      if (kind === 'settle') {
        return res.json({ success: true, preview: await previewSettleRefund(req.body.percent, req.body.hours) });
      }
      return res.status(400).json({ success: false, error: '미리보기 종류가 올바르지 않습니다.' });
    } catch (e) {
      return taxFail(res, e, '미리보기에 실패했습니다.');
    }
  });

  router.post('/tax/collect', async (req, res) => {
    const session = req.adminSession;
    if (req.body.confirm !== true) {
      return res.status(400).json({ success: false, error: '확인 후 다시 실행하세요.' });
    }
    try {
      const kind = String(req.body.kind || 'user');
      const why = clipReason(req.body.reason, '관리자 웹 세금 징수');
      let result;
      if (kind === 'user') {
        const resolved = await resolveTargetUser(req.body.userId, { createIfMissing: false });
        if (!resolved.user) return res.status(resolved.status || 404).json({ success: false, error: resolved.error });
        result = await collectFromUser(resolved.user.discord_id, req.body.mode, req.body.value, why);
      } else if (kind === 'wealth') {
        result = await collectWealthTax();
        result = {
          count: result.count,
          collected: result.collected.toString(),
          collectedText: formatMoney(result.collected)
        };
      } else if (kind === 'flat') {
        result = await collectFlatFromAll(req.body.mode, req.body.value, why);
      } else {
        return res.status(400).json({ success: false, error: '징수 종류가 올바르지 않습니다.' });
      }
      await logAdminAction(session.id, session.username || '관리자', 'WEB_TAX_COLLECT', kind, {
        kind,
        mode: req.body.mode,
        value: req.body.value,
        reason: why,
        result
      }, req);
      const tax = await getTaxOverview();
      return res.json({ success: true, result, tax, message: '세금 징수를 반영했습니다.' });
    } catch (e) {
      return taxFail(res, e, '세금 징수에 실패했습니다.');
    }
  });

  router.post('/tax/policy', async (req, res) => {
    const session = req.adminSession;
    try {
      const ratePct = req.body.rate;
      const threshold = req.body.threshold;
      const multiplier = req.body.multiplier;
      const payload = { locked: true };
      if (ratePct !== undefined && ratePct !== null && String(ratePct).trim() !== '') {
        payload.rate = Number(ratePct) / 100;
      }
      if (multiplier !== undefined && multiplier !== null && String(multiplier).trim() !== '') {
        payload.multiplier = Number(multiplier);
      }
      if (threshold !== undefined && threshold !== null && String(threshold).trim() !== '') {
        const parsed = parseGambleBet(threshold, 0n);
        payload.threshold = parsed !== null ? parsed.toString() : String(threshold);
      }
      const settings = await setTaxPolicyOverride(payload);
      await logAdminAction(session.id, session.username || '관리자', 'WEB_TAX_POLICY', 'lock', {
        rate: settings.taxRate,
        threshold: settings.wealthThresholdForTax,
        multiplier: settings.wealthTaxMultiplier
      }, req);
      const tax = await getTaxOverview();
      return res.json({
        success: true,
        tax,
        message: `누진 재산세율 승수 ×${Number(settings.wealthTaxMultiplier || 1).toFixed(1)}, 거래세율 ${(settings.taxRate * 100).toFixed(1)}%, 기준 ${formatMoney(settings.wealthThresholdForTax)} 로 저장 및 잠금 완료했습니다.`
      });
    } catch (e) {
      return taxFail(res, e, '세금 정책 변경에 실패했습니다.');
    }
  });

  router.post('/tax/policy/auto', async (req, res) => {
    const session = req.adminSession;
    try {
      await setTaxPolicyOverride({ locked: false });
      await logAdminAction(session.id, session.username || '관리자', 'WEB_TAX_POLICY', 'auto', {}, req);
      const tax = await getTaxOverview();
      return res.json({ success: true, tax, message: '세금 정책을 자동 조절에 맡겼습니다. 다음 주기부터 세율이 다시 계산됩니다.' });
    } catch (e) {
      return taxFail(res, e, '자동 조절 전환에 실패했습니다.');
    }
  });

  router.post('/tax/refund', async (req, res) => {
    const session = req.adminSession;
    try {
      const resolved = await resolveTargetUser(req.body.userId, { createIfMissing: false });
      if (!resolved.user) return res.status(resolved.status || 404).json({ success: false, error: resolved.error });
      const why = clipReason(req.body.reason, '국고 연말정산 환급');
      const result = await refundFromTreasury(resolved.user.discord_id, req.body.amount, why);
      await logAdminAction(session.id, session.username || '관리자', 'WEB_TAX_REFUND', resolved.user.discord_id, result, req);
      const tax = await getTaxOverview();
      return res.json({
        success: true,
        result,
        tax,
        message: `[@${result.username}]에게 ${result.gaveText} 환급했습니다. 국고 ${formatMoney(result.treasury)}`
      });
    } catch (e) {
      return taxFail(res, e, '환급에 실패했습니다.');
    }
  });

  router.post('/tax/withdraw', async (req, res) => {
    const session = req.adminSession;
    try {
      let targetUserId = session.id;
      if (req.body.userId && String(req.body.userId).trim() !== '') {
        const resolved = await resolveTargetUser(req.body.userId, { createIfMissing: false });
        if (resolved.user) targetUserId = resolved.user.discord_id;
      }
      const why = clipReason(req.body.reason, '관리자 국고 인출');
      const result = await withdrawTreasuryByAdmin(session.id, req.body.amount, targetUserId, why);
      await logAdminAction(session.id, session.username || '관리자', 'WEB_TAX_WITHDRAW', targetUserId, result, req);
      const tax = await getTaxOverview();
      return res.json({
        success: true,
        result,
        tax,
        message: `국고에서 ${result.withdrawnText}을 출금하여 [@${result.recipientName}] 지갑으로 지급했습니다. (국고 잔액: ${result.treasuryText})`
      });
    } catch (e) {
      return taxFail(res, e, '국고 출금에 실패했습니다.');
    }
  });

  router.post('/tax/settle', async (req, res) => {
    const session = req.adminSession;
    if (req.body.confirm !== true) {
      return res.status(400).json({ success: false, error: '확인 후 다시 실행하세요.' });
    }
    try {
      const result = await settleTaxRefund(req.body.percent, req.body.hours, clipReason(req.body.reason, '연말정산 환급'));
      await logAdminAction(session.id, session.username || '관리자', 'WEB_TAX_SETTLE', 'settle', result, req);
      const tax = await getTaxOverview();
      return res.json({
        success: true,
        result,
        tax,
        message: `연말정산 ${result.count}명에게 ${result.givenText} 환급. 남은 국고 ${result.leftoverText}`
      });
    } catch (e) {
      return taxFail(res, e, '연말정산에 실패했습니다.');
    }
  });

  router.get('/loans', async (req, res, next) => {
    if (isHtmlRequest(req)) return next();
    try {
      const loans = await listLoansAdmin(40);
      return res.json(jsonSafe({ success: true, ...loans }));
    } catch (e) {
      return res.status(500).json({ success: false, error: '대출 목록을 불러오지 못했습니다.' });
    }
  });

  router.post('/loans/force', async (req, res) => {
    const session = req.adminSession;
    if (req.body.confirm !== true) {
      return res.status(400).json({ success: false, error: '확인 후 다시 실행하세요.' });
    }
    try {
      const resolved = await resolveTargetUser(req.body.userId, { createIfMissing: false });
      if (!resolved.user) return res.status(resolved.status || 404).json({ success: false, error: resolved.error });
      const loan = await adminForceLoan(resolved.user.discord_id);
      await logAdminAction(session.id, session.username || '관리자', 'WEB_LOAN_FORCE', resolved.user.discord_id, {
        targetName: resolved.user.username,
        loan
      }, req);
      const list = await listLoansAdmin(40);
      return res.json({
        success: true,
        loan,
        ...list,
        message: `[@${resolved.user.username}] 대출을 강제 회수했습니다.`
      });
    } catch (e) {
      const status = e.code === 'NONE' ? 404 : (Number(e.status) || 400);
      return res.status(status).json({ success: false, error: e.message || '강제 회수에 실패했습니다.' });
    }
  });

  router.get('/users', async (req, res, next) => {
    if (isHtmlRequest(req)) return next();
    try {
      const q = String(req.query.q || '').trim();
      const params = [];
      let where = '';
      if (q) {
        const snowflake = extractSnowflake(q);
        if (snowflake) {
          where = 'WHERE u.discord_id = ?';
          params.push(snowflake);
        } else {
          const nick = q.replace(/^@+/, '').trim();
          where = 'WHERE u.discord_id = ? OR u.username = ? OR u.username LIKE ? ESCAPE \'\\\\\'';
          params.push(nick, nick, `%${escapeLike(nick)}%`);
        }
      }
      const [rows] = await pool.query(
        `${WEALTH_SELECT}
         ${where}
         GROUP BY u.discord_id, u.username, u.cash, u.bank
         ORDER BY net_worth DESC
         LIMIT 100`,
        params
      );
      return res.json(jsonSafe({
        success: true,
        total: rows.length,
        users: rows.map(serializeWealth)
      }));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  // 📊 특정 유저의 보유 주식 상세 포트폴리오 조회 API
  router.get('/users/:userId/stocks', async (req, res) => {
    try {
      const targetId = String(req.params.userId);
      const [userRows] = await pool.query('SELECT username, cash, bank FROM users WHERE discord_id = ? LIMIT 1', [targetId]);
      if (!userRows.length) return res.status(404).json({ success: false, error: '유저를 찾을 수 없습니다.' });

      const [stocks] = await pool.query(`
        SELECT us.stock_id, us.amount, us.total_spent, s.name, s.price, s.prev_price
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.user_id = ? AND us.amount > 0
        ORDER BY (us.amount * s.price) DESC
      `, [targetId]);

      let totalStockVal = 0n;
      let totalSpent = 0n;

      const portfolio = stocks.map(s => {
        const amt = Number(s.amount);
        const curPrice = safeBigInt(s.price);
        const spent = safeBigInt(s.total_spent);
        const evalVal = safeBigInt(Math.floor(amt * Number(curPrice)));
        const profit = evalVal - spent;
        const roi = spent > 0n ? ((Number(profit) / Number(spent)) * 100).toFixed(2) : '0.00';
        const avgPrice = amt > 0 ? safeBigInt(Math.floor(Number(spent) / amt)) : 0n;

        totalStockVal += evalVal;
        totalSpent += spent;

        return {
          stockId: s.stock_id,
          name: s.name,
          amount: amt,
          amountText: amt.toLocaleString() + '주',
          currentPrice: curPrice.toString(),
          currentPriceText: formatMoney(curPrice),
          avgPrice: avgPrice.toString(),
          avgPriceText: formatMoney(avgPrice),
          totalSpent: spent.toString(),
          totalSpentText: formatMoney(spent),
          evalValue: evalVal.toString(),
          evalValueText: formatMoney(evalVal),
          profit: profit.toString(),
          profitText: (profit >= 0n ? '+' : '') + formatMoney(profit),
          roiPercent: roi,
          isProfit: profit >= 0n
        };
      });

      const totalProfit = totalStockVal - totalSpent;
      const totalRoi = totalSpent > 0n ? ((Number(totalProfit) / Number(totalSpent)) * 100).toFixed(2) : '0.00';

      return res.json(jsonSafe({
        success: true,
        user: {
          discordId: targetId,
          username: userRows[0].username || '알수없음',
          cashText: formatMoney(safeBigInt(userRows[0].cash)),
          bankText: formatMoney(safeBigInt(userRows[0].bank)),
          totalStockValText: formatMoney(totalStockVal),
          totalSpentText: formatMoney(totalSpent),
          totalProfitText: (totalProfit >= 0n ? '+' : '') + formatMoney(totalProfit),
          totalRoiPercent: totalRoi
        },
        portfolio
      }));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '보유 주식 목록을 불러오지 못했습니다.' });
    }
  });

  // 📊 전체 유저 주식 보유 현황 및 주주 명부 API
  router.get('/stocks/portfolios/all', async (req, res) => {
    try {
      const [rows] = await pool.query(`
        SELECT 
          us.user_id,
          u.username,
          us.stock_id,
          s.name AS stock_name,
          us.amount,
          us.total_spent,
          s.price AS current_price,
          CAST(ROUND(us.amount * s.price) AS DECIMAL(65,0)) AS eval_val
        FROM user_stocks us
        JOIN users u ON us.user_id = u.discord_id
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.amount > 0
        ORDER BY eval_val DESC
        LIMIT 200
      `);

      const list = rows.map(r => {
        const amt = Number(r.amount);
        const curPrice = safeBigInt(r.current_price);
        const spent = safeBigInt(r.total_spent);
        const evalVal = safeBigInt(r.eval_val);
        const profit = evalVal - spent;
        const roi = spent > 0n ? ((Number(profit) / Number(spent)) * 100).toFixed(2) : '0.00';
        const avgPrice = amt > 0 ? safeBigInt(Math.floor(Number(spent) / amt)) : 0n;

        return {
          userId: r.user_id,
          username: r.username || '알수없음',
          stockId: r.stock_id,
          stockName: r.stock_name,
          amount: amt,
          amountText: amt.toLocaleString() + '주',
          currentPriceText: formatMoney(curPrice),
          avgPriceText: formatMoney(avgPrice),
          totalSpentText: formatMoney(spent),
          evalValueText: formatMoney(evalVal),
          profitText: (profit >= 0n ? '+' : '') + formatMoney(profit),
          roiPercent: roi,
          isProfit: profit >= 0n
        };
      });

      return res.json(jsonSafe({
        success: true,
        total: list.length,
        list
      }));
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '전체 주식 보유 현황을 불러오지 못했습니다.' });
    }
  });

  // 🚨 관리자 주식 강제 판매 (강제 매도 처분) API
  router.post('/stocks/force-sell', async (req, res) => {
    const session = req.adminSession;
    const { userId, stockId, amount } = req.body;
    if (!userId || !stockId) {
      return res.status(400).json({ success: false, error: '유저 ID와 종목 코드를 입력하세요.' });
    }

    try {
      const targetId = String(userId).trim();
      const sId = String(stockId).toUpperCase().trim();

      // 1. 유저 보유 주식 확인
      const [holdRows] = await pool.query(
        'SELECT amount, total_spent FROM user_stocks WHERE user_id = ? AND stock_id = ? LIMIT 1',
        [targetId, sId]
      );
      if (!holdRows.length || Number(holdRows[0].amount) <= 0) {
        return res.status(400).json({ success: false, error: '해당 유저는 해당 주식을 보유하고 있지 않습니다.' });
      }

      const curHoldAmt = Number(holdRows[0].amount);
      const curSpent = safeBigInt(holdRows[0].total_spent);

      // 매도 수량 결정
      let sellAmt = curHoldAmt;
      if (amount && amount !== 'all' && Number(amount) > 0) {
        sellAmt = Math.min(curHoldAmt, Math.floor(Number(amount)));
      }
      if (sellAmt <= 0) {
        return res.status(400).json({ success: false, error: '판매할 수량이 0보다 커야 합니다.' });
      }

      // 2. 현재 종목 시세 확인
      const [sRows] = await pool.query('SELECT name, price FROM stocks WHERE stock_id = ? LIMIT 1', [sId]);
      if (!sRows.length) return res.status(404).json({ success: false, error: '종목 정보를 찾을 수 없습니다.' });

      const stockName = sRows[0].name;
      const curPrice = safeBigInt(sRows[0].price);
      const refundAmount = curPrice * BigInt(sellAmt);

      // 3. user_stocks 차감 / 삭제
      const remainAmt = curHoldAmt - sellAmt;
      if (remainAmt <= 0) {
        await pool.query('DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?', [targetId, sId]);
      } else {
        const newSpent = curSpent * BigInt(remainAmt) / BigInt(curHoldAmt);
        await pool.query(
          'UPDATE user_stocks SET amount = ?, total_spent = ? WHERE user_id = ? AND stock_id = ?',
          [remainAmt, newSpent.toString(), targetId, sId]
        );
      }

      // 4. 유저 현금으로 환급 지급
      const cashRes = await applyCashDelta(targetId, refundAmount);

      // 5. 경제 로그 및 주식 로그 기록
      try {
        await pool.query(`
          INSERT INTO economy_logs (user_id, type, amount, balance_after, note, ip)
          VALUES (?, 'ADMIN_FORCE_SELL', ?, ?, ?, ?)
        `, [
          targetId,
          refundAmount.toString(),
          cashRes.cashAfter.toString(),
          `관리자 강제매도: ${stockName}(${sId}) ${sellAmt.toLocaleString()}주 @ ${formatMoney(curPrice)} (총 ${formatMoney(refundAmount)} 환급)`,
          req.ip || 'admin'
        ]);
      } catch (e) {}

      return res.json(jsonSafe({
        success: true,
        message: `@${targetId} 님의 ${stockName}(${sId}) ${sellAmt.toLocaleString()}주를 강제 매도하여 ${formatMoney(refundAmount)}을 현금으로 환급했습니다.`,
        soldAmount: sellAmt,
        refundAmount: refundAmount.toString(),
        refundAmountText: formatMoney(refundAmount),
        remainingAmount: remainAmt
      }));
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, error: '강제 매도 처리 중 오류가 발생했습니다.' });
    }
  });

  // 🎁 관리자: 전원 경기부양 재난지원금 일괄 에어드랍 API
  router.post('/action/airdrop', async (req, res) => {
    const { amount, reason } = req.body;
    let pAmt;
    try {
      pAmt = parseAdminMoney(amount || '100만');
    } catch (e) {
      return res.status(400).json({ success: false, error: '금액이 올바르지 않습니다.' });
    }
    if (!pAmt || pAmt <= 0n) return res.status(400).json({ success: false, error: '1원 이상이어야 합니다.' });

    try {
      const [users] = await pool.query('SELECT discord_id, username FROM users');
      let successCount = 0;
      for (const u of users) {
        try {
          await applyCashDelta(u.discord_id, pAmt);
          successCount++;
        } catch (e) {}
      }

      return res.json(jsonSafe({
        success: true,
        message: `총 ${successCount}명의 모든 유저에게 경기부양 지원금 ${formatMoney(pAmt)}씩 지급 완료되었습니다!`,
        count: successCount,
        amountText: formatMoney(pAmt)
      }));
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 🕵️ 특정 감시 대상 유저 (@dlhaslflkgh 등) 독립 정밀 관제 및 전체 로그 API
  router.get('/audit/target-user', async (req, res) => {
    const targetQuery = String(req.query.user || 'dlhaslflkgh').trim();
    try {
      // 1. 유저 정보 조회
      let [uRows] = await pool.query(
        'SELECT discord_id, username, cash, bank, created_at FROM users WHERE username LIKE ? OR discord_id = ? LIMIT 1',
        [`%${targetQuery}%`, targetQuery]
      );
      if (!uRows.length) {
        [uRows] = await pool.query('SELECT discord_id, username, cash, bank, created_at FROM users WHERE username = "dlhaslflkgh" LIMIT 1');
      }
      const user = uRows.length ? uRows[0] : { discord_id: '1481258930909872239', username: 'dlhaslflkgh', cash: 0, bank: 0 };
      const uid = user.discord_id;
      const uname = user.username;

      // 2. 전용 독립 감사 로그 조회 (user_dedicated_audit_logs) - IP 비노출
      let dedicatedLogs = [];
      try {
        const [dRows] = await pool.query(`
          SELECT id, user_id, username, category, action, amount, balance_after, country, details, created_at
          FROM user_dedicated_audit_logs 
          WHERE user_id = ? OR username LIKE ?
          ORDER BY id DESC LIMIT 150
        `, [uid, `%${uname}%`]);
        dedicatedLogs = dRows;
      } catch (e) {}

      // 3. 사이트 접속 기록 (web_access_logs) - 보안 침입 추적용 IP 제공
      const [webLogs] = await pool.query(`
        SELECT id, ip, country, country_name, city, method, url, status_code, duration_ms, user_agent, created_at
        FROM web_access_logs
        WHERE user_id = ? OR username LIKE ?
        ORDER BY id DESC LIMIT 60
      `, [uid, `%${uname}%`]);

      // 4. 자금 이동 기록 (economy_logs)
      const [ecoLogs] = await pool.query(`
        SELECT id, type, amount, balance_before, balance_after, description, created_at
        FROM economy_logs
        WHERE user_id = ?
        ORDER BY id DESC LIMIT 60
      `, [uid]);

      // 5. 도박 기록 (gambling_logs)
      const [gambleLogs] = await pool.query(`
        SELECT id, game, bet, payout, profit, balance_before, balance_after, is_rolled_back, created_at
        FROM gambling_logs
        WHERE user_id = ?
        ORDER BY id DESC LIMIT 50
      `, [uid]);

      // 6. 주식 거래 (stock_transactions)
      const [stockLogs] = await pool.query(`
        SELECT st.*, s.name as stock_name
        FROM stock_transactions st
        JOIN stocks s ON st.stock_id = s.stock_id
        WHERE st.user_id = ?
        ORDER BY st.id DESC LIMIT 50
      `, [uid]);

      return res.json(jsonSafe({
        success: true,
        user: {
          discordId: uid,
          username: uname,
          cashText: formatMoney(safeBigInt(user.cash)),
          bankText: formatMoney(safeBigInt(user.bank))
        },
        dedicatedLogs,
        webLogs,
        ecoLogs,
        gambleLogs,
        stockLogs
      }));
    } catch (err) {
      console.error('감사 로그 조회 에러:', err);
      return res.status(500).json({ success: false, error: '감사 로그 조회 실패' });
    }
  });

  router.post('/action/give', async (req, res) => {
    const session = req.adminSession;
    const { userId, amount, reason, unit, source } = req.body;
    const isTreasurySource = (source === 'treasury' || req.body.isTreasury === true);

    if (!userId || amount === undefined || amount === null || String(amount).trim() === '') {
      return res.status(400).json({ success: false, error: '유저 ID(또는 닉네임)와 금액을 입력하세요.' });
    }
    if (isAllInAmount(amount)) {
      return res.status(400).json({ success: false, error: '지급에는 전액/올인을 쓸 수 없습니다. 금액을 숫자나 5만처럼 입력하세요.' });
    }

    let parsedAmount;
    try {
      parsedAmount = parseAdminMoney(amount, unit);
    } catch (e) {
      if (e && e.code === 'MONEY_OVERFLOW') {
        return res.status(400).json({ success: false, error: e.message });
      }
      throw e;
    }
    if (!parsedAmount || parsedAmount <= 0n) {
      return res.status(400).json({ success: false, error: '금액은 1원 이상이어야 합니다. (예: 50000, 5만, 500양)' });
    }

    try {
      const resolved = await resolveTargetUser(userId, { createIfMissing: true });
      if (!resolved.user) return res.status(resolved.status || 404).json({ success: false, error: resolved.error });

      const targetId = resolved.user.discord_id;
      const targetName = resolved.user.username || `유저_${String(targetId).slice(-4)}`;
      const why = clipReason(reason, isTreasurySource ? '국고 특별 지원금' : '관리자 직권 지급');
      const { before, after } = await applyCashGiveLocked(targetId, parsedAmount);

      let newTreasuryVal = null;
      if (isTreasurySource) {
        // 국고에서 차감
        const { takeTreasury } = require('../../utils/taxEngine');
        const { treasury } = await takeTreasury(parsedAmount, true);
        newTreasuryVal = treasury;

        await pool.query(`
          INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
          VALUES (?, ?, 'TAX_REFUND', ?, ?, ?, ?)
        `, [
          targetId,
          targetName,
          parsedAmount.toString(),
          before.toString(),
          after.toString(),
          `🏛️ [국고 지원금 지급] +${formatMoney(parsedAmount)} (국고 잔액: ${formatMoney(treasury)}, 사유: ${why})`
        ]);
      } else {
        // 일반 관리자 직권 지급 (국고 무관)
        await pool.query(`
          INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
          VALUES (?, ?, 'ADMIN_GIVE', ?, ?, ?, ?)
        `, [
          targetId,
          targetName,
          parsedAmount.toString(),
          before.toString(),
          after.toString(),
          `👑 [관리자 직권 지급] +${formatMoney(parsedAmount)} (사유: ${why})`
        ]);
      }

      await logAdminAction(session.id, session.username || '관리자', isTreasurySource ? 'WEB_GIVE_TREASURY' : 'WEB_GIVE_MONEY', targetId, {
        amount: parsedAmount.toString(),
        targetName,
        source: isTreasurySource ? 'treasury' : 'direct',
        reason: why,
        treasuryLeft: newTreasuryVal ? newTreasuryVal.toString() : undefined,
        beforeCash: before.toString(),
        afterCash: after.toString()
      }, req);

      const user = await getWealthRow(targetId);
      return res.json({
        success: true,
        message: isTreasurySource
          ? `🏛️ [@${targetName}]님에게 국고에서 ${formatMoney(parsedAmount)}을 차감 지원했습니다. (국고 잔액: ${formatMoney(newTreasuryVal)}, 현금 ${formatMoney(before)} → ${formatMoney(after)})`
          : `⚡ [@${targetName}]님에게 직권으로 ${formatMoney(parsedAmount)}을 지급했습니다. (국고 미차감, 현금 ${formatMoney(before)} → ${formatMoney(after)})`,
        isTreasury: isTreasurySource,
        treasury: newTreasuryVal ? newTreasuryVal.toString() : undefined,
        actualAmount: parsedAmount.toString(),
        actualAmountText: formatMoney(parsedAmount),
        beforeCash: before.toString(),
        afterCash: after.toString(),
        user
      });
    } catch (e) {
      if (e && e.code === 'MONEY_OVERFLOW') {
        return res.status(400).json({ success: false, error: e.message });
      }
      console.error(e);
      return res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  router.post('/action/take', async (req, res) => {
    const session = req.adminSession;
    const { userId, amount, reason, unit } = req.body;
    if (!userId || amount === undefined || amount === null || String(amount).trim() === '') {
      return res.status(400).json({ success: false, error: '유저 ID(또는 닉네임)와 금액을 입력하세요.' });
    }

    try {
      const resolved = await resolveTargetUser(userId, { createIfMissing: false });
      if (!resolved.user) return res.status(resolved.status || 404).json({ success: false, error: resolved.error });

      const targetId = resolved.user.discord_id;
      const targetName = resolved.user.username || `유저_${String(targetId).slice(-4)}`;
      const why = clipReason(reason, '관리자 수동 회수');
      const allowNegative = req.body.allowNegative !== false; // 기본적으로 마이너스 잔고 허용

      let requested;
      if (isAllInAmount(amount)) {
        requested = 'ALL';
      } else {
        requested = parseAdminMoney(amount, unit);
        if (!requested || requested <= 0n) {
          return res.status(400).json({ success: false, error: '금액은 1원 이상이어야 합니다. (예: 50000, 5만, 500양, 전액)' });
        }
      }

      const result = await applyCashTakeClamped(targetId, requested, { allowNegative });

      await pool.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'ADMIN_TAKE', ?, ?, ?, ?)
      `, [
        targetId,
        targetName,
        result.actual.toString(),
        result.before.toString(),
        result.after.toString(),
        `👑 [웹 관리자 회수] -${formatMoney(result.actual)} (사유: ${why})`
      ]);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_TAKE_MONEY', targetId, {
        requested: result.requested.toString(),
        actual: result.actual.toString(),
        targetName,
        reason: why,
        beforeCash: result.before.toString(),
        afterCash: result.after.toString()
      }, req);

      const user = await getWealthRow(targetId);
      const isNegative = safeBigInt(result.after) < 0n;
      const debtNote = isNegative ? ' ⚠️ (마이너스 빚/채무 잔고 발생)' : '';
      return res.json({
        success: true,
        message: `[@${targetName}]님에게서 ${formatMoney(result.actual)}을 회수했습니다.${debtNote} (현금 ${formatMoney(result.before)} → ${formatMoney(result.after)})`,
        actualAmount: result.actual.toString(),
        actualAmountText: formatMoney(result.actual),
        requestedAmount: result.requested.toString(),
        beforeCash: result.before.toString(),
        afterCash: result.after.toString(),
        user
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  // ✏️ [관리자] 유저 정보 통합 수정 (DB 트랜잭션 보장)
  // - username / cash / bank / clicker_level / auto_miner_level / daily_streak / gamble_turns / total_clicks 수정 가능
  // - 변경 전/후 값 모두 audit_logs 에 남김
  router.post('/action/user-edit', async (req, res) => {
    const session = req.adminSession;
    const { userId, reason, fields, confirm } = req.body || {};
    if (!userId) return res.status(400).json({ success: false, error: '유저 ID(또는 닉네임)를 입력하세요.' });
    if (!confirm) return res.status(400).json({ success: false, error: '위험 작업 확인(confirm=true)이 필요합니다.' });
    if (!fields || typeof fields !== 'object') return res.status(400).json({ success: false, error: '수정할 필드가 없습니다.' });

    // 허용 필드와 변환 함수 (화이트리스트 기반 안전 처리)
    const ALLOWED_FIELDS = {
      username: (v) => {
        const s = String(v || '').trim().slice(0, 100);
        return s || null;
      },
      cash: (v) => {
        const n = safeBigInt(v);
        if (n < 0n) throw new Error('cash는 0 이상이어야 합니다.');
        return n;
      },
      bank: (v) => {
        const n = safeBigInt(v);
        if (n < 0n) throw new Error('bank는 0 이상이어야 합니다.');
        return n;
      },
      clicker_level: (v) => {
        const n = Math.max(1, Math.min(9999, parseInt(v, 10) || 1));
        return n;
      },
      auto_miner_level: (v) => {
        const n = Math.max(0, Math.min(9999, parseInt(v, 10) || 0));
        return n;
      },
      daily_streak: (v) => {
        const n = Math.max(0, Math.min(99999, parseInt(v, 10) || 0));
        return n;
      },
      gamble_turns: (v) => {
        const n = Math.max(0, Math.min(99999, parseInt(v, 10) || 0));
        return n;
      },
      total_clicks: (v) => {
        const n = safeBigInt(v);
        if (n < 0n) throw new Error('total_clicks는 0 이상이어야 합니다.');
        return n;
      }
    };

    const updates = [];
    const values = [];
    const changes = [];
    for (const [key, raw] of Object.entries(fields)) {
      if (!ALLOWED_FIELDS[key]) continue;
      try {
        const parsed = ALLOWED_FIELDS[key](raw);
        if (parsed === undefined || parsed === null) continue;
        updates.push(`${key} = ?`);
        values.push(typeof parsed === 'bigint' ? parsed.toString() : parsed);
        changes.push({ field: key, raw: typeof parsed === 'bigint' ? parsed.toString() : parsed });
      } catch (e) {
        return res.status(400).json({ success: false, error: `${key} 값 오류: ${e.message}` });
      }
    }
    if (!updates.length) return res.status(400).json({ success: false, error: '수정 가능한 필드가 전달되지 않았습니다.' });

    try {
      const resolved = await resolveTargetUser(userId, { createIfMissing: false });
      if (!resolved.user) return res.status(resolved.status || 404).json({ success: false, error: resolved.error });
      const targetId = resolved.user.discord_id;
      const targetName = resolved.user.username || `유저_${String(targetId).slice(-4)}`;
      const why = clipReason(reason, '관리자 웹 유저 정보 수정');

      const connection = await pool.getConnection();
      let before;
      try {
        await connection.beginTransaction();
        const [rows] = await connection.query(
          'SELECT discord_id, username, cash, bank, clicker_level, auto_miner_level, daily_streak, gamble_turns, total_clicks FROM users WHERE discord_id = ? FOR UPDATE',
          [targetId]
        );
        if (!rows.length) {
          await connection.rollback();
          return res.status(404).json({ success: false, error: '유저를 찾을 수 없습니다.' });
        }
        before = rows[0];
        values.push(targetId);
        await connection.query(
          `UPDATE users SET ${updates.join(', ')} WHERE discord_id = ?`,
          values
        );
        await connection.commit();
      } catch (err) {
        try { await connection.rollback(); } catch (e) {}
        throw err;
      } finally {
        connection.release();
      }

      const after = await getWealthRow(targetId);

      // 변경 사항을 economy_logs에도 흔적 남김 (감사 추적용)
      const summary = changes.map((c) => `${c.field}: ${String(before[c.field] ?? 'null')} → ${c.raw}`).join(', ');
      await pool.query(
        `INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
         VALUES (?, ?, 'ADMIN_EDIT', 0, ?, ?, ?)`,
        [
          targetId,
          targetName,
          safeBigInt(before.cash).toString(),
          safeBigInt(after.cash).toString(),
          `👑 [관리자 유저 수정] ${summary} (사유: ${why})`.slice(0, 255)
        ]
      );

      await logAdminAction(session.id, session.username || '관리자', 'WEB_EDIT_USER', targetId, {
        targetName,
        reason: why,
        before: {
          username: before.username,
          cash: String(before.cash ?? 0),
          bank: String(before.bank ?? 0),
          clicker_level: before.clicker_level,
          auto_miner_level: before.auto_miner_level,
          daily_streak: before.daily_streak,
          gamble_turns: before.gamble_turns,
          total_clicks: String(before.total_clicks ?? 0)
        },
        changes
      }, req);

      try { pushUserLive(targetId); } catch (e) {}

      return res.json({
        success: true,
        message: `[@${targetName}]님의 정보 ${changes.length}개 항목을 수정했습니다.`,
        changes,
        before: {
          username: before.username,
          cash: String(before.cash ?? 0),
          bank: String(before.bank ?? 0),
          clicker_level: before.clicker_level,
          auto_miner_level: before.auto_miner_level,
          daily_streak: before.daily_streak,
          gamble_turns: before.gamble_turns,
          total_clicks: String(before.total_clicks ?? 0)
        },
        user: after
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '처리 중 오류가 발생했습니다.' });
    }
  });

  // 🔍 [관리자] 유저 단일 조회 API (수정 모달 초기값 로드용)
  router.get('/users/:userId/profile', async (req, res) => {
    try {
      const targetId = String(req.params.userId);
      const [rows] = await pool.query(
        `SELECT discord_id, username, avatar, cash, bank,
                clicker_level, auto_miner_level, daily_streak, gamble_turns, total_clicks,
                last_daily, last_work, last_subsidy, is_banned, banned_until, ban_reason,
                created_at
         FROM users WHERE discord_id = ? LIMIT 1`,
        [targetId]
      );
      if (!rows.length) return res.status(404).json({ success: false, error: '유저를 찾을 수 없습니다.' });

      const r = rows[0];
      return res.json({
        success: true,
        profile: {
          discordId: String(r.discord_id),
          username: r.username || '',
          avatar: r.avatar || '',
          cash: String(r.cash ?? 0),
          bank: String(r.bank ?? 0),
          clicker_level: r.clicker_level ?? 1,
          auto_miner_level: r.auto_miner_level ?? 0,
          daily_streak: r.daily_streak ?? 0,
          gamble_turns: r.gamble_turns ?? 50,
          total_clicks: String(r.total_clicks ?? 0),
          isBanned: !!r.is_banned,
          bannedUntil: r.banned_until,
          banReason: r.ban_reason,
          createdAt: r.created_at
        }
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '유저 정보를 불러오지 못했습니다.' });
    }
  });

  // 🧹 [전체 유저 일괄 초기화] 관리자 페이지에서 호출 (스크립트와 동일 로직)
  // dataTables: ['users', 'user_stocks', 'user_businesses', 'gambling_logs', 'stock_transactions', 'economy_logs', 'inquiries', 'web_access_logs']
  router.post('/action/reset-all', async (req, res) => {
    const session = req.adminSession;
    const tables = Array.isArray(req.body && req.body.tables) ? req.body.tables : null;
    if (!Array.isArray(tables) || tables.length === 0) {
      return res.status(400).json({ success: false, error: '초기화할 테이블을 선택하세요.' });
    }
    const allow = new Set(['users', 'user_stocks', 'user_businesses', 'gambling_logs', 'stock_transactions', 'economy_logs', 'user_loan_credit']);
    const filtered = Array.from(new Set(tables.filter(t => typeof t === 'string' && allow.has(t))));
    if (filtered.length === 0) return res.status(400).json({ success: false, error: '유효한 테이블이 없습니다.' });

    const adminIds = (config.adminIds || []).map(String);
    const ph = adminIds.length > 0 ? adminIds.map(() => '?').join(',') : '?';
    const params = adminIds.length > 0 ? adminIds : ['__no_admin__'];

    let summary = { usersReset: 0, stocksDeleted: 0, businessesDeleted: 0, gamblingLogsDeleted: 0, stockTxDeleted: 0, ecoLogsDeleted: 0, loansDeleted: 0 };

    try {
      await withTransaction(async (cn) => {
        if (filtered.includes('users')) {
          const [r] = await cn.query(
            `UPDATE users
             SET cash = 10000, bank = 0,
                 clicker_level = 1, auto_miner_level = 0, total_clicks = 0, daily_streak = 0,
                 last_daily = NULL, last_work = NULL, last_subsidy = NULL,
                 gamble_turns = 50, last_turn_update = NOW(),
                 mine_genre = 'classic',
                 is_banned = 0, banned_until = NULL, ban_reason = NULL, banned_at = NULL, banned_by = NULL
             WHERE discord_id NOT IN (${ph})`, params);
          summary.usersReset = r.affectedRows;

          await cn.query(
            `INSERT INTO economy_settings (key_name, value) VALUES ('taxTreasury', '0')
             ON DUPLICATE KEY UPDATE value = '0'`);
        }
        if (filtered.includes('user_stocks')) {
          const [r] = await cn.query(
            `DELETE FROM user_stocks WHERE user_id NOT IN (${ph})`, params);
          summary.stocksDeleted = r.affectedRows;
        }
        if (filtered.includes('user_businesses')) {
          const [r1] = await cn.query(
            `DELETE FROM user_businesses WHERE user_id NOT IN (${ph})`, params);
          const [r2] = await cn.query(
            `DELETE FROM user_business_meta WHERE user_id NOT IN (${ph})`, params);
          summary.businessesDeleted = r1.affectedRows;
        }
        if (filtered.includes('user_loan_credit')) {
          const [r] = await cn.query(
            `DELETE FROM user_loan_credit WHERE user_id NOT IN (${ph})`, params);
          summary.loansDeleted = r.affectedRows;
        }
        if (filtered.includes('gambling_logs')) {
          const [r] = await cn.query(
            `DELETE FROM gambling_logs WHERE user_id NOT IN (${ph})`, params);
          summary.gamblingLogsDeleted = r.affectedRows;
        }
        if (filtered.includes('stock_transactions')) {
          const [r] = await cn.query(
            `DELETE FROM stock_transactions WHERE user_id NOT IN (${ph})`, params);
          summary.stockTxDeleted = r.affectedRows;
        }
        if (filtered.includes('economy_logs')) {
          const [r] = await cn.query(
            `DELETE FROM economy_logs WHERE user_id NOT IN (${ph})`, params);
          summary.ecoLogsDeleted = r.affectedRows;
        }

        try {
          await cn.query(
            `DELETE FROM command_logs WHERE user_id NOT IN (${ph})`, params);
        } catch (e) {}
        try {
          await cn.query(
            `DELETE FROM web_access_logs WHERE user_id NOT IN (${ph})`, params);
        } catch (e) {}
      });

      // 모든 유저 캐시 + 라이브 푸시 무효화
      try {
        const ls = require('../../utils/liveSync');
        if (typeof ls.invalidateUser === 'function') {
          // 봇을 통해 모든 사용자 broadcast 갱신
          if (typeof ls.broadcastUserRefresh === 'function') {
            // Invalidate everyone by pulling their fresh snapshot next request
            snapshotCache && snapshotCache.clear && snapshotCache.clear();
          }
        }
      } catch (e) {}

      // admin_logs에 기록
      try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        await pool.query(
          `INSERT INTO admin_logs (admin_id, admin_username, action, details, ip)
           VALUES (?, ?, ?, ?, ?)`,
          [String(session.id), session.username || 'admin', 'RESET_ALL_USERS',
           JSON.stringify({ tables: filtered, summary }), ip]
        );
      } catch (e) {}

      return res.json({
        success: true,
        message: `전체 일반 유저 데이터 초기화 완료 (${summary.usersReset}명)`,
        summary
      });
    } catch (e) {
      console.error('[/action/reset-all]', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  router.post('/action/reset', async (req, res) => {
    const session = req.adminSession;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: '유저 ID(또는 닉네임)를 입력하세요.' });

    try {
      const resolved = await resolveTargetUser(userId, { createIfMissing: false });
      if (!resolved.user) return res.status(resolved.status || 404).json({ success: false, error: resolved.error });

      const targetId = resolved.user.discord_id;
      const targetName = resolved.user.username || `유저_${String(targetId).slice(-4)}`;
      const initialCash = config.initialBalance || 10000;

      await withUserLock(targetId, async () => {
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const [users] = await connection.query('SELECT * FROM users WHERE discord_id = ? FOR UPDATE', [targetId]);
          const [stockSnap] = await connection.query(
            'SELECT stock_id, amount, total_spent FROM user_stocks WHERE user_id = ?',
            [targetId]
          );
          const before = users[0] || resolved.user;
          const snapshot = {
            targetName,
            cash: String(before.cash ?? 0),
            bank: String(before.bank ?? 0),
            clicker_level: before.clicker_level ?? 1,
            auto_miner_level: before.auto_miner_level ?? 0,
            total_clicks: String(before.total_clicks ?? 0),
            daily_streak: before.daily_streak ?? 0,
            stocks: stockSnap || []
          };

          await connection.query(`
            UPDATE users
            SET cash = ?, bank = 0, clicker_level = 1, auto_miner_level = 0, total_clicks = 0,
                daily_streak = 0, last_daily = NULL, last_work = NULL, last_subsidy = NULL
            WHERE discord_id = ?
          `, [initialCash, targetId]);
          await connection.query('DELETE FROM user_stocks WHERE user_id = ?', [targetId]);
          await connection.commit();
          try { await closeLoansOnReset(targetId); } catch (e) {}

          await logAdminAction(session.id, session.username || '관리자', 'WEB_RESET_USER', targetId, {
            targetName,
            snapshot
          }, req);
        } catch (err) {
          await connection.rollback();
          throw err;
        } finally {
          connection.release();
        }
      });

      try { pushUserLive(targetId); } catch (e) {}

      const user = await getWealthRow(targetId);
      return res.json({
        success: true,
        message: `[@${targetName}]님의 경제/주식/클리커 데이터를 초기화했습니다. (현금 ${formatMoney(initialCash)})`,
        user
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  // 🚫 유저 로그인 차단 (시간 단위 또는 영구) API
  router.post('/action/user-ban', async (req, res) => {
    const session = req.adminSession;
    const { userId, durationHours, reason } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: '차단할 유저 ID(또는 닉네임)를 입력하세요.' });
    }

    try {
      const resolved = await resolveTargetUser(userId, { createIfMissing: false });
      if (!resolved.user) return res.status(resolved.status || 404).json({ success: false, error: resolved.error });

      const targetId = resolved.user.discord_id;
      const targetName = resolved.user.username || `유저_${String(targetId).slice(-4)}`;
      const hours = Number(durationHours) || 0;
      const why = clipReason(reason, '관리자 직권 로그인 차단');

      const { banUser } = require('../../utils/userBanEngine');
      const banResult = await banUser(targetId, session.id, session.username || '관리자', {
        hours,
        reason: why
      });

      await logAdminAction(session.id, session.username || '관리자', 'WEB_USER_BAN', targetId, {
        targetName,
        durationHours: hours,
        isPermanent: banResult.isPermanent,
        bannedUntil: banResult.bannedUntil,
        reason: why
      }, req);

      const durationLabel = hours > 0 ? `${hours}시간 동안` : '영구적으로';
      return res.json({
        success: true,
        message: `[@${targetName}]님의 로그인을 ${durationLabel} 차단했습니다. (사유: ${why})`,
        data: banResult
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '유저 차단 처리 중 오류가 발생했습니다.' });
    }
  });

  // 🔓 유저 로그인 차단 해제 (언밴) API
  router.post('/action/user-unban', async (req, res) => {
    const session = req.adminSession;
    const { userId, reason } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: '차단 해제할 유저 ID를 입력하세요.' });
    }

    try {
      const resolved = await resolveTargetUser(userId, { createIfMissing: false });
      if (!resolved.user) return res.status(resolved.status || 404).json({ success: false, error: resolved.error });

      const targetId = resolved.user.discord_id;
      const targetName = resolved.user.username || `유저_${String(targetId).slice(-4)}`;
      const why = clipReason(reason, '관리자 직권 차단 해제');

      const { unbanUser } = require('../../utils/userBanEngine');
      const result = await unbanUser(targetId, session.id, session.username || '관리자', why);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_USER_UNBAN', targetId, {
        targetName,
        reason: why
      }, req);

      return res.json({
        success: true,
        message: `[@${targetName}]님의 로그인 차단을 해제하여 정상 복구했습니다.`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '유저 차단 해제 중 오류가 발생했습니다.' });
    }
  });

  router.post('/action/stock-price', async (req, res) => {
    const session = req.adminSession;
    const { stockId, price } = req.body;
    if (!stockId || price === undefined || price === null || String(price).trim() === '') {
      return res.status(400).json({ success: false, error: '종목 ID와 가격을 입력하세요.' });
    }
    if (!isValidStockId(stockId)) {
      return res.status(400).json({ success: false, error: '올바르지 않은 종목 ID입니다.' });
    }

    try {
      const parsedPrice = parseAdminMoney(price, '원');
      if (!parsedPrice || parsedPrice < 10n) {
        return res.status(400).json({ success: false, error: '주가는 최소 10원 이상이어야 합니다. 예: 10000, 5만, 1양' });
      }
      const { adjustStockPrice } = require('../../utils/stockEngine');
      const result = await adjustStockPrice(stockId, parsedPrice, `관리자(@${session.username}) 웹 수동 조절`);
      await logAdminAction(session.id, session.username || '관리자', 'WEB_SET_STOCK_PRICE', stockId, {
        oldPrice: result.oldPrice.toString(),
        newPrice: result.newPrice.toString()
      }, req);

      return res.json({
        success: true,
        message: `[${result.name}] 주가가 ${formatMoney(result.newPrice)} (${result.rate}%) 으로 조절되었습니다.`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  router.post('/action/stock-adjust-ratio', async (req, res) => {
    const session = req.adminSession;
    const { percent } = req.body;
    const pct = parseFloat(percent);
    if (isNaN(pct)) return res.status(400).json({ success: false, error: '조절할 비율(%)을 입력하세요.' });
    if (Math.abs(pct) > 90) {
      return res.status(400).json({ success: false, error: '일괄 조절은 ±90% 이내로 제한됩니다.' });
    }

    try {
      const { adjustAllStocksRatio } = require('../../utils/stockEngine');
      const results = await adjustAllStocksRatio(pct, `관리자(@${session.username}) 전종목 ${pct > 0 ? '+' : ''}${pct}% 일괄 조절`);
      await logAdminAction(session.id, session.username || '관리자', 'WEB_SET_ALL_STOCKS_RATIO', 'ALL', { percent: pct }, req);

      return res.json({
        success: true,
        message: `전 종목 ${pct > 0 ? '+' : ''}${pct}% 일괄 가격 조절이 완료되었습니다. (${results.length}개 종목)`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  // 💥 관리자 직권 상장폐지 & 청산 환급 API
  router.post('/action/stock-delist', async (req, res) => {
    const session = req.adminSession;
    const { stockId, reason, liquidationPrice } = req.body;
    if (!stockId) return res.status(400).json({ success: false, error: '상장폐지할 종목을 선택하세요.' });

    try {
      const { executeDelisting } = require('../../utils/stockEngine');
      const parsedLiq = parseAdminMoney(liquidationPrice || '30', '원');
      const result = await executeDelisting(stockId, reason || `관리자(@${session.username}) 직권 상장폐지`, parsedLiq || 30n);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_DELIST_STOCK', stockId, {
        reason: reason || '관리자 직권 상장폐지',
        liquidatedUsers: result.liquidatedUsers,
        totalPayout: result.totalPayout
      }, req);

      return res.json({
        success: true,
        message: `[${result.stockName}] 종목이 성공적으로 상장폐지되었습니다. (주주 ${result.liquidatedUsers}명에게 총 ${result.totalPayoutText} 청산금 지급)`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '상장폐지 처리 중 오류가 발생했습니다.' });
    }
  });

  // 🚀 관리자 신규 혁신 기업 IPO 공모 상장 API
  router.post('/action/stock-ipo', async (req, res) => {
    const session = req.adminSession;
    const { customStock } = req.body;

    try {
      const { launchNewIPOStock } = require('../../utils/stockEngine');
      const ipo = await launchNewIPOStock(customStock || null);

      if (!ipo) {
        return res.status(400).json({ success: false, error: '상장 대기 중인 신규 IPO 후보가 없습니다.' });
      }

      await logAdminAction(session.id, session.username || '관리자', 'WEB_IPO_STOCK', ipo.stock_id, {
        name: ipo.name,
        price: ipo.price,
        sector: ipo.sector
      }, req);

      return res.json({
        success: true,
        message: `신규 혁신 기업 [${ipo.name} (${ipo.stock_id})]이 공모가 ${formatMoney(ipo.price)}원에 성공적으로 신규 상장되었습니다!`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '신규 IPO 상장 중 오류가 발생했습니다.' });
    }
  });

  // 👑 관리자 커스텀 주식 신규 상장/추가 API
  router.post('/action/stock-create', async (req, res) => {
    const session = req.adminSession;
    const { stockId, name, price, sector, description, volatility, peRatio, dividendYield } = req.body;

    try {
      const { createCustomStock } = require('../../utils/stockEngine');
      const { parseAdminMoney } = require('../../utils/moneyScale');

      const parsedPrice = parseAdminMoney(price || '1000', '원') || 1000n;
      const result = await createCustomStock({
        stockId,
        name,
        price: parsedPrice,
        sector,
        description,
        volatility,
        peRatio,
        dividendYield
      });

      await logAdminAction(session.id, session.username || '관리자', 'WEB_CREATE_STOCK', result.stockId, {
        name: result.name,
        price: result.price,
        sector: result.sector
      }, req);

      return res.json({
        success: true,
        message: `신규 주식 [${result.name} (${result.stockId})]이 공모가 ${result.priceFormatted}원에 성공적으로 상장되었습니다!`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '주식 생성 중 오류가 발생했습니다.' });
    }
  });

  // 🎉 상장폐지 주식 전격 재상장 API
  router.post('/action/stock-relist', async (req, res) => {
    const session = req.adminSession;
    const { stockId, price, reason } = req.body;

    if (!stockId) {
      return res.status(400).json({ success: false, error: '재상장할 종목 코드를 선택하세요.' });
    }

    try {
      const { relistStock } = require('../../utils/stockEngine');
      const { parseAdminMoney } = require('../../utils/moneyScale');

      const parsedPrice = price ? (parseAdminMoney(price, '원') || 1000n) : null;
      const result = await relistStock(stockId, {
        price: parsedPrice,
        reason: reason || `웹 관리자(@${session.username}) 특별 승인 재상장`
      });

      await logAdminAction(session.id, session.username || '관리자', 'WEB_RELIST_STOCK', result.stockId, {
        name: result.stockName,
        price: result.price,
        reason: result.reason
      }, req);

      return res.json({
        success: true,
        message: `[${result.stockName} (${result.stockId})] 종목이 기준가 ${result.priceFormatted}원에 성공적으로 재상장(Relisting)되었습니다!`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '주식 재상장 처리 중 오류가 발생했습니다.' });
    }
  });

  // ⚡ 주식 액면분할 (Stock Split) API
  router.post('/action/stock-split', async (req, res) => {
    const session = req.adminSession;
    const { stockId, splitRatio, reason } = req.body;

    if (!stockId) {
      return res.status(400).json({ success: false, error: '액면분할할 종목 코드를 입력하세요.' });
    }

    const ratio = parseInt(splitRatio, 10);
    if (!ratio || ratio < 2 || ratio > 100) {
      return res.status(400).json({ success: false, error: '분할 비율은 2~100 사이의 정수여야 합니다.' });
    }

    try {
      const { executeStockSplit } = require('../../utils/stockEngine');
      const result = await executeStockSplit(stockId, ratio, reason || `웹 관리자(@${session.username}) 액면분할 단행`);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_STOCK_SPLIT', result.stockId, {
        name: result.stockName,
        ratio: result.ratio,
        oldPrice: result.oldPrice,
        newPrice: result.newPrice,
        affectedUsers: result.affectedUsers
      }, req);

      return res.json({
        success: true,
        message: `[${result.stockName} (${result.stockId})] 1:${result.ratio} 액면분할 완료! 주가 ${result.oldPriceFormatted} ➔ ${result.newPriceFormatted} (주주 ${result.affectedUsers}명 주식 수 배정 완료)`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '주식 액면분할 처리 중 오류가 발생했습니다.' });
    }
  });

  // 🏢 기업 인적분할 (Corporate Spin-off) API
  router.post('/action/stock-spinoff', async (req, res) => {
    const session = req.adminSession;
    const { parentStockId, newStockId, newStockName, splitRatio, newSector, reason } = req.body;

    if (!parentStockId || !newStockId || !newStockName) {
      return res.status(400).json({ success: false, error: '모회사 코드, 신설 종목코드, 신설 종목명을 모두 입력하세요.' });
    }

    const rawRatio = parseFloat(splitRatio);
    const ratio = (rawRatio > 1) ? (rawRatio / 100) : (rawRatio || 0.4);

    try {
      const { executeSpinOff } = require('../../utils/stockEngine');
      const result = await executeSpinOff(parentStockId, newStockId, newStockName, ratio, newSector, reason || `웹 관리자(@${session.username}) 기업 인적분할 단행`);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_STOCK_SPINOFF', result.newStockId, {
        parent: result.parentStockId,
        parentPrice: result.parentNewPrice,
        child: result.newStockId,
        childPrice: result.newStockPrice,
        ratio: result.splitRatio,
        affectedUsers: result.affectedUsers
      }, req);

      return res.json({
        success: true,
        message: `[${result.parentName} (${result.parentStockId})] ➔ [${result.newStockName} (${result.newStockId})] 인적분할 상장 완료! (기존 주주 ${result.affectedUsers}명 신주 100% 무상 배정)`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '기업 인적분할 처리 중 오류가 발생했습니다.' });
    }
  });

  // 🛡️ 주식 종목별 1회 최대 구매 한도 설정 API
  router.post('/action/stock-buy-limit', async (req, res) => {
    const session = req.adminSession;
    const { stockId, maxBuyLimit } = req.body;

    if (!stockId) {
      return res.status(400).json({ success: false, error: '종목코드를 입력하세요.' });
    }

    try {
      const { setStockCustomBuyLimit } = require('../../utils/stockEngine');
      const result = await setStockCustomBuyLimit(stockId, maxBuyLimit);

      await logAdminAction(session.id, session.username || '관리자', 'WEB_STOCK_BUY_LIMIT_SET', result.stockId, {
        customLimit: result.customLimit,
        maxShares: result.buyLimitInfo.maxShares,
        policyName: result.buyLimitInfo.policyName
      }, req);

      return res.json({
        success: true,
        message: `[${result.stockName} (${result.stockId})] 1회 최대 구매 한도가 성공적으로 수정되었습니다! (현재 적용 한도: ${result.buyLimitInfo.maxSharesText})`,
        data: result
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '구매 한도 수정 중 오류가 발생했습니다.' });
    }
  });

  // 🛡️ 전체 종목 및 현재 매수/발행 한도 목록 조회 API (전체 유저 보유 현황 포함)
  router.get('/stocks/limits', async (req, res) => {
    try {
      const [stocks] = await pool.query(`
        SELECT s.stock_id, s.name, s.sector, s.price, s.status, s.max_buy_limit,
               COALESCE(SUM(us.amount), 0) AS total_held
        FROM stocks s
        LEFT JOIN user_stocks us ON s.stock_id = us.stock_id
        GROUP BY s.stock_id
        ORDER BY (s.status = "DELISTED") ASC, s.price DESC
      `);
      const { getStockMaxBuyLimit } = require('../../utils/stockEngine');
      const list = stocks.map(s => {
        const info = getStockMaxBuyLimit(s);
        const totalHeld = Number(s.total_held || 0);
        const limitShares = s.max_buy_limit != null && Number(s.max_buy_limit) > 0 ? Number(s.max_buy_limit) : info.maxShares;
        const remainingShares = Math.max(0, limitShares - totalHeld);
        const usageRate = limitShares > 0 ? Math.min(100, (totalHeld / limitShares) * 100) : 0;

        return {
          stock_id: s.stock_id,
          name: s.name,
          sector: s.sector,
          price: s.price,
          status: s.status,
          customLimit: s.max_buy_limit,
          isCustom: info.isCustom,
          baseShares: info.baseShares,
          currentMaxShares: limitShares,
          currentMaxSharesText: limitShares.toLocaleString('ko-KR') + '주',
          totalHeld,
          totalHeldText: totalHeld.toLocaleString('ko-KR') + '주',
          remainingShares,
          remainingSharesText: remainingShares.toLocaleString('ko-KR') + '주',
          usageRate: Math.round(usageRate * 10) / 10,
          policyName: info.policyName,
          regimeName: info.regimeName
        };
      });
      return res.json({ success: true, list });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 🏛️ 국고 자금 입금 (충전) API
  router.post('/action/treasury-deposit', async (req, res) => {
    const session = req.adminSession;
    const { amount, reason } = req.body;

    if (!amount) {
      return res.status(400).json({ success: false, error: '입금할 금액을 입력하세요.' });
    }

    try {
      const { parseKoreanOrNumericAmount } = require('../../utils/money');
      const { addTreasury, readTreasury } = require('../../utils/taxEngine');
      const { formatMoney } = require('../../utils/formatters');

      const amt = parseKoreanOrNumericAmount(amount, 0n);
      if (!amt || amt <= 0n) {
        return res.status(400).json({ success: false, error: '올바른 입금 금액을 입력하세요. (예: 50000, 100만, 10억, 5조)' });
      }

      const newTreasury = await addTreasury(amt);

      await logAdminAction(session.id, session.username || '관리자', 'TREASURY_DEPOSIT', 'TREASURY', {
        amount: amt.toString(),
        newTreasury: newTreasury.toString(),
        reason: reason || `웹 관리자(@${session.username}) 국고 자금 충전`
      }, req);

      if (global.__io) {
        global.__io.emit('admin:event', {
          type: 'TREASURY_UPDATE',
          amount: amt.toString(),
          newTreasury: newTreasury.toString()
        });
      }

      return res.json({
        success: true,
        message: `🏛️ 국고에 ${formatMoney(amt)}이 성공적으로 입금되었습니다! (현재 국고 잔액: ${formatMoney(newTreasury)})`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: e.message || '국고 자금 입금 중 오류가 발생했습니다.' });
    }
  });

  const handleMarketRegimeChange = async (req, res) => {
    const session = req.adminSession;
    const { regimeIndex, regime, news } = req.body;
    const rawIdx = (regimeIndex !== undefined) ? regimeIndex : regime;
    const idx = parseInt(rawIdx, 10);
    if (isNaN(idx)) return res.status(400).json({ success: false, error: '국면 번호를 선택하세요.' });

    try {
      const stockEngine = require('../../utils/stockEngine');
      stockEngine.setMarketRegime(idx);
      const targetRegime = stockEngine.MARKET_REGIMES[idx];
      if (news && String(news).trim()) {
        try {
          await pool.query('INSERT INTO stock_news (title, content, sentiment, category, created_at) VALUES (?, ?, ?, ?, NOW())', [
            `[시장 긴급 공시] ${String(news).trim()}`,
            `금융당국 및 거래소 공시: 시장 국면이 [${targetRegime ? targetRegime.name : idx}] (으)로 전격 전환되었습니다.`,
            idx === 1 || idx === 5 || idx === 7 ? 'BULLISH' : (idx === 3 || idx === 2 ? 'BEARISH' : 'NEUTRAL'),
            'MARKET_REGIME'
          ]);
        } catch (ne) {
          console.error('뉴스 등록 오류:', ne);
        }
      }
      await logAdminAction(session.id, session.username || '관리자', 'WEB_SET_REGIME', 'MARKET', {
        regime: targetRegime ? targetRegime.name : 'Unknown',
        news: news || ''
      }, req);

      return res.json({
        success: true,
        message: `시장 국면이 [${targetRegime ? targetRegime.name : idx}] (으)로 강제 변경되었습니다.`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  };

  router.post('/action/market-regime', handleMarketRegimeChange);
  router.post('/stocks/regime', handleMarketRegimeChange);

  // 📈 주식 가격 변동 주기 조회 및 설정
  router.get('/stocks/interval', async (req, res) => {
    const { getStockIntervalSec } = require('../../utils/stockEngine');
    return res.json({ success: true, intervalSec: getStockIntervalSec() });
  });

  router.post(['/stocks/interval', '/action/stock-interval'], async (req, res) => {
    const session = req.adminSession;
    const { intervalSec, seconds } = req.body;
    const targetSec = parseInt(intervalSec || seconds, 10);
    if (!Number.isInteger(targetSec) || targetSec < 3 || targetSec > 3600) {
      return res.status(400).json({ success: false, error: '주식 변동 주기는 3초에서 3600초 사이여야 합니다.' });
    }

    try {
      const { setStockIntervalSec } = require('../../utils/stockEngine');
      const updated = setStockIntervalSec(targetSec);
      await logAdminAction(session?.id || 'WEB_ADMIN', 'UPDATE_STOCK_INTERVAL', { intervalSec: updated });
      return res.json({
        success: true,
        intervalSec: updated,
        message: `주식 가격 변동 주기가 ${updated}초로 성공적으로 변경되었습니다.`
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 🎁 전 유저 국고 보조금 살포
  const handleStimulusPackage = async (req, res) => {
    const session = req.adminSession;
    const { amount, reason } = req.body;
    const parseAmount = (input) => {
      if (!input) return null;
      let clean = String(input).replace(/,/g, '').trim();
      if (/^\d+$/.test(clean)) return BigInt(clean);
      const multipliers = { '만': 10000n, '억': 100000000n, '조': 1000000000000n, '경': 10000000000000000n, '해': 100000000000000000000n, '자': 1000000000000000000000000n, '양': 10000000000000000000000000000n };
      let match = clean.match(/^(\d+(?:\.\d+)?)\s*([만억조경해자양])$/);
      if (match) {
        let num = parseFloat(match[1]);
        let mul = multipliers[match[2]];
        return BigInt(Math.floor(num * 10000)) * (mul / 10000n);
      }
      return null;
    };

    const amt = parseAmount(amount);
    if (!amt || amt <= 0n) return res.status(400).json({ success: false, error: '올바른 지원금 액수를 입력하세요.' });

    try {
      const [users] = await pool.query('SELECT discord_id, username, cash FROM users');
      if (!users.length) return res.status(400).json({ success: false, error: '지급할 대상 유저가 없습니다.' });

      const stimulusReason = reason ? `[전유저 지원금] ${reason}` : '[전유저 지원금] 봇 운영진 특별 지원금';
      const totalPayout = amt * BigInt(users.length);

      // 국고에서 전 유저 지원금 총액 차감
      const { takeTreasury } = require('../../utils/taxEngine');
      const { treasury: newTreasury } = await takeTreasury(totalPayout, true);
      
      for (const u of users) {
        const prevCash = safeBigInt(u.cash);
        const newCash = prevCash + amt;
        await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), u.discord_id]);
        try {
          await pool.query('INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())', [
            u.discord_id,
            u.username,
            'TAX_REFUND',
            amt.toString(),
            prevCash.toString(),
            newCash.toString(),
            `🏛️ ${stimulusReason} (국고 지원)`
          ]);
        } catch (le) {}
      }

      await logAdminAction(session.id, session.username || '관리자', 'WEB_STIMULUS_ALL', 'ALL_USERS', {
        amount: amt.toString(),
        totalPayout: totalPayout.toString(),
        recipientCount: users.length,
        reason: stimulusReason,
        treasuryLeft: newTreasury.toString()
      }, req);

      return res.json({
        success: true,
        message: `총 ${users.length}명의 유저에게 각 ${amt.toLocaleString()}원씩(총 ${totalPayout.toLocaleString()}원) 국고 지원금 살포가 완료되었습니다. (국고 잔액: ${newTreasury.toLocaleString()}원)`
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '지원금 살포 처리 중 오류가 발생했습니다.' });
    }
  };

  router.post('/economy/stimulus', handleStimulusPackage);
  router.post('/action/stimulus', handleStimulusPackage);

  // 🎛️ 경제 관리자 수동 컨트롤 (세율·금리·국면·자동모드) — API 전용, ajax 전용
  router.get('/api/economy-controls/snapshot', async (req, res) => {
    try {
      const { summarizeCurrentSettings, getManualState, loadManualState } = require('../../utils/economyControls');
      await loadManualState();
      const settings = summarizeCurrentSettings();
      const manual = getManualState();
      const recentHealth = await (async () => {
        try {
          const [rows] = await pool.query(`
            SELECT id, total_money, avg_wealth, gini_coefficient, top10_ratio,
                   health_score, status, actions_taken, created_at
            FROM economy_health_log
            ORDER BY id DESC
            LIMIT 5
          `);
          return rows;
        } catch (e) { return []; }
      })();
      res.json({
        success: true,
        settings: settings || {},
        manual,
        recentHealth,
        limits: {
          taxRateMin: 0,
          taxRateMax: 0.15,
          bankInterestRateMin: 0,
          bankInterestRateMax: 0.0001,
          wealthTaxMultiplierMin: 0.1,
          wealthTaxMultiplierMax: 5.0,
          wealthThresholdForTaxMin: 100000,
          wealthThresholdForTaxMax: 10000000000,
          subsidyMultiplierMin: 0.1,
          subsidyMultiplierMax: 5.0
        }
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.post('/api/economy-controls/auto-mode', async (req, res) => {
    try {
      const { mode } = req.body || {};
      const { setAutoMode } = require('../../utils/economyControls');
      const session = getSessionUser(req);
      const adminId = session ? session.id : 'admin';
      const result = await setAutoMode(mode, adminId);
      if (!result.success) return res.status(400).json(result);
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.post('/api/economy-controls/bulk-update', async (req, res) => {
    try {
      const { updates } = req.body || {};
      const { bulkUpdate } = require('../../utils/economyControls');
      const session = getSessionUser(req);
      const adminId = session ? session.id : 'admin';
      const result = await bulkUpdate(updates || {}, adminId);
      if (!result.success || (Array.isArray(result.applied) && result.applied.length === 0)) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get('/api/economy-controls/history', async (req, res) => {
    try {
      const { getManualState } = require('../../utils/economyControls');
      const st = getManualState();
      res.json({ success: true, history: st.history });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get('/security', async (req, res, next) => {
    if (isHtmlRequest(req)) return next();
    try {
      const [recentEvents] = await pool.query(`
        SELECT ip, event_type, path, reason, country, country_name, created_at
        FROM security_events
        ORDER BY created_at DESC
        LIMIT 50
      `);
      const events = (recentEvents || []).map((ev) => {
        const geo = ev.ip && ev.ip !== 'DELETED' ? lookupIp(ev.ip) : null;
        return {
          ...ev,
          flag: geo ? geo.flag : getFlagEmoji(ev.country),
          countryName: ev.country_name || (geo && geo.countryName) || ev.country || '알 수 없음'
        };
      });
      return res.json(securityPayload({ recentEvents: events }));
    } catch (e) {
      return res.json(securityPayload({ recentEvents: [] }));
    }
  });

  router.get('/security/lookup', async (req, res) => {
    const ip = String(req.query.ip || '').trim();
    if (!ip) return res.status(400).json({ success: false, error: 'IP를 입력하세요.' });
    if (!isValidIp(ip)) return res.status(400).json({ success: false, error: '올바른 IP 주소가 아닙니다.' });
    const geo = lookupIp(ip);
    return res.json({ success: true, geo });
  });

  // 🔍 특정 유저 IP 기록 조회
  router.get('/users/:userId/ips', async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, error: '유저 ID가 필요합니다.' });
    try {
      const [rows] = await pool.query(`
        SELECT DISTINCT ip, country, country_name, created_at
        FROM web_access_logs
        WHERE user_id = ?
        ORDER BY id DESC LIMIT 20
      `, [userId]);

      const ips = (rows || []).map(row => {
        const geo = row.ip && row.ip !== 'DELETED' ? lookupIp(row.ip) : null;
        return {
          ip: row.ip,
          country: row.country || (geo && geo.country) || 'KR',
          countryName: row.country_name || (geo && geo.countryName) || '대한민국',
          flag: geo ? geo.flag : getFlagEmoji(row.country),
          createdAt: row.created_at
        };
      });
      return res.json({ success: true, ips });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // 📈 특정 유저 보유 주식 목록 조회
  router.get('/users/:userId/stocks', async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ success: false, error: '유저 ID가 필요합니다.' });
    try {
      const [rows] = await pool.query(`
        SELECT us.stock_id, us.amount, us.average_price, s.name, s.price as current_price
        FROM user_stocks us
        JOIN stocks s ON us.stock_id = s.stock_id
        WHERE us.user_id = ? AND us.amount > 0
      `, [userId]);
      return res.json({ success: true, stocks: rows });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get('/security/user-ips', async (req, res) => {
    const q = String(req.query.userId || req.query.q || '').trim();
    if (!q) return res.status(400).json({ success: false, error: '유저 ID 또는 닉네임을 입력하세요.' });
    try {
      const like = `%${escapeLike(q.replace(/[%_]/g, ''))}%`;
      const [rows] = await pool.query(`
        SELECT ip, country, country_name, city, method, url, status_code, created_at, user_id, username
        FROM web_access_logs
        WHERE user_id = ? OR username = ? OR username LIKE ? ESCAPE '\\\\'
        ORDER BY id DESC
        LIMIT 50
      `, [q, q, like]);
      const logs = (rows || []).map((row) => {
        const geo = row.ip && row.ip !== 'DELETED' ? lookupIp(row.ip) : null;
        return {
          ...row,
          flag: geo ? geo.flag : getFlagEmoji(row.country),
          countryName: row.country_name || (geo && geo.countryName) || row.country || '알 수 없음',
          city: row.city || (geo && geo.city) || ''
        };
      });
      return res.json({ success: true, count: logs.length, logs });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    }
  });

  router.post('/security/ban', async (req, res) => {
    const session = req.adminSession;
    const { ip, reason, durationMinutes } = req.body;
    if (!ip) return res.status(400).json({ success: false, error: 'IP 필요' });
    const result = banIp(ip, reason || '관리자 수동 차단', Number(durationMinutes) || 1440);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.message });
    }
    await logAdminAction(session.id, session.username || '관리자', 'WEB_BAN_IP', result.ip || ip, {
      reason: reason || '관리자 수동 차단',
      durationMinutes: Number(durationMinutes) || 1440
    }, req);
    return res.json(securityPayload({
      message: result.message,
      ip: result.ip
    }));
  });

  router.post('/security/unban', async (req, res) => {
    const session = req.adminSession;
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ success: false, error: 'IP 필요' });
    const ok = unbanIp(ip);
    if (ok) {
      await logAdminAction(session.id, session.username || '관리자', 'WEB_UNBAN_IP', ip, {}, req);
    }
    return res.json(securityPayload({
      success: ok,
      message: ok ? `${ip} 차단 해제` : `${ip}는 차단 목록에 없음`
    }));
  });

  // ── 🛡️ IP 화이트리스트 API ──────────────────────────────
  router.get('/security/whitelist', async (req, res) => {
    try {
      const list = await getWhitelistedIpsList();
      return res.json({ success: true, list });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  router.post('/security/whitelist/add', async (req, res) => {
    const session = req.adminSession;
    const { ip, description } = req.body || {};
    if (!ip) return res.status(400).json({ success: false, error: 'IP를 입력하세요.' });
    const result = await addIpToWhitelist(ip, description, session?.username || 'ADMIN');
    if (!result.success) return res.status(400).json(result);
    await logAdminAction(session?.id || 'ADMIN', session?.username || '관리자', 'WEB_WHITELIST_ADD', ip, { description }, req);
    return res.json(result);
  });

  router.post('/security/whitelist/remove', async (req, res) => {
    const session = req.adminSession;
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ success: false, error: 'IP를 입력하세요.' });
    const result = await removeIpFromWhitelist(ip);
    if (!result.success) return res.status(400).json(result);
    await logAdminAction(session?.id || 'ADMIN', session?.username || '관리자', 'WEB_WHITELIST_REMOVE', ip, {}, req);
    return res.json(result);
  });

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

      const currentCash = safeBigInt(users[0].cash);
      const profit = safeBigInt(log.profit);
      const revert = -profit;

      if (revert >= 0n) {
        await connection.query(
          'UPDATE users SET cash = cash + ? WHERE discord_id = ?',
          [revert.toString(), log.user_id]
        );
      } else {
        const need = (-revert).toString();
        const [upd] = await connection.query(
          'UPDATE users SET cash = cash + ? WHERE discord_id = ? AND cash >= ?',
          [revert.toString(), log.user_id, need]
        );
        if (!upd.affectedRows) {
          await connection.rollback();
          return res.status(400).json({ success: false, error: '롤백 적용 시 유저의 현금이 음수가 되어 처리할 수 없습니다.' });
        }
      }

      const [afterRows] = await connection.query('SELECT cash FROM users WHERE discord_id = ?', [log.user_id]);
      const newCash = safeBigInt(afterRows[0]?.cash);

      await connection.query('UPDATE gambling_logs SET is_rolled_back = 1, rolled_back_at = NOW() WHERE id = ?', [logId]);
      await connection.commit();

      try { pushUserLive(log.user_id); } catch (e) {}

      await logAdminAction(session.id, session.username || '관리자', 'ROLLBACK_GAMBLING', log.user_id, {
        logId,
        profit: profit.toString(),
        beforeCash: currentCash.toString(),
        afterCash: newCash.toString()
      }, req);

      const user = await getWealthRow(log.user_id);
      return res.json({
        success: true,
        message: `로그 #${logId} (${log.game}) 롤백 완료. 잔액 ${formatMoney(currentCash)} → ${formatMoney(newCash)}`,
        user
      });
    } catch (e) {
      await connection.rollback();
      console.error(e);
      return res.status(500).json({ success: false, error: '처리 중 오류가 발생했습니다.' });
    } finally {
      connection.release();
    }
  });

  // 📊 한달 전체 자금 흐름 & 영역별 경제 로그 탐색 API
  router.get('/economy/logs', async (req, res) => {
    try {
      const category = String(req.query.category || 'all').toLowerCase();
      const days = parseInt(req.query.days, 10) || 30; // 기본 30일(한달)
      const userId = String(req.query.userId || '').trim();
      const search = String(req.query.search || '').trim();
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(200, Math.max(10, parseInt(req.query.limit, 10) || 50));
      const offset = (page - 1) * limit;

      const CATEGORY_MAP = {
        tax: ['TAX_WEALTH', 'TAX_TRADE', 'TAX_ADMIN', 'TAX_REFUND', 'TREASURY_SUBSIDY', 'TREASURY_WITHDRAW', 'TREASURY_CASINO_VIP'],
        transfer: ['TRANSFER', 'TRANSFER_SEND', 'TRANSFER_RECEIVE'],
        gamble: ['GAMBLING', 'SLOT', 'DICE', 'COIN', 'ROULETTE', 'HORSE', 'LOTTERY', 'CASINO_VIP', 'CASINO_MISSION', 'CASINO_VIP_DAILY'],
        stock: ['STOCK_BUY', 'STOCK_SELL', 'DIVIDEND'],
        bank: ['BANK_DEPOSIT', 'BANK_WITHDRAW', 'BANK_INTEREST', 'INTEREST', 'LOAN_BORROW', 'LOAN_REPAY', 'LOAN'],
        activity: ['CLICKER', 'MINE', 'WORK', 'DAILY', 'ATTENDANCE', 'SUBSIDY', 'BUSINESS', 'FARM', 'STORE'],
        admin: ['ADMIN_GIVE', 'ADMIN_TAKE', 'ADMIN_RESET', 'ADMIN_SET', 'WEB_TAX_WITHDRAW', 'DISCORD_TAX_WITHDRAW', 'WEB_TAX_REFUND']
      };

      const whereClauses = [];
      const params = [];

      // 날짜 필터 (최근 N일 이내)
      if (days > 0 && days <= 365) {
        whereClauses.push('created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)');
        params.push(days);
      }

      // 카테고리 필터
      if (category !== 'all' && CATEGORY_MAP[category]) {
        const types = CATEGORY_MAP[category];
        whereClauses.push(`type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
      }

      // 특정 유저 필터
      if (userId) {
        whereClauses.push('(user_id = ? OR username LIKE ?)');
        params.push(userId, `%${escapeLike(userId)}%`);
      }

      // 키워드 검색
      if (search) {
        whereClauses.push('(description LIKE ? OR username LIKE ? OR type LIKE ?)');
        const searchLike = `%${escapeLike(search)}%`;
        params.push(searchLike, searchLike, searchLike);
      }

      const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

      // 총 개수 카운트
      const [countRows] = await pool.query(
        `SELECT COUNT(*) as total, COALESCE(SUM(CAST(amount AS DECIMAL(65,0))), 0) as total_volume FROM economy_logs ${whereSql}`,
        params
      );
      const totalCount = countRows[0]?.total || 0;
      const totalVolume = String(countRows[0]?.total_volume || '0');

      // 페이징된 로그 목록 조회
      const queryParams = [...params, limit, offset];
      const [rows] = await pool.query(
        `SELECT id, user_id, username, type, amount, balance_before, balance_after, description, created_at
         FROM economy_logs
         ${whereSql}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        queryParams
      );

      const logs = rows.map((r) => {
        const amt = safeBigInt(r.amount);
        const before = safeBigInt(r.balance_before);
        const after = safeBigInt(r.balance_after);
        const isInflow = after > before;

        // 카테고리 배지 자동 분류
        let cat = 'etc';
        let badge = '기타';
        let badgeColor = '#9ca3af';

        if (r.type.startsWith('TAX') || r.type.startsWith('TREASURY')) {
          cat = 'tax'; badge = '🏛️ 세금·국고'; badgeColor = '#38bdf8';
        } else if (r.type.includes('TRANSFER')) {
          cat = 'transfer'; badge = '💸 송금·이체'; badgeColor = '#60a5fa';
        } else if (['SLOT','DICE','COIN','ROULETTE','HORSE','LOTTERY','CASINO_VIP','CASINO_MISSION','CASINO_VIP_DAILY'].includes(r.type)) {
          cat = 'gamble'; badge = '🎰 도박·카지노'; badgeColor = '#fbbf24';
        } else if (['STOCK_BUY','STOCK_SELL','DIVIDEND'].includes(r.type)) {
          cat = 'stock'; badge = '📈 주식·배당'; badgeColor = '#34d399';
        } else if (r.type.startsWith('BANK') || r.type.startsWith('LOAN') || r.type === 'INTEREST') {
          cat = 'bank'; badge = '🏦 은행·대출'; badgeColor = '#818cf8';
        } else if (['CLICKER','MINE','WORK','DAILY','ATTENDANCE','SUBSIDY','BUSINESS'].includes(r.type)) {
          cat = 'activity'; badge = '⛏️ 활동·지원금'; badgeColor = '#a78bfa';
        } else if (r.type.startsWith('ADMIN') || r.type.includes('WITHDRAW')) {
          cat = 'admin'; badge = '👑 관리자'; badgeColor = '#f87171';
        }

        return {
          id: r.id,
          userId: r.user_id,
          username: r.username || '알수없음',
          type: r.type,
          category: cat,
          badge,
          badgeColor,
          isInflow,
          amount: amt.toString(),
          amountText: formatMoney(amt),
          before: before.toString(),
          beforeText: formatMoney(before),
          after: after.toString(),
          afterText: formatMoney(after),
          description: r.description || '',
          createdAt: r.created_at
        };
      });

      return res.json({
        success: true,
        pagination: {
          page,
          limit,
          totalCount,
          totalPages: Math.ceil(totalCount / limit) || 1
        },
        summary: {
          totalVolume,
          totalVolumeText: formatMoney(safeBigInt(totalVolume)),
          count: totalCount,
          days
        },
        logs
      });
    } catch (e) {
      console.error('경제 로그 조회 오류:', e);
      return res.status(500).json({ success: false, error: '로그 조회 중 오류가 발생했습니다.' });
    }
  });

  // 📜 실시간 텍스트 파일 로그 뷰어 & 탐색 API
  router.get('/logs/files', async (req, res) => {
    try {
      const { getLogFilesList } = require('../../utils/universalLogger');
      const files = getLogFilesList();
      return res.json({ success: true, files });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get('/logs/raw', async (req, res) => {
    try {
      const { readLogFileTail } = require('../../utils/universalLogger');
      const fileName = String(req.query.file || 'system_all.log').trim();
      const maxLines = Math.min(1000, Math.max(10, parseInt(req.query.lines, 10) || 200));
      const search = String(req.query.search || '').trim();

      const result = readLogFileTail(fileName, maxLines, search);
      return res.json(result);
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  router.get('/logs/download/:fileName', async (req, res) => {
    try {
      const path = require('path');
      const fs = require('fs');
      const { LOGS_BASE_DIR } = require('../../utils/universalLogger');
      const safeName = path.basename(req.params.fileName || 'system_all.log');
      const filePath = path.join(LOGS_BASE_DIR, safeName);
      if (!fs.existsSync(filePath)) {
        return res.status(404).send('로그 파일을 찾을 수 없습니다.');
      }
      res.download(filePath, safeName);
    } catch (e) {
      return res.status(500).send('다운로드 실패');
    }
  });

  // 💾 데이터베이스 백업 목록 조회 API
  router.get('/backups', async (req, res) => {
    try {
      const { listBackups } = require('../../utils/backupEngine');
      const backups = await listBackups();
      return res.json({ success: true, backups });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message || '백업 목록 조회 실패' });
    }
  });

  // ⚡ 관리자 원클릭 즉시 DB 백업 생성 API
  router.post('/backups/create', async (req, res) => {
    try {
      const { createDatabaseBackup } = require('../../utils/backupEngine');
      const user = req.adminUser || { username: 'ADMIN_WEB' };
      const result = await createDatabaseBackup({
        reason: 'ADMIN_CONSOLE_MANUAL',
        triggeredBy: user.username || 'ADMIN'
      });
      return res.json({
        success: true,
        message: `DB 백업이 성공적으로 완료되었습니다! (${result.filename}, ${result.sizeMb})`,
        backup: result
      });
    } catch (e) {
      console.error('DB 백업 생성 실패:', e);
      return res.status(500).json({ success: false, error: e.message || 'DB 백업 생성 실패' });
    }
  });

  // 📩 1:1 고객센터 문의 답변 등록 API (Discord DM 연동)
  router.post('/inquiries/:id/answer', async (req, res) => {
    const session = req.adminSession;
    const ticketId = req.params.id;
    const answer = String(req.body.answer || '').trim();

    if (!ticketId || !answer) {
      return res.status(400).json({ success: false, error: '문의 번호와 답변 내용을 모두 입력하세요.' });
    }

    try {
      const [tickets] = await pool.query('SELECT * FROM inquiries WHERE id = ?', [ticketId]);
      if (!tickets.length) {
        return res.status(404).json({ success: false, error: '해당 문의를 찾을 수 없습니다.' });
      }

      const ticket = tickets[0];
      await pool.query(`
        UPDATE inquiries
        SET status = 'ANSWERED', answer = ?, answered_by = ?, answered_at = NOW()
        WHERE id = ?
      `, [answer, session.username || '관리자', ticketId]);

      // 유저에게 Discord DM 알림 전송 시도
      let dmNotified = false;
      if (client && client.users) {
        try {
          const targetUser = await client.users.fetch(ticket.user_id);
          if (targetUser) {
            const { EmbedBuilder } = require('discord.js');
            const userDmEmbed = new EmbedBuilder()
              .setTitle(`📬 [1:1 고객센터 답변 도착] Ticket #${ticketId}`)
              .setColor(0x10b981)
              .setDescription(`안녕하세요, **${ticket.username}**님!\n접수하신 1:1 문의에 관리자 답변이 등록되었습니다.`)
              .addFields(
                { name: '📌 내 문의 제목', value: String(ticket.title || '문의').slice(0, 250), inline: false },
                { name: '💬 관리자 공식 답변', value: `\`\`\`\n${answer}\n\`\`\``, inline: false }
              )
              .setFooter({ text: `답변자: @${session.username || '관리자'} · 웹사이트 [내 프로필]에서도 언제든 확인 가능합니다.` })
              .setTimestamp();
            await targetUser.send({ embeds: [userDmEmbed] });
            dmNotified = true;
          }
        } catch (e) {
          console.warn(`[Inquiry DM] 유저(${ticket.user_id}) DM 알림 실패:`, e.message);
        }
      }

      await logAdminAction(session.id, session.username || '관리자', 'INQUIRY_ANSWER', ticket.user_id, {
        ticketId,
        user: ticket.username,
        answer: answer.slice(0, 100)
      }, req);

      if (global.__io) {
        global.__io.emit('admin:event', {
          type: 'INQUIRY_ANSWERED',
          ticketId
        });
      }

      return res.json({
        success: true,
        message: `Ticket #${ticketId} 답변 등록 완료! (유저 DM 알림: ${dmNotified ? '성공' : '웹에서 확인 가능'})`
      });
    } catch (err) {
      console.error('고객센터 답변 등록 오류:', err);
      return res.status(500).json({ success: false, error: '답변 등록 중 서버 오류가 발생했습니다.' });
    }
  });


  // ── 📊 종목별 주가 변동 기록 조회 (24시간 단위 집계) ──────────────
  router.get('/stock-price-history', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '인증 필요' });

    const stockId = String(req.query.stockId || '').toUpperCase().trim();
    const days = Math.min(30, Math.max(1, parseInt(req.query.days) || 7));

    try {
      // 24시간 단위 OHLC 집계 (시가/고가/저가/종가)
      let dailyQuery, dailyParams;
      if (stockId) {
        dailyQuery = `
          SELECT
            DATE(created_at) AS day,
            MIN(CAST(new_price AS DECIMAL(65,0))) AS low_price,
            MAX(CAST(new_price AS DECIMAL(65,0))) AS high_price,
            CAST(SUBSTRING_INDEX(GROUP_CONCAT(CAST(new_price AS CHAR) ORDER BY created_at ASC), ',', 1) AS DECIMAL(65,0)) AS open_price,
            CAST(SUBSTRING_INDEX(GROUP_CONCAT(CAST(new_price AS CHAR) ORDER BY created_at DESC), ',', 1) AS DECIMAL(65,0)) AS close_price,
            COUNT(*) AS tick_count,
            AVG(change_rate) AS avg_change_rate,
            SUM(CASE WHEN diff > 0 THEN 1 ELSE 0 END) AS up_ticks,
            SUM(CASE WHEN diff < 0 THEN 1 ELSE 0 END) AS down_ticks,
            stock_name
          FROM stock_price_logs
          WHERE stock_id = ?
            AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          GROUP BY DATE(created_at), stock_name
          ORDER BY day ASC
        `;
        dailyParams = [stockId, days];
      } else {
        // 전 종목 오늘 요약
        dailyQuery = `
          SELECT
            stock_id,
            stock_name,
            DATE(created_at) AS day,
            MIN(CAST(new_price AS DECIMAL(65,0))) AS low_price,
            MAX(CAST(new_price AS DECIMAL(65,0))) AS high_price,
            CAST(SUBSTRING_INDEX(GROUP_CONCAT(CAST(new_price AS CHAR) ORDER BY created_at ASC), ',', 1) AS DECIMAL(65,0)) AS open_price,
            CAST(SUBSTRING_INDEX(GROUP_CONCAT(CAST(new_price AS CHAR) ORDER BY created_at DESC), ',', 1) AS DECIMAL(65,0)) AS close_price,
            COUNT(*) AS tick_count,
            AVG(change_rate) AS avg_change_rate
          FROM stock_price_logs
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          GROUP BY stock_id, stock_name, DATE(created_at)
          ORDER BY stock_id, day ASC
        `;
        dailyParams = [days];
      }

      const [daily] = await pool.query(dailyQuery, dailyParams);

      // 최근 50개 실시간 틱 로그
      let recentQuery, recentParams;
      if (stockId) {
        recentQuery = `
          SELECT id, stock_id, stock_name, prev_price, new_price, change_rate, diff, regime, reason, created_at
          FROM stock_price_logs
          WHERE stock_id = ?
          ORDER BY id DESC LIMIT 100
        `;
        recentParams = [stockId];
      } else {
        recentQuery = `
          SELECT id, stock_id, stock_name, prev_price, new_price, change_rate, diff, regime, reason, created_at
          FROM stock_price_logs
          ORDER BY id DESC LIMIT 100
        `;
        recentParams = [];
      }
      const [recent] = await pool.query(recentQuery, recentParams);

      // 현재 주가 목록
      const [stocks] = await pool.query(
        stockId
          ? 'SELECT stock_id, name, price, prev_price, high_24h, low_24h, volume_24h FROM stocks WHERE stock_id = ?'
          : 'SELECT stock_id, name, price, prev_price, high_24h, low_24h, volume_24h FROM stocks ORDER BY stock_id',
        stockId ? [stockId] : []
      );

      return res.json({
        success: true,
        stockId: stockId || null,
        days,
        daily: daily.map(r => ({
          day: r.day,
          stockId: r.stock_id || stockId,
          stockName: r.stock_name,
          open: String(r.open_price),
          high: String(r.high_price),
          low: String(r.low_price),
          close: String(r.close_price),
          tickCount: r.tick_count,
          avgChangeRate: Number(r.avg_change_rate || 0).toFixed(2),
          upTicks: r.up_ticks || 0,
          downTicks: r.down_ticks || 0
        })),
        recent: recent.map(r => ({
          id: r.id,
          stockId: r.stock_id,
          stockName: r.stock_name,
          prevPrice: String(r.prev_price),
          newPrice: String(r.new_price),
          changeRate: Number(r.change_rate || 0).toFixed(2),
          diff: String(r.diff),
          regime: r.regime,
          reason: r.reason,
          createdAt: r.created_at
        })),
        stocks: stocks.map(s => ({
          stockId: s.stock_id,
          name: s.name,
          price: String(s.price),
          prevPrice: String(s.prev_price),
          high24h: String(s.high_24h || 0),
          low24h: String(s.low_24h || 0)
        }))
      });
    } catch (err) {
      console.error('주가 기록 조회 오류:', err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── 🛍️ 가상 경제 소비 시스템 관리자 API ───────────────────────────────
  const AdminSpendingService = require('../../core/economy/AdminSpendingService');
  const PrestigeShopService = require('../../core/economy/PrestigeShopService');
  const WorkshopService = require('../../core/economy/WorkshopService');

  // 유저 검색
  router.get('/spending/users/search', async (req, res) => {
    try {
      const users = await AdminSpendingService.searchUser(req.query.q);
      return res.json({ success: true, users });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 유저 소비 프로필 상세 조회
  router.get('/spending/users/:userId', async (req, res) => {
    try {
      const profile = await AdminSpendingService.getUserFullSpendingProfile(req.params.userId);
      return res.json({ success: true, ...profile });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 유저 아이템 강제 지급
  router.post('/spending/users/:userId/grant-item', async (req, res) => {
    try {
      const adminId = req.adminSession?.id || 'ADMIN';
      const result = await AdminSpendingService.adminGrantItem(req.params.userId, { ...req.body, adminId });
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 유저 아이템 회수 / 삭제
  router.post('/spending/users/:userId/revoke-item', async (req, res) => {
    try {
      const adminId = req.adminSession?.id || 'ADMIN';
      const result = await AdminSpendingService.adminRevokeItem(req.params.userId, req.body.inventoryId, { ...req.body, adminId });
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 유저 제작 재료 수량 설정
  router.post('/spending/users/:userId/materials', async (req, res) => {
    try {
      const adminId = req.adminSession?.id || 'ADMIN';
      const result = await AdminSpendingService.adminSetMaterials(req.params.userId, req.body.materialKey, req.body.quantity, { ...req.body, adminId });
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 유저 덕하우스 레벨 강제 변경
  router.post('/spending/users/:userId/duck-house-level', async (req, res) => {
    try {
      const adminId = req.adminSession?.id || 'ADMIN';
      const result = await AdminSpendingService.adminSetDuckHouseLevel(req.params.userId, req.body.level, { ...req.body, adminId });
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 명예 상점 카탈로그 관리
  router.get('/spending/catalog', async (req, res) => {
    try {
      const items = await PrestigeShopService.listCatalog({ activeOnly: false });
      return res.json({ success: true, items });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/spending/catalog', async (req, res) => {
    try {
      const result = await AdminSpendingService.adminSaveCatalogItem(req.body);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  router.delete('/spending/catalog/:itemKey', async (req, res) => {
    try {
      const result = await AdminSpendingService.adminDeleteCatalogItem(req.params.itemKey);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 제작소 레시피 관리
  router.get('/spending/workshop', async (req, res) => {
    try {
      const recipes = await WorkshopService.listRecipes();
      return res.json({ success: true, recipes });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/spending/workshop', async (req, res) => {
    try {
      const result = await AdminSpendingService.adminSaveRecipe(req.body);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  router.delete('/spending/workshop/:recipeKey', async (req, res) => {
    try {
      const result = await AdminSpendingService.adminDeleteRecipe(req.params.recipeKey);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
  });

  // 소비/소각 통계 및 원장 로그
  router.get('/spending/ledger', async (req, res) => {
    try {
      const data = await AdminSpendingService.getSpendingSummary();
      return res.json({ success: true, ...data });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createAdminRoutes };
