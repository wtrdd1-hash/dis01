'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { inspectContainer, dockerInfoOk, getAllDockerFleet } = require('./docker');

const CONTAINERS = [
  { id: 'app', name: '웹·봇 프로세스', container: 'wtrdd-discord-app' },
  { id: 'test-app', name: '테스트 환경', container: 'wtrdd-test-app' },
  { id: 'proxy', name: '엣지 프록시', container: 'wtrdd-edge-proxy' },
  { id: 'tunnel', name: 'Cloudflare 터널', container: 'wtrdd-cloudflared' },
  { id: 'autoheal', name: '컨테이너 자동복구', container: 'wtrdd-autoheal' }
];

let lastCpuSample = null;

function getHostCpuUsage() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const firstLine = stat.split('\n')[0];
    const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    const now = Date.now();
    let usage = 0;
    if (lastCpuSample && (now - lastCpuSample.ts) >= 200) {
      const deltaTotal = total - lastCpuSample.total;
      const deltaIdle = idle - lastCpuSample.idle;
      if (deltaTotal > 0) {
        usage = Math.max(0, Math.min(100, Math.round(((deltaTotal - deltaIdle) / deltaTotal) * 1000) / 10));
      }
    }
    lastCpuSample = { total, idle, ts: now };
    return usage;
  } catch (e) {
    return 0;
  }
}

function pingUrl(url, timeoutMs = 4000) {
  const started = Date.now();
  return (async () => {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await fetch(url, { signal: ac.signal, cache: 'no-store' });
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
      } catch (_) {}
    }
    return events.reverse();
  } catch (_) {
    return [];
  }
}

function getDiskMetrics() {
  const mountConfigs = [
    { id: 'ssd1', path: '/', label: 'SSD 1 (시스템 NVMe)', mount: '/', model: 'NVMe 256GB' },
    { id: 'ssd2', path: '/data', label: 'SSD 2 (데이터·DB NVMe)', mount: '/data', model: 'NVMe 256GB' }
  ];

  const disks = [];
  let totalBytesAll = 0;
  let usedBytesAll = 0;
  let freeBytesAll = 0;

  for (const cfg of mountConfigs) {
    try {
      if (fs.existsSync(cfg.path)) {
        const st = fs.statfsSync(cfg.path);
        if (st && st.blocks > 0) {
          const totalBytes = Number(st.blocks) * Number(st.bsize);
          const freeBytes = Number(st.bavail) * Number(st.bsize);
          const usedBytes = totalBytes - freeBytes;
          const totalGb = Math.round((totalBytes / (1024 ** 3)) * 10) / 10;
          const usedGb = Math.round((usedBytes / (1024 ** 3)) * 10) / 10;
          const freeGb = Math.round((freeBytes / (1024 ** 3)) * 10) / 10;
          const usedPct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;

          disks.push({
            id: cfg.id,
            label: cfg.label,
            mount: cfg.mount,
            model: cfg.model,
            totalGb,
            usedGb,
            freeGb,
            usedPercent: usedPct,
            totalBytes,
            usedBytes,
            freeBytes
          });

          totalBytesAll += totalBytes;
          usedBytesAll += usedBytes;
          freeBytesAll += freeBytes;
        }
      }
    } catch (_) {}
  }

  const totalGbAll = Math.round((totalBytesAll / (1024 ** 3)) * 10) / 10;
  const usedGbAll = Math.round((usedBytesAll / (1024 ** 3)) * 10) / 10;
  const freeGbAll = Math.round((freeBytesAll / (1024 ** 3)) * 10) / 10;
  const usedPctAll = totalBytesAll > 0 ? Math.round((usedBytesAll / totalBytesAll) * 1000) / 10 : 0;

  return {
    totalGb: totalGbAll,
    usedGb: usedGbAll,
    freeGb: freeGbAll,
    usedPercent: usedPctAll,
    disks
  };
}

function hostMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsedPct = totalMem ? Math.round((usedMem / totalMem) * 1000) / 10 : 0;

  const disk = getDiskMetrics();
  const loads = os.loadavg();
  const cpus = os.cpus() || [];
  const cpuModel = cpus[0]?.model || 'Intel / AMD CPU';
  const cpuCount = cpus.length || 1;
  const cpuUsagePct = getHostCpuUsage();

  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const [name, netList] of Object.entries(ifaces)) {
    for (const net of netList) {
      if (net.family === 'IPv4' && !net.internal && !name.includes('docker') && !name.includes('br-')) {
        let label = 'LAN';
        if (net.address.startsWith('192.168.100.')) label = '직접 랜선 (eno1)';
        else if (net.address.startsWith('192.168.0.')) label = '공유기 LAN';
        ips.push({ iface: name, ip: net.address, label });
      }
    }
  }

  return {
    cpu: {
      model: cpuModel,
      cores: cpuCount,
      usagePercent: cpuUsagePct,
      load1: Number(loads[0].toFixed(2)),
      load5: Number(loads[1].toFixed(2)),
      load15: Number(loads[2].toFixed(2))
    },
    memory: {
      totalBytes: totalMem,
      usedBytes: usedMem,
      freeBytes: freeMem,
      totalGb: Math.round((totalMem / (1024 ** 3)) * 10) / 10,
      usedGb: Math.round((usedMem / (1024 ** 3)) * 10) / 10,
      freeGb: Math.round((freeMem / (1024 ** 3)) * 10) / 10,
      usedPercent: memUsedPct
    },
    disk,
    uptimeSec: Math.round(os.uptime()),
    publicIp: process.env.PUBLIC_IP || '14.49.239.119',
    sshHost: 'ssh.easy-scraping.com',
    sshPort: 34567,
    dns: [
      { domain: 'ssh.easy-scraping.com', type: 'A', target: '14.49.239.119', port: '34567', purpose: 'SSH 원격 관리 (Direct)', proxied: false },
      { domain: 'mini.easy-scraping.com', type: 'A', target: '14.49.239.119', port: '34567', purpose: '미니 PC 직접 접속', proxied: false },
      { domain: 'direct.easy-scraping.com', type: 'A', target: '14.49.239.119', port: '80 / 443', purpose: '다이렉트 원격 라우팅', proxied: false },
      { domain: 'easy-scraping.com', type: 'CNAME', target: 'Cloudflare Tunnel', port: '8070 (HTTPS)', purpose: '월덕 메인 웹 대시보드', proxied: true },
      { domain: 'status.easy-scraping.com', type: 'CNAME', target: 'Cloudflare Tunnel', port: '8095 (HTTPS)', purpose: '미니 PC 실시간 관제 대시보드', proxied: true },
      { domain: 'test.easy-scraping.com', type: 'CNAME', target: 'Cloudflare Tunnel', port: '8090 (HTTPS)', purpose: '테스트 & 스테이징 환경', proxied: true }
    ],
    ips,
    nodeVersion: process.version,
    platform: `${os.type()} ${os.release()} (${os.arch()})`
  };
}

function overallOf(checks) {
  const downs = checks.filter((c) => c.level === 'down');
  const degraded = checks.filter((c) => c.level === 'degraded');
  if (downs.some((c) => c.critical)) return 'down';
  if (downs.length || degraded.length) return 'degraded';
  return 'ok';
}

