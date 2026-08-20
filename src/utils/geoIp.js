const geoip = require('geoip-lite');

// 국가 코드 -> 한국어 국가명 & 국기 이모지 매핑
const COUNTRY_MAP = {
  KR: { name: '대한민국', flag: '🇰🇷' },
  US: { name: '미국', flag: '🇺🇸' },
  JP: { name: '일본', flag: '🇯🇵' },
  CN: { name: '중국', flag: '🇨🇳' },
  HK: { name: '홍콩', flag: '🇭🇰' },
  TW: { name: '대만', flag: '🇹🇼' },
  GB: { name: '영국', flag: '🇬🇧' },
  DE: { name: '독일', flag: '🇩🇪' },
  FR: { name: '프랑스', flag: '🇫🇷' },
  CA: { name: '캐나다', flag: '🇨🇦' },
  AU: { name: '호주', flag: '🇦🇺' },
  SG: { name: '싱가포르', flag: '🇸🇬' },
  VN: { name: '베트남', flag: '🇻🇳' },
  TH: { name: '태국', flag: '🇹🇭' },
  PH: { name: '필리핀', flag: '🇵🇭' },
  RU: { name: '러시아', flag: '🇷🇺' },
  NL: { name: '네덜란드', flag: '🇳🇱' },
  BR: { name: '브라질', flag: '🇧🇷' },
  IN: { name: '인도', flag: '🇮🇳' },
  SE: { name: '스웨덴', flag: '🇸🇪' },
  CH: { name: '스위스', flag: '🇨🇭' }
};

// 2글자 ISO 코드로 국기 이모지 생성
function getFlagEmoji(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  if (COUNTRY_MAP[countryCode.toUpperCase()]) return COUNTRY_MAP[countryCode.toUpperCase()].flag;
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

// IP 정제 (IPv6 접두사 제거, 로컬 IP 검사)
function cleanIp(rawIp) {
  if (!rawIp) return '127.0.0.1';
  let ip = String(rawIp).trim();
  if (ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') {
    ip = '127.0.0.1';
  }
  return ip;
}

// 사설/로컬/도커 브리지 IP 여부 검사
function isLocalIp(ip) {
  const v = cleanIp(ip);
  if (!v || v === 'unknown') return false;
  if (v === '127.0.0.1' || v === 'localhost' || v === '::1' || v === '0.0.0.0') return true;
  if (v.startsWith('10.') || v.startsWith('192.168.') || v.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(v)) return true;
  const lower = v.toLowerCase();
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')) return true;
  return false;
}

function isValidIp(rawIp) {
  if (!rawIp) return false;
  const ip = cleanIp(rawIp);
  if (!ip || ip === 'unknown') return false;
  if (ip === 'localhost' || ip === '127.0.0.1') return true;
  const v4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
  if (v4.test(ip)) return true;
  if (ip.includes(':') && /^[0-9a-fA-F:]+$/.test(ip)) return true;
  return false;
}

const ipCache = new Map();

/**
 * IP 주소의 국가 및 상세 지리 정보 조회
 */
function lookupIp(rawIp) {
  const ip = cleanIp(rawIp);

  if (ipCache.has(ip)) {
    return ipCache.get(ip);
  }

  if (isLocalIp(ip)) {
    const localInfo = {
      ip,
      country: 'LOCAL',
      countryName: '로컬/내부망',
      flag: '🏠',
      city: '내부망',
      timezone: 'Asia/Seoul'
    };
    ipCache.set(ip, localInfo);
    return localInfo;
  }

  try {
    const geo = geoip.lookup(ip);
    if (geo && geo.country) {
      const code = geo.country.toUpperCase();
      const mapped = COUNTRY_MAP[code];
      const result = {
        ip,
        country: code,
        countryName: mapped ? mapped.name : code,
        flag: getFlagEmoji(code),
        city: geo.city || '',
        timezone: geo.timezone || ''
      };
      // 캐시 최대 10,000개 유지
      if (ipCache.size > 10000) ipCache.clear();
      ipCache.set(ip, result);
      return result;
    }
  } catch (err) {
    // lookup fail fallback
  }

  const unknownResult = {
    ip,
    country: 'UNKNOWN',
    countryName: '알 수 없음',
    flag: '🌐',
    city: '',
    timezone: ''
  };
  ipCache.set(ip, unknownResult);
  return unknownResult;
}

module.exports = {
  cleanIp,
  lookupIp,
  getFlagEmoji,
  isLocalIp,
  isValidIp
};
