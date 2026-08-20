'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeBigInt } = require('../src/utils/moneyValue');
const { amountToUnits, mulPriceAmount } = require('../src/utils/moneyScale');

test('65자리 범위의 정수 문자열을 정밀도 손실 없이 변환한다', () => {
  const source = '100000000000000000001';
  assert.equal(safeBigInt(source), 100000000000000000001n);
  assert.equal(safeBigInt(`${source}.9999`), 100000000000000000001n);
});

test('소수점 주식 수량의 평가액을 정수 연산으로 계산한다', () => {
  const price = 99999999999999999999n;
  assert.equal(amountToUnits('1.2345'), 12345n);
  assert.equal(mulPriceAmount(price, '1.2345'), (price * 12345n) / 10000n);
});
