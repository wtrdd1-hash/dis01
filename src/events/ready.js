const { REST, Routes, Events } = require('discord.js');
const { initDatabase, cleanupOldDatabaseLogs } = require('../config/database');
const { updateStockPrices } = require('../utils/stockEngine');
const { startWebServer } = require('../web/server');
const { logInfo, logError } = require('../utils/logger');

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
    }

    // 디스코드 경제 & OAuth2 대시보드 웹 서버 실행
    try {
      startWebServer(client);
    } catch (err) {
      logError('Ready', '웹 서버 시작 실패', err);
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

    // 백그라운드 주가 실시간 변동 엔진 (3분마다 실행)
    setInterval(() => {
      updateStockPrices();
    }, 3 * 60 * 1000);

    // 24시간마다 DB 오래된 로그 자동 최적화 정리
    setInterval(() => {
      cleanupOldDatabaseLogs();
    }, 24 * 60 * 60 * 1000);

    logInfo('Ready', '🚀 시스템 백그라운드 엔진 및 DB 최적화 스케줄러 활성화 완료');
  }
};
