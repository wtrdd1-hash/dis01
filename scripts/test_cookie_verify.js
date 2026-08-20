'use strict';
const crypto = require('crypto');
const session = require('../src/web/session');

function makeSignedCookieHeader(name, payloadObj, secret) {
  const jsonStr = JSON.stringify(payloadObj);
  const hmac = crypto.createHmac('sha256', secret)
    .update(jsonStr)
    .digest('base64')
    .replace(/=+$/g, '');
  const signedRaw = `s:${jsonStr}.${hmac}`;
  return `${name}=${encodeURIComponent(signedRaw)}`;
}

// 검증
const mockReq = {
  headers: {
    host: 'easy-scraping.com',
    cookie: makeSignedCookieHeader('discord_user', {
      id: '886478189520637992',
      username: 'test_admin',
      avatar: ''
    }, session.getCookieSecret())
  },
  signedCookies: {}
};

console.log('Generated header:', mockReq.headers.cookie);
const user = session.getSessionUser(mockReq);
console.log('Parsed User:', user);
