'use strict';

const { pool } = require('../config/database');
const { safeBigInt, withUserLock } = require('./money');
const { formatMoney } = require('./formatters');
const { logInfo, logError } = require('./logger');

const TICKET_PRICE = 1000n; // 1장당 1,000원
const BURN_PERCENT = 30n;   // 30% 즉시 영구 소각
const PRIZE_PERCENT = 70n;  // 70% 잭팟 누적

/**
 * 🎰 현재 진행 중인 로또 회차 조회
 */
async function getCurrentLottoRound(db = pool, lockForUpdate = false) {
  const lockSql = lockForUpdate ? ' FOR UPDATE' : '';
  const [rows] = await db.query(
    `SELECT * FROM lotto_rounds WHERE status = "OPEN" ORDER BY round_number DESC LIMIT 1${lockSql}`
  );
  if (rows.length) return rows[0];

  // 회차가 없으면 1회차 생성
  await db.query(`
    INSERT INTO lotto_rounds (round_number, jackpot_pool, total_sales, total_burned, status)
    VALUES (1, 10000000, 0, 0, 'OPEN')
    ON DUPLICATE KEY UPDATE round_number = VALUES(round_number);
  `);
  const [newRows] = await db.query(`SELECT * FROM lotto_rounds WHERE status = "OPEN" ORDER BY round_number DESC LIMIT 1${lockSql}`);
  if (!newRows[0]) throw new Error('현재 구매 가능한 로또 회차가 없습니다.');
  return newRows[0];
}

async function inTransaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (err) {
    try { await connection.rollback(); } catch (rollbackError) {}
    throw err;
  } finally {
    connection.release();
  }
}

function notifyCashChanged(userId, username, amount, afterCash) {
  try { require('./liveSync').pushUserLive(userId); } catch (e) {}
  if (global.__io) {
    global.__io.emit('admin:event', {
      type: 'USER_MONEY_CHANGE',
      userId: String(userId),
      username,
      actionType: 'LOTTO_BUY',
      amount: amount.toString(),
      balanceAfter: afterCash.toString(),
      timestamp: Date.now()
    });
  }
}

/**
 * 🎟️ 로또 복권 구매 (1~45 중 6개 번호, 30% 확정 소각)
 */
