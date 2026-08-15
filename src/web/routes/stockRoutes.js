/**
 * 📈 주식 시장 & 시세 & 소수점 매매 라우트 모듈
 */
const express = require('express');
const { pool, getOrCreateUser } = require('../../config/database');
const { formatMoney } = require('../../utils/formatters');

function createStockRoutes(getSessionUser) {
  const router = express.Router();

  // 1. 전체 실시간 주식 시세 목록 API
  router.get('/stocks', async (req, res) => {
    try {
      const [stocks] = await pool.query('SELECT * FROM stocks ORDER BY market_cap DESC');
      const formatted = stocks.map(s => {
        const price = Number(s.price);
        const prevPrice = Number(s.prev_price);
        const diff = price - prevPrice;
        const rate = prevPrice > 0 ? Number(((diff / prevPrice) * 100).toFixed(2)) : 0;
        return {
          stock_id: s.stock_id,
          name: s.name,
          price: price,
          prev_price: prevPrice,
          rate: rate,
          isUp: diff >= 0,
          sector: s.sector || 'IT/기술',
          pe_ratio: Number(s.pe_ratio) || 15.0,
          dividend_yield: Number(s.dividend_yield) || 2.5
        };
      });
      return res.json({ success: true, count: formatted.length, stocks: formatted });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 2. 단일 주식 상세 및 가격 히스토리 차트 API
  router.get('/stock/:stockId', async (req, res) => {
    const { stockId } = req.params;
    const session = getSessionUser(req);

    try {
      const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
      if (stocks.length === 0) return res.status(404).json({ success: false, error: '존재하지 않는 주식 종목입니다.' });

      const stock = stocks[0];
      const [history] = await pool.query('SELECT price, recorded_at FROM stock_history WHERE stock_id = ? ORDER BY recorded_at ASC LIMIT 60', [stockId]);

      let userHolding = 0;
      let userAvgPrice = 0;
      if (session) {
        const [holdings] = await pool.query('SELECT amount, total_spent FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        if (holdings.length > 0) {
          userHolding = Number(holdings[0].amount);
          const spent = Number(holdings[0].total_spent);
          userAvgPrice = userHolding > 0 ? Math.round(spent / userHolding) : 0;
        }
      }

      return res.json({
        success: true,
        stock: {
          stock_id: stock.stock_id,
          name: stock.name,
          price: Number(stock.price),
          prev_price: Number(stock.prev_price),
          sector: stock.sector,
          description: stock.description,
          high_24h: Number(stock.high_24h),
          low_24h: Number(stock.low_24h),
          market_cap: Number(stock.market_cap),
          pe_ratio: Number(stock.pe_ratio),
          dividend_yield: Number(stock.dividend_yield),
          userHolding,
          userAvgPrice
        },
        history: history.map(h => ({ price: Number(h.price), time: h.recorded_at }))
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. 주식 실시간 매수/매도 API (소수점 매매 지원)
  router.post('/stock/trade', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });

    const { action, stockId, amount } = req.body;
    if (!['buy', 'sell'].includes(action)) return res.status(400).json({ success: false, error: '유효하지 않은 거래 유형입니다.' });

    try {
      const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
      if (stocks.length === 0) return res.status(404).json({ success: false, error: '존재하지 않는 주식 종목입니다.' });

      const stock = stocks[0];
      const stockPrice = BigInt(stock.price);

      const userData = await getOrCreateUser(session.id, session.username, session.avatar);
      let userCash = BigInt(userData.cash || 0);

      let count = 0;
      const isAll = (typeof amount === 'string' && ['all', 'max', '전량', '올인', '최대', '전체'].includes(amount.trim().toLowerCase())) || req.body.isAll === true;

      if (isAll) {
        if (action === 'sell') {
          const [holdingRows] = await pool.query('SELECT amount FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
          if (holdingRows.length === 0 || Number(holdingRows[0].amount) <= 0) {
            return res.status(400).json({ success: false, error: '매도할 수 있는 주식을 보유하고 있지 않습니다.' });
          }
          count = Number(holdingRows[0].amount);
        } else if (action === 'buy') {
          const maxCanBuy = stockPrice > 0n ? (Number(userCash) / Number(stockPrice)) : 0;
          if (maxCanBuy <= 0.0001) {
            return res.status(400).json({ success: false, error: '현재 보유 현금으로 매수할 수 없습니다.' });
          }
          count = Math.floor(maxCanBuy * 10000) / 10000;
        }
      } else {
        count = parseFloat(amount);
        if (action === 'buy') {
          const neededCash = BigInt(Math.floor(Number(stockPrice) * count));
          if (userCash < neededCash && userCash > 0n) {
            const adjustedMax = Math.floor((Number(userCash) / Number(stockPrice)) * 10000) / 10000;
            if (adjustedMax > 0.0001 && Math.abs(adjustedMax - count) <= 1.0) {
              count = adjustedMax;
            }
          }
        }
      }

      if (isNaN(count) || count < 0.0001) {
        return res.status(400).json({ success: false, error: '거래 수량은 최소 0.0001주 이상이어야 합니다.' });
      }

      // 소수점 4자리 정밀 라운딩
      count = Math.round(count * 10000) / 10000;
      const countDecStr = count.toFixed(4);
      const totalTradePrice = BigInt(Math.floor(Number(stockPrice) * count));

      if (action === 'buy') {
        if (userCash < totalTradePrice) {
          return res.status(400).json({ success: false, error: `현금이 부족합니다! (필요: ${formatMoney(totalTradePrice)}, 보유: ${formatMoney(userCash)})` });
        }

        userCash -= totalTradePrice;
        await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [userCash.toString(), session.id]);

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

        const displayCount = (count % 1 === 0) ? count.toLocaleString() : count.toFixed(4);
        return res.json({
          success: true,
          action: 'buy',
          stockId,
          stockName: stock.name,
          amount: count,
          price: stockPrice.toString(),
          totalPrice: totalTradePrice.toString(),
          newCash: userCash.toString(),
          message: `🛒 [${stock.name}] ${displayCount}주 매수 완료 (-${formatMoney(totalTradePrice)})`
        });
      } else if (action === 'sell') {
        const [holdingRows] = await pool.query('SELECT * FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        const currentHoldingNum = holdingRows.length > 0 ? Number(holdingRows[0].amount) : 0;

        if (holdingRows.length === 0 || currentHoldingNum < (count - 0.00001)) {
          const displayHolding = (currentHoldingNum % 1 === 0) ? currentHoldingNum.toLocaleString() : currentHoldingNum.toFixed(4);
          return res.status(400).json({ success: false, error: `보유 주식이 부족합니다! (현재 보유: ${displayHolding}주)` });
        }

        const holding = holdingRows[0];
        const holdingSpent = BigInt(holding.total_spent || 0);
        const ratio = Math.min(1.0, count / (currentHoldingNum || 1));
        const spentDeduction = BigInt(Math.floor(Number(holdingSpent) * ratio));
        const newHoldingAmountNum = Math.max(0, Math.round((currentHoldingNum - count) * 10000) / 10000);
        const newHoldingSpent = holdingSpent > spentDeduction ? holdingSpent - spentDeduction : 0n;

        userCash += totalTradePrice;
        await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [userCash.toString(), session.id]);

        if (newHoldingAmountNum <= 0.00001) {
          await pool.query('DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?', [session.id, stockId]);
        } else {
          await pool.query('UPDATE user_stocks SET amount = ?, total_spent = ? WHERE user_id = ? AND stock_id = ?', [
            newHoldingAmountNum.toFixed(4), newHoldingSpent.toString(), session.id, stockId
          ]);
        }

        try {
          await pool.query(`
            INSERT INTO stock_transactions (user_id, username, stock_id, stock_name, action, amount, price, total_price)
            VALUES (?, ?, ?, ?, 'SELL', ?, ?, ?)
          `, [session.id, session.username, stockId, stock.name, countDecStr, stockPrice.toString(), totalTradePrice.toString()]);
        } catch (e) {}

        const displayCount = (count % 1 === 0) ? count.toLocaleString() : count.toFixed(4);
        return res.json({
          success: true,
          action: 'sell',
          stockId,
          stockName: stock.name,
          amount: count,
          price: stockPrice.toString(),
          totalPrice: totalTradePrice.toString(),
          newCash: userCash.toString(),
          message: `💰 [${stock.name}] ${displayCount}주 매도 완료 (+${formatMoney(totalTradePrice)})`
        });
      }
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

module.exports = { createStockRoutes };
