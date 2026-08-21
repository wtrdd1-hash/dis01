'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../src/db/migrations/009_repair_economy_flow_logs');

test('009 마이그레이션은 기존 원장 데이터 보존 상태로 누락 컬럼과 인덱스를 보정한다', async () => {
  const statements = [];
  const legacyColumns = [
    'id', 'ts', 'category', 'amount', 'source_user_id', 'sink_user_id', 'reason'
  ].map((Field) => ({ Field }));
  const connection = {
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, params });
      if (normalized === 'SHOW COLUMNS FROM economy_flow_logs') return [legacyColumns];
      if (normalized.includes('FROM information_schema.statistics')) return [[]];
      return [{ affectedRows: 0 }];
    }
  };

  await migration.up(connection);
  const sql = statements.map((entry) => entry.sql).join('\n');
  for (const column of ['flow_type', 'user_id', 'target_user_id', 'balance_after', 'metadata', 'created_at']) {
    assert.ok(sql.includes('ADD COLUMN `' + column + '`'), `누락 컬럼 ${column}을 추가해야 함`);
  }
  assert.match(sql, /MODIFY COLUMN category VARCHAR\(64\) NOT NULL/);
  assert.match(sql, /source_user_id/);
  assert.match(sql, /sink_user_id/);
  assert.match(sql, /created_at = COALESCE\(created_at, ts, NOW\(\)\)/);
  assert.match(sql, /ADD INDEX `idx_flow_type_date`/);
  assert.ok(!sql.includes('DROP COLUMN'), '레거시 데이터 컬럼을 삭제하면 안 됨');
});

test('009 마이그레이션은 이미 최신인 스키마에서도 재실행 가능한 쿼리만 수행한다', async () => {
  const statements = [];
  const currentColumns = [
    'id', 'flow_type', 'category', 'amount', 'user_id', 'target_user_id',
    'balance_after', 'reason', 'metadata', 'created_at'
  ].map((Field) => ({ Field }));
  const connection = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      statements.push(normalized);
      if (normalized === 'SHOW COLUMNS FROM economy_flow_logs') return [currentColumns];
      if (normalized.includes('FROM information_schema.statistics')) return [[{ 1: 1 }]];
      return [{ affectedRows: 0 }];
    }
  };

  await migration.up(connection);
  assert.equal(statements.filter((sql) => sql.includes('ADD COLUMN')).length, 0);
  assert.equal(statements.filter((sql) => sql.includes('ADD INDEX')).length, 0);
});