async function buyLottoTicket(userId, username, inputNumbers = null, isAuto = false) {
  let numbers = [];

  if (isAuto || !inputNumbers) {
    // 자동 번호 추출
    const set = new Set();
    while (set.size < 6) {
      set.add(Math.floor(Math.random() * 45) + 1);
    }
    numbers = Array.from(set).sort((a, b) => a - b);
  } else {
    // 수동 번호 검증
    if (Array.isArray(inputNumbers)) {
      numbers = inputNumbers.map(Number).filter(n => n >= 1 && n <= 45);
    } else if (typeof inputNumbers === 'string') {
      numbers = inputNumbers.split(/[\s,]+/).map(Number).filter(n => n >= 1 && n <= 45);
    }
    const unique = Array.from(new Set(numbers)).sort((a, b) => a - b);
    if (unique.length !== 6) {
      throw new Error('1부터 45 사이의 서로 다른 번호 6개를 선택해주세요.');
    }
    numbers = unique;
  }

  const numberStr = numbers.join(',');

  return withUserLock(userId, async () => {
    const burnAmount = (TICKET_PRICE * BURN_PERCENT) / 100n;
    const prizeAdd = (TICKET_PRICE * PRIZE_PERCENT) / 100n;
    const purchase = await inTransaction(async (connection) => {
      const round = await getCurrentLottoRound(connection, true);
      const [users] = await connection.query(
        'SELECT cash, username FROM users WHERE discord_id = ? LIMIT 1 FOR UPDATE',
        [userId]
      );
      if (!users[0]) throw new Error('사용자 정보를 찾을 수 없습니다.');
      const beforeCash = safeBigInt(users[0].cash);
      if (beforeCash < TICKET_PRICE) {
        throw new Error(`로또 구매 비용(${formatMoney(TICKET_PRICE)})이 부족합니다. (현재 보유: ${formatMoney(beforeCash)})`);
      }
      const afterCash = beforeCash - TICKET_PRICE;
      const description = `🎰 로또 6/45 ${round.round_number}회차 구매 (${numberStr}) - 30% 국고소각`;

      await connection.query('UPDATE users SET cash = ? WHERE discord_id = ?', [afterCash.toString(), userId]);
      await connection.query(`
        UPDATE lotto_rounds
        SET
          total_sales = total_sales + ?,
          total_burned = total_burned + ?,
          jackpot_pool = jackpot_pool + ?
        WHERE round_number = ? AND status = 'OPEN'
      `, [TICKET_PRICE.toString(), burnAmount.toString(), prizeAdd.toString(), round.round_number]);
      await connection.query(`
        INSERT INTO lotto_tickets (round_number, user_id, numbers, is_auto)
        VALUES (?, ?, ?, ?)
      `, [round.round_number, userId, numberStr, isAuto ? 1 : 0]);
      await connection.query(`
        INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason)
        VALUES ('OUTFLOW_SINK', 'LOTTO_BUY', ?, ?, ?, ?)
      `, [TICKET_PRICE.toString(), userId, afterCash.toString(), description]);
      await connection.query(`
        INSERT INTO economy_logs
          (user_id, username, type, amount, balance_before, balance_after, description)
        VALUES (?, ?, 'LOTTO_BUY', ?, ?, ?, ?)
      `, [
        String(userId),
        username || users[0].username || `유저_${String(userId).slice(-4)}`,
        TICKET_PRICE.toString(),
        beforeCash.toString(),
        afterCash.toString(),
        description
      ]);

      return { round, afterCash };
    });

    const { round, afterCash } = purchase;
    notifyCashChanged(userId, username, TICKET_PRICE, afterCash);

    return {
      success: true,
      roundNumber: round.round_number,
      numbers,
      numberStr,
      isAuto,
      afterCash,
      message: `🎟️ [제 ${round.round_number}회 로또 6/45] 구매 완료!\n선택 번호: [ ${numberStr} ] (${isAuto ? '자동' : '수동'})\n💸 30%(${formatMoney(burnAmount)}) 국고 소각, 70%(${formatMoney(prizeAdd)}) 잭팟 풀 적립 완료!`
    };
  });
}

/**
 * 🎲 주간 로또 당첨 번호 추첨 및 상금 자동 분배
 */
