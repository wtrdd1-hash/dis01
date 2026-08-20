'use strict';

const assert = require('assert');
const EconomyCore = require('../src/core/economy/EconomyCore');

async function testEconomyCore() {
  console.log('🧪 Testing EconomyCoreFacade Integration...');

  // 1. Vault test
  assert(typeof EconomyCore.vault.safeBigInt === 'function');
  assert(typeof EconomyCore.vault.applyCashDelta === 'function');
  assert.strictEqual(EconomyCore.vault.safeBigInt(100), 100n);

  // 2. Tax test
  assert(typeof EconomyCore.tax.getTreasuryBalance === 'function');
  assert(typeof EconomyCore.tax.calculateTradeTax === 'function');

  // 3. Bank test
  assert(typeof EconomyCore.bank.getCurrentInterestRate === 'function');
  const rate = EconomyCore.bank.getCurrentInterestRate();
  assert(typeof rate === 'number' && rate > 0);

  // 4. Governor test
  assert(typeof EconomyCore.governor.getDynamicSettings === 'function');
  const settings = EconomyCore.governor.getDynamicSettings();
  assert(settings && typeof settings === 'object');

  // 5. Summary test
  const status = await EconomyCore.getStatusSummary();
  console.log('Core Status Summary:', status);
  assert.strictEqual(status.status, 'HEALTHY');

  console.log('✅ All EconomyCore Integration Tests PASSED!');
}

testEconomyCore().catch(err => {
  console.error('❌ EconomyCore Test Failed:', err);
  process.exit(1);
});
