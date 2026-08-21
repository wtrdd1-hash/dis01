'use strict';

const config = require('../../config/config');
const session = require('../session');
const UserModel = require('../../models/UserModel');

class AuthController {
  /**
   * 🔑 디스코드 로그인 시작 (OAuth2 리다이렉트)
   */
  static async loginWithDiscord(req, res) {
    const clientId = config.DISCORD_CLIENT_ID;
    const redirectUri = encodeURIComponent(config.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/discord/callback`);
    const scope = encodeURIComponent('identify guilds');
    const state = Math.random().toString(36).substring(2, 15);

    // Save state in session or cookie
    res.cookie('oauth_state', state, { httpOnly: true, maxAge: 300000, secure: config.IS_PRODUCTION });

    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&state=${state}`;
    res.redirect(discordAuthUrl);
  }

  /**
   * 🔄 디스코드 OAuth2 콜백 처리
   */
  static async discordCallback(req, res) {
    const { code, state } = req.query;
    const savedState = req.cookies?.oauth_state;

    if (!code) {
      return res.redirect('/stocks?error=no_code');
    }

    try {
      const redirectUri = config.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/discord/callback`;
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.DISCORD_CLIENT_ID,
          client_secret: config.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri
        })
      });

      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        return res.redirect('/stocks?error=token_failed');
      }

      // Fetch user profile from Discord
      const userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const discordUser = await userRes.json();

      if (!discordUser || !discordUser.id) {
        return res.redirect('/stocks?error=user_fetch_failed');
      }

      // Format avatar URL
      let avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
      if (discordUser.avatar) {
        avatarUrl = `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128`;
      }

      // Ensure user exists in DB
      await UserModel.findOrCreate(discordUser.id, discordUser.username || '사용자', avatarUrl);

      const sessionUser = {
        id: discordUser.id,
        username: discordUser.username,
        avatar: avatarUrl,
        isDiscordUser: true
      };

      // Set session cookie
      session.setSessionCookie(res, req, sessionUser);
      session.clearGuestCookie(res, req);
      res.clearCookie('oauth_state');

      res.redirect('/stocks?login=success');
    } catch (err) {
      console.error('[AuthController] Discord OAuth Error:', err);
      res.redirect('/stocks?error=auth_exception');
    }
  }

  /**
   * 🚪 로그아웃 (모든 쿠키 및 세션 완벽 파기)
   */
  static async logout(req, res) {
    try {
      session.clearSessionCookie(res, req);
      session.clearGuestCookie(res, req);
      
      res.clearCookie('wtrdd_session');
      res.clearCookie('wtrdd_guest_session');
      res.clearCookie('wtrdd_local_session');
      res.clearCookie('wtrdd_local');
      res.clearCookie('connect.sid');
      res.clearCookie('oauth_state');

      if (req.session) {
        req.session.destroy(() => {});
      }
    } catch (e) {
      console.error('[AuthController] Logout Error:', e);
    }

    res.redirect('/stocks?logout=success');
  }
}

module.exports = AuthController;
