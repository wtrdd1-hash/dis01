/**
 * 마인즈 · 플링코
 */
const HOUSE = 0.04;

function minesMultiplier(mines, revealed) {
  const m = Math.min(24, Math.max(1, Number(mines) || 5));
  const r = Math.max(0, Number(revealed) || 0);
  if (r <= 0) return 1;
  let mult = 1;
  for (let i = 0; i < r; i++) {
    const safeLeft = 25 - m - i;
    const totalLeft = 25 - i;
    if (safeLeft <= 0 || totalLeft <= 0) break;
    mult *= totalLeft / safeLeft;
  }
  return Math.max(1, Math.floor(mult * (1 - HOUSE) * 100) / 100);
}

function makeMineField(mines) {
  const m = Math.min(24, Math.max(1, Number(mines) || 5));
  const bombs = new Set();
  while (bombs.size < m) bombs.add(Math.floor(Math.random() * 25));
  return { mines: m, bombs: [...bombs] };
}

const PLINKO_ROWS = 12;
const PLINKO_MULT = {
  low: [8.8, 4.0, 2.5, 1.4, 1.1, 0.8, 0.7, 0.8, 1.1, 1.4, 2.5, 4.0, 8.8],
  med: [24.0, 8.0, 4.5, 1.8, 0.9, 0.6, 0.5, 0.6, 0.9, 1.8, 4.5, 8.0, 24.0],
  high: [55.0, 15.0, 6.0, 2.2, 0.7, 0.4, 0.3, 0.4, 0.7, 2.2, 6.0, 15.0, 55.0]
};

function dropPlinko(risk) {
  const key = PLINKO_MULT[risk] ? risk : 'med';
  const buckets = PLINKO_MULT[key];
  let pos = 0;
  const path = [];
  for (let i = 0; i < PLINKO_ROWS; i++) {
    const right = Math.random() < 0.5;
    if (right) pos += 1;
    path.push(right ? 1 : 0);
  }
  const idx = Math.min(buckets.length - 1, Math.max(0, pos));
  return {
    risk: key,
    path,
    bucket: idx,
    multiplier: buckets[idx],
    rows: PLINKO_ROWS
  };
}

module.exports = {
  minesMultiplier,
  makeMineField,
  dropPlinko,
  PLINKO_ROWS,
  PLINKO_MULT
};
