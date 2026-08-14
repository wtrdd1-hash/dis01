const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');

const LOG_DIR = path.join(__dirname, '../../logs');
const LOG_FILE = path.join(LOG_DIR, 'commands.log');

// logs 디렉토리 생성
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getFormattedTimestamp() {
  const now = new Date();
  return now.toISOString().replace(/T/, ' ').replace(/\..+/, '');
}

/**
 * 명령어 실행 상황 로그 저장 (콘솔, 파일, DB)
 */
async function logCommandExecution(interaction, status = 'SUCCESS', durationMs = 0, error = null) {
  const timestamp = getFormattedTimestamp();
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username;
  const guildId = interaction.guildId || 'DM';
  const channelId = interaction.channelId || 'N/A';
  const commandName = interaction.commandName;

  // 옵션 파싱
  const optionsObj = {};
  if (interaction.options && interaction.options.data) {
    for (const opt of interaction.options.data) {
      optionsObj[opt.name] = opt.value;
    }
  }
  const optionsJson = JSON.stringify(optionsObj);

  const statusSymbol = status === 'SUCCESS' ? '✅' : '❌';
  const logLine = `[${timestamp}] ${statusSymbol} /${commandName} | User: ${username} (${userId}) | Guild: ${guildId} | Options: ${optionsJson} | Status: ${status} | Duration: ${durationMs}ms${error ? ` | Error: ${error.message}` : ''}`;

  // 1. 콘솔 출력
  if (status === 'SUCCESS') {
    console.log(logLine);
  } else {
    console.error(logLine);
  }

  // 2. 파일 저장 (비동기 처리 - 이벤트 루프 블로킹 방지)
  fs.appendFile(LOG_FILE, logLine + '\n', 'utf8', (fsErr) => {
    if (fsErr) console.error('❌ 로그 파일 작성 실패:', fsErr.message);
  });

  // 3. MySQL DB 저장 (비동기 처리)
  try {
    await pool.query(`
      INSERT INTO command_logs (user_id, username, guild_id, channel_id, command_name, options, status, execution_time_ms, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      username,
      guildId,
      channelId,
      commandName,
      optionsJson,
      status,
      durationMs,
      error ? error.message : null
    ]);
  } catch (dbErr) {
    console.error('❌ DB 로그 저장 실패:', dbErr.message);
  }
}

module.exports = {
  logCommandExecution
};
