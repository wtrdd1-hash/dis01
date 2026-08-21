'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveShopUser,
  serializeShopItem,
  serializeLottoTicket
} = require('../src/web/routes/shopRoutes');

test('상점 API는 Discord 및 웹 로그인을 통합 판정한다', () => {
  const expected = { id: 'w_0123456789abcdef', username: 'tester', local: true };
  const session = {
    getPlayUser(req) {
      assert.equal(req.marker, 'request');
      return expected;
    }
  };

  assert.equal(resolveShopUser(session, { marker: 'request' }), expected);
});

test('상점 API는 이전 세션 어댑터도 호환한다', () => {
  const expected = { id: '123456789012345678', username: 'discord-user' };
  assert.equal(resolveShopUser({ getSessionUser: () => expected }, {}), expected);
  assert.equal(resolveShopUser(null, { session: { localUser: expected } }), expected);
});

test('상점 API 상품 응답은 BigInt 가격을 JSON 안전 문자열로 변환한다', () => {
  const item = serializeShopItem({ key: 'test', name: '테스트', price: 100000n });
  assert.equal(item.price, '100000');
  assert.doesNotThrow(() => JSON.stringify(item));
});

test('로또 API 응답은 BigInt 잔액을 JSON 안전 문자열로 변환한다', () => {
  const ticket = serializeLottoTicket({ roundNumber: 1, afterCash: 899000n });
  assert.equal(ticket.afterCash, '899000');
  assert.doesNotThrow(() => JSON.stringify(ticket));
});
