'use strict';

const { execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const WHITELIST_FILE = process.env.SSH_WHITELIST_FILE || path.join(__dirname, '../data/ssh_whitelist.json');

function execText(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        code: err && typeof err.code === 'number' ? err.code : 0
      });
    });
  });
}

function loadSavedWhitelist() {
  try {
    if (fs.existsSync(WHITELIST_FILE)) {
      return JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf8'));
    }
  } catch (_) {}
  return [];
}

function saveWhitelistFile(list) {
  try {
    const dir = path.dirname(WHITELIST_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(WHITELIST_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (_) {}
}

async function getSshWhitelist() {
  const saved = loadSavedWhitelist();
  const ufwRes = await execText('sudo', ['ufw', 'status', 'numbered']);
  const ufwRules = [];

  if (ufwRes.ok && ufwRes.stdout) {
    const lines = ufwRes.stdout.split('\n');
    for (const line of lines) {
      if (line.includes('34567') || line.includes('22')) {
        const match = line.match(/\[\s*(\d+)\]\s+(.*?)\s+(ALLOW(?:\s+IN)?)\s+(\S+)(?:\s+#\s*(.*))?/i);
        if (match) {
          ufwRules.push({
            num: Number(match[1]),
            to: match[2].trim(),
            action: match[3].trim(),
            from: match[4].trim(),
            comment: (match[5] || '').trim()
          });
        }
      }
    }
  }

  return {
    saved,
    ufwRules,
    ufwRaw: ufwRes.stdout
  };
}

async function addSshWhitelist(ipInput, commentInput) {
  const ip = String(ipInput || '').trim();
  const comment = String(commentInput || 'Status-Admin').trim().replace(/[^a-zA-Z0-9_\-\.\s]/g, '');

  if (!ip || (!net.isIP(ip) && !ip.includes('/'))) {
    return { ok: false, error: '유효한 IPv4 / IPv6 주소 또는 CIDR 대역이 아닙니다.' };
  }

  const res34567 = await execText('sudo', ['ufw', 'allow', 'from', ip, 'to', 'any', 'port', '34567', 'proto', 'tcp', 'comment', comment]);
  
  const saved = loadSavedWhitelist();
  const exists = saved.find(item => item.ip === ip);
  if (!exists) {
    saved.push({
      ip,
      comment,
      addedAt: new Date().toISOString(),
      addedBy: 'Admin'
    });
    saveWhitelistFile(saved);
  }

  return {
    ok: res34567.ok || (res34567.stdout && res34567.stdout.includes('added')),
    message: `${ip} (포트 34567) 화이트리스트에 성공적으로 추가되었습니다.`,
    stdout: res34567.stdout
  };
}

async function removeSshWhitelist(ipInput) {
  const ip = String(ipInput || '').trim();
  if (!ip) return { ok: false, error: '삭제할 IP를 지정하세요.' };

  const res = await execText('sudo', ['ufw', 'delete', 'allow', 'from', ip, 'to', 'any', 'port', '34567', 'proto', 'tcp']);

  let saved = loadSavedWhitelist();
  saved = saved.filter(item => item.ip !== ip);
  saveWhitelistFile(saved);

  return {
    ok: true,
    message: `${ip} 화이트리스트가 삭제되었습니다.`,
    stdout: res.stdout
  };
}

function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp && typeof cfIp === 'string') return cfIp.trim();

  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }

  const realIp = req.headers['x-real-ip'];
  if (realIp && typeof realIp === 'string') return realIp.trim();

  return (req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

module.exports = {
  getSshWhitelist,
  addSshWhitelist,
  removeSshWhitelist,
  getClientIp
};
