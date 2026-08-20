'use strict';

const fs = require('fs');
const path = require('path');
const { adminIdsFromEnv } = require('./env');

const REMINDER_MS = 15 * 60 * 1000;
const MIN_GAP_MS = 60 * 1000;

function criticalDown(health) {
  return (health.checks || []).filter((c) => c.critical && c.level === 'down').map((c) => c.name);
}

function degradedNames(health) {
  return (health.checks || [])
    .filter((c) => c.level === 'degraded' || (c.level === 'down' && !c.critical))
    .map((c) => c.name);
}

function loadState(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return { overall: null, lastSentAt: 0, lastReminderAt: 0, bootNotified: false };
  }
}

function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state), 'utf8');
}

async function discordJson(token, method, urlPath, body) {
  const res = await fetch('https://discord.com/api/v10' + urlPath, {
    method,
    headers: {
      Authorization: 'Bot ' + token,
      'Content-Type': 'application/json',
      'User-Agent': 'WtrddStatus (https://status.easy-scraping.com, 1.0)'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = {};
  }
  return { ok: res.ok, status: res.status, json };
}

async function sendChannel(token, channelId, payload) {
  if (!channelId) return false;
  const result = await discordJson(token, 'POST', '/channels/' + channelId + '/messages', payload);
  return result.ok;
}

async function sendDm(token, userId, payload) {
  const ch = await discordJson(token, 'POST', '/users/@me/channels', { recipient_id: String(userId) });
  if (!ch.ok || !ch.json.id) return false;
  const msg = await discordJson(token, 'POST', '/channels/' + ch.json.id + '/messages', payload);
  return msg.ok;
}

function embedPayload(title, description, color, fields) {
  return {
    embeds: [
      {
        title,
        description,
        color,
        url: 'https://status.easy-scraping.com',
        fields: fields || [],
        footer: { text: '월덕 상태 감시' },
        timestamp: new Date().toISOString()
      }
    ]
  };
}

function createAlerter({ envFileLoad, stateFile }) {
  async function notifyAll(env, payload) {
    const token = env.DISCORD_TOKEN || '';
    if (!token) return { sent: 0 };
    let sent = 0;
    const channelId = env.DISCORD_STATUS_CHANNEL_ID || env.DISCORD_ANNOUNCE_CHANNEL_ID || '';
    if (channelId && (await sendChannel(token, channelId, payload))) sent += 1;
    for (const adminId of adminIdsFromEnv(env)) {
      try {
        if (await sendDm(token, adminId, payload)) sent += 1;
      } catch (_) {
        /* 개별 DM 실패는 다음 관리자로 */
      }
    }
    return { sent };
  }

  async function maybeAlert(health) {
    const env = envFileLoad();
    const state = loadState(stateFile);
    const now = Date.now();
    if (health.paused) {
      state.overall = 'paused';
      saveState(stateFile, state);
      return;
    }

    if (!state.bootNotified) {
      state.bootNotified = true;
      saveState(stateFile, state);
      const payload = embedPayload(
        '월덕 상태 알림이 켜졌습니다',
        '서버가 꺼지거나 응답이 없으면 여기로 알려 드립니다.\n상태 페이지: https://status.easy-scraping.com',
        0x5865f2,
        [{ name: '현재', value: health.overall === 'ok' ? '정상' : health.overall, inline: true }]
      );
      const result = await notifyAll(env, payload);
      if (result.sent > 0) {
        process.stdout.write('[status] discord_boot_alert sent=' + result.sent + '\n');
      } else {
        process.stdout.write('[status] discord_boot_alert sent=0\n');
      }
    }

    const downs = criticalDown(health);
    const nextOverall = health.overall;
    const prev = state.overall;

    if (nextOverall === prev && nextOverall === 'ok') {
      return;
    }

    if (nextOverall === 'ok' && prev && prev !== 'ok') {
      if (now - state.lastSentAt < MIN_GAP_MS) return;
      state.overall = 'ok';
      state.lastSentAt = now;
      saveState(stateFile, state);
      await notifyAll(
        env,
        embedPayload('월덕 서비스가 복구되었습니다', '핵심 구성 요소가 다시 정상입니다.', 0x23a559, [
          { name: '상태 페이지', value: 'https://status.easy-scraping.com', inline: false }
        ])
      );
      return;
    }

    if (downs.length && prev !== 'down') {
      if (now - state.lastSentAt < MIN_GAP_MS) return;
      state.overall = 'down';
      state.lastSentAt = now;
      state.lastReminderAt = now;
      saveState(stateFile, state);
      await notifyAll(
        env,
        embedPayload(
          '월덕 서비스가 내려갔습니다',
          '감시자가 자동 기동을 시도합니다. 상태 페이지에서 확인하세요.',
          0xf23f42,
          [
            { name: '중단', value: downs.join(', ') || '핵심 서비스', inline: false },
            { name: '상태', value: 'https://status.easy-scraping.com', inline: false }
          ]
        )
      );
      return;
    }

    if (nextOverall === 'degraded' && prev === 'ok') {
      if (now - state.lastSentAt < MIN_GAP_MS) return;
      state.overall = 'degraded';
      state.lastSentAt = now;
      saveState(stateFile, state);
      await notifyAll(
        env,
        embedPayload('월덕 일부 구성 요소 주의', '서비스는 떠 있지만 일부가 불안정합니다.', 0xf0b232, [
          { name: '항목', value: degradedNames(health).join(', ') || '확인 필요', inline: false }
        ])
      );
      return;
    }

    if (downs.length && now - (state.lastReminderAt || 0) >= REMINDER_MS) {
      state.lastReminderAt = now;
      saveState(stateFile, state);
      await notifyAll(
        env,
        embedPayload('월덕 아직 복구되지 않았습니다', '15분이 지났는데도 핵심 서비스가 내려가 있습니다.', 0xf23f42, [
          { name: '중단', value: downs.join(', ') || '핵심 서비스', inline: false }
        ])
      );
    }
  }

  return { maybeAlert };
}

module.exports = { createAlerter };
