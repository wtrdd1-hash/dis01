/**
 * 웹 아이디·비밀번호 계정. 게임용이며 송금은 Discord 계정만.
 */
const crypto = require('crypto');
const express = require('express');
const { pool, getOrCreateUser } = require('../config/database');
const { createKeyedRateLimiter } = require('./httpSafe');
const session = require('./session');

const USERNAME_RE = /^[a-zA-Z0-9가-힣_]{3,16}$/;
const allowRegister = createKeyedRateLimiter({ windowMs: 60 * 60 * 1000, max: 8 });
const allowLogin = createKeyedRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), String(salt), 32, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived.toString('hex'));
    });
  });
}

function hashesEqual(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

function normalizeUsername(raw) {
  return String(raw || '').trim();
}

function validatePassword(raw) {
  const password = String(raw || '');
  if (password.length < 8 || password.length > 72) {
    const err = new Error('비밀번호는 8자 이상 72자 이하여야 합니다.');
    err.status = 400;
    throw err;
  }
  return password;
}

async function ensureWebAccountsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_accounts (
      user_id VARCHAR(32) PRIMARY KEY,
      username VARCHAR(32) NOT NULL UNIQUE,
      password_salt VARCHAR(64) NOT NULL,
      password_hash VARCHAR(128) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function registerLocalUser(usernameRaw, passwordRaw) {
  await ensureWebAccountsTable();
  const username = normalizeUsername(usernameRaw);
  if (!USERNAME_RE.test(username)) {
    const err = new Error('아이디는 3~16자, 한글·영문·숫자·밑줄만 됩니다.');
    err.status = 400;
    throw err;
  }
  const password = validatePassword(passwordRaw);
  const [dup] = await pool.query(
    'SELECT user_id FROM web_accounts WHERE username = ? OR LOWER(username) = LOWER(?) LIMIT 1',
    [username, username]
  );
  if (dup.length) {
    const err = new Error('이미 쓰이는 아이디입니다.');
    err.status = 409;
    throw err;
  }
  const userId = 'w_' + crypto.randomBytes(8).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = await scryptHash(password, salt);
  try {
    await pool.query(
      'INSERT INTO web_accounts (user_id, username, password_salt, password_hash) VALUES (?, ?, ?, ?)',
      [userId, username, salt, passwordHash]
    );
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      const err = new Error('이미 쓰이는 아이디입니다.');
      err.status = 409;
      throw err;
    }
    throw e;
  }
  await getOrCreateUser(userId, username, null);
  return { id: userId, username, avatar: '', local: true };
}

async function loginLocalUser(usernameRaw, passwordRaw) {
  await ensureWebAccountsTable();
  const username = normalizeUsername(usernameRaw);
  const password = String(passwordRaw || '');
  const [rows] = await pool.query(
    'SELECT user_id, username, password_salt, password_hash FROM web_accounts WHERE username = ? OR LOWER(username) = LOWER(?) LIMIT 1',
    [username, username]
  );
  const row = rows[0];
  const dummySalt = '0'.repeat(32);
  const dummyHash = await scryptHash('invalid-password-check', dummySalt);
  const salt = row ? row.password_salt : dummySalt;
  const expected = row ? row.password_hash : dummyHash;
  const got = await scryptHash(password, salt);
  if (!row || !hashesEqual(got, expected)) {
    const err = new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
    err.status = 401;
    throw err;
  }
  const { checkUserBanStatus } = require('../utils/userBanEngine');
  const banInfo = await checkUserBanStatus(row.user_id, { failClosed: true });
  if (banInfo.isBanned) {
    const err = new Error(`계정 이용이 제한되었습니다. ${banInfo.reason || ''}`.trim());
    err.status = 403;
    throw err;
  }
  await pool.query('UPDATE web_accounts SET last_login = NOW() WHERE user_id = ?', [row.user_id]);
  await getOrCreateUser(row.user_id, row.username, null);
  return { id: row.user_id, username: row.username, avatar: '', local: true };
}

function createLocalAuthRoutes() {
  const router = express.Router();

  router.post('/local/register', async (req, res) => {
    if (!allowRegister(req.ip || 'unknown')) {
      return res.status(429).json({ success: false, error: '계정 생성이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    }
    try {
      const user = await registerLocalUser(req.body?.username, req.body?.password);
      session.setLocalCookie(res, user, req);
      session.clearGuestCookie(res, req);
      return res.json({ success: true, username: user.username });
    } catch (err) {
      const status = Number(err && err.status) || 500;
      return res.status(status).json({
        success: false,
        error: status >= 500 ? '처리 중 오류가 발생했습니다.' : err.message
      });
    }
  });

  router.post('/local/login', async (req, res) => {
    if (!allowLogin(req.ip || 'unknown')) {
      return res.status(429).json({ success: false, error: '로그인을 너무 많이 시도했습니다. 잠시 후 다시 시도해 주세요.' });
    }
    try {
      const user = await loginLocalUser(req.body?.username, req.body?.password);
      session.setLocalCookie(res, user, req);
      session.clearGuestCookie(res, req);
      return res.json({ success: true, username: user.username });
    } catch (err) {
      const status = Number(err && err.status) || 500;
      return res.status(status).json({
        success: false,
        error: status >= 500 ? '처리 중 오류가 발생했습니다.' : err.message
      });
    }
  });

  return router;
}

module.exports = {
  ensureWebAccountsTable,
  registerLocalUser,
  loginLocalUser,
  createLocalAuthRoutes
};
