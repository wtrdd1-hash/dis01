const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const { lookupIp } = require('./geoIp');

const LOG_DIR = path.join(__dirname, '../../logs');
const ACCESS_JSONL_FILE = path.join(LOG_DIR, 'access.jsonl');
const ADMIN_JSONL_FILE = path.join(LOG_DIR, 'admin.jsonl');
const COMMANDS_JSONL_FILE = path.join(LOG_DIR, 'commands.jsonl');
const ALL_JSONL_FILE = path.join(LOG_DIR, 'all.jsonl');
const LEGACY_LOG_FILE = path.join(LOG_DIR, 'commands.log');

// logs 디렉토리 생성
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getFormattedTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * JSON 라인 파일에 비동기 안전하게 추가
 */
function appendJsonLog(filePath, logObj) {
  try {
    const line = JSON.stringify(logObj) + '\n';
    fs.appendFile(filePath, line, 'utf8', (err) => {
      if (err) console.error(`❌ 로그 파일 쓰기 실패 (${path.basename(filePath)}):`, err.message);
    });
    // 종합 로그 파일에도 병합 기록
    if (filePath !== ALL_JSONL_FILE) {
      fs.appendFile(ALL_JSONL_FILE, line, 'utf8', () => {});
    }
  } catch (e) {
    console.error('JSON 직렬화 에러:', e);
  }
}

/**
 * 웹 사이트 접속 / 관리자 접근 실시간 로깅 (JSON 파일 + MySQL DB + 콘솔)
 */
