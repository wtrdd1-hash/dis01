'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { inspectContainer, dockerInfoOk } = require('./docker');

const CONTAINERS = [
  { id: 'app', name: '웹·봇 프로세스', container: 'wtrdd-discord-app' },
  { id: 'proxy', name: '엣지 프록시', container: 'wtrdd-edge-proxy' },
  { id: 'tunnel', name: 'Cloudflare 터널', container: 'wtrdd-cloudflared' },
  { id: 'autoheal', name: '컨테이너 자동복구', container: 'wtrdd-autoheal' }
];

function pingApp(appHealthUrl) {
  const started = Date.now();
  return (async () => {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 4000);
      const res = await fetch(appHealthUrl, { signal: ac.signal, cache: 'no-store' });
      clearTimeout(timer);
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok && body.ok !== false, latencyMs: Date.now() - started, body };
    } catch (_) {
      return { ok: false, latencyMs: Date.now() - started, body: null };
    }
  })();
}

function pingMysql(env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const user = env.DB_USER || 'root';
    const host = env.DB_HOST || '127.0.0.1';
    const port = String(env.DB_PORT || '3306');
    const childEnv = { ...process.env };
    if (env.DB_PASSWORD) childEnv.MYSQL_PWD = env.DB_PASSWORD;
    execFile(
      'mysqladmin',
      ['ping', '-h', host, '-P', port, '-u', user, '--connect-timeout=3', '--silent'],
      { timeout: 4000, env: childEnv },
      (err) => {
        resolve({ ok: !err, latencyMs: Date.now() - started });
      }
    );
  });
}

function readWatchdogEvents(logFile, limit) {
  try {
    const text = fs.readFileSync(logFile, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean).slice(-limit);
    const events = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (_) {
        /* 깨진 줄은 건너뛴다 */
      }
    }
    return events.reverse();
  } catch (_) {
    return [];
  }
}

function hostMetrics() {
  const os = require('os');
  const total = os.totalmem();
  const free = os.freemem();
  let diskUsedPct = null;
  try {
    const st = fs.statfsSync('/');
    if (st.blocks > 0) {
      diskUsedPct = Math.round((1 - Number(st.bavail) / Number(st.blocks)) * 100);
    }
  } catch (_) {
    diskUsedPct = null;
  }
  const loads = os.loadavg();
  return {
    memUsedPct: total ? Math.round(((total - free) / total) * 100) : null,
    diskUsedPct,
    load1: Number(loads[0].toFixed(2)),
    uptimeSec: Math.round(os.uptime())
  };
}

function overallOf(checks) {
  const downs = checks.filter((c) => c.level === 'down');
  const degraded = checks.filter((c) => c.level === 'degraded');
  if (downs.some((c) => c.critical)) return 'down';
  if (downs.length || degraded.length) return 'degraded';
  return 'ok';
}

