'use strict';

const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 55 * 1000;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function parseLine(line) {
  try {
    const row = JSON.parse(line);
    if (!row || !row.ts) return null;
    const t = Date.parse(row.ts);
    if (!Number.isFinite(t)) return null;
    return { t, overall: row.overall || 'down', checks: row.checks || {} };
  } catch (_) {
    return null;
  }
}

function scoreOf(overall) {
  if (overall === 'ok') return 2;
  if (overall === 'degraded') return 1;
  return 0;
}

function downsample(rows, bucketMs, rangeMs) {
  const cutoff = Date.now() - rangeMs;
  const buckets = new Map();
  for (const row of rows) {
    if (row.t < cutoff) continue;
    const key = Math.floor(row.t / bucketMs) * bucketMs;
    const prev = buckets.get(key);
    const score = scoreOf(row.overall);
    if (!prev || score < prev.v) {
      buckets.set(key, { t: key, v: score, overall: row.overall });
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.t - b.t);
}

function uptimePct(rows, rangeMs) {
  const cutoff = Date.now() - rangeMs;
  const sliced = rows.filter((row) => row.t >= cutoff);
  if (!sliced.length) return null;
  const ok = sliced.filter((row) => row.overall === 'ok').length;
  return Math.round((ok / sliced.length) * 1000) / 10;
}

function createHistory(filePath) {
  let rows = [];
  let lastWrite = 0;

  function load() {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const cutoff = Date.now() - MAX_AGE_MS;
      rows = text
        .split(/\r?\n/)
        .map(parseLine)
        .filter(Boolean)
        .filter((row) => row.t >= cutoff);
    } catch (_) {
      rows = [];
    }
  }

  function persistTrimmed() {
    const cutoff = Date.now() - MAX_AGE_MS;
    rows = rows.filter((row) => row.t >= cutoff);
    ensureDir(filePath);
    const body = rows
      .map((row) =>
        JSON.stringify({
          ts: new Date(row.t).toISOString(),
          overall: row.overall,
          checks: row.checks
        })
      )
      .join('\n');
    fs.writeFileSync(filePath, body ? body + '\n' : '', 'utf8');
  }

  load();

  function record(health) {
    const now = Date.now();
    if (now - lastWrite < MIN_INTERVAL_MS) return;
    lastWrite = now;
    const checks = {};
    for (const item of health.checks || []) {
      checks[item.id] = item.level;
    }
    const row = { t: now, overall: health.overall || 'down', checks };
    rows.push(row);
    ensureDir(filePath);
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        ts: new Date(now).toISOString(),
        overall: row.overall,
        checks
      }) + '\n',
      'utf8'
    );
    if (rows.length % 200 === 0) persistTrimmed();
  }

  function snapshot() {
    const cutoff = Date.now() - MAX_AGE_MS;
    rows = rows.filter((row) => row.t >= cutoff);
    return {
      uptime24h: uptimePct(rows, 24 * 60 * 60 * 1000),
      uptime7d: uptimePct(rows, MAX_AGE_MS),
      h24: downsample(rows, 5 * 60 * 1000, 24 * 60 * 60 * 1000),
      d7: downsample(rows, 30 * 60 * 1000, MAX_AGE_MS),
      samples: rows.length
    };
  }

  return { record, snapshot, load };
}

module.exports = { createHistory };
