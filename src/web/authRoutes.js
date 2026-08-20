'use strict';
/**
 * Discord OAuth2 로그인 / 로그아웃 / 회원 탈퇴 라우터
 *
 * 기존 server.js에 인라인으로 박혀 있던 200줄 분량의 인증 라우트를 분리.
 * server.js에서 createAuthRoutes() 형태로 호출하여 미들웨어에 마운트한다.
 */

const axios = require('axios');
const config = require('../config/config');
const session = require('./session');
const { escapeHtml } = require('./httpSafe');

function getDynamicRedirectUri(req) {
  if (config.discord.redirectUri && !config.discord.redirectUri.includes('localhost')) {
    return config.discord.redirectUri;
  }
  return `${session.resolvePublicBaseUrl(req)}/auth/discord/callback`;
}

const BANNED_USER_HTML = (username, banInfo) => `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>접속 차단 안내 - 월덕 가상 경제</title>
  <style>
    body { background:#030712; color:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; box-sizing:border-box; }
    .card { background:#0f172a; border:1px solid rgba(239,68,68,0.4); border-radius:16px; padding:32px; max-width:480px; width:100%; text-align:center; box-shadow:0 20px 40px rgba(0,0,0,0.8); }
    .icon { font-size:3.5rem; margin-bottom:12px; }
    h1 { color:#f87171; font-size:1.5rem; margin:0 0 8px 0; font-weight:800; }
    p { color:#94a3b8; font-size:0.9rem; line-height:1.6; margin:0 0 20px 0; }
    .info-box { background:#030712; border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:16px; text-align:left; margin-bottom:24px; }
    .info-row { display:flex; justify-content:space-between; margin-bottom:8px; font-size:0.85rem; }
    .info-row:last-child { margin-bottom:0; }
    .info-lbl { color:#64748b; font-weight:600; }
    .info-val { color:#f1f5f9; font-weight:700; }
    .btn-home { display:inline-block; background:#1e293b; border:1px solid rgba(255,255,255,0.15); color:#fff; padding:10px 24px; border-radius:8px; text-decoration:none; font-weight:700; font-size:0.9rem; transition:all 0.2s; }
    .btn-home:hover { background:#334155; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🚫</div>
    <h1>서비스 이용이 제한되었습니다</h1>
    <p>귀하의 계정은 관리자 규정에 따라 로그인이 차단되었습니다.</p>
    <div class="info-box">
      <div class="info-row">
        <span class="info-lbl">차단 대상</span>
        <span class="info-val">${escapeHtml(username)}</span>
      </div>
      <div class="info-row">
        <span class="info-lbl">차단 사유</span>
        <span class="info-val" style="color:#fca5a5;">${escapeHtml(banInfo.reason || '')}</span>
      </div>
      <div class="info-row">
        <span class="info-lbl">제한 구분</span>
        <span class="info-val" style="color:${banInfo.isPermanent ? '#ef4444' : '#f59e0b'};">${banInfo.isPermanent ? '🔒 영구 차단' : '⏳ 시간 단위 정지 (' + escapeHtml(banInfo.remainingText || '') + ' 남음)'}</span>
      </div>
      ${banInfo.bannedUntil ? `
      <div class="info-row">
        <span class="info-lbl">해제 예정</span>
        <span class="info-val" style="color:#38bdf8;">${new Date(banInfo.bannedUntil).toLocaleString('ko-KR')}</span>
      </div>` : ''}
    </div>
    <a href="/" class="btn-home">메인 화면으로 이동</a>
  </div>
</body>
</html>`;