function getSshSessions() {
  return new Promise((resolve) => {
    execFile('who', [], { timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
      if (err || !stdout) {
        return resolve({ count: 0, active: false, sessions: [] });
      }
      const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
      const sessions = [];
      for (const line of lines) {
        const ipMatch = line.match(/\(([^)]+)\)/);
        const ip = ipMatch ? ipMatch[1] : '-';
        const rawWithoutIp = line.replace(/\([^)]+\)/, '').trim();
        const parts = rawWithoutIp.split(/\s+/);
        const user = parts[0] || 'unknown';
        const tty = parts.length > 3 ? parts.slice(1, -2).join(' ') : (parts[1] || 'pts');
        const loginTime = parts.length >= 3 ? parts.slice(-2).join(' ') : '-';

        sessions.push({
          user,
          tty,
          ip,
          loginTime
        });
      }
      resolve({
        count: sessions.length,
        active: sessions.length > 0,
        sessions
      });
    });
  });
}

function getUfwWhitelist() {
  return new Promise((resolve) => {
    execFile('sudo', ['ufw', 'status'], { timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
      if (err || !stdout) {
        try {
          const rules = fs.readFileSync('/etc/ufw/user.rules', 'utf8');
          const ips = [];
          const matches = rules.matchAll(/-A ufw-user-input.*--dport 34567.*-s ([0-9\.\/]+)/g);
          for (const m of matches) {
            if (m[1] && !ips.includes(m[1])) ips.push(m[1]);
          }
          return resolve(ips);
        } catch (_) {
          return resolve([]);
        }
      }
      const lines = stdout.split('\n');
      const ips = [];
      for (const line of lines) {
        if (line.includes('34567') && (line.includes('ALLOW') || line.includes('ALLOW IN'))) {
          const match = line.match(/ALLOW(?: IN)?\s+([^\s]+)/i) || line.match(/([0-9\.\/a-fA-F:]+)\s+.*ALLOW/);
          if (match && match[1] && match[1] !== 'Anywhere' && match[1] !== '(v6)') {
            if (!ips.includes(match[1])) ips.push(match[1]);
          }
        }
      }
      resolve(ips);
    });
  });
}

let cachedDdnsRecords = [];
let lastDdnsCheck = 0;