async function logWebAccess(req, res, durationMs = 0, currentUser = null) {
  const timestamp = getFormattedTimestamp();
  const rawIp = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '127.0.0.1';
  const geo = lookupIp(rawIp);

  const method = req.method;
  const url = req.originalUrl || req.url;
  const statusCode = res.statusCode;
  const userAgent = req.headers['user-agent'] || 'Unknown';

  const userId = currentUser ? currentUser.id : null;
  let username = currentUser ? (currentUser.username || currentUser.tag || 'Unknown') : '비회원(방문자)';
  if (username && !username.startsWith('@') && username !== '비회원(방문자)') {
    username = `@${username}`;
  }

  const config = require('../config/config');
  const isAdmin = currentUser ? config.isAdmin(currentUser.id) : false;

  const logPayload = {
    type: 'WEB_ACCESS',
    timestamp,
    ip: geo.ip,
    country: geo.country,
    countryName: geo.countryName,
    flag: geo.flag,
    city: geo.city,
    method,
    url,
    statusCode,
    durationMs,
    userId,
    username,
    isAdmin,
    userAgent
  };

  // 1. JSON 파일 저장
  appendJsonLog(ACCESS_JSONL_FILE, logPayload);
  if (isAdmin || url.startsWith('/admin')) {
    appendJsonLog(ADMIN_JSONL_FILE, logPayload);
  }

  // 2. 콘솔 출력
  const statusEmoji = statusCode >= 400 ? '⚠️' : '🌐';
  if (isAdmin) {
    console.log(`👑 [웹 관리자 접속] ${geo.flag} ${geo.countryName}(${geo.ip}) | ${username} (ID: ${userId}) | ${method} ${url} | ${statusCode} (${durationMs}ms)`);
  } else {
    console.log(`${statusEmoji} [웹 접속] ${geo.flag} ${geo.countryName}(${geo.ip}) | ${username} | ${method} ${url} | ${statusCode} (${durationMs}ms)`);
  }

  // 3. MySQL DB 비동기 저장
  try {
    await pool.query(`
      INSERT INTO web_access_logs (ip, country, country_name, city, method, url, status_code, duration_ms, user_id, username, is_admin, user_agent, json_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      geo.ip,
      geo.country,
      geo.countryName,
      geo.city,
      method,
      url,
      statusCode,
      durationMs,
      userId,
      username,
      isAdmin ? 1 : 0,
      userAgent.slice(0, 490),
      JSON.stringify(logPayload)
    ]);
  } catch (dbErr) {
    // DB 에러 시 무시 (논블로킹)
  }
}

/**
 * 명령어 실행 상세 로깅
 */
async function logCommandExecution(interaction, status = 'SUCCESS', durationMs = 0, error = null) {
  const timestamp = getFormattedTimestamp();
  const userId = interaction.user.id;
  let username = interaction.user.tag || interaction.user.username;
  if (!username.startsWith('@')) username = `@${username}`;

  const guildName = interaction.guild ? `${interaction.guild.name} (${interaction.guild.id})` : 'DM (개인메시지)';
  const channelName = interaction.channel ? `#${interaction.channel.name || '채널'}` : 'N/A';
  const commandName = interaction.commandName;

  const config = require('../config/config');
  const isAdmin = config.isAdmin(userId);

  // 옵션 파싱
  const optionsObj = {};
  if (interaction.options && interaction.options.data) {
    for (const opt of interaction.options.data) {
      if (opt.value !== undefined) {
        optionsObj[opt.name] = opt.value;
      } else if (opt.options) {
        optionsObj[opt.name] = opt.options.map(sub => `${sub.name}:${sub.value}`).join(', ');
      }
    }
  }

  const logPayload = {
    type: 'DISCORD_COMMAND',
    timestamp,
    command: `/${commandName}`,
    userId,
    username,
    isAdmin,
    guild: guildName,
    guildId: interaction.guildId || 'DM',
    channel: channelName,
    channelId: interaction.channelId || 'N/A',
    options: optionsObj,
    status,
    durationMs,
    error: error ? error.message : null
  };

  // 1. JSON 파일 저장
  appendJsonLog(COMMANDS_JSONL_FILE, logPayload);
  if (isAdmin) {
    appendJsonLog(ADMIN_JSONL_FILE, logPayload);
  }

  // 2. 콘솔 출력
  const statusSymbol = status === 'SUCCESS' ? '✅' : '❌';
  const adminTag = isAdmin ? ' 👑[ADMIN]' : '';
  const logLine = `[${timestamp}] ${statusSymbol} [명령어${adminTag}] /${commandName} | 유저: ${username} (${userId}) | 서버: ${guildName} | 채널: ${channelName} | 옵션: ${JSON.stringify(optionsObj)} | 상태: ${status} | 소요: ${durationMs}ms${error ? ` | 오류: ${error.message}` : ''}`;

  if (status === 'SUCCESS') {
    console.log(logLine);
  } else {
    console.error(logLine);
  }

  // 3. MySQL DB 저장
  try {
    await pool.query(`
      INSERT INTO command_logs (user_id, username, guild_id, channel_id, command_name, options, status, execution_time_ms, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      username,
      interaction.guildId || 'DM',
      interaction.channelId || 'N/A',
      commandName,
      JSON.stringify(optionsObj),
      status,
      durationMs,
      error ? error.message : null
    ]);
  } catch (dbErr) {
    // DB 실패 무시
  }
}

/**
 * 버튼 / 셀렉트 메뉴 등 컴포넌트 상호작용 로그
 */
function logComponentInteraction(interaction) {
  const timestamp = getFormattedTimestamp();
  let username = interaction.user.tag || interaction.user.username;
  if (!username.startsWith('@')) username = `@${username}`;

  const guildName = interaction.guild ? interaction.guild.name : 'DM';
  const customId = interaction.customId || 'N/A';
  const type = interaction.isButton() ? '🔘 버튼' : interaction.isStringSelectMenu() ? '📋 메뉴' : '🧩 상호작용';

  const config = require('../config/config');
  const isAdmin = config.isAdmin(interaction.user.id);

  const logPayload = {
    type: 'DISCORD_COMPONENT',
    timestamp,
    componentType: type,
    userId: interaction.user.id,
    username,
    isAdmin,
    guild: guildName,
    customId
  };

  appendJsonLog(COMMANDS_JSONL_FILE, logPayload);
  console.log(`[${timestamp}] ${type}${isAdmin ? ' 👑[ADMIN]' : ''} | 유저: ${username} (${interaction.user.id}) | 서버: ${guildName} | CustomId: ${customId}`);
}

function logInfo(tag, message) {
  const timestamp = getFormattedTimestamp();
  const line = `[${timestamp}] ℹ️ [${tag}] ${message}`;
  console.log(line);
  appendJsonLog(ALL_JSONL_FILE, { type: 'INFO', timestamp, tag, message });
}

function logWarn(tag, message) {
  const timestamp = getFormattedTimestamp();
  const line = `[${timestamp}] ⚠️ [${tag}] ${message}`;
  console.warn(line);
  appendJsonLog(ALL_JSONL_FILE, { type: 'WARN', timestamp, tag, message });
}

function logError(tag, message, error = null) {
  const timestamp = getFormattedTimestamp();
  const errDetails = error ? (error.stack || error.message || error) : '';
  const line = `[${timestamp}] ❌ [${tag}] ${message}${errDetails ? ` | ${errDetails}` : ''}`;
  console.error(line);
  appendJsonLog(ALL_JSONL_FILE, { type: 'ERROR', timestamp, tag, message, error: errDetails });
}

// 30일(1개월) 초과된 오래된 JSONL 파일 로그 라인 자동 정돈
function pruneOldJsonlFiles() {
  try {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const files = [ACCESS_JSONL_FILE, ADMIN_JSONL_FILE, COMMANDS_JSONL_FILE, ALL_JSONL_FILE];

    for (const filePath of files) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(Boolean);
      const keptLines = [];

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const logTime = parsed.timestamp ? new Date(parsed.timestamp).getTime() : Date.now();
          if (logTime >= thirtyDaysAgo) {
            keptLines.push(line);
          }
        } catch (e) {
          keptLines.push(line);
        }
      }

      if (keptLines.length !== lines.length) {
        fs.writeFileSync(filePath, keptLines.join('\n') + (keptLines.length > 0 ? '\n' : ''), 'utf8');
      }
    }
  } catch (err) {
    console.warn('⚠️ JSONL 파일 로그 정리 경고:', err.message);
  }
}

// 봇 시작 시 및 24시간마다 30일 초과 파일 로그 자동 정돈
pruneOldJsonlFiles();
setInterval(pruneOldJsonlFiles, 24 * 60 * 60 * 1000);

module.exports = {
  getFormattedTimestamp,
  logWebAccess,
  logAdminAction,
  logCommandExecution,
  logComponentInteraction,
  logInfo,
  logWarn,
  logError,
  pruneOldJsonlFiles
};
