'use strict';

const { pool } = require('../config/database');
const { safeBigInt, withUserLock, getUserCash, applyCashDelta } = require('./money');
const { formatMoney } = require('./formatters');

// 강화 테이블 (+1 ~ +15강)
const ENHANCE_TABLE = [
  { level: 1, cost: 5000n, rate: 100, failPenalty: 'KEEP', bonus: 15 },
  { level: 2, cost: 10000n, rate: 100, failPenalty: 'KEEP', bonus: 30 },
  { level: 3, cost: 20000n, rate: 100, failPenalty: 'KEEP', bonus: 50 },
  { level: 4, cost: 40000n, rate: 80, failPenalty: 'KEEP', bonus: 75 },
  { level: 5, cost: 70000n, rate: 70, failPenalty: 'KEEP', bonus: 105 },
  { level: 6, cost: 120000n, rate: 60, failPenalty: 'KEEP', bonus: 140 },
  { level: 7, cost: 200000n, rate: 50, failPenalty: 'DOWN', bonus: 180 },
  { level: 8, cost: 350000n, rate: 40, failPenalty: 'DOWN', bonus: 230 },
  { level: 9, cost: 550000n, rate: 35, failPenalty: 'DOWN', bonus: 290 },
  { level: 10, cost: 900000n, rate: 30, failPenalty: 'DOWN_OR_RESET', bonus: 360 },
  { level: 11, cost: 1500000n, rate: 25, failPenalty: 'DOWN_OR_RESET', bonus: 450 },
  { level: 12, cost: 2500000n, rate: 20, failPenalty: 'DOWN_OR_RESET', bonus: 560 },
  { level: 13, cost: 4000000n, rate: 15, failPenalty: 'DOWN_OR_RESET', bonus: 700 },
  { level: 14, cost: 6500000n, rate: 10, failPenalty: 'DOWN_OR_RESET', bonus: 900 },
  { level: 15, cost: 10000000n, rate: 5, failPenalty: 'DOWN_OR_RESET', bonus: 1200 }
];

/**
 * ⛏️ 유저 드릴 장비 상태 조회
 */
async function getDrillEquipment(userId) {
  const [rows] = await pool.query(
    'SELECT enhancement_level, protection_tickets, overclock_until, total_spent FROM user_drill_equipment WHERE user_id = ?',
    [userId]
  );
  if (!rows.length) {
    const firstTable = ENHANCE_TABLE[0];
    return {
      enhancementLevel: 0,
      protectionTickets: 0,
      overclockUntil: null,
      isOverclocked: false,
      totalSpent: 0n,
      bonusPercent: 0,
      nextCost: firstTable ? firstTable.cost : 5000n,
      nextRate: firstTable ? firstTable.rate : 100,
      failPenalty: firstTable ? firstTable.failPenalty : 'KEEP'
    };
  }
  const r = rows[0];
  const isOverclocked = r.overclock_until ? new Date(r.overclock_until) > new Date() : false;
  const curLevel = r.enhancement_level || 0;
  const currentTable = ENHANCE_TABLE.find(t => t.level === curLevel);
  const nextLevel = curLevel + 1;
  const nextTable = ENHANCE_TABLE.find(t => t.level === nextLevel);

  return {
    enhancementLevel: curLevel,
    protectionTickets: r.protection_tickets || 0,
    overclockUntil: r.overclock_until,
    isOverclocked,
    totalSpent: BigInt(r.total_spent || 0),
    bonusPercent: (currentTable ? currentTable.bonus : 0) + (isOverclocked ? 20 : 0),
    nextCost: nextTable ? nextTable.cost : 0n,
    nextRate: nextTable ? nextTable.rate : 0,
    failPenalty: nextTable ? nextTable.failPenalty : 'MAX'
  };
}

/**
 * ⚡ 드릴 강화 시도 (비용 100% 소각)
 */
