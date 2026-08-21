'use strict';

const { Server } = require('socket.io');
const { attachLiveSyncSocket, startLiveSyncGc } = require('../../utils/liveSync');
const { attachCrashEngine } = require('../../utils/crashEngine');
const { attachMetaverseSocket } = require('./metaverseSocket');
const { getAppVersion, getAppVersionLabel } = require('../autoRefreshPatch');
const { getCurrentMarketRegime, getLastNews } = require('../../utils/stockEngine');
const { pool } = require('../../config/database');

function initSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
  });

  global.__io = io;

  // 1. 코어 엔진 소켓 어태치
  attachLiveSyncSocket(io);
  startLiveSyncGc();
  attachCrashEngine(io);
  attachMetaverseSocket(io);

  // 2. 실시간 연결 이벤트
  io.on('connection', async (socket) => {
    try {
      const [stocks] = await pool.query('SELECT * FROM stocks');
      const regime = getCurrentMarketRegime();
      const news = getLastNews();

      socket.emit('app:version', { version: getAppVersion(), label: getAppVersionLabel() });
      socket.emit('market:snapshot', {
        stocks,
        regime,
        news: news ? { text: news.headline || news.text } : null,
        timestamp: Date.now()
      });
    } catch (e) {}

    socket.on('market:refresh', async () => {
      try {
        const [stocks] = await pool.query('SELECT * FROM stocks');
        socket.emit('market:update', {
          stocks,
          regime: getCurrentMarketRegime(),
          news: getLastNews(),
          timestamp: Date.now()
        });
      } catch (e) {}
    });
  });

  return io;
}

module.exports = { initSocketServer };
