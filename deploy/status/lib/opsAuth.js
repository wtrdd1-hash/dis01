'use strict';

const crypto = require('crypto');

const COOKIE = 'wtrdd_status_ops';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx < 1) return;
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    });
  return out;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function createOpsAuth(getSecret, getOpsKey) {
  function issueToken() {
    const payload = b64url(JSON.stringify({ exp: Date.now() + MAX_AGE_MS, v: 1 }));
    return payload + '.' + sign(getSecret(), payload);
  }

  function verifyToken(token) {
    const raw = String(token || '');
    const idx = raw.lastIndexOf('.');
    if (idx < 1) return false;
    const payload = raw.slice(0, idx);
    const sig = raw.slice(idx + 1);
    const expected = sign(getSecret(), payload);
    if (!safeEqual(sig, expected)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return Number(data.exp) > Date.now();
    } catch (_) {
      return false;
    }
  }

  function hasSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    return verifyToken(cookies[COOKIE]);
  }

  function cookieHeader(token, secure) {
    const parts = [
      COOKIE + '=' + encodeURIComponent(token),
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=' + Math.floor(MAX_AGE_MS / 1000)
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  function clearCookie(secure) {
    const parts = [COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  function checkKey(input) {
    const expected = getOpsKey();
    if (!expected) return false;
    return safeEqual(input, expected);
  }

  return { hasSession, issueToken, cookieHeader, clearCookie, checkKey };
}

module.exports = { createOpsAuth };
