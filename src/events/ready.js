const { REST, Routes, Events } = require('discord.js');
const { initDatabase } = require('../config/database');
const { startStockEngine, updateStockPrices, setMarketRegime } = require('../utils/stockEngine');
const { startWebServer } = require('../web/server');
const { logInfo, logError } = require('../utils/logger');
const { startAutoBalancer } = require('../utils/economyBalancer');
const { startBankEngine } = require('../utils/bankEngine');
const { startAutoMiner } = require('../utils/autoMiner');
const { startBusinessEngine } = require('../utils/businessEngine');
const { startEconomySupplyMonitor } = require('../utils/economySupplyMonitor');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client, commandsMap) {
    const guildCount = client.guilds.cache.size;
    const userCount = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);

    logInfo('Ready', `봇이 성공적으로 로그인했습니다: ${client.user.tag} (ID: ${client.user.id})`);
    logInfo('Ready', `현재 ${guildCount}개의 디스코드 서버 및 약 ${userCount}명의 유저와 연결되어 있습니다.`);
    client.guilds.cache.forEach(guild => {
      logInfo('Guild', `연결된 서버: ${guild.name} (ID: ${guild.id}, 멤버: ${guild.memberCount}명)`);
    });

    // 데이터베이스 초기화
    try {
      await initDatabase();
    } catch (err) {
      logError('Ready', 'DB 초기화 중 오류 발생', err);
      throw err;
    }

    try {
      const { refundOpenSessions } = require('../utils/blackjackStore');
      const refunded = await refundOpenSessions();
      if (refunded > 0) {
        logInfo('Ready', `블랙잭 미종료 배팅 ${refunded}건을 재시작 환불했습니다.`);
      }
    } catch (err) {
      logError('Ready', '블랙잭 재시작 환불 중 오류', err);
    }

    try {
      const { refundOpenSessions: refundPokerSessions } = require('../utils/pokerStore');
      const refundedPoker = await refundPokerSessions();
      if (refundedPoker > 0) {
        logInfo('Ready', `포커 미종료 배팅 ${refundedPoker}건을 재시작 환불했습니다.`);
      }
    } catch (err) {
      logError('Ready', '포커 재시작 환불 중 오류', err);
    }

    try {
      const { refundOpenSessions: refundSevenPokerSessions } = require('../utils/sevenPokerStore');
      const refundedSeven = await refundSevenPokerSessions();
      if (refundedSeven > 0) {
        logInfo('Ready', `세븐포커 미종료 배팅 ${refundedSeven}건을 재시작 환불했습니다.`);
      }
    } catch (err) {
      logError('Ready', '세븐포커 재시작 환불 중 오류', err);
    }

    // 디스코드 경제 & OAuth2 대시보드 웹 서버 실행
    try {
      startWebServer(client);
    } catch (err) {
      logError('Ready', '웹 서버 시작 실패', err);
      throw err;
    }

    // Slash Commands REST 등록
    const rest = new REST({ version: '10' }).setToken(client.token);
    const commandDataList = Array.from(commandsMap.values()).map(cmd => cmd.data.toJSON());

    try {
      logInfo('Ready', `${commandDataList.length}개의 슬래시 명령어(/) 등록 중...`);
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commandDataList }
      );
      logInfo('Ready', '✅ 모든 슬래시 명령어(/) 등록 완료!');
    } catch (error) {
      logError('Ready', '슬래시 명령어 등록 실패', error);
    }

    // 백그라운드 주가 실시간 변동 엔진 및 배당 스케줄러 (3분 주기)
    startStockEngine(180 * 1000);

    // 🏦 자동 경제 조절 시스템 가동 (10분 주기 분석, 관리자 DM 발송)
    startAutoBalancer(client, setMarketRegime);

    // 🏦 덕스 중앙은행 정기 예금 이자 지급 엔진 가동 (1분 주기, 1분 복리)
    startBankEngine(60 * 1000);

    // 자동 채굴 봇 백그라운드 적립 (1초 틱, economyBalance.CLICKER 기준)
    startAutoMiner();
    startBusinessEngine(60 * 1000);

    // 📊 자가 자금 순환 모니터링 시작 (5분 주기, economySupplyMonitor)
    try {
      startEconomySupplyMonitor();
    } catch (err) {
      logError('Ready', 'economySupplyMonitor 시작 실패', err);
    }

    // 🎛️ 경제 수동 컨트롤 상태 로드 (관리자 페이지에서 즉시 반영)
    try {
      const { loadManualState } = require('../utils/economyControls');
      await loadManualState();
    } catch (err) {
      logError('Ready', 'economyControls 상태 로드 실패', err);
    }

    // 💾 데이터베이스 자동 정기 백업 스케줄러 가동 (6시간 주기 + 만료 백업 30일 로테이션)
    try {
      const { startAutoBackupScheduler } = require('../utils/backupEngine');
      startAutoBackupScheduler();
    } catch (err) {
      logError('Ready', 'DB 자동 백업 스케줄러 가동 실패', err);
    }

    logInfo('Ready', '🚀 시스템 백그라운드 엔진 및 DB 최적화 스케줄러 활성화 완료');
  }
};
