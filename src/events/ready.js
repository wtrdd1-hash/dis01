const { REST, Routes, Events } = require('discord.js');
const { initDatabase, cleanupOldDatabaseLogs } = require('../config/database');
const { updateStockPrices } = require('../utils/stockEngine');
const { startWebServer } = require('../web/server');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client, commandsMap) {
    console.log(`🤖 봇이 성공적으로 로그인했습니다: ${client.user.tag}`);

    // 데이터베이스 초기화
    try {
      await initDatabase();
    } catch (err) {
      console.error('❌ DB 초기화 중 오류 발생:', err);
    }

    // 디스코드 경제 & OAuth2 대시보드 웹 서버 실행
    try {
      startWebServer(client);
    } catch (err) {
      console.error('❌ 웹 서버 시작 실패:', err);
    }

    // Slash Commands REST 등록
    const rest = new REST({ version: '10' }).setToken(client.token);
    const commandDataList = Array.from(commandsMap.values()).map(cmd => cmd.data.toJSON());

    try {
      console.log(`🔄 ${commandDataList.length}개의 슬래시 명령어(/) 등록 중...`);
      await rest.put(
        Routes.applicationCommands(client.user.id),
        { body: commandDataList }
      );
      console.log('✅ 슬래시 명령어(/) 등록 완료!');
    } catch (error) {
      console.error('❌ 슬래시 명령어 등록 실패:', error);
    }

    // 백그라운드 주가 실시간 변동 엔진 (2분마다 실행)
    setInterval(() => {
      updateStockPrices();
    }, 2 * 60 * 1000);

    // 24시간마다 DB 오래된 로그 자동 최적화 정리
    setInterval(() => {
      cleanupOldDatabaseLogs();
    }, 24 * 60 * 60 * 1000);

    console.log('🚀 시스템 백그라운드 엔진 및 DB 최적화 스케줄러 활성화 완료');
  }
};

