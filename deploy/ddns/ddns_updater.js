'use strict';

const fs = require('fs');
const path = require('path');

const CHECK_INTERVAL_MS = parseInt(process.env.DDNS_INTERVAL_MS || '10000', 10);
const ZONE_ID = process.env.CF_ZONE_ID || '';
const API_KEY = process.env.CF_GLOBAL_API_KEY || process.env.CF_API_KEY || '';
const EMAIL = process.env.CF_EMAIL || '';
const TARGET_DOMAINS = (process.env.DDNS_DOMAINS || 'ssh.easy-scraping.com,mini.easy-scraping.com,direct.easy-scraping.com').split(',').map(s => s.trim()).filter(Boolean);
const LOG_FILE = process.env.DDNS_LOG_FILE || path.join(process.cwd(), 'logs', 'ddns.log');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const ADMIN_IDS = (process.env.ADMIN_IDS || process.env.ADMIN_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_MINE_WEBHOOK_URL || '';

let lastKnownIp = null;

function log(msg) {
  const ts = new Date().toISOString();
  const line = '[' + ts + '] [DDNS] ' + msg;
  console.log(line);
  try {
    const logDir = path.dirname(LOG_FILE);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (err) {
    console.error('[' + ts + '] [DDNS LOG ERROR] ' + err.message);
  }
}

async function sendDiscordNotification(oldIp, newIp, results) {
  const kstTime = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19) + ' KST';
  const domainStatusList = (results || []).map(r => '• **' + r.domain + '** : ' + (r.success ? '✅ 성공' : '❌ 실패 (' + r.error + ')')).join('\n');
  const embed = {
    title: '🌐 [DDNS] 미니PC 공인 IP 변경 및 DNS 자동 갱신 알림',
    color: 0x3498db,
    fields: [
      { name: '이전 IP', value: '```' + (oldIp || '최초 감지') + '```', inline: true },
      { name: '신규 IP', value: '```' + newIp + '```', inline: true },
      { name: 'SSH 접속 주소', value: '`ssh -p 34567 wtrdd@ssh.easy-scraping.com`', inline: false },
      { name: '도메인 갱신 현황', value: domainStatusList || '없음', inline: false }
    ],
    footer: { text: '감지 주기: ' + (CHECK_INTERVAL_MS / 1000) + '초 | ' + kstTime }
  };

  if (DISCORD_WEBHOOK_URL) {
    try {
      await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
      });
      log('Discord notification sent via Webhook.');
    } catch (e) {
      log('Failed to send Discord webhook: ' + e.message);
    }
  }

  if (DISCORD_TOKEN && ADMIN_IDS.length > 0) {
    for (const adminId of ADMIN_IDS) {
      try {
        const dmRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
          method: 'POST',
          headers: {
            Authorization: 'Bot ' + DISCORD_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ recipient_id: adminId })
        });
        if (dmRes.ok) {
          const dmChannel = await dmRes.json();
          await fetch('https://discord.com/api/v10/channels/' + dmChannel.id + '/messages', {
            method: 'POST',
            headers: {
              Authorization: 'Bot ' + DISCORD_TOKEN,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ embeds: [embed] })
          });
          log('Discord DM sent to Admin ' + adminId);
        }
      } catch (e) {
        log('Failed to send Discord DM to ' + adminId + ': ' + e.message);
      }
    }
  }
}

async function fetchCurrentPublicIp() {
  const jsonProviders = [
    'https://api.ipify.org?format=json',
    'https://api.seeip.org/jsonip',
    'https://ipinfo.io/json'
  ];
  for (const url of jsonProviders) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const ip = (data.ip || '').trim();
        if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip;
      }
    } catch (e) {}
  }
  const textProviders = ['https://icanhazip.com', 'https://ifconfig.me/ip', 'https://checkip.amazonaws.com'];
  for (const url of textProviders) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const text = (await res.text()).trim();
        if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)) return text;
      }
    } catch (e) {}
  }
  throw new Error('All IP detection providers failed.');
}

async function syncCloudflareDns(newIp) {
  const headers = {
    'X-Auth-Email': EMAIL,
    'X-Auth-Key': API_KEY,
    'Content-Type': 'application/json'
  };
  const listRes = await fetch('https://api.cloudflare.com/client/v4/zones/' + ZONE_ID + '/dns_records?type=A', { headers });
  if (!listRes.ok) {
    const body = await listRes.text();
    throw new Error('Failed to list DNS records: ' + listRes.status + ' ' + body);
  }
  const listData = await listRes.json();
  const existingRecords = listData.result || [];
  const results = [];
  for (const domain of TARGET_DOMAINS) {
    const existing = existingRecords.find(r => r.name === domain);
    if (existing) {
      if (existing.content === newIp && existing.proxied === false) {
        log(domain + ' is already pointing to ' + newIp + ' (proxied: false).');
        results.push({ domain, success: true, changed: false });
        continue;
      }
      log('Updating ' + domain + ': ' + existing.content + ' -> ' + newIp);
      const updateRes = await fetch('https://api.cloudflare.com/client/v4/zones/' + ZONE_ID + '/dns_records/' + existing.id, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ type: 'A', name: domain, content: newIp, ttl: 1, proxied: false })
      });
      const updateData = await updateRes.json();
      if (!updateData.success) {
        const errMsg = JSON.stringify(updateData.errors);
        log('ERROR updating ' + domain + ': ' + errMsg);
        results.push({ domain, success: false, error: errMsg });
      } else {
        log('SUCCESS: ' + domain + ' updated to ' + newIp);
        results.push({ domain, success: true, changed: true });
      }
    } else {
      log('Creating ' + domain + ' -> ' + newIp);
      const createRes = await fetch('https://api.cloudflare.com/client/v4/zones/' + ZONE_ID + '/dns_records', {
        method: 'POST',
        headers,
        body: JSON.stringify({ type: 'A', name: domain, content: newIp, ttl: 1, proxied: false })
      });
      const createData = await createRes.json();
      if (!createData.success) {
        const errMsg = JSON.stringify(createData.errors);
        log('ERROR creating ' + domain + ': ' + errMsg);
        results.push({ domain, success: false, error: errMsg });
      } else {
        log('SUCCESS: ' + domain + ' created pointing to ' + newIp);
        results.push({ domain, success: true, changed: true });
      }
    }
  }
  return results;
}

async function checkAndUpdate() {
  try {
    const currentIp = await fetchCurrentPublicIp();
    if (currentIp !== lastKnownIp) {
      const oldIp = lastKnownIp;
      log('IP change detected (Old: ' + (oldIp || 'None') + ', New: ' + currentIp + ')');
      const results = await syncCloudflareDns(currentIp);
      lastKnownIp = currentIp;
      if (oldIp !== null) {
        await sendDiscordNotification(oldIp, currentIp, results);
      }
    }
  } catch (err) {
    log('Cycle failed: ' + err.message);
  }
}

async function main() {
  log('DDNS Updater started. Check interval: ' + (CHECK_INTERVAL_MS / 1000) + 's, Target domains: ' + TARGET_DOMAINS.join(', '));
  await checkAndUpdate();
  setInterval(checkAndUpdate, CHECK_INTERVAL_MS);
}

main();