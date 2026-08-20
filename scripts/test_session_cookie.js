'use strict';
const session = require('../src/web/session');
const config = require('../src/config/config');

const user = {
  id: '886478189520637992',
  username: 'test_admin',
  avatar: ''
};

// 모의 res 객체
let cookieSent = null;
const mockRes = {
  cookie(name, val, opts) {
    console.log(`Setting cookie [${name}]:`, val, opts);
    cookieSent = { name, val, opts };
  }
};

const mockReq = {
  headers: {
    host: 'easy-scraping.com'
  }
};

session.setSessionCookie(mockRes, user, mockReq);
console.log('Cookie generated:', cookieSent);
