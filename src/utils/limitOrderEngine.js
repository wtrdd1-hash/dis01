'use strict';

/**
 * 📋 지정가 주문(예약 매수/매도) 엔진
 * - BUY:  현재가 <= 지정가 → 자동 매수 체결
 * - SELL: 현재가 >= 지정가 → 자동 매도 체결
 */

const { pool } = require('../config/database');
const { safeBigInt, withUserLock } = require('./money');
const { amountToUnits, unitsToAmountStr, mulPriceAmount } = require('./moneyScale');
const { quoteTradeTax, applyDebitWithTax, applyCreditMinusTax } = require('./taxEngine');

// ── 상수 ──────────────────────────────────────────────────────
const MAX_PENDING_ORDERS_PER_USER = 20; // 유저당 동시 미체결 최대 주문 수

// ── 지정가 주문 등록 ──────────────────────────────────────────
async function placeLimitOrder(userId, username, stockId, orderType, limitPrice, amount, expiresHours = null) {
  const type = String(orderType).toUpperCase();
  if (type !== 'BUY' && type !== 'SELL') throw Object.assign(new Error('주문 유형은 BUY 또는 SELL이어야 합니다.'), { code: 'INVALID_TYPE' });

  const price = safeBigInt(limitPrice);
  if (price <= 0n) throw Object.assign(new Error('지정가는 1원 이상이어야 합니다.'), { code: 'INVALID_PRICE' });

  const units = amountToUnits(String(amount));
  if (units <= 0n) throw Object.assign(new Error('수량은 0.0001주 이상이어야 합니다.'), { code: 'INVALID_AMOUNT' });

  // 종목 확인
  const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockId]);
  if (!stocks.length) throw Object.assign(new Error(`\`${stockId}\` 종목을 찾을 수 없습니다.`), { code: 'NO_STOCK' });

  // 미체결 주문 수 제한
  const [pending] = await pool.query(
    "SELECT COUNT(*) as cnt FROM stock_limit_orders WHERE user_id = ? AND status = 'PENDING'",
    [userId]
  );
  if (Number(pending[0].cnt) >= MAX_PENDING_ORDERS_PER_USER) {
    throw Object.assign(new Error(`미체결 예약 주문이 최대 ${MAX_PENDING_ORDERS_PER_USER}개입니다. 먼저 일부를 취소해주세요.`), { code: 'TOO_MANY_ORDERS' });
  }

  // 매수 주문: 주문 시점에 예약금 선차감 (잔고 충분한지 검증)
  if (type === 'BUY') {
    const totalCost = mulPriceAmount(price, unitsToAmountStr(units));
    const taxQuote = quoteTradeTax(userId, totalCost);
    const totalRequired = taxQuote.netBuy;
    const [userRows] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [userId]);
    const cash = safeBigInt(userRows[0]?.cash);
    if (cash < totalRequired) {
      throw Object.assign(new Error(
        `잔고가 부족합니다.\n필요 금액: **${formatMoneyInline(totalRequired)}** (지정가 × 수량 + 거래세)\n현재 보유: **${formatMoneyInline(cash)}**`
      ), { code: 'INSUFFICIENT_CASH' });
    }
  }

  // 매도 주문: 보유 수량 확인
  if (type === 'SELL') {
    const [holdRows] = await pool.query(
      'SELECT amount FROM user_stocks WHERE user_id = ? AND stock_id = ?',
      [userId, stockId]
    );
    const holdUnits = holdRows.length ? amountToUnits(holdRows[0].amount) : 0n;
    if (holdUnits < units) {
      throw Object.assign(new Error(
        `보유 수량이 부족합니다.\n예약 수량: **${unitsToAmountStr(units)}주**\n현재 보유: **${unitsToAmountStr(holdUnits)}주**`
      ), { code: 'INSUFFICIENT_STOCK' });
    }
  }

  const amountStr = unitsToAmountStr(units);
  let expiresAt = null;
  if (expiresHours && expiresHours > 0) {
    expiresAt = new Date(Date.now() + expiresHours * 3600 * 1000);
  }

  const [result] = await pool.query(
    `INSERT INTO stock_limit_orders (user_id, username, stock_id, order_type, limit_price, amount, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
    [userId, username, stockId, type, price.toString(), amountStr, expiresAt]
  );

  return {
    orderId: result.insertId,
    stockId,
    stockName: stocks[0].name,
    orderType: type,
    limitPrice: price,
    amount: amountStr,
    expiresAt
  };
}

// ── 주문 취소 ─────────────────────────────────────────────────
async function cancelLimitOrder(userId, orderId) {
  const [rows] = await pool.query(
    "SELECT * FROM stock_limit_orders WHERE id = ? AND status = 'PENDING'",
    [orderId]
  );
  if (!rows.length) throw Object.assign(new Error('미체결 주문을 찾을 수 없습니다.'), { code: 'NOT_FOUND' });

  const order = rows[0];
  if (String(order.user_id) !== String(userId)) {
    throw Object.assign(new Error('본인의 주문만 취소할 수 있습니다.'), { code: 'FORBIDDEN' });
  }

  await pool.query(
    "UPDATE stock_limit_orders SET status = 'CANCELLED' WHERE id = ?",
    [orderId]
  );
  return order;
}

// ── 유저 주문 조회 ────────────────────────────────────────────
async function getUserOrders(userId, status = null, limit = 30) {
  let sql = `SELECT lo.*, s.name as stock_name
    FROM stock_limit_orders lo
    LEFT JOIN stocks s ON lo.stock_id = s.stock_id
    WHERE lo.user_id = ?`;
  const params = [userId];
  if (status) { sql += ' AND lo.status = ?'; params.push(status); }
  sql += ' ORDER BY lo.created_at DESC LIMIT ?';
  params.push(limit);
  const [rows] = await pool.query(sql, params);
  return rows;
}

// ── 만료 주문 자동 취소 (30분 주기 호출) ─────────────────────
async function expirePendingOrders() {
  try {
    const [result] = await pool.query(
      "UPDATE stock_limit_orders SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at < NOW()"
    );
    if (result.affectedRows > 0) {
      console.log(`⏰ [지정가 주문] 만료 처리 완료: ${result.affectedRows}건`);
    }
  } catch (e) {
    console.error('지정가 만료 처리 오류:', e);
  }
}

// ── 체결 처리 (주가 갱신 시 호출) ────────────────────────────
async function processPendingOrders(client) {
  try {
    // 미체결 주문 전체 조회
    const [orders] = await pool.query(
      `SELECT lo.*, s.price as current_price, s.name as stock_name
       FROM stock_limit_orders lo
       JOIN stocks s ON lo.stock_id = s.stock_id
       WHERE lo.status = 'PENDING'
         AND (lo.expires_at IS NULL OR lo.expires_at > NOW())`
    );

    for (const order of orders) {
      const currentPrice = safeBigInt(order.current_price);
      const limitPrice = safeBigInt(order.limit_price);
      const type = order.order_type;

      // 체결 조건 확인
      const shouldFill =
        (type === 'BUY'  && currentPrice <= limitPrice) ||
        (type === 'SELL' && currentPrice >= limitPrice);

      if (!shouldFill) continue;

      // 체결 처리 (유저 락 적용)
      try {
        await withUserLock(order.user_id, async () => {
          await fillOrder(order, currentPrice, client);
        });
      } catch (fillErr) {
        // 체결 실패 시 주문 취소 처리
        await pool.query(
          "UPDATE stock_limit_orders SET status = 'CANCELLED' WHERE id = ?",
          [order.id]
        );
        console.error(`❌ [지정가 주문] 체결 실패 (orderId=${order.id}):`, fillErr.message);
      }
    }
  } catch (e) {
    console.error('지정가 주문 처리 오류:', e);
  }
}

// ── 단건 체결 처리 ────────────────────────────────────────────
async function fillOrder(order, currentPrice, client) {
  const userId = order.user_id;
  const username = order.username;
  const stockId = order.stock_id;
  const stockName = order.stock_name;
  const type = order.order_type;
  const units = amountToUnits(String(order.amount));
  const amountStr = unitsToAmountStr(units);
  const totalAmount = mulPriceAmount(currentPrice, amountStr);

  if (type === 'BUY') {
    // 잔고 재확인
    const [userRows] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [userId]);
    const cash = safeBigInt(userRows[0]?.cash);
    const taxQuote = quoteTradeTax(userId, totalAmount);
    if (cash < taxQuote.netBuy) {
      throw Object.assign(new Error('잔고 부족으로 체결 불가'), { code: 'INSUFFICIENT_CASH' });
    }

    await applyDebitWithTax(userId, username, totalAmount, taxQuote.tax, 'TAX_TRADE', `지정가 매수 체결 [${stockId}]`);
    await pool.query(
      `INSERT INTO user_stocks (user_id, stock_id, amount, total_spent) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount), total_spent = total_spent + VALUES(total_spent)`,
      [userId, stockId, amountStr, totalAmount.toString()]
    );

    // 체결 로그
    await pool.query(
      `INSERT INTO stock_transactions (user_id, username, stock_id, stock_name, action, amount, price, total_price)
       VALUES (?, ?, ?, ?, 'BUY', ?, ?, ?)`,
      [userId, username, stockId, stockName, amountStr, currentPrice.toString(), totalAmount.toString()]
    );

    await pool.query(
      `UPDATE stock_limit_orders SET status = 'FILLED', filled_price = ?, filled_at = NOW() WHERE id = ?`,
      [currentPrice.toString(), order.id]
    );

    // Discord DM 알림
    notifyUser(client, userId, {
      color: 0x10B981,
      title: '✅ 지정가 매수 체결 완료!',
      desc: `**${stockName}** (\`${stockId}\`) **${amountStr}주**\n지정가: ${formatMoneyInline(safeBigInt(order.limit_price))} → 체결가: **${formatMoneyInline(currentPrice)}**\n지불: **-${formatMoneyInline(taxQuote.netBuy)}**`
    });

  } else { // SELL
    const [holdRows] = await pool.query(
      'SELECT amount, total_spent FROM user_stocks WHERE user_id = ? AND stock_id = ? FOR UPDATE',
      [userId, stockId]
    );
    const holdUnits = holdRows.length ? amountToUnits(holdRows[0].amount) : 0n;
    if (holdUnits < units) {
      throw Object.assign(new Error('보유 수량 부족으로 체결 불가'), { code: 'INSUFFICIENT_STOCK' });
    }

    const taxQuote = quoteTradeTax(userId, totalAmount);
    await applyCreditMinusTax(userId, username, totalAmount, taxQuote.tax, 'TAX_TRADE', `지정가 매도 체결 [${stockId}]`);

    const newUnits = holdUnits - units;
    if (newUnits <= 0n) {
      await pool.query('DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?', [userId, stockId]);
    } else {
      const totalSpent = safeBigInt(holdRows[0].total_spent);
      const spentDeduction = holdUnits > 0n ? (totalSpent * units) / holdUnits : 0n;
      await pool.query(
        'UPDATE user_stocks SET amount = ?, total_spent = ? WHERE user_id = ? AND stock_id = ?',
        [unitsToAmountStr(newUnits), (totalSpent - spentDeduction).toString(), userId, stockId]
      );
    }

    await pool.query(
      `INSERT INTO stock_transactions (user_id, username, stock_id, stock_name, action, amount, price, total_price)
       VALUES (?, ?, ?, ?, 'SELL', ?, ?, ?)`,
      [userId, username, stockId, stockName, amountStr, currentPrice.toString(), totalAmount.toString()]
    );

    await pool.query(
      `UPDATE stock_limit_orders SET status = 'FILLED', filled_price = ?, filled_at = NOW() WHERE id = ?`,
      [currentPrice.toString(), order.id]
    );

    notifyUser(client, userId, {
      color: 0xF59E0B,
      title: '🔔 지정가 매도 체결 완료!',
      desc: `**${stockName}** (\`${stockId}\`) **${amountStr}주**\n지정가: ${formatMoneyInline(safeBigInt(order.limit_price))} → 체결가: **${formatMoneyInline(currentPrice)}**\n수령: **+${formatMoneyInline(taxQuote.netSell)}**`
    });
  }
}

