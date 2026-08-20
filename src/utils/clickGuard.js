'use strict';

/** 연속으로 같은 픽셀이 이 횟수를 넘으면 그 클릭은 지급하지 않는다. */
const SAME_PIXEL_MAX = 8;

function normalizeHits(raw, max) {
  if (!Array.isArray(raw)) return [];
  const cap = Math.min(raw.length, Math.max(0, Number(max) || 0));
  const out = [];
  for (let i = 0; i < cap; i++) {
    const x = Math.round(Number(raw[i] && raw[i].x));
    const y = Math.round(Number(raw[i] && raw[i].y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(x) > 8192 || Math.abs(y) > 8192) continue;
    out.push({ x, y });
  }
  return out;
}

function applySamePixelGuard(state, hits, maxPaid) {
  const next = {
    x: state && Number.isFinite(state.x) ? state.x : null,
    y: state && Number.isFinite(state.y) ? state.y : null,
    streak: state && Number(state.streak) > 0 ? Number(state.streak) : 0,
    at: Date.now()
  };
  let paid = 0;
  let dropped = 0;
  const limit = Math.min(hits.length, Math.max(0, Number(maxPaid) || 0));
  for (let i = 0; i < limit; i++) {
    const x = hits[i].x;
    const y = hits[i].y;
    if (next.x === x && next.y === y) next.streak += 1;
    else {
      next.x = x;
      next.y = y;
      next.streak = 1;
    }
    if (next.streak > SAME_PIXEL_MAX) dropped += 1;
    else paid += 1;
  }
  return { paid, dropped, state: next };
}

/** 한 계정당 동시에 채굴되는 창은 1개. 클릭이 끊기면 이 시간 후 다른 창이 이어받는다. */
const MINER_SLOT_MS = 2500;
const MINER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function normalizeMinerId(raw) {
  const id = String(raw || '').trim();
  return MINER_ID_RE.test(id) ? id : '';
}

function claimMinerSlot(slot, minerId, now) {
  const ts = Number(now) || Date.now();
  if (!minerId) {
    return { ok: false, reason: 'invalid', slot };
  }
  if (!slot || slot.id === minerId || ts > Number(slot.until || 0)) {
    return {
      ok: true,
      reason: null,
      slot: { id: minerId, until: ts + MINER_SLOT_MS, at: ts }
    };
  }
  return { ok: false, reason: 'window', slot };
}

module.exports = {
  SAME_PIXEL_MAX,
  MINER_SLOT_MS,
  normalizeHits,
  applySamePixelGuard,
  normalizeMinerId,
  claimMinerSlot
};