function createCollector(opts) {
  const {
    appHealthUrl,
    envFileLoad,
    watchdogLog,
    watchdogStateDir
  } = opts;

  async function collectHealth() {
    const env = envFileLoad();
    const paused = fs.existsSync(path.join(watchdogStateDir, 'off'));
    const [appPing, mysql, docker, ...containerStates] = await Promise.all([
      pingApp(appHealthUrl),
      pingMysql(env),
      dockerInfoOk(),
      ...CONTAINERS.map((item) => inspectContainer(item.container))
    ]);

    const containerMap = {};
    CONTAINERS.forEach((item, idx) => {
      containerMap[item.id] = { ...item, ...containerStates[idx] };
    });

    const appBody = appPing.body || {};
    const webOk = appPing.ok;
    const dbOk = Boolean(mysql.ok || appBody.db);
    const botOk = appBody.bot === true;
    const appBox = containerMap.app;
    const proxyBox = containerMap.proxy;
    const tunnelBox = containerMap.tunnel;
    const healBox = containerMap.autoheal;

    const checks = [
      {
        id: 'web',
        name: '웹 대시보드',
        detail: webOk
          ? `응답 ${appPing.latencyMs}ms · 버전 ${appBody.label || appBody.version || '-'}`
          : 'HTTP 응답 없음. 감시자가 자동 기동을 시도합니다.',
        latencyMs: appPing.latencyMs,
        level: webOk ? 'ok' : 'down',
        critical: true
      },
      {
        id: 'bot',
        name: '디스코드 봇',
        detail: !webOk
          ? '웹 프로세스와 함께 내려간 상태입니다.'
          : botOk
            ? `연결됨 · 업타임 ${appBody.uptime || 0}초`
            : '프로세스는 살아 있으나 디스코드 준비 전(또는 재연결 중)입니다.',
        level: !webOk ? 'down' : botOk ? 'ok' : 'degraded',
        critical: true
      },
      {
        id: 'mysql',
        name: '데이터베이스',
        detail: dbOk ? `MySQL 응답 ${mysql.latencyMs}ms` : 'MySQL ping 실패',
        latencyMs: mysql.latencyMs,
        level: dbOk ? 'ok' : 'down',
        critical: true
      },
      {
        id: 'app-container',
        name: '앱 컨테이너',
        detail: appBox.exists
          ? `${appBox.status}${appBox.health ? ` · health ${appBox.health}` : ''} · 재시작 ${appBox.restartCount}회`
          : '컨테이너가 없습니다. 감시자가 compose up 합니다.',
        level: appBox.running ? 'ok' : 'down',
        critical: true
      },
      {
        id: 'proxy',
        name: '엣지 프록시',
        detail: proxyBox.running ? `nginx · ${proxyBox.health}` : '프록시 컨테이너가 꺼져 있습니다.',
        level: proxyBox.running ? 'ok' : 'down',
        critical: false
      },
      {
        id: 'tunnel',
        name: 'Cloudflare 터널',
        detail: tunnelBox.running ? 'cloudflared 실행 중' : '터널 컨테이너가 꺼져 있습니다.',
        level: tunnelBox.running ? 'ok' : 'degraded',
        critical: false
      },
      {
        id: 'autoheal',
        name: 'Docker Autoheal',
        detail: healBox.running
          ? '비정상 컨테이너를 자동 재시작합니다.'
          : '자동복구 컨테이너가 꺼져 있습니다. 감시자가 다시 올립니다.',
        level: healBox.running ? 'ok' : 'degraded',
        critical: false
      },
      {
        id: 'docker',
        name: 'Docker 엔진',
        detail: docker.ok ? `Server ${docker.version}` : 'Docker 데몬 응답 없음',
        level: docker.ok ? 'ok' : 'down',
        critical: true
      },
      {
        id: 'watchdog',
        name: '호스트 감시자',
        detail: paused
          ? '유지보수 모드(watchdog/off). 자동 기동이 잠시 멈춘 상태입니다.'
          : 'systemd 타이머가 20초마다 점검하고, 꺼져 있으면 다시 켭니다.',
        level: paused ? 'degraded' : 'ok',
        critical: false
      }
    ];

    const events = readWatchdogEvents(watchdogLog, 40);
    const restarts24h = events.filter((ev) => {
      const action = String(ev.action || '');
      if (!ev.ts) return false;
      if (!action.includes('restart') && action !== 'compose_up') return false;
      const t = Date.parse(ev.ts);
      return Number.isFinite(t) && Date.now() - t < 24 * 60 * 60 * 1000;
    }).length;

    return {
      ok: overallOf(checks) !== 'down',
      overall: overallOf(checks),
      generatedAt: new Date().toISOString(),
      site: '월덕',
      publicUrl: 'https://status.easy-scraping.com',
      paused,
      checks,
      containers: containerMap,
      app: {
        version: appBody.version || null,
        label: appBody.label || null,
        uptime: appBody.uptime || 0,
        db: Boolean(appBody.db),
        bot: Boolean(appBody.bot)
      },
      recovery: {
        paused,
        restarts24h,
        lastEvent: events[0] || null
      },
      host: hostMetrics(),
      events
    };
  }

  return { collectHealth, CONTAINERS };
}

module.exports = { createCollector };
