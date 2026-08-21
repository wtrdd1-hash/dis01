'use strict';
process.env.TZ = 'Asia/Seoul';

const processType = (process.env.PROCESS_TYPE || 'all').toLowerCase().trim();

if (processType === 'web') {
  require('./entries/web').runWeb();
} else if (processType === 'bot') {
  require('./entries/bot').runBot();
} else if (processType === 'worker') {
  require('./entries/worker').runWorker();
} else {
  // All-in-One Monolith Mode (Default & Local Development)
  const { Client, GatewayIntentBits, Collection } = require('discord.js');
  const fs = require('fs');
  const path = require('path');
  const config = require('./config/config');
  require('./web/autoRefreshPatch');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  const commandsMap = new Collection();
  function loadCommands(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        loadCommands(fullPath);
      } else if (file.endsWith('.js')) {
        const command = require(fullPath);
        if (command.data && command.execute) {
          commandsMap.set(command.data.name, command);
        }
      }
    }
  }

  loadCommands(path.join(__dirname, 'commands'));

  const readyEvent = require('./events/ready');
  const interactionEvent = require('./events/interactionCreate');

  client.once(readyEvent.name, async () => {
    try {
      await readyEvent.execute(client, commandsMap);
    } catch (err) {
      console.error('[startup] 필수 서비스 초기화 실패:', err);
      shutdown('STARTUP_FAILURE');
    }
  });

  client.on(interactionEvent.name, (interaction) => {
    interactionEvent.execute(interaction, client, commandsMap).catch((err) => {
      console.error('[interaction] 처리되지 않은 오류:', err);
    });
  });

  // 프로세스 안정성 예외 핸들러
  process.on('unhandledRejection', (reason) => {
    console.error('⚠️ [Unhandled Rejection]:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('❌ [Uncaught Exception]:', err);
  });

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} 수신, 정리 후 종료합니다.`);
    const timer = setTimeout(() => process.exit(1), 10000);
    if (typeof timer.unref === 'function') timer.unref();
    Promise.resolve()
      .then(() => (client && typeof client.destroy === 'function' ? client.destroy() : undefined))
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('[shutdown] 종료 중 오류:', err);
        process.exit(1);
      });
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (config.token) {
    client.login(config.token).catch(err => {
      console.error('❌ 디스코드 로그인 실패! 토큰을 확인하세요:', err.message);
      // Even if discord login fails, start the web server so dashboard and /readyz are accessible!
      const { startWebServer } = require('./web/server');
      const { initDatabase } = require('./config/database');
      initDatabase().then(() => startWebServer(null)).catch(console.error);
    });
  } else {
    console.warn('⚠️ DISCORD_TOKEN이 없습니다. Web 및 DB 모드로만 시작합니다.');
    const { startWebServer } = require('./web/server');
    const { initDatabase } = require('./config/database');
    initDatabase().then(() => startWebServer(null)).catch(console.error);
  }
}