const WITHDRAW_PAGE_HTML = (user) => `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>회원 탈퇴 | 월덕 가상 경제</title>
  <style>
    body { background:#030712; color:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; box-sizing:border-box; }
    .card { background:#0f172a; border:1px solid rgba(239,68,68,0.4); border-radius:16px; padding:32px; max-width:480px; width:100%; text-align:center; box-shadow:0 20px 40px rgba(0,0,0,0.8); }
    .icon { font-size:3.5rem; margin-bottom:12px; }
    h1 { color:#f87171; font-size:1.45rem; margin:0 0 8px 0; font-weight:800; }
    p { color:#94a3b8; font-size:0.9rem; line-height:1.6; margin:0 0 20px 0; }
    .info-box { background:#030712; border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:16px; text-align:left; margin-bottom:24px; font-size:0.85rem; line-height:1.6; color:#cbd5e1; }
    .btn-danger { background:linear-gradient(135deg, #b91c1c, #ef4444); border:none; color:#fff; padding:12px 24px; border-radius:8px; font-weight:800; font-size:0.95rem; cursor:pointer; width:100%; box-shadow:0 4px 12px rgba(239,68,68,0.35); }
    .btn-cancel { display:inline-block; margin-top:12px; color:#94a3b8; text-decoration:none; font-size:0.85rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>회원 탈퇴 및 데이터 영구 삭제</h1>
    <p>월덕 가상 경제 서비스에서 탈퇴하시겠습니까?</p>
    <div class="info-box">
      <div>• <b>가상 자산 전액 소멸:</b> 보유 현금, 은행 예금, 주식, 사업체</div>
      <div>• <b>기록 영구 삭제:</b> 거래/도박 로그 및 랭킹 데이터</div>
      <div>• <b>복구 불가:</b> 탈퇴 후에는 이전 데이터를 절대 복구할 수 없습니다.</div>
    </div>
    ${user ? `
    <button type="button" class="btn-danger" onclick="doWithdraw()">🔴 영구 탈퇴 및 모든 데이터 삭제</button>
    ` : `
    <p style="color:#ef4444; font-weight:700;">로그인된 계정이 없습니다.</p>
    `}
    <br>
    <a href="/" class="btn-cancel">← 메인 대시보드로 돌아가기</a>
  </div>
  <script>
    async function doWithdraw() {
      if (!confirm('정말로 탈퇴하시겠습니까?\\n보유한 모든 자산과 데이터가 즉시 영구 삭제되며 복구할 수 없습니다.')) return;
      try {
        const res = await fetch('/api/user/withdraw', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true })
        });
        const data = await res.json();
        if (data.success) {
          alert('회원 탈퇴가 완료되었습니다. 이용해 주셔서 감사합니다.');
          location.href = '/';
        } else {
          alert(data.error || '탈퇴 실패');
        }
      } catch (e) {
        alert('통신 오류가 발생했습니다.');
      }
    }
  </script>
</body>
</html>`;