async function getDdnsRecords() {
  const now = Date.now();
  if (now - lastDdnsCheck < 8000 && cachedDdnsRecords.length > 0) {
    return cachedDdnsRecords;
  }
  const dns = require('dns').promises;
  const domains = ['ssh.easy-scraping.com', 'mini.easy-scraping.com', 'direct.easy-scraping.com'];
  const records = [];
  for (const d of domains) {
    try {
      const res = await dns.resolve4(d);
      records.push({ domain: d, ip: res[0] || '-', status: 'ok' });
    } catch (e) {
      records.push({ domain: d, ip: '조회 중', status: 'pending' });
    }
  }
  cachedDdnsRecords = records;
  lastDdnsCheck = now;
  return records;
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
    
    // 주요 서비스 핑, 도커 플릿, SSH 접속자 전체 현황 수집
    const [appPing, testPing, mysql, docker, dockerFleet, sshSessions, ufwWhitelist, ddnsRecords, ...containerStates] = await Promise.all([
      pingUrl(appHealthUrl),
      pingUrl('http://127.0.0.1:8085/healthz'),
      pingMysql(env),
      dockerInfoOk(),
      getAllDockerFleet(),
      getSshSessions(),
      getUfwWhitelist(),
      getDdnsRecords(),
      getSshSessions(),
      ...CONTAINERS.map((item) => inspectContainer(item.container))
    ]);

    const containerMap = {};
    CONTAINERS.forEach((item, idx) => {
      containerMap[item.id] = { ...item, ...containerStates[idx] };
    });

    const appBody = appPing.body || {};
    const testBody = testPing.body || {};
    const webOk = appPing.ok;
    const testOk = testPing.ok;
    const dbOk = Boolean(mysql.ok || appBody.db);
    const botOk = appBody.bot === true;

    const checks = [
      {
        id: 'web',
        name: '웹 대시보드 (본 서버)',
        detail: webOk
          ? `응답 ${appPing.latencyMs}ms · 버전 ${appBody.label || appBody.version || '-'}`
          : 'HTTP 응답 없음. 감시자가 자동 기동을 시도합니다.',
        latencyMs: appPing.latencyMs,
        level: webOk ? 'ok' : 'down',
        critical: true
      },
      {
        id: 'test-web',
        name: '테스트 환경 (test.easy-scraping.com)',
        detail: testOk
          ? `응답 ${testPing.latencyMs}ms · 버전 ${testBody.label || testBody.version || '-'}`
          : '테스트 서버 오프라인 또는 미기동 상태입니다.',
        latencyMs: testPing.latencyMs,
        level: testOk ? 'ok' : 'degraded',
        critical: false
      },
      {
        id: 'bot',
        name: '디스코드 봇 (월덕봇)',
        detail: !webOk
          ? '웹 프로세스와 함께 내려간 상태입니다.'
          : botOk
            ? `정상 연결 · 업타임 ${appBody.uptime || 0}초`
            : '프로세스는 살아 있으나 디스코드 준비 전(또는 재연결 중)입니다.',
        level: !webOk ? 'down' : botOk ? 'ok' : 'degraded',
        critical: true
      },
      {
        id: 'mysql',
        name: '데이터베이스 (MariaDB / MySQL)',
        detail: dbOk ? `MySQL 쿼리 핑 ${mysql.latencyMs}ms (포트 3306)` : 'MySQL ping 실패',
        latencyMs: mysql.latencyMs,
        level: dbOk ? 'ok' : 'down',
        critical: true
      },
      {
        id: 'proxy',
        name: 'Nginx 엣지 프록시',
        detail: containerMap.proxy?.running ? `nginx · ${containerMap.proxy?.health || 'running'}` : '프록시 컨테이너 중지',
        level: containerMap.proxy?.running ? 'ok' : 'down',
        critical: false
      },
      {
        id: 'tunnel',
        name: 'Cloudflare 터널',
        detail: containerMap.tunnel?.running ? 'cloudflared 터널 정상 가동 중' : '터널 컨테이너 중지',
        level: containerMap.tunnel?.running ? 'ok' : 'degraded',
        critical: false
      },
      {
        id: 'autoheal',
        name: 'Docker Autoheal',
        detail: containerMap.autoheal?.running ? '비정상 컨테이너 실시간 자동 복구 활성화' : 'Autoheal 중지',
        level: containerMap.autoheal?.running ? 'ok' : 'degraded',
        critical: false
      },
      {
        id: 'docker',
        name: 'Docker 엔진 데몬',
        detail: docker.ok ? `Docker Server v${docker.version || ''} (컨테이너 ${dockerFleet.length}개 가동)` : 'Docker 데몬 응답 없음',
        level: docker.ok ? 'ok' : 'down',
        critical: true
      },
      {
        id: 'watchdog',
        name: '미니 PC 24h 감시자',
        detail: paused
          ? '유지보수 모드(watchdog/off). 자동 기동이 일시 정지되었습니다.'
          : 'systemd 타이머가 20초마다 점검하며 무중단 복구 수행',
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

    const host = hostMetrics();

    return {
      ok: overallOf(checks) !== 'down',
      overall: overallOf(checks),
      generatedAt: new Date().toISOString(),
      site: '월덕 & 이지스크랩 미니 PC 관제',
      publicUrl: 'https://status.easy-scraping.com',
      paused,
      checks,
      containers: containerMap,
      dockerFleet, // 🐳 미니 PC 내 모든 도커 컨테이너 실시간 통계
      ssh: sshSessions, // 🔑 SSH 실시간 접속자 현황
      sshWhitelist: ufwWhitelist || [], // 🛡️ UFW SSH 포트 34567 허용 IP 목록
      ddns: {
        intervalSec: 10,
        records: ddnsRecords || []
      },
      host,        // 💻 미니 PC CPU, RAM, Disk, Load, Network
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
      events
    };
  }

  return { collectHealth, CONTAINERS };
}

module.exports = { createCollector };
