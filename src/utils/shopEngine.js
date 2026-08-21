'use strict';

const { pool } = require('../config/database');
const { safeBigInt, withUserLock } = require('./money');
const { formatMoney } = require('./formatters');
const { logInfo, logError } = require('./logger');

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

function notifyCashChanged(userId, username, actionType, amount, afterCash) {
  try { require('./liveSync').pushUserLive(userId); } catch (e) {}
  if (global.__io) {
    global.__io.emit('admin:event', {
      type: 'USER_MONEY_CHANGE',
      userId: String(userId),
      username,
      actionType,
      amount: amount.toString(),
      balanceAfter: afterCash.toString(),
      timestamp: Date.now()
    });
  }
}

async function debitUser(connection, userId, username, amount, logType, description) {
  const [rows] = await connection.query(
    'SELECT cash, username FROM users WHERE discord_id = ? LIMIT 1 FOR UPDATE',
    [userId]
  );
  if (!rows[0]) throw new Error('사용자 정보를 찾을 수 없습니다.');

  const beforeCash = safeBigInt(rows[0].cash);
  if (beforeCash < amount) {
    throw new Error(`잔액이 부족합니다! (필요: ${formatMoney(amount)}, 보유: ${formatMoney(beforeCash)})`);
  }
  const afterCash = beforeCash - amount;
  await connection.query('UPDATE users SET cash = ? WHERE discord_id = ?', [afterCash.toString(), userId]);
  await connection.query(`
    INSERT INTO economy_logs
      (user_id, username, type, amount, balance_before, balance_after, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    String(userId),
    username || rows[0].username || `유저_${String(userId).slice(-4)}`,
    logType,
    amount.toString(),
    beforeCash.toString(),
    afterCash.toString(),
    description
  ]);
  return afterCash;
}

const SHOP_CATALOG = [
  // 1. 👑 명예 & 프로필 네온 오라 (30일 기간제)
  {
    key: 'aura_cyberpunk',
    type: 'AURA',
    name: '✨ 사이버펑크 네온 오라',
    price: 100000n,
    durationDays: 30,
    emoji: '🔮',
    description: '웹 대시보드 및 프로필 카드에 사이버펑크 네온 테두리 효과를 적용합니다. (30일)'
  },
  {
    key: 'aura_golden',
    type: 'AURA',
    name: '👑 황금빛 부의 오라',
    price: 250000n,
    durationDays: 30,
    emoji: '🏆',
    description: '웹 순위표 및 프로필에 찬란하게 빛나는 골든 글로우 오라를 부여합니다. (30일)'
  },
  {
    key: 'aura_diamond',
    type: 'AURA',
    name: '💎 다이아몬드 갤럭시 오라',
    price: 500000n,
    durationDays: 30,
    emoji: '💎',
    description: '초호화 다이아몬드 글리터 입자 애니메이션 테두리를 부여합니다. (30일)'
  },

  // 2. 🎖️ 레전더리 영구 칭호
  {
    key: 'title_mansour',
    type: 'TITLE',
    name: '🎖️ [월덕 만수르] 영구 칭호',
    price: 200000n,
    durationDays: null,
    emoji: '💰',
    description: '채팅 및 웹 프로필에 영구적으로 "월덕 만수르" 칭호가 표시됩니다.'
  },
  {
    key: 'title_wolf',
    type: 'TITLE',
    name: '🎖️ [월가의 늑대] 영구 칭호',
    price: 200000n,
    durationDays: null,
    emoji: '🐺',
    description: '주식 거래소 및 랭킹에서 "월가의 늑대" 칭호가 영구 표시됩니다.'
  },
  {
    key: 'title_casino_king',
    type: 'TITLE',
    name: '🎖️ [카지노 지배자] 영구 칭호',
    price: 200000n,
    durationDays: null,
    emoji: '🃏',
    description: '카지노 룸 및 대시보드에서 "카지노 지배자" 칭호가 영구 표시됩니다.'
  },

  // 3. 🃏 전략 버프 & 보험 카드
  {
    key: 'card_casino_insurance',
    type: 'CARD',
    name: '🛡️ 카지노 안심 보험 카드 (30분)',
    price: 15000n,
    durationDays: null,
    emoji: '🛡️',
    description: '사용 즉시 30분간 카지노 게임에서 패배 시 배팅금의 30%를 국고에서 즉시 페이백합니다.'
  },
  {
    key: 'card_stock_rumor',
    type: 'CARD',
    name: '📈 증권가 극비 찌라시 힌트권',
    price: 30000n,
    durationDays: null,
    emoji: '📜',
    description: '다음 주가 갱신 주기에서 상승 호재가 발생할 가능성이 가장 높은 종목 힌트 1개를 즉시 확인합니다.'
  },
  {
    key: 'card_zero_tax',
    type: 'CARD',
    name: '📉 주식 거래 수수료 24시간 면제권',
    price: 50000n,
    durationDays: null,
    emoji: '🎫',
    description: '사용 후 24시간 동안 모든 주식 매수/매도 거래 수수료가 0%로 전액 면제됩니다.'
  },

  // 4. ⚡ 채굴 강화 부스트 소모품
  {
    key: 'buff_overclock_oil',
    type: 'BUFF',
    name: '🛢️ 초고순도 오버클럭 냉각유',
    price: 10000n,
    durationDays: null,
    emoji: '🛢️',
    description: '채굴 드릴에 주입하여 24시간 동안 채굴 효율을 +20% 증가시킵니다.'
  },
  {
    key: 'item_protect_ticket',
    type: 'CONSUMABLE',
    name: '🛡️ 드릴 강화 파괴 방지권',
    price: 50000n,
    durationDays: null,
    emoji: '📜',
    description: '드릴 +10강 이상 강화 실패 시 단계 하락 및 파괴를 1회 막아줍니다.'
  },

  // 5. 🎁 행운의 럭키 박스
  {
    key: 'lucky_box',
    type: 'BOX',
    name: '🎁 황금오리 미스터리 럭키 박스',
    price: 5000n,
    durationDays: null,
    emoji: '🎁',
    description: '오라, 칭호, 강화 방지권, 수수료 면제권, 카지노 보험 카드 중 1종을 랜덤 획득합니다.'
  }
];

function getShopCatalog() {
  return SHOP_CATALOG;
}

function findCatalogItem(key) {
  return SHOP_CATALOG.find(i => i.key === key);
}

/**
 * 🛍️ 상점 아이템 구매 (100% 화폐 소각)
 */
async function buyShopItem(userId, username, itemKey) {
  const item = findCatalogItem(itemKey);
  if (!item) {
    throw new Error('존재하지 않는 상품입니다.');
  }

  return withUserLock(userId, async () => {
    const description = `🛍️ 상점 아이템 구매: ${item.name}`;
    const afterCash = await inTransaction(async (connection) => {
      const nextCash = await debitUser(connection, userId, username, item.price, 'SHOP_BUY', description);

      let expiresAt = null;
      if (item.durationDays) {
        const d = new Date();
        d.setDate(d.getDate() + item.durationDays);
        expiresAt = d;
      }

      if (item.key === 'item_protect_ticket') {
        await connection.query(`
          INSERT INTO user_drill_equipment (user_id, protection_tickets)
          VALUES (?, 1)
          ON DUPLICATE KEY UPDATE protection_tickets = protection_tickets + 1;
        `, [userId]);
      } else {
        await connection.query(`
          INSERT INTO user_inventory (user_id, item_type, item_key, item_name, quantity, expires_at, is_active)
          VALUES (?, ?, ?, ?, 1, ?, 1)
          ON DUPLICATE KEY UPDATE
            quantity = quantity + 1,
            expires_at = VALUES(expires_at),
            is_active = 1;
        `, [userId, item.type, item.key, item.name, expiresAt]);
      }

      await connection.query(`
        INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason)
        VALUES ('OUTFLOW_SINK', 'SHOP_BUY', ?, ?, ?, ?)
      `, [item.price.toString(), userId, nextCash.toString(), description]);
      return nextCash;
    });

    notifyCashChanged(userId, username, 'SHOP_BUY', item.price, afterCash);

    return {
      success: true,
      item,
      afterCash,
      message: `🎉 [${item.name}] 구매가 완료되었습니다! (-${formatMoney(item.price)})`
    };
  });
}

/**
 * 📢 전 서버 & 웹 실시간 확성기 발송 (50,000원 소각)
 */
async function sendMegaphone(userId, username, message, theme = 'gold') {
  const MEGAPHONE_COST = 50000n;
  const cleanMsg = String(message || '').trim().slice(0, 150);
  if (!cleanMsg) {
    throw new Error('확성기 메시지를 입력해주세요.');
  }

  return withUserLock(userId, async () => {
    const activeUntil = new Date(Date.now() + 10 * 60 * 1000); // 10분간 활성
    const description = `📢 실시간 확성기 송출: ${cleanMsg}`;
    const purchase = await inTransaction(async (connection) => {
      const nextCash = await debitUser(connection, userId, username, MEGAPHONE_COST, 'MEGAPHONE', description);
      const [insertResult] = await connection.query(`
        INSERT INTO megaphone_logs (user_id, username, message, theme, cost, active_until)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [userId, username, cleanMsg, theme, MEGAPHONE_COST.toString(), activeUntil]);

      await connection.query(`
        INSERT INTO economy_flow_logs (flow_type, category, amount, user_id, balance_after, reason)
        VALUES ('OUTFLOW_SINK', 'MEGAPHONE', ?, ?, ?, ?)
      `, [MEGAPHONE_COST.toString(), userId, nextCash.toString(), description]);
      return { afterCash: nextCash, insertId: insertResult.insertId };
    });

    const afterCash = purchase.afterCash;
    notifyCashChanged(userId, username, 'MEGAPHONE', MEGAPHONE_COST, afterCash);

    const broadcastPayload = {
      id: purchase.insertId,
      userId,
      username,
      message: cleanMsg,
      theme,
      activeUntil: activeUntil.toISOString()
    };

    // Socket.IO 실시간 브로드캐스트
    if (global.__io) {
      global.__io.emit('megaphone:shout', broadcastPayload);
    }

    return {
      success: true,
      data: broadcastPayload,
      afterCash,
      message: `📢 확성기 방송이 전 서버와 웹에 10분간 송출됩니다! (-${formatMoney(MEGAPHONE_COST)})`
    };
  });
}

