'use strict';

const express = require('express');
const { renderHelpInnerHtml } = require('../helpContent');
const { renderGuidePage } = require('../guidePage');

function createHelpRoutes(getPlayUser) {
  const router = express.Router();

  router.get('/partials/help', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('HX-Push-Url', 'false');
    res.type('html').send(renderHelpInnerHtml());
  });

  router.get('/guide', (req, res) => {
    const user = typeof getPlayUser === 'function' ? getPlayUser(req) : null;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(renderGuidePage({ user }));
  });

  router.get('/game-guide', (req, res) => {
    const user = typeof getPlayUser === 'function' ? getPlayUser(req) : null;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(renderGuidePage({ user }));
  });

  router.get('/help', (req, res) => {
    const user = typeof getPlayUser === 'function' ? getPlayUser(req) : null;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(renderGuidePage({ user }));
  });

  return router;
}

module.exports = { createHelpRoutes };
