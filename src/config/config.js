process.env.TZ = 'Asia/Seoul';
const path = require('path');
const dotenv = require('dotenv');

// 프로젝트 루트의 .env 파일을 절대경로로 자동 탐색 및 로드
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config(); // CWD fallback

// 환경 변수에서 관리자 목록 파싱 (콤마 구분 또는 단일 ID 지원)
function parseAdminIds() {
  const raw = process.env.ADMIN_IDS || process.env.ADMIN_ID || '';
  return Array.from(new Set(
    raw.split(',')
      .map(id => id.trim())
      .filter(Boolean)
  ));
}

let combinedAdminIds = parseAdminIds();
if (combinedAdminIds.length === 0) {
  console.warn('[config] ADMIN_IDS가 비어 있어 관리자 기능이 비활성화됩니다.');
}

/**
 * 런타임에 관리자 목록을 다시 로드 (서버 재시작 없이 반영)
 * - DB의 admin_roles 테이블(있을 경우) + .env 의 ADMIN_IDS 합집합
 * - 관리자가 명령으로 자신을 추가/제거하는 경우 호출됨
 */
async function reloadAdminIds() {
  combinedAdminIds = parseAdminIds();
  try {
    const { pool } = require('../config/database');
    const [rows] = await pool.query("SELECT discord_id FROM admin_roles WHERE is_active = 1").catch(() => [[]]);
    if (Array.isArray(rows) && rows.length) {
      const dbIds = rows.map(r => String(r.discord_id || '')).filter(Boolean);
      combinedAdminIds = Array.from(new Set([...combinedAdminIds, ...dbIds]));
    }
  } catch (e) {
    // DB가 없거나 테이블이 없는 경우 무시 (.env만 사용)
  }
  return combinedAdminIds;
}

module.exports = {
  token: process.env.DISCORD_TOKEN || process.env.t,
  adminId: combinedAdminIds[0], // 이전 코드 호환용
  adminIds: combinedAdminIds,  // 전체 관리자 ID 배열
  reloadAdminIds,              // 런타임 재로드 (DB + .env 합집합)
  
  // 관리자 권한 검사 헬퍼
  isAdmin(userId) {
    if (userId === null || userId === undefined || userId === '') return false;
    // BigInt / Number / String / Object 모두 안전하게 문자열로 변환하여 비교
    let key;
    try {
      key = String(userId);
    } catch (e) {
      return false;
    }
    if (!key) return false;
    // adminIds는 reloadAdminIds() 호출 시 갱신되므로 실시간 반영됨
    return combinedAdminIds.includes(key);
  },

  initialBalance: 10000,   // 10,000원 기본 정착금 (기존 5만원에서 건전한 경제를 위해 조정)
  casinoMaxBet: 0,         // 0이면 1회 배팅 상한 없음 (65자리 MAX_MONEY만). 양/구 경제에서 100만 캡은 올인을 0원처럼 만듦
  maxPlayerCash: 0,        // 0이면 현금 보유 상한 없음 (65자리 MAX_MONEY만). 1억 캡은 당첨금을 조용히 버림
  dailyReward: 3000,       // 기본 출석 3,000원
  dailyStreakBonus: 200,   // 연속 출석 1일당 +200원 (최대 10일 연속 시 4,800원)
  workCooldownMinutes: 10, // 일하기 쿨타임 10분
  subsidyAmount: 2000,     // 생활 지원금 2,000원 (순자산 2만원 이하 유저 대상)
  subsidyCooldownMinutes: 1440, // 지원금 쿨타임 24시간 (1일 1회)
  bankInterestRate: (0.001 / 24) / 60, // 분당 분할 복리 지급 (하루 0.1%)
  port: parseInt(process.env.PORT || '8080', 10),

  getServerEnvBadge() {
    const isTest = 
      process.env.APP_ENV === 'test' || 
      process.env.NODE_ENV === 'test' || 
      (process.env.DB_NAME && process.env.DB_NAME.includes('test')) ||
      (process.env.WEB_PORT === '8085' || process.env.PORT === '8085');
    return isTest ? '🧪 [테스트 서버]' : '🚀 [본 서버]';
  },

  // 참고용. 실제 지급 수치는 src/utils/economyBalance.js 의 CLICKER 가 기준이다.
  clicker: {
    powerPerLevel: 10,
    upgradeCostPerLevel: 4500,
    critChance: 0.10,
    critMultiplier: 3,
    bonusTurnChance: 0.10,
    autoIncomePerLevel: 15,
    autoCostPerNextLevel: 12000,
    maxClicksPerRequest: 200
  },

  colors: {
    primary: 0xF59E0B
  },

  cookieSecret: process.env.COOKIE_SECRET || process.env.SESSION_SECRET || '',
  
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || process.env.GITHUB_CLIENT_ID || process.env.CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET || process.env.CLIENT_SECRET || '',
    redirectUri: process.env.DISCORD_REDIRECT_URI || process.env.REDIRECT_URI || 'https://easy-scraping.com/auth/discord/callback'
  },

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'account_user',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'accountax_db',
    timezone: '+09:00',
    waitForConnections: true,
    connectionLimit: 15,
    maxIdle: 10,
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    queueLimit: 0
  }
};
