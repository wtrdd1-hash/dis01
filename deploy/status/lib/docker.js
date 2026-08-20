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

async function containerLogs(name, tail) {
  if (!ALLOWED_LOG_CONTAINERS.has(name)) {
    return { ok: false, lines: [], error: '허용되지 않은 컨테이너' };
  }
  const n = Math.min(200, Math.max(20, Number(tail) || 120));
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
  containerLogs
};
