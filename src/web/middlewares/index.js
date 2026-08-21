'use strict';

const config = require('../../config/bot');
const UserModel = require('../../models/UserModel');
const session = require('../session');

// 1. 보안 헤더 미들웨어
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
}

// 2. 세션 주입 및 인증 미들웨어
function attachSession(req, res, next) {
  const discordUser = session.getSessionUser(req);
  req.sessionUser = discordUser || null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.sessionUser) {
    return res.status(401).json({ success: false, error: 'Discord 로그인이 필요합니다.' });
  }
  next();
}

// 3. 관리자 권한 & IP 화이트리스트 미들웨어
async function requireAdmin(req, res, next) {
  const user = req.sessionUser;
  if (!user || !config.isAdmin(user.id)) {
    if (req.accepts('html')) return res.redirect('/');
    return res.status(403).json({ success: false, error: '관리자 권한이 필요합니다.' });
  }

  const clientIp = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const access = await UserModel.checkAdminAccess(user.id, clientIp, config);
  if (!access.allowed) {
    if (req.accepts('html')) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><title>접근 제한</title></head>
        <body style="background:#0b0e14;color:#f87171;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <div style="text-align:center;padding:40px;background:#1e293b;border-radius:16px;border:1px solid #ef4444;">
            <h2>🚫 관리자 IP 접근 차단</h2>
            <p style="color:#94a3b8;margin-top:8px;">등록되지 않은 IP (${access.clientIp || clientIp}) 로부터의 관리자 콘솔 접근이 거부되었습니다.</p>
          </div>
        </body></html>
      `);
    }
    return res.status(403).json({ success: false, error: `보안 제한: 허용되지 않은 IP (${access.clientIp || clientIp}) 입니다.` });
  }

  next();
}

// 4. 에러 핸들러 미들웨어
function errorHandler(err, req, res, next) {
  console.error('[Web Error Handler]:', err.message || err);
  const status = err.status || 500;
  const message = (err.status && err.status < 500) ? err.message : '요청 처리 중 오류가 발생했습니다.';
  res.status(status).json({ success: false, error: message });
}

module.exports = {
  securityHeaders,
  attachSession,
  requireAuth,
  requireAdmin,
  errorHandler
};
