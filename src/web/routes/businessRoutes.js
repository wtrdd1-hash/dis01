const express = require('express');
const { getOrCreateUser } = require('../../config/database');
const { sendPublicError, jsonSafe } = require('../httpSafe');
const {
  listUserBusinesses,
  buyBusiness,
  upgradeBusiness,
  hireStaff,
  upgradeHq,
  setAutoCollect,
  collectBusiness,
  sellBusiness
} = require('../../utils/businessEngine');

function createBusinessRoutes(getSessionUser) {
  const router = express.Router();

  async function run(req, res, fn) {
    const session = getSessionUser(req);
    if (!session) return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    try {
      await getOrCreateUser(session.id, session.username, session.avatar);
      const data = await fn(session);
      return res.json({ success: true, ...jsonSafe(data) });
    } catch (err) {
      if (err && err.code === 'INSUFFICIENT_CASH') {
        return res.status(400).json({ success: false, error: '보유 현금이 부족합니다.' });
      }
      if (err && err.code === 'RATE_LIMIT') {
        return res.status(429).json({ success: false, error: err.message });
      }
      if (err && ['NOT_FOUND', 'OWNED', 'ALREADY_OWNED', 'NOT_OWNED', 'MAX', 'EMPTY', 'LOCKED'].includes(err.code)) {
        return res.status(400).json({ success: false, error: err.message });
      }
      return sendPublicError(res, err);
    }
  }

  router.get('/', (req, res) => run(req, res, async (session) => {
    const state = await listUserBusinesses(session.id);
    return { state };
  }));

  router.post('/buy', (req, res) => run(req, res, (session) => (
    buyBusiness(session.id, session.username, String(req.body?.key || ''))
  )));

  router.post('/upgrade', (req, res) => run(req, res, (session) => (
    upgradeBusiness(session.id, session.username, String(req.body?.key || ''))
  )));

  router.post('/hire', (req, res) => run(req, res, (session) => (
    hireStaff(session.id, session.username, String(req.body?.key || ''))
  )));

  router.post('/hq', (req, res) => run(req, res, (session) => (
    upgradeHq(session.id, session.username)
  )));

  router.post('/auto', (req, res) => run(req, res, (session) => (
    setAutoCollect(session.id, session.username, Boolean(req.body?.on))
  )));

  router.post('/collect', (req, res) => run(req, res, (session) => (
    collectBusiness(session.id, session.username, req.body?.key ? String(req.body.key) : null)
  )));

  router.post('/sell', (req, res) => run(req, res, (session) => (
    sellBusiness(session.id, session.username, String(req.body?.key || ''))
  )));

  return router;
}

module.exports = { createBusinessRoutes };
