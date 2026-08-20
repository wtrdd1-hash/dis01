'use strict';

const MONEY_UNITS = [
  { key: 'won', label: '원', exp: 0 },
  { key: 'man', label: '만', exp: 4 },
  { key: 'eok', label: '억', exp: 8 },
  { key: 'jo', label: '조', exp: 12 },
  { key: 'gyeong', label: '경', exp: 16 },
  { key: 'hae', label: '해', exp: 20 },
  { key: 'ja', label: '자', exp: 24 },
  { key: 'yang', label: '양', exp: 28 },
  { key: 'gu', label: '구', exp: 32 },
  { key: 'gan', label: '간', exp: 36 },
  { key: 'jeong', label: '정', exp: 40 },
  { key: 'jae', label: '재', exp: 44 },
  { key: 'geuk', label: '극', exp: 48 }
];

const MAX_MONEY_DIGITS = 65;
const MAX_MONEY = 10n ** BigInt(MAX_MONEY_DIGITS) - 1n;

function pow10(exp) {
  return 10n ** BigInt(exp);
}

function findUnit(name) {
  const key = String(name || '').trim();
  return MONEY_UNITS.find((u) => u.label === key || u.key === key) || null;
}

function parseCoefficient(raw) {
  const str = String(raw || '').trim().replace(/,/g, '');
  if (!str || !/^\d+(?:\.\d+)?$/.test(str)) return null;
  const [whole, frac = ''] = str.split('.');
  const digits = (whole.replace(/^0+(?=\d)/, '') || '0') + frac;
  return { value: BigInt(digits), frac: frac.length };
}

function scaleCoefficient(raw, exp) {
  const parsed = parseCoefficient(raw);
  if (!parsed) return null;
  if (exp >= parsed.frac) return parsed.value * pow10(exp - parsed.frac);
  return parsed.value / pow10(parsed.frac - exp);
}

function clampMoney(amount) {
  if (amount > MAX_MONEY) return MAX_MONEY;
  if (amount < -MAX_MONEY) return -MAX_MONEY;
  return amount;
}

function assertMoneyRange(amount, label) {
  if (amount > MAX_MONEY || amount < -MAX_MONEY) {
    const err = new Error(label || '금액이 허용 한도(65자리)를 넘습니다.');
    err.code = 'MONEY_OVERFLOW';
    throw err;
  }
  return amount;
}

function applyUnitToNumber(raw, unitName) {
  const unit = findUnit(unitName) || findUnit('원');
  const scaled = scaleCoefficient(raw, unit.exp);
  if (scaled === null) return null;
  return assertMoneyRange(scaled);
}

function parseMoneyInput(inputStr, balanceIfAll = null) {
  if (inputStr === null || inputStr === undefined) return null;
  const str = String(inputStr).trim().replace(/,/g, '').replace(/\s+/g, '').toLowerCase();
  if (!str) return null;
  if (['올인', '전체', '전량', '전액', 'all', 'max', '최대'].includes(str)) {
    return balanceIfAll !== null ? balanceIfAll : 'ALL';
  }
  if (/^[+-]?\d+$/.test(str)) {
    try {
      return assertMoneyRange(BigInt(str));
    } catch (e) {
      if (e && e.code === 'MONEY_OVERFLOW') throw e;
      return null;
    }
  }

  const unitNames = MONEY_UNITS.filter((u) => u.exp > 0).map((u) => u.label).join('|');
  const tokenRe = new RegExp('(\\d+(?:\\.\\d+)?)(' + unitNames + '|천)', 'g');
  let total = 0n;
  let matched = false;
  let m;
  while ((m = tokenRe.exec(str)) !== null) {
    matched = true;
    const label = m[2];
    if (label === '천') {
      total += scaleCoefficient(m[1], 3) || 0n;
    } else {
      const unit = findUnit(label);
      total += scaleCoefficient(m[1], unit ? unit.exp : 0) || 0n;
    }
  }
  const leftover = str
    .replace(new RegExp('(\\d+(?:\\.\\d+)?)(' + unitNames + '|천)', 'g'), '')
    .replace(/원/g, '')
    .replace(/[+\s]/g, '');
  if (leftover && /^\d+$/.test(leftover)) {
    matched = true;
    total += BigInt(leftover);
  } else if (leftover) {
    return null;
  }
  if (!matched || total <= 0n) return null;
  return assertMoneyRange(total);
}

function parseAdminMoney(amount, unitName) {
  const raw = String(amount || '').trim();
  if (!raw) return null;
  const plain = raw.replace(/,/g, '');
  if (unitName && unitName !== '원' && findUnit(unitName) && /^\d+(?:\.\d+)?$/.test(plain)) {
    return applyUnitToNumber(plain, unitName);
  }
  return parseMoneyInput(raw, 0n);
}

function mulRate(amount, rate, scaleDigits = 12) {
  const amt = typeof amount === 'bigint' ? amount : BigInt(String(amount || 0).split('.')[0] || 0);
  const rateNum = Number(rate);
  if (!Number.isFinite(rateNum) || rateNum === 0 || amt === 0n) return 0n;
  const scale = 10n ** BigInt(scaleDigits);
  const rateInt = BigInt(Math.round(rateNum * Number(scale)));
  return (amt * rateInt) / scale;
}

function amountToUnits(amount) {
  const str = String(amount ?? '0').replace(/,/g, '').trim();
  if (!str) return 0n;
  const sign = str.startsWith('-') ? -1n : 1n;
  const body = str.replace(/^[+-]/, '');
  if (!/^\d+(?:\.\d+)?$/.test(body)) return 0n;
  const [whole, frac = ''] = body.split('.');
  const frac4 = (frac + '0000').slice(0, 4);
  return sign * (BigInt(whole || '0') * 10000n + BigInt(frac4 || '0'));
}

