/**
 * 채굴 장르 API
 */
const express = require('express');
const { getOrCreateUser } = require('../../config/database');
const { withUserLock } = require('../../utils/money');
const { sendPublicError } = require('../httpSafe');
const { pushUserLive } = require('../../utils/liveSync');
const { formatMoney } = require('../../utils/formatters');
const { publicGenreList, currentWeather, normalizeGenre } = require('../../utils/mineGenres');
const mine = require('../../utils/mineService');

function createMineRoutes(getSessionUser) {
  const router = express.Router();

  router.get('/catalog', (req, res) => {
    return res.json({
      success: true,
      genres: publicGenreList(),
      weather: currentWeather()
    });
  });

  router.get('/state', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) {
      return res.json({
        success: true,
        loggedIn: false,
        weather: currentWeather(),
        genres: publicGenreList().map((g) => ({
          ...g,
          unlocked: g.id === 'classic',
          clicks: 0,
          depth: 0,
          badge: { id: 'none', name: '견습', emoji: '🌱' }
        })),
        selected: 'classic',
        leaderboard: []
      });
    }
    try {
      await getOrCreateUser(session.id, session.username, session.avatar);
      const data = await mine.getState(session.id);
      return res.json({ success: true, loggedIn: true, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.get('/leaderboard', async (req, res) => {
    try {
      const genreId = normalizeGenre(req.query.genre);
      const rows = await mine.getLeaderboard(genreId, 10);
      return res.json({ success: true, genreId, rows });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/select', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const selected = await mine.setSelectedGenre(session.id, req.body?.genre);
      const data = await mine.getState(session.id);
      return res.json({ success: true, selected, ...data });
    } catch (err) {
      return sendPublicError(res, err);
    }
  });

  router.post('/unlock', async (req, res) => {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      const result = await withUserLock(session.id, async () => {
        await getOrCreateUser(session.id, session.username, session.avatar);
        return mine.unlockGenre(session.id, req.body?.genre);
      });
      pushUserLive(session.id);
      const data = await mine.getState(session.id);
      const msg = result.already
        ? `${result.genre.emoji} ${result.genre.name}은(는) 이미 해금되어 있습니다.`
        : `${result.genre.emoji} ${result.genre.name} 해금! (${formatMoney(result.genre.unlockCost)}) 이후에도 계속 유지됩니다.`;
      return res.json({
        success: true,
        message: msg,
        newCash: result.newCash,
        ...data
      });
    } catch (err) {
      if (err.code === 'INSUFFICIENT_CASH') {
        return res.json({ success: false, error: '현금이 부족합니다!' });
      }
      return sendPublicError(res, err);
    }
  });

  return router;
}

module.exports = { createMineRoutes };
