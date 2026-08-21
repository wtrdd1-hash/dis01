'use strict';

const { getAppVersion, getAppVersionLabel } = require('./autoRefreshPatch');

const startedAt = Date.now();

async function pingDb(pool, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      })
    ]);
    return true;
  } catch (_) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isBotReady() {
  try {
    const client = global.__discordClient;
    return Boolean(client && typeof client.isReady === 'function' && client.isReady());
  } catch (_) {
    return false;
  }
}

function isBotRequiredForReadiness() {
  return String(process.env.PROCESS_TYPE || 'all').trim().toLowerCase() !== 'web';
}

/**
 * 라이브니스 전용. DB/봇이 꺼져 있어도 HTTP 200을 내려
 * Docker healthcheck가 재시작 폭풍을 만들지 않게 한다.
 */
function registerHealthz(app, pool) {
  app.get('/healthz', async (req, res) => {
    const db = await pingDb(pool, 2000);
    const payload = {
      ok: true,
      web: true,
      db,
      bot: isBotReady(),
      uptime: Math.round(process.uptime()),
      startedAt: new Date(startedAt).toISOString(),
      version: getAppVersion(),
      label: getAppVersionLabel()
    };
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  });

  // 준비 상태는 의존성 장애를 HTTP 상태 코드로 노출한다.
  app.get('/readyz', async (req, res) => {
    const db = await pingDb(pool, 2000);
    const bot = isBotReady();
    const botRequired = isBotRequiredForReadiness();
    const ready = db && (!botRequired || bot);
    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({
      ok: ready,
      web: true,
      db,
      bot,
      botRequired,
      uptime: Math.round(process.uptime()),
      startedAt: new Date(startedAt).toISOString(),
      version: getAppVersion(),
      label: getAppVersionLabel()
    });
  });
}

module.exports = { registerHealthz, pingDb, isBotReady, isBotRequiredForReadiness };