// ── 관리자 전체 미체결 주문 조회 ─────────────────────────────
async function getAllPendingOrders(limit = 100) {
  const [rows] = await pool.query(
    `SELECT lo.*, s.name as stock_name, s.price as current_price
     FROM stock_limit_orders lo
     LEFT JOIN stocks s ON lo.stock_id = s.stock_id
     WHERE lo.status = 'PENDING'
     ORDER BY lo.created_at DESC LIMIT ?`,
    [limit]
  );
  return rows;
}

// ── 헬퍼 ──────────────────────────────────────────────────────
function formatMoneyInline(bigint) {
  try {
    const { formatMoney } = require('./formatters');
    return formatMoney(bigint);
  } catch (e) {
    return String(bigint) + '원';
  }
}

async function notifyUser(client, userId, { color, title, desc }) {
  if (!client) return;
  try {
    const user = await client.users.fetch(userId);
    await user.send({
      embeds: [{
        color,
        title,
        description: desc,
        footer: { text: '월덕 가상 경제 · 지정가 주문 시스템' },
        timestamp: new Date().toISOString()
      }]
    });
  } catch (e) {}
}

module.exports = {
  placeLimitOrder,
  cancelLimitOrder,
  getUserOrders,
  getAllPendingOrders,
  processPendingOrders,
  expirePendingOrders
};
