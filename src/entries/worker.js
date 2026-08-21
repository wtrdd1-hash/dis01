'use strict';
process.env.TZ = 'Asia/Seoul';

const { initDatabase } = require('../config/database');
const { logInfo, logError } = require('../utils/logger');
const { startStockEngine, setMarketRegime } = require('../utils/stockEngine');
const { startBankEngine } = require('../utils/bankEngine');
const { startAutoMiner } = require('../utils/autoMiner');
const { startBusinessEngine } = require('../utils/businessEngine');
const { startEconomySupplyMonitor } = require('../utils/economySupplyMonitor');
const { startAutoBalancer } = require('../utils/economyBalancer');
const { startAutoBackupScheduler } = require('../utils/backupEngine');

async function runWorker(discordClient = null) {
  logInfo('WorkerEntry', '⚙️ Background Worker 프로세스 시작 중...');

  try {
    await initDatabase();
    logInfo('WorkerEntry', '✅ 데이터베이스 초기화 및 연결 완료');
  } catch (err) {
    logError('WorkerEntry', '❌ DB 초기화 실패', err);
    process.exit(1);
  }

  // 1. 주가 실시간 변동 엔진 (3분 주기)
  startStockEngine(180 * 1000);
  logInfo('WorkerEntry', '📈 주식 시세 변동 엔진 활성화 (180s)');

  // 2. 자동 경제 거시 밸런서 (10분 주기)
  startAutoBalancer(discordClient, setMarketRegime);
  logInfo('WorkerEntry', '🏛️ 거시경제 밸런서 엔진 활성화 (600s)');

  // 3. 은행 1분 복리 이자 엔진
  startBankEngine(60 * 1000);
  logInfo('WorkerEntry', '🏦 중앙은행 이자 지급 엔진 활성화 (60s)');

  // 4. 자동 채굴 봇 적립
  startAutoMiner();
  logInfo('WorkerEntry', '⛏️ 자동 채굴기 엔진 활성화');

  // 5. 기업 방치형 수익 엔진
  startBusinessEngine(60 * 1000);
  logInfo('WorkerEntry', '🏢 가상 기업 수익 엔진 활성화 (60s)');

  // 6. 자금 공급 순환 모니터
  try {
    startEconomySupplyMonitor();
    logInfo('WorkerEntry', '📊 통화량 순환 모니터 활성화');
  } catch (err) {
    logError('WorkerEntry', '통화량 순환 모니터 시작 실패', err);
  }

  // 7. 자동 정기 백업 스케줄러 (6시간 주기)
  try {
    startAutoBackupScheduler();
    logInfo('WorkerEntry', '💾 자동 DB 백업 스케줄러 활성화');
  } catch (err) {
    logError('WorkerEntry', '자동 백업 스케줄러 시작 실패', err);
  }

  logInfo('WorkerEntry', '✨ 모든 백그라운드 워커가 정상적으로 활성화되었습니다.');
}

if (require.main === module) {
  runWorker();
}

module.exports = { runWorker };
