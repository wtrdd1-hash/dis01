/**
 * 📈 주식 시장 & 시세 & 소수점 매매 라우트 모듈
 */
const express = require('express');
const { pool, getOrCreateUser } = require('../../config/database');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt, withUserLock, isAllInAmount } = require('../../utils/money');
const { isValidStockId } = require('../../utils/sanitize');
const { sendPublicError } = require('../httpSafe');
const { quoteTradeTax, maxBuyShareUnits, applyDebitWithTax, applyCreditMinusTax } = require('../../utils/taxEngine');
const { amountToUnits, unitsToAmountStr, mulPriceAmount } = require('../../utils/moneyScale');

function createStockRoutes(getSessionUser) {
  const router = express.Router();

  // 1. 전체 실시간 주식 시세 목록 API
  router.get('/stocks', async (req, res) => {
    try {
      const [stocks] = await pool.query('SELECT * FROM stocks ORDER BY (status = "DELISTED") ASC, market_cap DESC');
      const { getStockMaxBuyLimit } = require('../../utils/stockEngine');
      const formatted = stocks.map(s => {
        const price = safeBigInt(s.price);
        const prevPrice = safeBigInt(s.prev_price);
        const diff = price - prevPrice;
        const rate = prevPrice > 0n ? Number((diff * 10000n) / prevPrice) / 100 : 0;
        const buyLimitInfo = getStockMaxBuyLimit(s);

        return {
          stock_id: s.stock_id,
          name: s.name,
          price: price.toString(),
          prev_price: prevPrice.toString(),
          rate: rate,
          isUp: diff >= 0n,
          status: s.status || 'ACTIVE',
          sector: s.sector || 'IT/기술',
          pe_ratio: Number(s.pe_ratio) || 15.0,
          dividend_yield: Number(s.dividend_yield) || 2.5,
          maxBuyShares: buyLimitInfo.maxShares,
          maxBuySharesText: buyLimitInfo.maxSharesText,
          regimeBuyPolicy: buyLimitInfo.policyName
        };
      });
      return res.json({ success: true, count: formatted.length, stocks: formatted });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  // 2. 단일 주식 상세 및 가격 히스토리 차트 API
  router.get('/stock/:stockId', async (req, res) => {
    const { stockId } = req.params;
    if (!isValidStockId(stockId)) {
      return res.status(400).json({ success: false, error: '올바르지 않은 종목입니다.' });
    }
    const session = getSessionUser(req);

    try {
      const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
      if (stocks.length === 0) return res.status(404).json({ success: false, error: '존재하지 않는 주식 종목입니다.' });

      const stock = stocks[0];
      const { getStockMaxBuyLimit } = require('../../utils/stockEngine');
      const buyLimitInfo = getStockMaxBuyLimit(stock);
      const [history] = await pool.query('SELECT price, recorded_at FROM stock_history WHERE stock_id = ? ORDER BY recorded_at ASC LIMIT 60', [stockId]);

      let userHolding = '0';
      let userAvgPrice = '0';
      if (session) {
        const [holdings] = await pool.query('SELECT amount, total_spent FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        if (holdings.length > 0) {
          const units = amountToUnits(holdings[0].amount);
          userHolding = unitsToAmountStr(units);
          const spent = safeBigInt(holdings[0].total_spent);
          userAvgPrice = units > 0n ? ((spent * 10000n) / units).toString() : '0';
        }
      }

      return res.json({
        success: true,
        stock: {
          stock_id: stock.stock_id,
          name: stock.name,
          price: String(stock.price),
          prev_price: String(stock.prev_price),
          sector: stock.sector,
          description: stock.description,
          high_24h: String(stock.high_24h),
          low_24h: String(stock.low_24h),
          market_cap: String(stock.market_cap),
          pe_ratio: Number(stock.pe_ratio),
          dividend_yield: Number(stock.dividend_yield),
          maxBuyShares: buyLimitInfo.maxShares,
          maxBuySharesText: buyLimitInfo.maxSharesText,
          regimeBuyPolicy: buyLimitInfo.policyName,
          userHolding,
          userAvgPrice
        },
        history: history.map(h => ({ price: Number(h.price), time: h.recorded_at }))
      });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  // 3. 주식 실시간 매수/매도 API (소수점 매매 지원)
  router.post('/stock/trade', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { action, stockId, amount } = req.body;
    if (!['buy', 'sell'].includes(action)) return res.status(400).json({ success: false, error: '유효하지 않은 거래 유형입니다.' });
    if (!isValidStockId(stockId)) return res.status(400).json({ success: false, error: '올바르지 않은 종목입니다.' });

    try {
      return await withUserLock(session.id, async () => {
      if (action === 'buy') {
        const { assertLoanPlayAllowed } = require('../../utils/loanEngine');
        await assertLoanPlayAllowed(session.id);
      }
      const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
      if (stocks.length === 0) return res.status(404).json({ success: false, error: '존재하지 않는 주식 종목입니다.' });

      const stock = stocks[0];
      if (stock.status === 'DELISTED') {
        return res.status(400).json({ success: false, error: '상장폐지된 종목은 거래할 수 없습니다.' });
      }
      if (action === 'buy' && stock.status === 'DELISTING_SOON') {
        return res.status(400).json({ success: false, error: '🚨 정리매매 종목은 신규 매수가 제한되며 보유 주식 매도만 가능합니다.' });
      }

      const stockPrice = safeBigInt(stock.price);
      const { getStockMaxBuyLimit } = require('../../utils/stockEngine');
      const buyLimitInfo = getStockMaxBuyLimit(stock);

      const userData = await getOrCreateUser(session.id, session.username, session.avatar);
      let userCash = safeBigInt(userData.cash);

      let tradeUnits = 0n;
      const isAll = isAllInAmount(amount) || req.body.isAll === true;

      if (isAll) {
        if (action === 'sell') {
          const [holdingRows] = await pool.query('SELECT amount FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
          tradeUnits = holdingRows.length ? amountToUnits(holdingRows[0].amount) : 0n;
          if (tradeUnits <= 0n) {
            return res.status(400).json({ success: false, error: '매도할 수 있는 주식을 보유하고 있지 않습니다.' });
          }
        } else if (action === 'buy') {
          tradeUnits = maxBuyShareUnits(userCash, stockPrice, session.id);
          if (tradeUnits <= 0n) {
            return res.status(400).json({ success: false, error: '현재 보유 현금으로 매수할 수 없습니다.' });
          }
          if (tradeUnits > buyLimitInfo.maxUnits) {
            tradeUnits = buyLimitInfo.maxUnits; // 1회 최대 구매 한도로 자동 캡
          }
        }
      } else {
        tradeUnits = amountToUnits(amount);
        if (tradeUnits <= 0n) {
          return res.status(400).json({ success: false, error: '거래 수량은 최소 0.0001주 이상이어야 합니다.' });
        }
        if (action === 'buy') {
          const maxUnits = maxBuyShareUnits(userCash, stockPrice, session.id);
          if (tradeUnits > maxUnits && maxUnits > 0n && tradeUnits - maxUnits <= 10000n) {
            tradeUnits = maxUnits;
          }
        }
      }

      // 🛡️ [주식별 & 거시경제 연동 1회 최대 구매 한도 검증]
      if (action === 'buy' && tradeUnits > buyLimitInfo.maxUnits) {
        return res.status(400).json({
          success: false,
          error: `[${stock.name}] 종목의 현재 경제 국면(${buyLimitInfo.regimeName}) 기준 1회 최대 구매 가능 수량은 [${buyLimitInfo.maxSharesText}]입니다. (${buyLimitInfo.policyName})`
        });
      }

      if (tradeUnits <= 0n) {
        return res.status(400).json({ success: false, error: '거래 수량은 최소 0.0001주 이상이어야 합니다.' });
      }

      const countDecStr = unitsToAmountStr(tradeUnits);
      const totalTradePrice = mulPriceAmount(stockPrice, countDecStr);

      let taxQuote = quoteTradeTax(session.id, totalTradePrice);

      // 🎫 수수료 24시간 면제권(card_zero_tax) 보유 확인
      try {
        const [invRows] = await pool.query(
          'SELECT id FROM user_inventory WHERE user_id = ? AND item_key = "card_zero_tax" AND is_active = 1 AND quantity > 0 LIMIT 1',
          [session.id]
        );
        if (invRows.length > 0) {
          taxQuote = {
            rate: 0,
            tax: 0n,
            exempt: true,
            isTaxKing: taxQuote.isTaxKing,
            taxKingDiscountText: '🎫 수수료 24시간 면제권 적용 (수수료 0%)',
            netBuy: totalTradePrice,
            netSell: totalTradePrice
          };
        }
      } catch (e) {}

      if (action === 'buy') {
        if (userCash < taxQuote.netBuy) {
          return res.status(400).json({ success: false, error: `현금이 부족합니다! (필요: ${formatMoney(taxQuote.netBuy)}${taxQuote.tax > 0n ? `, 세금 ${formatMoney(taxQuote.tax)} 포함` : ''}, 보유: ${formatMoney(userCash)})` });
        }

        const paid = await applyDebitWithTax(
          session.id,
          session.username,
          totalTradePrice,
          taxQuote.tax,
          'TAX_TRADE',
          `주식 매수 거래세 [${stock.stock_id}]`
        );
        userCash = paid.after;

        await pool.query(`
          INSERT INTO user_stocks (user_id, stock_id, amount, total_spent)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            amount = amount + VALUES(amount),
            total_spent = total_spent + VALUES(total_spent)
        `, [session.id, stockId, countDecStr, totalTradePrice.toString()]);

        try {
          await pool.query(`
            INSERT INTO stock_transactions (user_id, username, stock_id, stock_name, action, amount, price, total_price)
            VALUES (?, ?, ?, ?, 'BUY', ?, ?, ?)
          `, [session.id, session.username, stockId, stock.name, countDecStr, stockPrice.toString(), totalTradePrice.toString()]);
        } catch (e) {}

        const displayCount = countDecStr;
        const taxNote = taxQuote.tax > 0n ? ` · 세금 ${formatMoney(taxQuote.tax)}` : '';
        const [afterHold] = await pool.query(
          'SELECT amount FROM user_stocks WHERE user_id = ? AND stock_id = ?',
          [session.id, stockId]
        );
        return res.json({
          success: true,
          action: 'buy',
          stockId,
          stockName: stock.name,
          amount: countDecStr,
          holding: afterHold.length ? String(afterHold[0].amount) : countDecStr,
          price: stockPrice.toString(),
          totalPrice: totalTradePrice.toString(),
          tax: taxQuote.tax.toString(),
          taxRate: taxQuote.rate,
          newCash: userCash.toString(),
          message: `🛒 [${stock.name}] ${displayCount}주 매수 완료 (-${formatMoney(taxQuote.netBuy)}${taxNote})`
        });
      } else if (action === 'sell') {
        const [holdingRows] = await pool.query('SELECT * FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        const currentUnits = holdingRows.length > 0 ? amountToUnits(holdingRows[0].amount) : 0n;

        if (holdingRows.length === 0 || currentUnits < tradeUnits) {
          return res.status(400).json({ success: false, error: `보유 주식이 부족합니다! (현재 보유: ${unitsToAmountStr(currentUnits)}주)` });
        }

        const holding = holdingRows[0];
        const holdingSpent = safeBigInt(holding.total_spent);
        const spentDeduction = currentUnits > 0n ? (holdingSpent * tradeUnits) / currentUnits : 0n;
        const newHoldingUnits = currentUnits - tradeUnits;
        const newHoldingSpent = holdingSpent > spentDeduction ? holdingSpent - spentDeduction : 0n;

        const credited = await applyCreditMinusTax(
          session.id,
          session.username,
          totalTradePrice,
          taxQuote.tax,
          'TAX_TRADE',
          `주식 매도 거래세 [${stock.stock_id}]`
        );
        userCash = credited.after;

        if (newHoldingUnits <= 0n) {
          await pool.query('DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        } else {
          await pool.query('UPDATE user_stocks SET amount = ?, total_spent = ? WHERE user_id = ? AND stock_id = ?', [
            unitsToAmountStr(newHoldingUnits), newHoldingSpent.toString(), session.id, stockId
          ]);
        }

        try {
          await pool.query(`
            INSERT INTO stock_transactions (user_id, username, stock_id, stock_name, action, amount, price, total_price)
            VALUES (?, ?, ?, ?, 'SELL', ?, ?, ?)
          `, [session.id, session.username, stockId, stock.name, countDecStr, stockPrice.toString(), totalTradePrice.toString()]);
        } catch (e) {}

        const displayCount = countDecStr;
        const taxNote = taxQuote.tax > 0n ? ` · 세금 ${formatMoney(taxQuote.tax)}` : '';
        return res.json({
          success: true,
          action: 'sell',
          stockId,
          stockName: stock.name,
          amount: countDecStr,
          holding: unitsToAmountStr(newHoldingUnits),
          price: stockPrice.toString(),
          totalPrice: totalTradePrice.toString(),
          tax: taxQuote.tax.toString(),
          taxRate: taxQuote.rate,
          newCash: userCash.toString(),
          message: `💰 [${stock.name}] ${displayCount}주 매도 완료 (+${formatMoney(taxQuote.netSell)}${taxNote})`
        });
      }
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_CASH') {
        return res.status(400).json({ success: false, error: '현금이 부족합니다!' });
      }
      if (err.code === 'LOAN_BLOCK') {
        return res.status(403).json({ success: false, error: err.message, code: 'LOAN_BLOCK' });
      }
      return sendPublicError(res, err);
    }
  });

  // ── 📋 지정가 예약 주문 API ───────────────────────────────────

  // 내 예약 주문 목록 조회
  router.get('/limit-orders', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const { getUserOrders } = require('../../utils/limitOrderEngine');
      const statusFilter = req.query.status || 'PENDING';
      const orders = await getUserOrders(session.id, statusFilter === 'ALL' ? null : statusFilter, 50);
      const formatted = orders.map(o => ({
        id: o.id,
        stockId: o.stock_id,
        stockName: o.stock_name || o.stock_id,
        orderType: o.order_type,
        limitPrice: o.limit_price,
        amount: o.amount,
        status: o.status,
        filledPrice: o.filled_price,
        expiresAt: o.expires_at,
        filledAt: o.filled_at,
        createdAt: o.created_at
      }));
      return res.json({ success: true, orders: formatted });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  // 예약 주문 등록
  router.post('/limit-orders', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const { placeLimitOrder } = require('../../utils/limitOrderEngine');
      const { stockId, orderType, limitPrice, amount, expiresHours } = req.body || {};
      if (!stockId || !orderType || !limitPrice || !amount) {
        return res.status(400).json({ success: false, error: '필수 항목(종목코드, 유형, 지정가, 수량)을 입력해주세요.' });
      }
      const result = await placeLimitOrder(
        session.id, session.username,
        String(stockId).toUpperCase(),
        orderType, limitPrice, amount,
        expiresHours ? Number(expiresHours) : null
      );
      return res.json({ success: true, order: result });
    } catch (err) {
      if (['INVALID_TYPE','INVALID_PRICE','INVALID_AMOUNT','NO_STOCK','TOO_MANY_ORDERS','INSUFFICIENT_CASH','INSUFFICIENT_STOCK'].includes(err.code)) {
        return res.status(400).json({ success: false, error: err.message, code: err.code });
      }
      return sendPublicError(res, err);
    }
  });

  // 예약 주문 취소
  router.delete('/limit-orders/:orderId', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const { cancelLimitOrder } = require('../../utils/limitOrderEngine');
      const orderId = Number(req.params.orderId);
      if (!orderId || isNaN(orderId)) return res.status(400).json({ success: false, error: '유효한 주문 ID를 입력해주세요.' });
      await cancelLimitOrder(session.id, orderId);
      return res.json({ success: true, message: `주문 #${orderId}이 취소되었습니다.` });
    } catch (err) {
      if (['NOT_FOUND','FORBIDDEN'].includes(err.code)) {
        return res.status(err.code === 'FORBIDDEN' ? 403 : 404).json({ success: false, error: err.message });
      }
      return sendPublicError(res, err);
    }
  });

  return router;
}

module.exports = { createStockRoutes };