function createAuthRoutes(deps = {}) {
  const getOrCreateUser = deps.getOrCreateUser;
  const allowOauthAttempt = deps.allowOauthAttempt;

  return function authRoutes(app) {
    // ───── Discord OAuth2 시작 (state CSRF 방지) ─────
    app.get('/auth/discord', (req, res) => {
      if (!allowOauthAttempt || !allowOauthAttempt(req.ip || 'unknown')) {
        return res.status(429).send('로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
      }
      if (!config.discord.clientId) return res.redirect('/auth/guide');
      const state = session.createOAuthState(res, req);
      const redirectUri = getDynamicRedirectUri(req);
      const url = new URL('https://discord.com/api/oauth2/authorize');
      url.searchParams.set('client_id', config.discord.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'identify');
      url.searchParams.set('state', state);
      res.redirect(url.toString());
    });

    // ───── Discord OAuth2 콜백 ─────
    app.get('/auth/discord/callback', async (req, res) => {
      if (!allowOauthAttempt || !allowOauthAttempt((req.ip || 'unknown') + ':cb')) {
        return res.status(429).send('로그인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
      }
      const { code, state } = req.query;
      if (!code) return res.status(400).send('인증 코드가 전달되지 않았습니다.');
      if (!session.consumeOAuthState(req, res, state)) {
        return res.status(403).send('로그인 요청이 만료되었거나 유효하지 않습니다. 처음부터 다시 로그인해 주세요.');
      }

      try {
        const redirectUri = getDynamicRedirectUri(req);
        const params = new URLSearchParams();
        params.append('client_id', config.discord.clientId);
        params.append('client_secret', config.discord.clientSecret);
        params.append('grant_type', 'authorization_code');
        params.append('code', code);
        params.append('redirect_uri', redirectUri);
        params.append('scope', 'identify');

        const tokenRes = await axios.post('https://discord.com/api/v10/oauth2/token', params, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenRes.data.access_token;
        const userRes = await axios.get('https://discord.com/api/v10/users/@me', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });

        const discordUser = userRes.data;
        const username = discordUser.global_name || discordUser.username || discordUser.tag;
        const avatarUrl = discordUser.avatar
          ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
          : `https://cdn.discordapp.com/embed/avatars/0.png`;

        if (getOrCreateUser) {
          await getOrCreateUser(discordUser.id, username, avatarUrl);
        }

        const { checkUserBanStatus } = require('../utils/userBanEngine');
        const banInfo = await checkUserBanStatus(discordUser.id, { failClosed: true });
        if (banInfo.isBanned) {
          session.clearSessionCookie(res, req);
          return res.status(403).send(BANNED_USER_HTML(username, banInfo));
        }

        session.setSessionCookie(res, { id: discordUser.id, username, avatar: avatarUrl }, req);
        session.clearGuestCookie(res, req);
        res.redirect('/');
      } catch (err) {
        console.error('Discord OAuth Callback Error:', err.response?.data || err.message);
        res.status(500).send('Discord 인증에 실패했습니다. 잠시 후 다시 시도해 주세요.');
      }
    });

    // ───── 로그아웃 ─────
    app.get('/auth/logout', (req, res) => {
      session.clearSessionCookie(res, req);
      res.redirect('/');
    });

    // ───── 회원 탈퇴 API ─────
    app.post('/api/user/withdraw', async (req, res) => {
      const user = session.getSessionUser(req);
      if (!user || !user.id) {
        return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
      }
      const { confirm } = req.body || {};
      if (confirm !== true) {
        return res.status(400).json({ success: false, error: '탈퇴 확인 절차를 진행해 주세요.' });
      }
      try {
        const { withdrawUserAccount } = require('../utils/userWithdrawEngine');
        const result = await withdrawUserAccount(user.id, '웹 대시보드 회원 탈퇴');
        session.clearSessionCookie(res, req);
        session.clearGuestCookie(res, req);
        return res.json({ success: true, message: result.message });
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message || '탈퇴 처리 중 오류가 발생했습니다.' });
      }
    });

    // ───── 회원 탈퇴 페이지 ─────
    app.get('/withdraw', (req, res) => {
      const user = session.getSessionUser(req);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(WITHDRAW_PAGE_HTML(user));
    });

    // ───── OAuth 설정 안내 ─────
    app.get('/auth/guide', (req, res) => {
      const redirectUri = getDynamicRedirectUri(req);
      res.send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <title>Discord OAuth 설정 안내</title>
          <style>
            body { font-family: sans-serif; background: #0b0f19; color: #c9d1d9; padding: 40px; display: flex; justify-content: center; }
            .card { background: #161b22; border: 1px solid #30363d; padding: 30px; border-radius: 16px; max-width: 600px; }
            h1 { color: #58a6ff; }
            code { background: #0d1117; color: #79c0ff; padding: 4px 8px; border-radius: 6px; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>⚙️ Discord OAuth2 리디렉션 URI 설정 방법</h1>
            <p>Discord OAuth2 인증을 작동시키려면 디스코드 개발자 포털에 아래 리디렉션 URI를 등록해야 합니다:</p>
            <br>
            <p><b>1. Discord Developer Portal 접속</b> -> 애플리케이션 선택</p>
            <p><b>2. OAuth2 메뉴 -> Redirects 섹션</b> 이동</p>
            <p><b>3. Add Redirect 클릭 후 아래 URI 추가:</b></p>
            <p><code>${redirectUri}</code></p>
            <br>
            <a href="/" style="color:#58a6ff;">← 메인 페이지로 돌아가기</a>
          </div>
        </body>
        </html>
      `);
    });
  };
}

module.exports = {
  createAuthRoutes,
  getDynamicRedirectUri
};