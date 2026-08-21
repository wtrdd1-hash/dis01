'use strict';

const { execFile } = require('child_process');

const ALLOWED_LOG_CONTAINERS = new Set([
  'wtrdd-discord-app',
  'wtrdd-edge-proxy',
  'wtrdd-cloudflared',
  'wtrdd-autoheal'
]);

function execFileText(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1024 * 512 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        code: err && typeof err.code === 'number' ? err.code : 0
      });
    });
  });
}

async function inspectContainer(name) {
  const result = await execFileText('docker', ['inspect', '--format', '{{json .}}', name], 4000);
  if (!result.ok || !result.stdout.trim()) {
    return { exists: false, running: false, health: 'missing', status: '없음', restartCount: 0 };
  }
  try {
    const info = JSON.parse(result.stdout);
    const state = info.State || {};
    const health = (state.Health && state.Health.Status) || (state.Running ? 'running' : 'stopped');
    return {
      exists: true,
      running: Boolean(state.Running),
      health,
      status: state.Status || health,
      startedAt: state.StartedAt || null,
      finishedAt: state.FinishedAt || null,
      exitCode: typeof state.ExitCode === 'number' ? state.ExitCode : null,
      restartCount: Number(info.RestartCount || 0)
    };
  } catch (_) {
    return { exists: false, running: false, health: 'unknown', status: '파싱 실패', restartCount: 0 };
  }
}

function dockerInfoOk() {
  return execFileText('docker', ['info', '-f', '{{.ServerVersion}}'], 4000).then((r) => ({
    ok: r.ok,
    version: r.ok ? r.stdout.trim() : null
  }));
}

/**
 * 🐳 미니 PC 내 모든 도커 컨테이너 및 실시간 리소스(CPU, RAM, Net, IO) 조회
 */
async function getAllDockerFleet() {
  const [psRes, statsRes] = await Promise.all([
    execFileText('docker', ['ps', '-a', '--format', '{{json .}}'], 4000),
    execFileText('docker', ['stats', '--no-stream', '--format', '{{json .}}'], 5000)
  ]);

  const statsMap = new Map();
  if (statsRes.ok && statsRes.stdout) {
    const lines = statsRes.stdout.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line.trim());
        const name = item.Name || item.Container || '';
        if (name) statsMap.set(name, item);
      } catch (_) {}
    }
  }

  const containers = [];
  if (psRes.ok && psRes.stdout) {
    const lines = psRes.stdout.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line.trim());
        const name = c.Names || c.Name || '';
        const stats = statsMap.get(name) || {};
        
        let cpuPct = parseFloat(stats.CPUPerc || '0') || 0;
        let memPct = parseFloat(stats.MemPerc || '0') || 0;
        let memUsage = stats.MemUsage || '-';
        let netIO = stats.NetIO || '-';
        let blockIO = stats.BlockIO || '-';
        let pids = stats.PIDs || '-';

        const isRunning = (c.State || '').toLowerCase() === 'running' || (c.Status || '').toLowerCase().startsWith('up');
        const isHealthy = (c.Status || '').includes('(healthy)');
        const isUnhealthy = (c.Status || '').includes('(unhealthy)');

        let healthStatus = 'running';
        if (isHealthy) healthStatus = 'healthy';
        else if (isUnhealthy) healthStatus = 'unhealthy';
        else if (!isRunning) healthStatus = 'stopped';

        containers.push({
          id: c.ID || '',
          name,
          image: c.Image || '',
          state: c.State || (isRunning ? 'running' : 'stopped'),
          status: c.Status || '',
          health: healthStatus,
          ports: c.Ports || '',
          createdAt: c.CreatedAt || '',
          running: isRunning,
          cpuPercent: cpuPct,
          cpuPercentText: stats.CPUPerc || (isRunning ? '0.0%' : '0%'),
          memPercent: memPct,
          memPercentText: stats.MemPerc || '0%',
          memUsageText: memUsage,
          netIOText: netIO,
          blockIOText: blockIO,
          pidsText: pids
        });
      } catch (_) {}
    }
  }

  containers.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return containers;
}

async function containerLogs(name, tail) {
  if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
    return { ok: false, lines: [], error: '잘못된 컨테이너 이름' };
  }
  const n = Math.min(300, Math.max(20, Number(tail) || 120));
  const result = await execFileText('docker', ['logs', '--tail', String(n), '--timestamps', name], 8000);
  const text = (result.stdout || '') + (result.stderr || '');
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-n);
  return { ok: result.ok || lines.length > 0, lines };
}

module.exports = {
  ALLOWED_LOG_CONTAINERS,
  execFileText,
  inspectContainer,
  dockerInfoOk,
  getAllDockerFleet,
  containerLogs
};
