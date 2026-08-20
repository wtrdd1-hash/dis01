'use strict';

function safeBigInt(val) {
  if (val === null || val === undefined || val === '') return 0n;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return 0n;
    return BigInt(Math.trunc(val));
  }
  const cleaned = String(val).trim().replace(/[,원\s]/g, '');
  if (!cleaned) return 0n;
  if (/^[+-]?\d+$/.test(cleaned)) {
    try { return BigInt(cleaned); } catch (_) { return 0n; }
  }
  if (/^[+-]?\d+\.\d+$/.test(cleaned)) {
    try { return BigInt(cleaned.split('.')[0]); } catch (_) { return 0n; }
  }
  if (/^[+-]?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(cleaned)) {
    const num = Number(cleaned);
    if (Number.isFinite(num)) return BigInt(Math.trunc(num));
  }
  return 0n;
}

module.exports = { safeBigInt };
