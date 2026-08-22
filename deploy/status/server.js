'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnvFile } = require('./lib/env');
const { createCollector } = require('./lib/health');
const { createHistory } = require('./lib/history');
const { createAlerter } = require('./lib/alert');
const { createOpsAuth } = require('./lib/opsAuth');
const { containerLogs, ALLOWED_LOG_CONTAINERS } = require('./lib/docker');
const { getSshWhitelist, addSshWhitelist, removeSshWhitelist, getClientIp } = require('./lib/firewall');

const HOST = process.env.STATUS_HOST || '0.0.0.0';
const PORT = Number(process.env.STATUS_PORT || 8090);
const APP_HEALTH_URL = process.env.APP_HEALTH_URL || 'http://127.0.0.1:8080/healthz';
const ENV_FILE = process.env.ENV_FILE || '/home/wtrdd/discord-bot/.env';
const WATCHDOG_LOG = process.env.WATCHDOG_LOG || '/home/wtrdd/discord-bot/logs/watchdog.jsonl';
const WATCHDOG_STATE = process.env.WATCHDOG_STATE || '/home/wtrdd/discord-bot/logs/watchdog';
const PUBLIC_DIR = path.join(__dirname, 'public');
const HISTORY_FILE = path.join(WATCHDOG_STATE, 'samples.jsonl');
const ALERT_STATE = path.join(WATCHDOG_STATE, 'alert-state.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

const envFileLoad = () => loadEnvFile(ENV_FILE);
const collector = createCollector({
  appHealthUrl: APP_HEALTH_URL,
  envFileLoad,
  watchdogLog: WATCHDOG_LOG,
  watchdogStateDir: WATCHDOG_STATE
});
const history = createHistory(HISTORY_FILE);
const alerter = createAlerter({ envFileLoad, stateFile: ALERT_STATE });
const opsAuth = createOpsAuth(
  () => envFileLoad().COOKIE_SECRET || envFileLoad().STATUS_OPS_KEY || 'status-ops',
  () => envFileLoad().STATUS_OPS_KEY || ''
);

function send(res, status, type, body, extraHeaders) {
  const headers = Object.assign(
    {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    },
    extraHeaders || {}
  );
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, data, extraHeaders) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data), extraHeaders);
}

function isSecure(req) {
  return String(req.headers['x-forwarded-proto'] || '') === 'https';
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath;
  if (rel === '/') rel = '/index.html';
  if (rel === '/ops' || rel === '/ops/') rel = '/ops.html';
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!abs.startsWith(PUBLIC_DIR)) {
    send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    send(res, 200, MIME[path.extname(abs)] || 'application/octet-stream', data);
  });
}

async function publicHealth() {
  const health = await collector.collectHealth();
  history.record(health);
  health.history = history.snapshot();
  return health;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const urlPath = url.pathname;
  try {
    if (req.method === 'GET' && (urlPath === '/health.json' || urlPath === '/api/status')) {
      sendJson(res, 200, await publicHealth());
      return;
    }
    if (req.method === 'GET' && urlPath === '/healthz') {
      sendJson(res, 200, { ok: true, service: 'status' });
      return;
    }
    if (req.method === 'POST' && urlPath === '/ops/login') {
      const raw = await readBody(req, 4096);
      let key = '';
      try {
        key = String(JSON.parse(raw).key || '');
      } catch (_) {
        key = '';
      }
      if (!opsAuth.checkKey(key)) {
        sendJson(res, 401, { ok: false, error: '키가 올바르지 않습니다.' });
        return;
      }
      const token = opsAuth.issueToken();
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': opsAuth.cookieHeader(token, isSecure(req)) });
      return;
    }
    if ((req.method === 'POST' || req.method === 'GET') && urlPath === '/ops/logout') {
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': opsAuth.clearCookie(isSecure(req)) });
      return;
    }
    if (urlPath.startsWith('/ops/api/')) {
      const authKeyHeader = String(req.headers['x-ops-key'] || '');
      const hasKeyHeader = authKeyHeader && opsAuth.checkKey(authKeyHeader);
      const isAuthedSession = opsAuth.hasSession(req);

      if (req.method === 'GET' && urlPath === '/ops/api/whitelist') {
        const data = await getSshWhitelist();
        sendJson(res, 200, {
          ok: true,
          saved: data.saved,
          ufwRules: data.ufwRules,
          clientIp: getClientIp(req)
        });
        return;
      }

      if (urlPath.startsWith('/ops/api/whitelist/')) {
        const raw = await readBody(req, 4096);
        let body = {};
        try { body = JSON.parse(raw); } catch (_) {}
        const bodyKey = String(body.key || '');
        const hasKeyBody = bodyKey && opsAuth.checkKey(bodyKey);

        if (!isAuthedSession && !hasKeyHeader && !hasKeyBody) {
          sendJson(res, 401, { ok: false, error: '관리자 인증 키가 올바르지 않습니다.' });
          return;
        }

        if (req.method === 'POST' && urlPath === '/ops/api/whitelist/add') {
          const result = await addSshWhitelist(body.ip, body.comment || 'Web-Admin');
          sendJson(res, result.ok ? 200 : 400, result);
          return;
        }
        if (req.method === 'POST' && urlPath === '/ops/api/whitelist/add-my-ip') {
          const myIp = getClientIp(req);
          const result = await addSshWhitelist(myIp, 'Admin-My-IP');
          sendJson(res, result.ok ? 200 : 400, { ...result, ip: myIp });
          return;
        }
        if (req.method === 'POST' && urlPath === '/ops/api/whitelist/remove') {
          const result = await removeSshWhitelist(body.ip);
          sendJson(res, result.ok ? 200 : 400, result);
          return;
        }
      }

      if (!isAuthedSession && !hasKeyHeader) {
        sendJson(res, 401, { ok: false, error: '관리자 로그인이 필요합니다.' });
        return;
      }
      if (req.method === 'GET' && urlPath === '/ops/api/overview') {
        const health = await publicHealth();
        sendJson(res, 200, {
          ok: true,
          health,
          containers: health.containers,
          events: health.events,
          logTargets: Array.from(ALLOWED_LOG_CONTAINERS)
        });
        return;
      }
      if (req.method === 'GET' && urlPath === '/ops/api/logs') {
        const name = url.searchParams.get('name') || 'wtrdd-discord-app';
        const logs = await containerLogs(name, Number(url.searchParams.get('tail') || 120));
        sendJson(res, 200, { ok: logs.ok, name, lines: logs.lines, error: logs.error || null });
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'method not allowed');
      return;
    }
    serveStatic(req, res, urlPath);
  } catch (err) {
    sendJson(res, 500, { ok: false, overall: 'down', error: 'status_handler_failed' });
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function tick() {
  try {
    const health = await collector.collectHealth();
    history.record(health);
    await alerter.maybeAlert(health);
  } catch (_) {
    /* 다음 주기에 다시 */
  }
}

server.listen(PORT, HOST, () => {
  process.stdout.write(`[status] listening on ${HOST}:${PORT}\n`);
  tick();
  setInterval(tick, 60 * 1000).unref();
});