/**
 * 🎒 유저 인벤토리 목록 조회
 */
async function getUserInventory(userId) {
  const [rows] = await pool.query(`
    SELECT item_type, item_key, item_name, quantity, expires_at, is_active, created_at
    FROM user_inventory
    WHERE user_id = ? AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY id DESC
  `, [userId]);

  const [drillRows] = await pool.query(`
    SELECT enhancement_level, protection_tickets, overclock_until
    FROM user_drill_equipment
    WHERE user_id = ? LIMIT 1
  `, [userId]);

  const drill = drillRows[0] || { enhancement_level: 0, protection_tickets: 0, overclock_until: null };

  return {
    items: rows,
    drill
  };
}

/**
 * 🎁 럭키 박스 열기 (가챠)
 */
async function openLuckyBox(userId, username) {
  const GACHA_POOL = [
    { key: 'card_casino_insurance', name: '🛡️ 카지노 안심 보험 카드', weight: 30 },
    { key: 'card_stock_rumor', name: '📈 증권가 극비 찌라시 힌트권', weight: 25 },
    { key: 'buff_overclock_oil', name: '🛢️ 초고순도 오버클럭 냉각유', weight: 20 },
    { key: 'card_zero_tax', name: '📉 주식 거래 수수료 면제권', weight: 15 },
    { key: 'item_protect_ticket', name: '🛡️ 드릴 강화 파괴 방지권', weight: 8 },
    { key: 'aura_cyberpunk', name: '✨ 사이버펑크 네온 오라 (30일)', weight: 2 }
  ];

  const totalWeight = GACHA_POOL.reduce((acc, cur) => acc + cur.weight, 0);
  let random = Math.floor(Math.random() * totalWeight);
  let picked = GACHA_POOL[0];

  for (const item of GACHA_POOL) {
    if (random < item.weight) {
      picked = item;
      break;
    }
    random -= item.weight;
  }

  // 인벤토리에 당첨 아이템 지급
  if (picked.key === 'item_protect_ticket') {
    await pool.query(`
      INSERT INTO user_drill_equipment (user_id, protection_tickets)
      VALUES (?, 1)
      ON DUPLICATE KEY UPDATE protection_tickets = protection_tickets + 1;
    `, [userId]);
  } else {
    await pool.query(`
      INSERT INTO user_inventory (user_id, item_type, item_key, item_name, quantity, is_active)
      VALUES (?, 'REWARD', ?, ?, 1, 1)
      ON DUPLICATE KEY UPDATE quantity = quantity + 1, is_active = 1;
    `, [userId, picked.key, picked.name]);
  }

  return {
    success: true,
    reward: picked,
    message: `🎉 럭키 박스 오픈 결과: [${picked.name}] 획득!`
  };
}

module.exports = {
  getShopCatalog,
  findCatalogItem,
  buyShopItem,
  sendMegaphone,
  getUserInventory,
  openLuckyBox
};