async function enhanceDrill(userId, username, useProtection = false) {
  return withUserLock(userId, async () => {
    const drill = await getDrillEquipment(userId);
    const currentLevel = drill.enhancementLevel;

    if (currentLevel >= 15) {
      throw new Error('드릴이 이미 최고 강화 단계(+15강)에 도달했습니다!');
    }

    const nextLevel = currentLevel + 1;
    const targetTable = ENHANCE_TABLE.find(t => t.level === nextLevel);
    if (!targetTable) throw new Error('강화 정보가 존재하지 않습니다.');

    const cost = targetTable.cost;
    const userCash = await getUserCash(userId);

    if (userCash < cost) {
      throw new Error(`강화 비용(${formatMoney(cost)})이 부족합니다! (현재 잔액: ${formatMoney(userCash)})`);
    }

    let protectionUsed = false;
    if (useProtection) {
      if (drill.protectionTickets <= 0) {
        throw new Error('보유 중인 강화 파괴 방지권이 없습니다. 상점에서 구매해주세요.');
      }
      protectionUsed = true;
    }

    // 1. 강화 비용 현금 차감 (소각)
    const afterCash = await applyCashDelta(userId, -cost, {
      logType: 'DRILL_ENHANCE',
      description: `🔨 드릴 대장간 강화 시도 (+${currentLevel}강 ➔ +${nextLevel}강) 비용 100% 완전 소각`
    });

    // 2. 주사위 굴리기
    const roll = Math.random() * 100;
    const success = roll < targetTable.rate;

    let finalLevel = currentLevel;
    let resultType = 'SUCCESS';
    let detailMsg = '';

    if (success) {
      finalLevel = nextLevel;
      resultType = 'SUCCESS';
      detailMsg = `✨ 강화 대성공! 드릴이 [+${finalLevel}강]으로 강화되었습니다! (채굴 효율 +${targetTable.bonus}%)`;
    } else {
      if (targetTable.failPenalty === 'KEEP') {
        resultType = 'FAIL_KEEP';
        detailMsg = `⚠️ 강화 실패! 다행히 강화 단계가 유지되었습니다. (현재 +${finalLevel}강)`;
      } else if (targetTable.failPenalty === 'DOWN') {
        if (protectionUsed) {
          resultType = 'FAIL_PROTECTED';
          detailMsg = `🛡️ 강화 실패! 파괴 방지권이 발동하여 단계 하락을 막았습니다. (현재 +${finalLevel}강)`;
        } else {
          finalLevel = Math.max(0, currentLevel - 1);
          resultType = 'FAIL_DOWN';
          detailMsg = `💥 강화 실패! 드릴 단계가 [+${finalLevel}강]으로 1단계 하락했습니다.`;
        }
      } else if (targetTable.failPenalty === 'DOWN_OR_RESET') {
        if (protectionUsed) {
          resultType = 'FAIL_PROTECTED';
          detailMsg = `🛡️ 강화 실패! 파괴 방지권이 발동하여 초기화 및 하락을 막았습니다. (현재 +${finalLevel}강)`;
        } else {
          // 20% 확률로 0강 초기화, 80% 확률로 1단계 하락
          if (Math.random() < 0.20) {
            finalLevel = 0;
            resultType = 'FAIL_RESET';
            detailMsg = `💥 과부하 폭발! 드릴이 [0강]으로 초기화되었습니다... ㅠㅠ`;
          } else {
            finalLevel = Math.max(0, currentLevel - 1);
            resultType = 'FAIL_DOWN';
            detailMsg = `💥 강화 실패! 드릴 단계가 [+${finalLevel}강]으로 1단계 하락했습니다.`;
          }
        }
      }
    }

    // 3. DB 업데이트
    await pool.query(`
      INSERT INTO user_drill_equipment (user_id, enhancement_level, protection_tickets, total_spent)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        enhancement_level = VALUES(enhancement_level),
        protection_tickets = protection_tickets - ?,
        total_spent = total_spent + ?;
    `, [
      userId,
      finalLevel,
      protectionUsed ? 0 : 0,
      cost.toString(),
      protectionUsed ? 1 : 0,
      cost.toString()
    ]);

    // 4. 경제 소각 원장 기록
    await pool.query(`
      INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason)
      VALUES ('OUTFLOW_SINK', 'DRILL_ENHANCE', ?, ?, ?, ?)
    `, [
      cost.toString(),
      userId,
      afterCash.toString(),
      `⚡ 드릴 강화 시도 (+${currentLevel} ➔ +${nextLevel}): ${resultType}`
    ]);

    return {
      success,
      resultType,
      previousLevel: currentLevel,
      currentLevel: finalLevel,
      cost,
      afterCash,
      message: detailMsg
    };
  });
}

/**
 * 🛢️ 오버클럭 냉각유 주입 (24시간 버프)
 */
async function applyOverclockOil(userId) {
  return withUserLock(userId, async () => {
    const [invRows] = await pool.query(
      'SELECT quantity FROM user_inventory WHERE user_id = ? AND item_key = "buff_overclock_oil" AND quantity > 0',
      [userId]
    );
    if (!invRows.length) {
      throw new Error('인벤토리에 [오버클럭 냉각유]가 없습니다.');
    }

    // 인벤토리 수량 1개 차감
    await pool.query(
      'UPDATE user_inventory SET quantity = quantity - 1 WHERE user_id = ? AND item_key = "buff_overclock_oil"',
      [userId]
    );

    const overclockUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(`
      INSERT INTO user_drill_equipment (user_id, overclock_until)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE overclock_until = VALUES(overclock_until);
    `, [userId, overclockUntil]);

    return {
      success: true,
      overclockUntil,
      message: '🛢️ 오버클럭 냉각유 주입 완료! 24시간 동안 채굴 효율 +20% 부스트가 활성화됩니다.'
    };
  });
}

module.exports = {
  ENHANCE_TABLE,
  getDrillEquipment,
  enhanceDrill,
  applyOverclockOil
};
