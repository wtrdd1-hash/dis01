const { pool } = require('../config/database');
const { formatMoney } = require('./formatters');
const { logInfo, logError } = require('./logger');
const { safeBigInt, applyCashDelta, withUserLock, getUserCash } = require('./money');
const {
  BUSINESS,
  findBusiness,
  businessIncomePerMin,
  businessUpgradeCost,
  businessPending,
  businessStaffHireCost,
  businessHqCost
} = require('./economyBalance');

async function logEconomy(userId, username, type, amount, before, after, description) {
  try {
    await pool.query(
      `INSERT INTO economy_logs (user_id, username, type, amount, balance_before, balance_after, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        username || `유저_${String(userId).slice(-4)}`,
        type,
        String(amount),
        String(before),
        String(after),
        String(description).slice(0, 255)
      ]
    );
  } catch (e) {}
}

async function getMeta(userId) {
  const [rows] = await pool.query(
    'SELECT auto_collect, hq_level FROM user_business_meta WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (!rows.length) return { autoCollect: false, hqLevel: 0 };
  return {
    autoCollect: Number(rows[0].auto_collect) === 1,
    hqLevel: Number(rows[0].hq_level || 0)
  };
}

async function saveMeta(userId, autoCollect, hqLevel) {
  await pool.query(
    `INSERT INTO user_business_meta (user_id, auto_collect, hq_level)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE auto_collect = VALUES(auto_collect), hq_level = VALUES(hq_level)`,
    [userId, autoCollect ? 1 : 0, hqLevel]
  );
}

const userCollectCooldown = new Map();
const COLLECT_COOLDOWN_MS = 3000;
const COOLDOWN_TTL_MS = 60 * 60 * 1000; // 1시간 지난 항목은 정리
const COOLDOWN_MAX_SIZE = 20000;

// 메모리 누수 방지: 시간 지난 쿨다운 정리
function gcUserCollectCooldown(nowMs) {
  if (userCollectCooldown.size <= COOLDOWN_MAX_SIZE) return;
  const cutoff = nowMs - COOLDOWN_TTL_MS;
  let dropped = 0;
  for (const [k, ts] of userCollectCooldown) {
    if (ts < cutoff) {
      userCollectCooldown.delete(k);
      dropped++;
      if (dropped > 5000) break;
    }
  }
}

function serializeOwned(def, row, nowMs, hqLevel) {
  const level = Number(row.level || 1);
  const staff = Number(row.staff || 0);
  const elapsedSec = row.elapsed_sec != null ? Math.max(0, Number(row.elapsed_sec)) : 0;
  const pending = businessPending(def, level, row.last_collect_at, nowMs, staff, hqLevel, elapsedSec);
  const canUpgrade = level < BUSINESS.MAX_LEVEL;
  const canHire = staff < BUSINESS.MAX_STAFF;
  return {
    key: def.key,
    name: def.name,
    emoji: def.emoji,
    blurb: def.blurb,
    owned: true,
    locked: false,
    requires: def.requires,
    requiresName: null,
    level,
    staff,
    maxStaff: BUSINESS.MAX_STAFF,
    maxLevel: BUSINESS.MAX_LEVEL,
    invested: String(row.invested || 0),
    incomePerMin: businessIncomePerMin(def, level, staff, hqLevel),
    pending,
    elapsedSec,
    lastCollectAt: row.last_collect_at,
    upgradeCost: canUpgrade ? businessUpgradeCost(def, level) : null,
    hireCost: canHire ? businessStaffHireCost(def, staff) : null,
    sellValue: Math.floor(Number(row.invested || 0) * BUSINESS.SELL_RATE),
    capMin: BUSINESS.COLLECT_CAP_MIN
  };
}

function serializeVacant(def, ownedKeys) {
  const req = def.requires ? findBusiness(def.requires) : null;
  const locked = Boolean(def.requires && !ownedKeys.has(def.requires));
  return {
    key: def.key,
    name: def.name,
    emoji: def.emoji,
    blurb: def.blurb,
    owned: false,
    locked,
    requires: def.requires,
    requiresName: req ? `${req.emoji} ${req.name}` : null,
    level: 0,
    staff: 0,
    maxStaff: BUSINESS.MAX_STAFF,
    maxLevel: BUSINESS.MAX_LEVEL,
    invested: '0',
    incomePerMin: def.incomePerMin,
    pending: 0,
    elapsedSec: 0,
    lastCollectAt: null,
    cost: def.cost,
    upgradeCost: null,
    hireCost: null,
    sellValue: 0,
    capMin: BUSINESS.COLLECT_CAP_MIN
  };
}

async function listUserBusinesses(userId) {
  const meta = await getMeta(userId);
  const [rows] = await pool.query(
    'SELECT business_key, level, staff, invested, last_collect_at, TIMESTAMPDIFF(SECOND, last_collect_at, NOW()) AS elapsed_sec FROM user_businesses WHERE user_id = ?',
    [userId]
  );
  const byKey = new Map(rows.map((row) => [row.business_key, row]));
  const ownedKeys = new Set(byKey.keys());
  const nowMs = Date.now();
  const items = BUSINESS.CATALOG.map((def) => {
    const row = byKey.get(def.key);
    return row ? serializeOwned(def, row, nowMs, meta.hqLevel) : serializeVacant(def, ownedKeys);
  });
  const pendingTotal = items.reduce((sum, item) => sum + (item.pending || 0), 0);
  const incomeTotal = items.filter((item) => item.owned).reduce((sum, item) => sum + item.incomePerMin, 0);
  const investedTotal = items.reduce((sum, item) => sum + Number(item.invested || 0), 0);
  const hqLevel = meta.hqLevel;
  return {
    items,
    pendingTotal,
    incomeTotal,
    investedTotal,
    serverNowMs: nowMs,
    sellRate: BUSINESS.SELL_RATE,
    capMin: BUSINESS.COLLECT_CAP_MIN,
    maxLevel: BUSINESS.MAX_LEVEL,
    maxStaff: BUSINESS.MAX_STAFF,
    hqLevel,
    maxHq: BUSINESS.MAX_HQ,
    hqBonusPct: Math.round(BUSINESS.HQ_BONUS * 100),
    hqCost: hqLevel < BUSINESS.MAX_HQ ? businessHqCost(hqLevel) : null,
    autoCollect: meta.autoCollect,
    autoUnlocked: hqLevel >= 1
  };
}

async function buyBusiness(userId, username, key) {
  const def = findBusiness(key);
  if (!def) {
    const err = new Error('없는 사업입니다.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return withUserLock(userId, async () => {
    const [existing] = await pool.query(
      'SELECT id FROM user_businesses WHERE user_id = ? AND business_key = ? LIMIT 1',
      [userId, def.key]
    );
    if (existing.length) {
      const err = new Error('이미 개업한 사업입니다.');
      err.code = 'ALREADY_OWNED';
      throw err;
    }
    if (def.requires) {
      const [reqRow] = await pool.query(
        'SELECT id FROM user_businesses WHERE user_id = ? AND business_key = ? LIMIT 1',
        [userId, def.requires]
      );
      if (!reqRow.length) {
        const req = findBusiness(def.requires);
        const err = new Error(`${req ? req.name : def.requires}을(를) 먼저 개업해야 합니다.`);
        err.code = 'LOCKED';
        throw err;
      }
    }
    const cost = safeBigInt(def.cost);
    const before = await getUserCash(userId);
    const after = await applyCashDelta(userId, -cost, {
      logType: 'BUSINESS_BUY',
      description: `${def.emoji} ${def.name} 사업체 신규 개업 (${formatMoney(cost)})`
    });
    await pool.query(
      `INSERT INTO user_businesses (user_id, business_key, level, staff, invested, last_collect_at)
       VALUES (?, ?, 1, 0, ?, NOW())`,
      [userId, def.key, cost.toString()]
    );
    await logEconomy(userId, username, 'BUSINESS_BUY', cost, before, after, `${def.emoji} ${def.name} 개업 (${formatMoney(cost)})`);
    return { cash: after, state: await listUserBusinesses(userId), message: `${def.emoji} ${def.name}을(를) 개업했습니다.` };
  });
}

async function upgradeBusiness(userId, username, key) {
  const def = findBusiness(key);
  if (!def) {
    const err = new Error('없는 사업입니다.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return withUserLock(userId, async () => {
    const [rows] = await pool.query(
      'SELECT id, level, invested FROM user_businesses WHERE user_id = ? AND business_key = ? LIMIT 1',
      [userId, def.key]
    );
    if (!rows.length) {
      const err = new Error('아직 보유하지 않은 사업입니다.');
      err.code = 'NOT_OWNED';
      throw err;
    }
    const level = Number(rows[0].level || 1);
    if (level >= BUSINESS.MAX_LEVEL) {
      const err = new Error(`이미 최대 레벨(Lv.${BUSINESS.MAX_LEVEL})입니다.`);
      err.code = 'MAX';
      throw err;
    }
    const cost = safeBigInt(businessUpgradeCost(def, level));
    const before = await getUserCash(userId);
    const after = await applyCashDelta(userId, -cost, {
      logType: 'BUSINESS_UPGRADE',
      description: `${def.emoji} ${def.name} Lv.${level}→${level + 1} 업그레이드 (${formatMoney(cost)})`
    });
    await pool.query(
      'UPDATE user_businesses SET level = level + 1, invested = invested + ? WHERE id = ?',
      [cost.toString(), rows[0].id]
    );
    await logEconomy(userId, username, 'BUSINESS_UPGRADE', cost, before, after, `${def.emoji} ${def.name} Lv.${level}→${level + 1} (${formatMoney(cost)})`);
    return { cash: after, state: await listUserBusinesses(userId), message: `${def.emoji} ${def.name}을(를) Lv.${level + 1}로 올렸습니다.` };
  });
}

async function hireStaff(userId, username, key) {
  const def = findBusiness(key);
  if (!def) {
    const err = new Error('없는 사업입니다.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return withUserLock(userId, async () => {
    const [rows] = await pool.query(
      'SELECT id, staff, invested FROM user_businesses WHERE user_id = ? AND business_key = ? LIMIT 1',
      [userId, def.key]
    );
    if (!rows.length) {
      const err = new Error('아직 보유하지 않은 사업입니다.');
      err.code = 'NOT_OWNED';
      throw err;
    }
    const staff = Number(rows[0].staff || 0);
    if (staff >= BUSINESS.MAX_STAFF) {
      const err = new Error(`알바는 최대 ${BUSINESS.MAX_STAFF}명까지만 고용할 수 있습니다.`);
      err.code = 'MAX';
      throw err;
    }
    const cost = safeBigInt(businessStaffHireCost(def, staff));
    const before = await getUserCash(userId);
    const after = await applyCashDelta(userId, -cost, {
      logType: 'BUSINESS_HIRE',
      description: `${def.emoji} ${def.name} 알바 고용 ${staff + 1}명 (${formatMoney(cost)})`
    });
    await pool.query(
      'UPDATE user_businesses SET staff = staff + 1, invested = invested + ? WHERE id = ?',
      [cost.toString(), rows[0].id]
    );
    await logEconomy(userId, username, 'BUSINESS_HIRE', cost, before, after, `${def.emoji} ${def.name} 알바 고용 ${staff + 1}명 (${formatMoney(cost)})`);
    return { cash: after, state: await listUserBusinesses(userId), message: `${def.emoji} ${def.name}에 알바를 고용했습니다. (${staff + 1}/${BUSINESS.MAX_STAFF})` };
  });
}

async function upgradeHq(userId, username) {
  return withUserLock(userId, async () => {
    const meta = await getMeta(userId);
    if (meta.hqLevel >= BUSINESS.MAX_HQ) {
      const err = new Error('본사가 이미 최대 레벨입니다.');
      err.code = 'MAX';
      throw err;
    }
    const [owned] = await pool.query(
      'SELECT id FROM user_businesses WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (!owned.length) {
      const err = new Error('점포를 하나 이상 개업한 뒤에 본사를 올릴 수 있습니다.');
      err.code = 'LOCKED';
      throw err;
    }
    const cost = safeBigInt(businessHqCost(meta.hqLevel));
    const before = await getUserCash(userId);
    const after = await applyCashDelta(userId, -cost, {
      logType: 'BUSINESS_HQ',
      description: `사업 본사 건물 Lv.${meta.hqLevel + 1} 증축 (${formatMoney(cost)})`
    });
    const next = meta.hqLevel + 1;
    await saveMeta(userId, next >= 1 ? meta.autoCollect : false, next);
    await logEconomy(userId, username, 'BUSINESS_HQ', cost, before, after, `본사 Lv.${next} (${formatMoney(cost)})`);
    const extra = next === 1 ? ' 자동 수금을 켤 수 있습니다.' : '';
    return { cash: after, state: await listUserBusinesses(userId), message: `본사를 Lv.${next}로 올렸습니다.${extra}` };
  });
}

async function setAutoCollect(userId, username, on) {
  return withUserLock(userId, async () => {
    const meta = await getMeta(userId);
    if (meta.hqLevel < 1) {
      const err = new Error('본사 1레벨이 필요합니다. 본사를 먼저 올리세요.');
      err.code = 'LOCKED';
      throw err;
    }
    const next = Boolean(on);
    await saveMeta(userId, next, meta.hqLevel);
    return {
      cash: await getUserCash(userId),
      state: await listUserBusinesses(userId),
      message: next ? '자동 수금을 켰습니다. 1분마다 현금으로 들어옵니다.' : '자동 수금을 껐습니다.'
    };
  });
}

async function collectBusiness(userId, username, key, opts) {
  const options = opts || {};
  const nowMs = Date.now();

  // 수동 수금 시 최소 3초 쿨타임 (연속 수금 매크로 차단)
  if (!options.auto) {
    const lastReq = userCollectCooldown.get(userId) || 0;
    if (nowMs - lastReq < COLLECT_COOLDOWN_MS) {
      const err = new Error('수금 요청이 너무 빠릅니다. 잠시 후 다시 시도해주세요.');
      err.code = 'RATE_LIMIT';
      throw err;
    }
    gcUserCollectCooldown(nowMs);
    userCollectCooldown.set(userId, nowMs);
  }

  return withUserLock(userId, async () => {
    const meta = await getMeta(userId);
    let sql = 'SELECT id, business_key, level, staff, last_collect_at, TIMESTAMPDIFF(SECOND, last_collect_at, NOW()) AS elapsed_sec FROM user_businesses WHERE user_id = ?';
    const params = [userId];
    if (key) {
      sql += ' AND business_key = ?';
      params.push(key);
    }
    const [rows] = await pool.query(sql, params);
    if (!rows.length) {
      const err = new Error(key ? '아직 보유하지 않은 사업입니다.' : '보유한 사업이 없습니다.');
      err.code = 'NOT_OWNED';
      throw err;
    }

    let total = 0;
    const names = [];
    const collectedIds = [];

    for (const row of rows) {
      const def = findBusiness(row.business_key);
      if (!def) continue;
      const elapsedSec = row.elapsed_sec != null ? Number(row.elapsed_sec) : undefined;
      const pending = businessPending(def, row.level, row.last_collect_at, nowMs, row.staff, meta.hqLevel, elapsedSec);
      if (pending <= 0) continue;
      total += pending;
      names.push(`${def.emoji}${def.name}`);
      collectedIds.push(row.id);
    }

    if (total <= 0) {
      if (options.allowEmpty) {
        return { cash: await getUserCash(userId), collected: 0n, state: await listUserBusinesses(userId), message: '수금할 수익이 없습니다. (최소 1분 경과 필요)', skipped: true };
      }
      const err = new Error('아직 수금할 수익이 없습니다. (최소 1분 경과 필요)');
      err.code = 'EMPTY';
      throw err;
    }

    // 수금된 점포들 last_collect_at 갱신
    if (collectedIds.length > 0) {
      await pool.query(
        `UPDATE user_businesses SET last_collect_at = NOW() WHERE id IN (${collectedIds.map(() => '?').join(',')})`,
        collectedIds
      );
    }

    // 거시경제 자동 조절 배율 적용 (불황 시 감소, 호황 시 증가)
    let revMult = 1.0;
    try {
      const { getDynamicSettings } = require('./economyBalancer');
      const dyn = getDynamicSettings();
      if (dyn && Number.isFinite(Number(dyn.businessRevenueMultiplier))) {
        revMult = Number(dyn.businessRevenueMultiplier);
      }
    } catch (e) {}

    total = Math.floor(total * revMult);

    let event = null;
    if (!options.auto && Math.random() < BUSINESS.COLLECT_EVENT_CHANCE) {
      if (Math.random() < 0.55) {
        total = Math.floor(total * 1.2);
        event = { type: 'boom', label: '대박 매출 +20%' };
      } else {
        total = Math.floor(total * 0.9);
        event = { type: 'slump', label: '비수기 -10%' };
      }
    }

    const rawPayout = safeBigInt(total);
    const before = await getUserCash(userId);

    // 🏛️ 부자 누진 소득세 계산 (순자산 1억 이상 구간별 6%~25% 국고 환수)
    let taxInfo = { tax: 0n, rate: 0, netIncome: rawPayout };
    try {
      const { computeBusinessIncomeTax, addTreasury } = require('./taxEngine');
      const { computeNetWorth } = require('./economyBalance');
      // 유저 순자산 조회
      const [uRows] = await pool.query(
        `SELECT u.cash, u.bank, COALESCE(SUM(us.amount * s.price), 0) AS stock_val
         FROM users u
         LEFT JOIN user_stocks us ON u.discord_id = us.user_id AND us.amount > 0
         LEFT JOIN stocks s ON us.stock_id = s.stock_id
         WHERE u.discord_id = ?
         GROUP BY u.discord_id, u.cash, u.bank`,
        [userId]
      );
      if (uRows.length > 0) {
        const netWorth = computeNetWorth(uRows[0].cash, uRows[0].bank, uRows[0].stock_val);
        taxInfo = computeBusinessIncomeTax(netWorth, rawPayout);
        if (taxInfo.tax > 0n) {
          // 국고로 세금 귀속
          await addTreasury(taxInfo.tax, 'TAX_BUSINESS_INCOME', userId, `사업 고소득 누진세 원천징수 (${(taxInfo.rate * 100).toFixed(0)}%)`);
        }
      }
    } catch (e) {}

    const payout = taxInfo.netIncome;
    const tag = options.auto ? '자동수금' : '수금';
    const ev = event ? ` · ${event.label}` : '';
    const taxNote = taxInfo.tax > 0n ? ` (국고 누진세 -${formatMoney(taxInfo.tax)} 원천징수)` : '';
    const after = await applyCashDelta(userId, payout, {
      logType: 'BUSINESS_COLLECT',
      description: `사업 ${tag} ${names.join(', ')} 수익금 (+${formatMoney(payout)}${ev}${taxNote})`
    });

    await logEconomy(userId, username, 'BUSINESS_COLLECT', payout, before, after, `사업 ${tag} ${names.join(', ')} (+${formatMoney(payout)}${ev}${taxNote})`);

    let msg = event
      ? `${event.label}! 사업 수익 ${formatMoney(payout)}을 수금했습니다.${taxNote}`
      : `사업 수익 ${formatMoney(payout)}을 수금했습니다.${taxNote}`;

    return { cash: after, collected: payout, taxDeducted: taxInfo.tax, event, state: await listUserBusinesses(userId), message: msg };
  });
}

async function sellBusiness(userId, username, key) {
  const def = findBusiness(key);
  if (!def) {
    const err = new Error('없는 사업입니다.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  return withUserLock(userId, async () => {
    const meta = await getMeta(userId);
    const [rows] = await pool.query(
      'SELECT id, level, staff, invested, last_collect_at, TIMESTAMPDIFF(SECOND, last_collect_at, NOW()) AS elapsed_sec FROM user_businesses WHERE user_id = ? AND business_key = ? LIMIT 1',
      [userId, def.key]
    );
    if (!rows.length) {
      const err = new Error('아직 보유하지 않은 사업입니다.');
      err.code = 'NOT_OWNED';
      throw err;
    }
    const blockers = BUSINESS.CATALOG.filter((item) => item.requires === def.key);
    if (blockers.length) {
      const [kids] = await pool.query(
        `SELECT business_key FROM user_businesses WHERE user_id = ? AND business_key IN (${blockers.map(() => '?').join(',')})`,
        [userId, ...blockers.map((item) => item.key)]
      );
      if (kids.length) {
        const names = kids.map((row) => {
          const child = findBusiness(row.business_key);
          return child ? child.name : row.business_key;
        });
        const err = new Error(`먼저 ${names.join(', ')}을(를) 매각해야 합니다.`);
        err.code = 'LOCKED';
        throw err;
      }
    }
    const elapsedSec = rows[0].elapsed_sec != null ? Number(rows[0].elapsed_sec) : undefined;
    const pending = businessPending(def, rows[0].level, rows[0].last_collect_at, Date.now(), rows[0].staff, meta.hqLevel, elapsedSec);
    const refund = Math.floor(Number(rows[0].invested || 0) * BUSINESS.SELL_RATE);
    const total = safeBigInt(pending + refund);
    await pool.query('DELETE FROM user_businesses WHERE id = ?', [rows[0].id]);
    const before = await getUserCash(userId);
    const after = total > 0n ? await applyCashDelta(userId, total, {
      logType: 'BUSINESS_SELL',
      description: `${def.emoji} ${def.name} 매각 환급금 (+${formatMoney(total)})`
    }) : before;
    await logEconomy(userId, username, 'BUSINESS_SELL', total, before, after, `${def.emoji} ${def.name} 매각 (환급 ${formatMoney(refund)} + 수익 ${formatMoney(pending)})`);
    return {
      cash: after,
      state: await listUserBusinesses(userId),
      message: `${def.emoji} ${def.name}을(를) 매각했습니다. ${formatMoney(total)} 입금.`
    };
  });
}

async function processBusinessAutoCollect() {
  try {
    const [users] = await pool.query(
      `SELECT m.user_id, u.username
       FROM user_business_meta m
       JOIN users u ON u.discord_id = m.user_id
       WHERE m.auto_collect = 1 AND m.hq_level >= 1`
    );
    let paid = 0;
    let total = 0n;
    for (const row of users) {
      try {
        const result = await collectBusiness(row.user_id, row.username, null, { auto: true, allowEmpty: true });
        if (result && result.collected && result.collected > 0n) {
          paid += 1;
          total += result.collected;
        }
      } catch (err) {
        if (err && err.code !== 'EMPTY' && err.code !== 'NOT_OWNED') {
          logError('BusinessEngine', `자동수금 실패 ${row.user_id}`, err);
        }
      }
    }
    if (paid > 0) {
      logInfo('BusinessEngine', `자동 수금 ${paid}명 · 총 ${formatMoney(total)}`);
    }
  } catch (err) {
    logError('BusinessEngine', '자동 수금 틱 오류', err);
  }
}

function startBusinessEngine(intervalMs) {
  const ms = Number(intervalMs) || 60 * 1000;
  logInfo('BusinessEngine', `사업 자동수금 엔진 가동 (주기: ${Math.round(ms / 1000)}초)`);
  setTimeout(processBusinessAutoCollect, 8000);
  setInterval(processBusinessAutoCollect, ms);
}

module.exports = {
  listUserBusinesses,
  buyBusiness,
  upgradeBusiness,
  hireStaff,
  upgradeHq,
  setAutoCollect,
  collectBusiness,
  sellBusiness,
  processBusinessAutoCollect,
  startBusinessEngine
};