async function drawLottoRound(targetRound = null) {
  const round = targetRound || await getCurrentLottoRound();
  if (round.status !== 'OPEN') {
    throw new Error('이미 추첨이 완료된 회차입니다.');
  }

  // 1. 당첨 번호 6개 + 보너스 번호 1개 추출
  const set = new Set();
  while (set.size < 7) {
    set.add(Math.floor(Math.random() * 45) + 1);
  }
  const all7 = Array.from(set);
  const win6 = all7.slice(0, 6).sort((a, b) => a - b);
  const bonus = all7[6];
  const winStr = win6.join(',');

  // 2. 전체 티켓 대조 및 당첨 등수 판정
  const [tickets] = await pool.query(
    'SELECT id, user_id, numbers FROM lotto_tickets WHERE round_number = ?',
    [round.round_number]
  );

  const rank1List = [];
  const rank2List = [];
  const rank3List = [];
  const rank4List = [];
  const rank5List = [];

  for (const t of tickets) {
    const tNums = t.numbers.split(',').map(Number);
    const matchCount = tNums.filter(n => win6.includes(n)).length;
    const hasBonus = tNums.includes(bonus);

    let rank = 0;
    if (matchCount === 6) rank = 1;
    else if (matchCount === 5 && hasBonus) rank = 2;
    else if (matchCount === 5) rank = 3;
    else if (matchCount === 4) rank = 4;
    else if (matchCount === 3) rank = 5;

    if (rank === 1) rank1List.push(t);
    else if (rank === 2) rank2List.push(t);
    else if (rank === 3) rank3List.push(t);
    else if (rank === 4) rank4List.push(t);
    else if (rank === 5) rank5List.push(t);
  }

  const jackpot = BigInt(round.jackpot_pool || 10000000);
  // 상금 배분: 1등(75%), 2등(15%), 3등(10%), 4등(고정 5만원), 5등(고정 5천원)
  let carriedOver = 10000000n; // 차기 이월 기본금

  if (rank1List.length > 0) {
    const rank1PrizeEach = (jackpot * 75n) / (100n * BigInt(rank1List.length));
    for (const t of rank1List) {
      await pool.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [rank1PrizeEach.toString(), t.user_id]);
      await pool.query('UPDATE lotto_tickets SET prize_rank = 1, prize_amount = ? WHERE id = ?', [rank1PrizeEach.toString(), t.id]);
    }
  }

  if (rank2List.length > 0) {
    const rank2PrizeEach = (jackpot * 15n) / (100n * BigInt(rank2List.length));
    for (const t of rank2List) {
      await pool.query('UPDATE users SET cash = cash + ? WHERE discord_id = ?', [rank2PrizeEach.toString(), t.user_id]);
      await pool.query('UPDATE lotto_tickets SET prize_rank = 2, prize_amount = ? WHERE id = ?', [rank2PrizeEach.toString(), t.id]);
    }
  }

  // 4. 회차 마감 및 신규 회차 생성
  await pool.query(`
    UPDATE lotto_rounds
    SET 
      winning_numbers = ?,
      bonus_number = ?,
      drawn_at = NOW(),
      status = 'SETTLED'
    WHERE round_number = ?
  `, [winStr, bonus, round.round_number]);

  const nextRound = round.round_number + 1;
  await pool.query(`
    INSERT INTO lotto_rounds (round_number, jackpot_pool, total_sales, total_burned, status)
    VALUES (?, ?, 0, 0, 'OPEN')
  `, [nextRound, carriedOver.toString()]);

  logInfo('LottoEngine', `[로또 추첨 완료] 제${round.round_number}회 당첨번호: [${winStr}] + 보너스 [${bonus}] (1등: ${rank1List.length}명)`);

  return {
    roundNumber: round.round_number,
    winningNumbers: win6,
    bonusNumber: bonus,
    rank1Count: rank1List.length,
    rank2Count: rank2List.length,
    rank3Count: rank3List.length,
    nextRound
  };
}

/**
 * ⏰ 2일 주기 자동 추첨 스케줄러 (48시간 주기)
 */
const LOTTO_DRAW_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000; // 2일

async function checkAndAutoDrawLotto() {
  try {
    const round = await getCurrentLottoRound();
    if (!round || round.status !== 'OPEN') return;
    const createdAt = round.created_at ? new Date(round.created_at).getTime() : Date.now();
    const elapsed = Date.now() - createdAt;
    if (elapsed >= LOTTO_DRAW_INTERVAL_MS) {
      logInfo('LottoEngine', `[자동 2일 추첨] 제${round.round_number}회차 로또 48시간 만료로 자동 추첨을 시작합니다.`);
      await drawLottoRound(round);
    }
  } catch (err) {
    logError('LottoEngine', `[자동 로또 추첨 오류]: ${err.message}`);
  }
}

function startLottoScheduler() {
  // 5분마다 2일 만료 검사
  setInterval(checkAndAutoDrawLotto, 5 * 60 * 1000).unref?.();
  setTimeout(checkAndAutoDrawLotto, 5000);
}

/**
 * 📋 유저 로또 티켓 목록 조회
 */
async function getUserLottoTickets(userId, roundNumber = null) {
  const round = roundNumber || (await getCurrentLottoRound()).round_number;
  const [tickets] = await pool.query(`
    SELECT id, round_number, numbers, is_auto, prize_rank, prize_amount, created_at
    FROM lotto_tickets
    WHERE user_id = ? AND round_number = ?
    ORDER BY id DESC
  `, [userId, round]);
  return tickets;
}

module.exports = {
  getCurrentLottoRound,
  buyLottoTicket,
  drawLottoRound,
  getUserLottoTickets,
  startLottoScheduler,
  LOTTO_DRAW_INTERVAL_MS
};

