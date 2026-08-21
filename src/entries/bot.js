'use strict';
process.env.TZ = 'Asia/Seoul';

const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { initDatabase } = require('../config/database');
const { logInfo, logError } = require('../utils/logger');
const interactionEvent = require('../events/interactionCreate');

async function runBot() {
  logInfo('BotEntry', '🤖 Discord 봇 프로세스 시작 중...');

  if (!config.token) {
    logError('BotEntry', '❌ .env에 DISCORD_TOKEN이 설정되어 있지 않습니다.');
    process.exit(1);
  }

  try {
    await initDatabase();
    logInfo('BotEntry', '✅ 데이터베이스 연결 완료');
  } catch (err) {
    logError('BotEntry', '❌ 데이터베이스 초기화 실패', err);
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  const commandsMap = new Collection();
  function loadCommands(dir) {
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

  loadCommands(path.join(__dirname, '../commands'));
  logInfo('BotEntry', `📦 ${commandsMap.size}개의 슬래시 명령어 로드 완료`);

  client.once('ready', async () => {
    logInfo('BotEntry', `✨ 봇 로그인 성공: ${client.user.tag} (ID: ${client.user.id})`);
    
    // Slash commands registration
    const rest = new REST({ version: '10' }).setToken(client.token);
    const commandDataList = Array.from(commandsMap.values()).map(cmd => cmd.data.toJSON());
    try {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commandDataList });
      logInfo('BotEntry', '✅ Discord Slash 명령어 REST 등록 성공');
    } catch (err) {
      logError('BotEntry', '⚠️ Slash 명령어 등록 실패', err);
    }
  });

  client.on(interactionEvent.name, (interaction) => {
    interactionEvent.execute(interaction, client, commandsMap).catch((err) => {
      logError('BotEntry', '인터랙션 처리 중 오류', err);
    });
  });

  await client.login(config.token);
  return client;
}

if (require.main === module) {
  runBot();
}

module.exports = { runBot };