function unitsToAmountStr(units) {
  const sign = units < 0n ? '-' : '';
  const abs = units < 0n ? -units : units;
  const whole = abs / 10000n;
  const frac = abs % 10000n;
  if (frac === 0n) return sign + whole.toString();
  return sign + whole.toString() + '.' + frac.toString().padStart(4, '0').replace(/0+$/, '');
}

function mulPriceAmount(price, amount) {
  const p = typeof price === 'bigint' ? price : BigInt(String(price || 0).split('.')[0] || 0);
  return (p * amountToUnits(amount)) / 10000n;
}

function formatUnitParts(amount) {
  let val = amount < 0n ? -amount : amount;
  const parts = [];
  for (let i = MONEY_UNITS.length - 1; i >= 1; i -= 1) {
    const unit = MONEY_UNITS[i];
    const base = pow10(unit.exp);
    const qty = val / base;
    if (qty > 0n) {
      parts.push(qty.toLocaleString('ko-KR') + unit.label);
      val %= base;
    }
  }
  if (val > 0n || parts.length === 0) {
    parts.push(val.toLocaleString('ko-KR') + (parts.length ? '' : '원'));
  }
  return parts;
}

function formatMoney(num) {
  let val = 0n;
  try {
    val = typeof num === 'bigint' ? num : BigInt(String(num || 0).split('.')[0]);
  } catch (e) {
    val = 0n;
  }
  const sign = val < 0n ? '-' : '';
  const absVal = val < 0n ? -val : val;
  const comma = absVal.toLocaleString('ko-KR') + '원';
  if (absVal < 10000n) return sign + comma;
  return sign + comma + ' (' + sign + formatUnitParts(absVal).join(' ') + ')';
}

function formatMoneyCompact(num) {
  let val = 0n;
  try {
    val = typeof num === 'bigint' ? num : BigInt(String(num || 0).split('.')[0]);
  } catch (e) {
    val = 0n;
  }
  const sign = val < 0n ? '-' : '';
  const absVal = val < 0n ? -val : val;
  if (absVal < 10000n) return sign + absVal.toLocaleString('ko-KR') + '원';
  return sign + formatUnitParts(absVal).join(' ');
}

/**
 * 🔢 자릿수 분할 저장 (Chunked Multi-tier Digits)
 * 큰 금액(BigInt)을 16자리(1경) 단위의 안전한 청크 배열로 분할하여
 * 데이터베이스나 메모리에서 오버플로우 없이 무제한 자릿수를 완벽 저장/복원
 */
const CHUNK_DIGITS = 16n;
const CHUNK_BASE = 10n ** CHUNK_DIGITS;

function splitMoneyChunks(amount) {
  let val = typeof amount === 'bigint' ? amount : BigInt(String(amount || 0).split('.')[0] || 0);
  const isNegative = val < 0n;
  if (isNegative) val = -val;

  const chunks = [];
  if (val === 0n) {
    chunks.push(0n);
  } else {
    while (val > 0n) {
      chunks.push(val % CHUNK_BASE);
      val /= CHUNK_BASE;
    }
  }

  return {
    isNegative,
    chunks: chunks.map(c => c.toString()), // JSON 및 DB 안전 문자열 배열
    digitCount: chunks.length
  };
}

function mergeMoneyChunks(chunkObj) {
  if (!chunkObj || !Array.isArray(chunkObj.chunks)) return 0n;
  let result = 0n;
  let multiplier = 1n;

  for (const chunkStr of chunkObj.chunks) {
    const chunkVal = BigInt(String(chunkStr || 0));
    result += chunkVal * multiplier;
    multiplier *= CHUNK_BASE;
  }

  if (chunkObj.isNegative) {
    result = -result;
  }

  return clampMoney(result);
}

/**
 * 🛡️ 오버플로우 원천 차단 안전 연산자
 */
function safeAdd(a, b) {
  const x = typeof a === 'bigint' ? a : BigInt(String(a || 0).split('.')[0] || 0);
  const y = typeof b === 'bigint' ? b : BigInt(String(b || 0).split('.')[0] || 0);
  const sum = x + y;
  return clampMoney(sum);
}

function safeSub(a, b, allowNegative = false) {
  const x = typeof a === 'bigint' ? a : BigInt(String(a || 0).split('.')[0] || 0);
  const y = typeof b === 'bigint' ? b : BigInt(String(b || 0).split('.')[0] || 0);
  const diff = x - y;
  if (!allowNegative && diff < 0n) return 0n;
  return clampMoney(diff);
}

function safeMul(a, b) {
  const x = typeof a === 'bigint' ? a : BigInt(String(a || 0).split('.')[0] || 0);
  const y = typeof b === 'bigint' ? b : BigInt(String(b || 0).split('.')[0] || 0);
  const prod = x * y;
  return clampMoney(prod);
}

module.exports = {
  MONEY_UNITS,
  MAX_MONEY,
  MAX_MONEY_DIGITS,
  findUnit,
  clampMoney,
  assertMoneyRange,
  applyUnitToNumber,
  parseMoneyInput,
  parseAdminMoney,
  mulRate,
  amountToUnits,
  unitsToAmountStr,
  mulPriceAmount,
  formatMoney,
  formatMoneyCompact,
  formatUnitParts,
  splitMoneyChunks,
  mergeMoneyChunks,
  safeAdd,
  safeSub,
  safeMul
};
