'use strict';

const { pool } = require('../config/database');
const { safeBigInt, applyCashDelta } = require('../utils/money');
const { amountToUnits, mulPriceAmount } = require('../utils/moneyScale');

class StockModel {
  /**
   * 전체 주식 종목 조회
   */
  static async getAllStocks() {
    const [rows] = await pool.query('SELECT * FROM stocks ORDER BY stock_id ASC');
    return rows.map(r => {
      const p = Number(r.price || 0);
      const prev = Number(r.prev_price || r.price || 1);
      const rate = prev > 0 ? ((p - prev) / prev) * 100 : 0;
      return {
        stock_id: r.stock_id,
        name: r.name,
        code: r.code || r.stock_id,
        icon: r.icon || '📈',
        price: safeBigInt(r.price).toString(),
        prev_price: safeBigInt(r.prev_price || r.price).toString(),
        rate: isNaN(rate) ? 0 : rate,
        total_shares: String(r.total_shares || '1000000000000000000000'),
        is_bankrupt: Number(r.is_bankrupt || 0)
      };
    });
  }

  /**
   * 주식 단건 조회
   */
  static async getStockById(stockId) {
    const [rows] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
    return rows[0] || null;
  }

  /**
   * 주식 과거 시세 히스토리 조회 (차트 렌더링용)
   */
  static async getStockHistory(stockId, limit = 60) {
    try {
      const [rows] = await pool.query(
        'SELECT price, recorded_at FROM stock_history WHERE stock_id = ? ORDER BY id DESC LIMIT ?',
        [stockId, Number(limit)]
      );
      if (!rows || rows.length === 0) {
        const stock = await StockModel.getStockById(stockId);
        if (!stock) return [];
        const p = Number(stock.price || 100);
        return Array.from({ length: 15 }, (_, i) => ({
          price: Math.max(1, p + Math.round((Math.sin(i) * p * 0.03)))
        }));
      }
      return rows.reverse().map(r => ({ price: Number(r.price), created_at: r.recorded_at }));
    } catch (_) {
      return [];
    }
  }

  /**
   * 유저의 보유 주식 목록 및 평가액 조회
   */
  static async getUserHoldings(userId) {
    const id = String(userId);
    const [rows] = await pool.query(`
      SELECT us.stock_id, us.amount, us.total_spent, s.name, s.price
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.stock_id
      WHERE us.user_id = ? AND us.amount > 0
    `, [id]);

    let totalStockVal = 0n;
    const holdings = rows.map(r => {
      const amountStr = String(r.amount || '0');
      const curPrice = safeBigInt(r.price);
      const spent = safeBigInt(r.total_spent);
      const evalVal = mulPriceAmount(curPrice, amountStr);
      totalStockVal += evalVal;

      return {
        stockId: r.stock_id,
        name: r.name,
        amount: amountStr,
        price: curPrice.toString(),
        totalSpent: spent.toString(),
        evalVal: evalVal.toString(),
        profit: (evalVal - spent).toString()
      };
    });

    return { holdings, totalStockVal };
  }

  /**
   * 주식 매수 트랜잭션
   */
  static async buyStock(userId, stockId, amountStr) {
    const id = String(userId);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [stockRows] = await conn.query('SELECT * FROM stocks WHERE stock_id = ? FOR UPDATE', [stockId]);
      if (!stockRows.length) throw new Error('존재하지 않는 주식 종목입니다.');
      const stock = stockRows[0];
      const price = safeBigInt(stock.price);

      const [userRows] = await conn.query('SELECT cash FROM users WHERE discord_id = ? FOR UPDATE', [id]);
      if (!userRows.length) throw new Error('유저를 찾을 수 없습니다.');
      const userCash = safeBigInt(userRows[0].cash);

      const cost = mulPriceAmount(price, amountStr);
      if (cost <= 0n) throw new Error('매수 금액이 올바르지 않습니다.');
      if (userCash < cost) throw new Error('보유 현금이 부족합니다.');

      // 1. 현금 차감
      await conn.query('UPDATE users SET cash = cash - ? WHERE discord_id = ?', [cost.toString(), id]);

      // 2. 보유 주식 갱신
      await conn.query(`
        INSERT INTO user_stocks (user_id, stock_id, amount, total_spent)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          amount = amount + VALUES(amount),
          total_spent = total_spent + VALUES(total_spent)
      `, [id, stockId, amountStr, cost.toString()]);

      // 3. 거래 로그 기록
      await conn.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, description)
        VALUES (?, ?, 'STOCK_BUY', ?, ?)
      `, [id, id, cost.toString(), `주식 매수: ${stockId} ${amountStr}주`]);

      await conn.commit();
      return { success: true, cost: cost.toString(), newCash: (userCash - cost).toString() };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  /**
   * 주식 매도 트랜잭션
   */
  static async sellStock(userId, stockId, amountStr) {
    const id = String(userId);
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [stockRows] = await conn.query('SELECT * FROM stocks WHERE stock_id = ? FOR UPDATE', [stockId]);
      if (!stockRows.length) throw new Error('존재하지 않는 주식 종목입니다.');
      const stock = stockRows[0];
      const price = safeBigInt(stock.price);

      const [holdingRows] = await conn.query('SELECT amount, total_spent FROM user_stocks WHERE user_id = ? AND stock_id = ? FOR UPDATE', [id, stockId]);
      if (!holdingRows.length || Number(holdingRows[0].amount) <= 0) throw new Error('보유하고 있는 주식이 없습니다.');

      const curHolding = Number(holdingRows[0].amount);
      const reqAmount = Number(amountStr);
      if (reqAmount <= 0 || reqAmount > curHolding) throw new Error('매도하려는 주식 수량이 보유 수량보다 많습니다.');

      const revenue = mulPriceAmount(price, amountStr);

      // 1. 현금 입금
      await conn.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [revenue.toString(), id]);

      // 2. 보유 주식 차감
      if (reqAmount === curHolding) {
        await conn.query('DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?', [id, stockId]);
      } else {
        await conn.query('UPDATE user_stocks SET amount = amount - ? WHERE user_id = ? AND stock_id = ?', [amountStr, id, stockId]);
      }

      // 3. 거래 로그 기록
      await conn.query(`
        INSERT INTO economy_logs (user_id, username, type, amount, description)
        VALUES (?, ?, 'STOCK_SELL', ?, ?)
      `, [id, id, revenue.toString(), `주식 매도: ${stockId} ${amountStr}주`]);

      await conn.commit();
      return { success: true, revenue: revenue.toString() };
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}

module.exports = StockModel;
