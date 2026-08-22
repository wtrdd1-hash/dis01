'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EconomyCore = require('../src/core/economy/EconomyCore');
const { pool } = require('../src/config/database');

test('EconomyCoreFacade 통합 검증', async (t) => {
  // 1. Vault test
  assert.equal(typeof EconomyCore.vault.safeBigInt, 'function');
  assert.equal(typeof EconomyCore.vault.applyCashDelta, 'function');
  assert.equal(EconomyCore.vault.safeBigInt(100), 100n);

  // 2. Tax test
  assert.equal(typeof EconomyCore.tax.getTreasuryBalance, 'function');
  assert.equal(typeof EconomyCore.tax.calculateTradeTax, 'function');

  // 3. Bank test
  assert.equal(typeof EconomyCore.bank.getCurrentInterestRate, 'function');
  const rate = EconomyCore.bank.getCurrentInterestRate();
  assert.ok(typeof rate === 'number' && rate > 0);

  // 4. Governor test
  assert.equal(typeof EconomyCore.governor.getDynamicSettings, 'function');
  const settings = EconomyCore.governor.getDynamicSettings();
  assert.ok(settings && typeof settings === 'object');

  // 5. Summary test
  assert.ok(typeof EconomyCore.getStatusSummary === 'function');
});
