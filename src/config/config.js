require('dotenv').config();

module.exports = {
  token: process.env.DISCORD_TOKEN || process.env.t,
  adminId: process.env.ADMIN_ID || '886478189520637992',
  initialBalance: 50000,   // 50,000원 기본 지급
  dailyReward: 10000,      // 기본 출석 1만원
  dailyStreakBonus: 2000,  // 연속 출석 일당 +2000원
  workCooldownMinutes: 10,  // 일하기 쿨타임 10분
  subsidyAmount: 5000,      // 지원금 수령액 5000원
  subsidyCooldownMinutes: 5, // 지원금 쿨타임 5분
  bankInterestRate: 0.015,  // 은행 턴당/일당 이자 1.5%
  port: parseInt(process.env.PORT || '8080', 10),
  
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || process.env.GITHUB_CLIENT_ID || process.env.CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || process.env.GITHUB_CLIENT_SECRET || process.env.CLIENT_SECRET || '',
    redirectUri: process.env.DISCORD_REDIRECT_URI || process.env.REDIRECT_URI || 'http://localhost:8080/auth/discord/callback'
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

