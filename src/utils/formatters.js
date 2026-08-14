/**
 * 숫자 및 한국 화폐 단위 포맷팅 함수 (BigInt & 무제한 대용량 화폐 지원)
 */
function formatMoney(num) {
  let val;
  try {
    if (typeof num === 'bigint') {
      val = num;
    } else {
      val = BigInt(String(num || 0).split('.')[0]);
    }
  } catch (e) {
    val = 0n;
  }

  const sign = val < 0n ? '-' : '';
  const absVal = val < 0n ? -val : val;

  const formattedComma = absVal.toLocaleString('ko-KR') + '원';

  if (absVal < 10000n) {
    return `${sign}${formattedComma}`;
  }

  const gyeong = absVal / 10000000000000000n; // 10^16 (경)
  const remGyeong = absVal % 10000000000000000n;

  const jo = remGyeong / 1000000000000n;       // 10^12 (조)
  const remJo = remGyeong % 1000000000000n;

  const eok = remJo / 100000000n;              // 10^8 (억)
  const remEok = remJo % 100000000n;

  const man = remEok / 10000n;                 // 10^4 (만)
  const remainder = remEok % 10000n;

  const unitParts = [];
  if (gyeong > 0n) unitParts.push(`${gyeong.toLocaleString('ko-KR')}경`);
  if (jo > 0n) unitParts.push(`${jo.toLocaleString('ko-KR')}조`);
  if (eok > 0n) unitParts.push(`${eok.toLocaleString('ko-KR')}억`);
  if (man > 0n) unitParts.push(`${man.toLocaleString('ko-KR')}만`);
  if (remainder > 0n) unitParts.push(`${remainder.toLocaleString('ko-KR')}`);

  const unitStr = unitParts.join(' ');
  return `${sign}${formattedComma} (${sign}${unitStr}원)`;
}

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

/**
 * 텍스트 단위 입력(예: 5만, 1.5만, 1억, 5천, 10000, 올인)을 BigInt 금액으로 파싱하는 함수
 */
function parseMoneyInput(inputStr, balanceIfAll = null) {
  if (!inputStr) return null;
  const str = inputStr.toString().trim().replace(/,/g, '').toLowerCase();

  if (['올인', '전체', '전량', 'all'].includes(str)) {
    return balanceIfAll !== null ? balanceIfAll : 'ALL';
  }

  if (/^\d+$/.test(str)) {
    try {
      return BigInt(str);
    } catch {
      return null;
    }
  }

  const regex = /^(?:(\d+(?:\.\d+)?)경)?(?:(\d+(?:\.\d+)?)조)?(?:(\d+(?:\.\d+)?)억)?(?:(\d+(?:\.\d+)?)만)?(?:(\d+(?:\.\d+)?)천)?(?:(\d+))?원?$/;
  const match = str.match(regex);
  if (!match) return null;

  const [, gyeong, jo, eok, man, cheon, won] = match;
  let total = 0n;

  if (gyeong) total += BigInt(Math.floor(parseFloat(gyeong) * 1e16));
  if (jo) total += BigInt(Math.floor(parseFloat(jo) * 1e12));
  if (eok) total += BigInt(Math.floor(parseFloat(eok) * 1e8));
  if (man) total += BigInt(Math.floor(parseFloat(man) * 1e4));
  if (cheon) total += BigInt(Math.floor(parseFloat(cheon) * 1e3));
  if (won) total += BigInt(parseInt(won, 10));

  return total > 0n ? total : null;
}

module.exports = {
  formatMoney,
  formatNumber,
  formatPercent,
  formatTimeRemaining,
  parseMoneyInput
};

