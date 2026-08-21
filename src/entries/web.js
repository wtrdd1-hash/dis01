'use strict';
process.env.TZ = 'Asia/Seoul';

const { initDatabase } = require('../config/database');
const { startWebServer } = require('../web/server');
const { logInfo, logError } = require('../utils/logger');
require('../web/autoRefreshPatch');

async function runWeb() {
  logInfo('WebEntry', '🚀 Web/API 서버 프로세스 시작 중...');
  try {
    await initDatabase();
    logInfo('WebEntry', '✅ 데이터베이스 초기화 및 마이그레이션 확인 완료');
  } catch (err) {
    logError('WebEntry', '❌ 데이터베이스 연결/초기화 실패', err);
    process.exit(1);
  }

  try {
    const serverInstance = startWebServer(null);
    logInfo('WebEntry', '✨ Web/API 서버가 성공적으로 가동되었습니다.');
    return serverInstance;
  } catch (err) {
    logError('WebEntry', '❌ Web/API 서버 실행 실패', err);
    process.exit(1);
  }
}

if (require.main === module) {
  runWeb();
}

module.exports = { runWeb };
