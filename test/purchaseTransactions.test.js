'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/config/database');
const { buyShopItem } = require('../src/utils/shopEngine');
const { buyLottoTicket } = require('../src/utils/lottoEngine');

function fakeConnection(handler) {
  const state = { begun: 0, committed: 0, rolledBack: 0, released: 0, queries: [] };
  return {
    state,
    async beginTransaction() { state.begun += 1; },
    async commit() { state.committed += 1; },
    async rollback() { state.rolledBack += 1; },
    release() { state.released += 1; },
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      state.queries.push({ sql: normalized, params });
      return handler(normalized, params);
    }
  };
}

test('상점 원장 기록 실패 시 현금과 아이템을 함께 롤백한다', async (t) => {
  const originalGetConnection = pool.getConnection;
  const connection = fakeConnection((sql) => {
    if (sql.startsWith('SELECT cash')) return [[{ cash: '200000', username: 'qa' }]];
    if (sql.includes('INSERT INTO economy_flow_logs')) throw new Error('simulated flow failure');
    return [{ affectedRows: 1, insertId: 1 }];
  });
  pool.getConnection = async () => connection;
  t.after(() => { pool.getConnection = originalGetConnection; });

  await assert.rejects(
    () => buyShopItem('w_0123456789abcdef', 'qa', 'aura_cyberpunk'),
    /simulated flow failure/
  );
  assert.equal(connection.state.begun, 1);
  assert.equal(connection.state.committed, 0);
  assert.equal(connection.state.rolledBack, 1);
  assert.equal(connection.state.released, 1);
});

test('로또 구매는 현금·회차·티켓·두 원장을 한 트랜잭션으로 커밋한다', async (t) => {
  const originalGetConnection = pool.getConnection;
  const connection = fakeConnection((sql) => {
    if (sql.startsWith('SELECT * FROM lotto_rounds')) {
      return [[{ round_number: 3, jackpot_pool: '10000000', status: 'OPEN' }]];
    }
    if (sql.startsWith('SELECT cash')) return [[{ cash: '5000', username: 'qa' }]];
    return [{ affectedRows: 1, insertId: 9 }];
  });
  pool.getConnection = async () => connection;
  t.after(() => { pool.getConnection = originalGetConnection; });

  const result = await buyLottoTicket('w_0123456789abcdef', 'qa', [1, 2, 3, 4, 5, 6], false);
  assert.equal(result.afterCash, 4000n);
  assert.equal(connection.state.committed, 1);
  assert.equal(connection.state.rolledBack, 0);
  const sql = connection.state.queries.map((entry) => entry.sql).join('\n');
  assert.match(sql, /UPDATE users SET cash/);
  assert.match(sql, /INSERT INTO lotto_tickets/);
  assert.match(sql, /INSERT INTO economy_flow_logs/);
  assert.match(sql, /INSERT INTO economy_logs/);
});
