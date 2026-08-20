'use strict';

const fs = require('fs');

function loadEnvFile(filePath) {
  const out = {};
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx < 1) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch (_) {
    /* 비밀값 없이 일부 점검만 해도 된다 */
  }
  return out;
}

function adminIdsFromEnv(env) {
  const fromEnv = String(env.ADMIN_IDS || env.ADMIN_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const defaults = ['886478189520637992', '889085646768078850'];
  return Array.from(new Set([...defaults, ...fromEnv]));
}

function isAdminId(env, userId) {
  return adminIdsFromEnv(env).includes(String(userId || ''));
}

module.exports = { loadEnvFile, adminIdsFromEnv, isAdminId };
