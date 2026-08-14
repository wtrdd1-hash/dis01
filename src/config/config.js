require('dotenv').config();

const defaultAdminIds = ['886478189520637992', '889085646768078850'];

// 환경 변수에서 관리자 목록 파싱 (콤마 구분 또는 단일 ID 지원)
const envAdminIds = (process.env.ADMIN_IDS || process.env.ADMIN_ID || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const combinedAdminIds = Array.from(new Set([...defaultAdminIds, ...envAdminIds]));

module.exports = {
  token: process.env.DISCORD_TOKEN || process.env.t,
  adminId: combinedAdminIds[0], // 이전 코드 호환용
  adminIds: combinedAdminIds,  // 전체 관리자 ID 배열
  
  // 관리자 권한 검사 헬퍼
  isAdmin(userId) {
    if (!userId) return false;
    return this.adminIds.includes(String(userId));
  },

  initialBalance: 10000,   // 10,000원 기본 정착금 (기존 5만원에서 건전한 경제를 위해 조정)
  dailyReward: 3000,       // 기본 출석 3,000원
  dailyStreakBonus: 500,   // 연속 출석 1일당 +500원 (최대 10일 연속 시 +5,000원 보너스)
  workCooldownMinutes: 10, // 일하기 쿨타임 10분
  subsidyAmount: 2000,     // 정기 생활 지원금 2,000원
  subsidyCooldownMinutes: 10, // 지원금 쿨타임 10분
  bankInterestRate: 0.005, // 은행 이자율 0.5% (과도한 인플레이션 방지)
  port: parseInt(process.env.PORT || '8080', 10),
  
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || process.env.GITHUB_CLIENT_ID || process.env.CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET || process.env.CLIENT_SECRET || '',
    redirectUri: process.env.DISCORD_REDIRECT_URI || process.env.REDIRECT_URI || 'https://easy-scraping.com/auth/discord/callback'
  },

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'account_user',
    password: process.env.DB_PASSWORD || 'Account2026!@#',
    database: process.env.DB_NAME || 'accountax_db',
    waitForConnections: true,
    connectionLimit: 15,
    maxIdle: 10,
    idleTimeout: 60000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    queueLimit: 0
  }
};
