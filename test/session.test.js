'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const session = require('../src/web/session');

function createResponse() {
  return {
    cookies: [],
    cleared: [],
    cookie(name, value, options) { this.cookies.push({ name, value, options }); },
    clearCookie(name, options) { this.cleared.push({ name, options }); }
  };
}

test('테스트 세션 쿠키는 운영과 다른 이름의 호스트 전용 쿠키다', () => {
  const req = { headers: { host: 'test.easy-scraping.com' } };
  const res = createResponse();

  session.setLocalCookie(res, {
    id: 'w_0123456789abcdef',
    username: 'tester',
    local: true
  }, req);

  assert.equal(session.LOCAL_COOKIE, 'web_user_test');
  assert.equal(res.cookies.length, 1);
  assert.equal(res.cookies[0].name, session.LOCAL_COOKIE);
  assert.equal(res.cookies[0].options.secure, true);
  assert.equal(res.cookies[0].options.httpOnly, true);
  assert.equal(res.cookies[0].options.sameSite, 'lax');
  assert.equal(Object.hasOwn(res.cookies[0].options, 'domain'), false);
  assert.equal(res.cleared.length, 0);
});
