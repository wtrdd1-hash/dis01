/**
 * 숫자 및 한국 화폐 단위 포맷팅 함수 (BigInt & 무제한 대용량 화폐 지원)
 */
const {
  formatMoney,
  formatMoneyCompact,
  parseMoneyInput,
  parseAdminMoney,
  mulRate,
  mulPriceAmount,
  amountToUnits,
  unitsToAmountStr
} = require('./moneyScale');

function formatNumber(num) {
  try {
    if (typeof num === 'bigint') return num.toLocaleString('ko-KR');
    return BigInt(String(num || 0).split('.')[0]).toLocaleString('ko-KR');
  } catch {
    return (Number(num) || 0).toLocaleString('ko-KR');
  }
}

function formatPercent(rate) {
  const percent = Number(rate) || 0;
  if (percent > 0) {
    return `📈 +${percent.toFixed(2)}%`;
  } else if (percent < 0) {
    return `📉 ${percent.toFixed(2)}%`;
  } else {
    return `➖ 0.00%`;
  }
}

function formatTimeRemaining(ms) {
  if (ms <= 0) return '0초';
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}분 ${seconds}초`;
  }
  return `${seconds}초`;
}

const KST_TZ = 'Asia/Seoul';
const kstDateTimeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: KST_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

function parseDateAssumeUtc(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    return new Date(s.replace(' ', 'T') + 'Z');
  }
  return new Date(s);
}

function formatKstDateTime(value, withSeconds) {
  if (value == null || value === '') return '-';
  const showSeconds = withSeconds !== false;
  const d = parseDateAssumeUtc(value);
  if (Number.isNaN(d.getTime())) {
    const s = String(value).replace('T', ' ');
    return showSeconds ? s.slice(0, 19) : s.slice(0, 16);
  }
  const parts = {};
  for (const p of kstDateTimeFmt.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hm = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return showSeconds ? `${hm}:${parts.second}` : hm;
}

const { safeBigInt } = require('./money');

module.exports = {
  formatMoney,
  formatMoneyCompact,
  formatNumber,
  formatPercent,
  formatTimeRemaining,
  formatKstDateTime,
  parseMoneyInput,
  parseAdminMoney,
  mulRate,
  mulPriceAmount,
  amountToUnits,
  unitsToAmountStr,
  safeBigInt
};
