const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('./config');

const LOG_ARCHIVE_DIR = path.join(__dirname, '../../logs/archive');

function archiveRows(tableName, rows) {
  if (!rows || rows.length === 0) return;
  if (!fs.existsSync(LOG_ARCHIVE_DIR)) {
    fs.mkdirSync(LOG_ARCHIVE_DIR, { recursive: true });
  }
  const stamp = new Date().toISOString().slice(0, 10);
  const filePath = path.join(LOG_ARCHIVE_DIR, `${tableName}-${stamp}.jsonl`);
  const lines = rows
    .map((row) => JSON.stringify(row, (_, val) => (typeof val === 'bigint' ? val.toString() : val)))
    .join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf8');
}

async function archiveAndDelete(tableName, dateColumn, intervalSql) {
  const batchSize = 2000;
  for (let round = 0; round < 20; round += 1) {
    const [rows] = await pool.query(
      `SELECT * FROM \`${tableName}\` WHERE ${dateColumn} < NOW() - INTERVAL ${intervalSql} LIMIT ${batchSize}`
    );
    if (!rows.length) return;
    archiveRows(tableName, rows);
    if (Object.prototype.hasOwnProperty.call(rows[0], 'id')) {
      const ids = rows.map((row) => row.id);
      await pool.query(
        `DELETE FROM \`${tableName}\` WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
    } else {
      await pool.query(
        `DELETE FROM \`${tableName}\` WHERE ${dateColumn} < NOW() - INTERVAL ${intervalSql} LIMIT ${batchSize}`
      );
    }
    if (rows.length < batchSize) return;
  }
}

async function ensureIndex(connection, tableName, indexName, columnsSql) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
     LIMIT 1`,
    [tableName, indexName]
  );
  if (rows.length) return;
  await connection.query(
    `ALTER TABLE \`${tableName}\` ADD INDEX \`${indexName}\` (${columnsSql})`
  );
  console.log(`✅ 인덱스 추가: ${tableName}.${indexName}`);
}

async function ensureDecimal65(connection, tableName, columnName, defaultSql) {
  const [cols] = await connection.query(
    `SELECT DATA_TYPE, NUMERIC_PRECISION
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  if (!cols.length) return;
  const type = String(cols[0].DATA_TYPE || cols[0].data_type || '').toLowerCase();
  const prec = Number(cols[0].NUMERIC_PRECISION || cols[0].NUMERIC_PRECISION || cols[0].numeric_precision || 0);
  if (type === 'decimal' && prec >= 65) return;
  await connection.query(
    `ALTER TABLE \`${tableName}\` MODIFY COLUMN \`${columnName}\` DECIMAL(65,0) NOT NULL ${defaultSql}`
  );
  console.log(`✅ 금액 컬럼 확장: ${tableName}.${columnName} → DECIMAL(65,0)`);
}

async function ensureDecimalAmount(connection, tableName, columnName) {
  const [cols] = await connection.query(
    `SELECT DATA_TYPE, NUMERIC_PRECISION, NUMERIC_SCALE
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  if (!cols.length) return;
  const type = String(cols[0].DATA_TYPE || cols[0].data_type || '').toLowerCase();
  const prec = Number(cols[0].NUMERIC_PRECISION || cols[0].numeric_precision || 0);
  const scale = Number(cols[0].NUMERIC_SCALE || cols[0].numeric_scale || 0);
  if (type === 'decimal' && prec >= 38 && scale >= 4) return;
  await connection.query(
    `ALTER TABLE \`${tableName}\` MODIFY COLUMN \`${columnName}\` DECIMAL(38,4) NOT NULL DEFAULT 0.0000`
  );
  console.log(`✅ 수량 컬럼 확장: ${tableName}.${columnName} → DECIMAL(38,4)`);
}

async function ensureWideMoneyColumns(connection) {
  await ensureDecimal65(connection, 'users', 'cash', 'DEFAULT 10000');
  await ensureDecimal65(connection, 'users', 'bank', 'DEFAULT 0');
  await ensureDecimal65(connection, 'economy_logs', 'amount', '');
  await ensureDecimal65(connection, 'economy_logs', 'balance_before', 'DEFAULT 0');
  await ensureDecimal65(connection, 'economy_logs', 'balance_after', 'DEFAULT 0');
  await ensureDecimal65(connection, 'gambling_logs', 'bet', '');
  await ensureDecimal65(connection, 'gambling_logs', 'payout', '');
  await ensureDecimal65(connection, 'gambling_logs', 'profit', '');
  await ensureDecimal65(connection, 'gambling_logs', 'balance_before', 'DEFAULT 0');
  await ensureDecimal65(connection, 'gambling_logs', 'balance_after', 'DEFAULT 0');
  await ensureDecimal65(connection, 'user_stocks', 'total_spent', 'DEFAULT 0');
  await ensureDecimalAmount(connection, 'user_stocks', 'amount');
  await ensureDecimal65(connection, 'stock_transactions', 'price', '');
  await ensureDecimal65(connection, 'stock_transactions', 'total_price', '');
  await ensureDecimalAmount(connection, 'stock_transactions', 'amount');
  await ensureDecimal65(connection, 'stocks', 'price', '');
  await ensureDecimal65(connection, 'stocks', 'prev_price', '');
  await ensureDecimal65(connection, 'stocks', 'high_24h', 'DEFAULT 0');
  await ensureDecimal65(connection, 'stocks', 'low_24h', 'DEFAULT 0');
  await ensureDecimal65(connection, 'stocks', 'volume_24h', 'DEFAULT 0');
  await ensureDecimal65(connection, 'stocks', 'market_cap', 'DEFAULT 0');
  await ensureDecimal65(connection, 'stock_history', 'price', '');
  await ensureDecimal65(connection, 'stock_price_logs', 'prev_price', '');
  await ensureDecimal65(connection, 'stock_price_logs', 'new_price', '');
  await ensureDecimal65(connection, 'stock_price_logs', 'diff', '');
  await ensureDecimal65(connection, 'blackjack_sessions', 'bet', '');
  await ensureDecimal65(connection, 'blackjack_sessions', 'balance_before', 'DEFAULT 0');
  await ensureDecimal65(connection, 'poker_sessions', 'bet', '');
  await ensureDecimal65(connection, 'poker_sessions', 'balance_before', 'DEFAULT 0');
  await ensureDecimal65(connection, 'seven_poker_sessions', 'bet', '');
  await ensureDecimal65(connection, 'seven_poker_sessions', 'balance_before', 'DEFAULT 0');
  await ensureDecimal65(connection, 'user_businesses', 'invested', 'DEFAULT 0');
  await ensureDecimal65(connection, 'economy_health_log', 'total_money', 'DEFAULT 0');
  await ensureDecimal65(connection, 'economy_health_log', 'avg_wealth', 'DEFAULT 0');
  await ensureDecimal65(connection, 'casino_pot', 'jackpot', 'DEFAULT 0');
  await ensureDecimal65(connection, 'casino_pot', 'reserve', 'DEFAULT 0');
  await ensureDecimal65(connection, 'user_casino', 'total_wagered', 'DEFAULT 0');
  await ensureDecimal65(connection, 'user_casino', 'total_profit', 'DEFAULT 0');
  await ensureDecimal65(connection, 'toto_tickets', 'amount', '');
  await ensureDecimal65(connection, 'toto_tickets', 'payout', 'DEFAULT 0');
}

async function dropIndexIfExists(connection, tableName, indexName) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
     LIMIT 1`,
    [tableName, indexName]
  );
  if (!rows.length) return;
  await connection.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${indexName}\``);
}

async function ensureRuntimeIndexes(connection) {
  const [tables] = await connection.query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()'
  );
  const have = new Set(tables.map((row) => row.TABLE_NAME || row.table_name));

  if (have.has('users')) {
    await ensureIndex(connection, 'users', 'idx_username', 'username');
  }
  if (have.has('gambling_logs')) {
    await ensureIndex(connection, 'gambling_logs', 'idx_created_at', 'created_at');
    await ensureIndex(connection, 'gambling_logs', 'idx_profit_rollback', 'is_rolled_back, profit');
  }
  if (have.has('market_news_feed')) {
    await ensureIndex(connection, 'market_news_feed', 'idx_event_type', 'event_type');
  }
  if (have.has('web_access_logs')) {
    await ensureIndex(connection, 'web_access_logs', 'idx_url', 'url(120)');
  }
  if (have.has('stock_history')) {
    await ensureIndex(connection, 'stock_history', 'idx_stock_id_id', 'stock_id, id');
  }
  if (have.has('user_stocks')) {
    await dropIndexIfExists(connection, 'user_stocks', 'idx_user_id');
  }
  if (have.has('chat_messages')) {
    const [cols] = await connection.query("SHOW COLUMNS FROM chat_messages LIKE 'room_id'");
    if (cols.length) {
      await ensureIndex(connection, 'chat_messages', 'idx_room_id', 'room_id');
      await ensureIndex(connection, 'chat_messages', 'idx_room_id_id', 'room_id, id');
    }
  }
  if (have.has('toto_matches')) {
    await ensureIndex(connection, 'toto_matches', 'idx_status_settle', 'status, settle_at');
  }
  if (have.has('toto_tickets')) {
    await ensureIndex(connection, 'toto_tickets', 'idx_match_status', 'match_id, status');
  }
  if (have.has('economy_flow_logs')) {
    await ensureIndex(connection, 'economy_flow_logs', 'idx_flow_type_date', 'flow_type, created_at');
    await ensureIndex(connection, 'economy_flow_logs', 'idx_flow_cat_date', 'category, created_at');
    await ensureIndex(connection, 'economy_flow_logs', 'idx_flow_user_date', 'user_id, created_at');
  }
  if (have.has('user_inventory')) {
    await ensureIndex(connection, 'user_inventory', 'idx_user_item_active', 'user_id, item_key, is_active');
  }
  if (have.has('lotto_tickets')) {
    await ensureIndex(connection, 'lotto_tickets', 'idx_round_user', 'round_number, user_id');
  }
  if (have.has('site_announcements')) {
    await ensureIndex(connection, 'site_announcements', 'idx_ann_active_popup', 'is_active, is_popup, created_at');
  }
  if (have.has('user_drill_equipment')) {
    await ensureIndex(connection, 'user_drill_equipment', 'idx_drill_user_lvl', 'user_id, enhancement_level');
  }
}

// DB Connection Pool 튜닝 (과부하 방지 + 안정성 강화)
// - connectionLimit: 동시에 유지할 최대 연결 수 (기본 10 → 운영 부하에 맞춰 상향)
// - queueLimit: 풀이 가득 찰 때 대기열 한계 (0이면 무제한 대기)
// - acquireTimeout: 연결 획득 대기 한계
// - enableKeepAlive: 장시간 유휴 연결의 죽은 TCP 감지
// - keepAliveInitialDelay: TCP keepalive 시작 시간
const pool = mysql.createPool({
  ...config.db,
  connectionLimit: 25,
  queueLimit: 0,
  waitForConnections: true,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000,
  multipleStatements: false,
  timezone: '+09:00',
  dateStrings: true,
  charset: 'utf8mb4_unicode_ci',
  supportBigNumbers: true,
  bigNumberStrings: true,
  typeCast: true
});

// 풀 상태 모니터링 통계 (모니터링 전용, getConnection 동작 변경 안 함)
let __poolStats = { acquired: 0, released: 0, errors: 0 };

function recordPoolAcquire() { __poolStats.acquired++; }
function recordPoolRelease() {
  __poolStats.released++;
  if (__poolStats.released % 500 === 0) {
    const pending = __poolStats.acquired - __poolStats.released;
    console.log(`[DB Pool stats] acquired=${__poolStats.acquired} released=${__poolStats.released} pending=${pending} errors=${__poolStats.errors}`);
  }
}
function recordPoolError(err) {
  __poolStats.errors++;
  console.error(`[DB Pool] 연결 오류 (errors=${__poolStats.errors}):`, err.message);
}

function getPoolStats() {
  const internal = pool.pool || pool._pool || {};
  return {
    ...__poolStats,
    internalPool: {
      _allConnections: internal._allConnections ? internal._allConnections.length : 0,
      _freeConnections: internal._freeConnections ? internal._freeConnections.length : 0,
      _connectionQueue: internal._connectionQueue ? internal._connectionQueue.length : 0
    }
  };
}

// 주기적인 풀 상태 모니터링 (5분마다)
setInterval(() => {
  if (__poolStats.acquired % 100 < 5) {
    const s = getPoolStats();
    console.log(`[DB Pool Monitor] ${JSON.stringify(s)} heap=${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`);
  }
}, 5 * 60 * 1000).unref?.();

// getPoolStats, recordPool*은 향후 다른 곳에서 호출할 수 있도록 export
module.exports.recordPoolAcquire = recordPoolAcquire;
module.exports.recordPoolRelease = recordPoolRelease;
module.exports.recordPoolError = recordPoolError;
module.exports.getPoolStats = getPoolStats;

// 데이터베이스 구축 여부 확인 및 없으면 자동 생성
async function ensureDatabaseExists() {
  const { host, port, user, password, database } = config.db;
  try {
    const connection = await mysql.createConnection({
      host,
      port,
      user,
      password
    });
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await connection.end();
    console.log(`✅ 데이터베이스 '${database}' 존재 확인 및 자동 생성 완료.`);
    return true;
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.warn(`⚠️ DB 서버 연결 실패 (${host}:${port}): MySQL 서비스가 가동 중이지 않거나 접근할 수 없습니다.`);
      console.warn(`💡 MySQL 실행 후 봇을 구동하면 '${database}' 데이터베이스 및 테이블이 자동 생성됩니다.`);
    } else {
      console.warn(`⚠️ DB 존재 확인 중 경고 (${error.code || error.message}):`, error.message);
    }
    return false;
  }
}

async function initDatabase() {
  const dbReady = await ensureDatabaseExists();
  if (!dbReady) {
    const err = new Error('데이터베이스 연결 실패로 테이블을 초기화할 수 없습니다.');
    err.code = 'DB_INIT_UNAVAILABLE';
    throw err;
  }

  const { runMigrations } = require('../db/migrationRunner');
  await runMigrations(pool);

  const connection = await pool.getConnection();
  try {
    await ensureWideMoneyColumns(connection);
    await ensureRuntimeIndexes(connection);
    await cleanupOldDatabaseLogs();
    console.log('✅ 데이터베이스 버전 마이그레이션 및 정밀 검사 완료!');
  } catch (error) {
    console.error('❌ 데이터베이스 추가 검사 실패:', error);
    throw error;
  } finally {
    connection.release();
  }
}

// 🛡️ 이용약관 및 개인정보 처리방침 규정: IP 접속 기록 30일 보관 후 정리
async function cleanupOldDatabaseLogs() {
  try {
    // 🛡️ 이용약관 명시 기준: 비인가 접근 및 보안 침입 감시 목적 접속 IP/웹 로그 30일 보관 후 로컬 아카이브 및 정리
    await archiveAndDelete('web_access_logs', 'created_at', '30 DAY');
    await archiveAndDelete('security_events', 'created_at', '30 DAY');
    await archiveAndDelete('admin_logs', 'created_at', '30 DAY');
    await archiveAndDelete('chat_messages', 'created_at', '7 DAY');
    await archiveAndDelete('stock_price_logs', 'created_at', '90 DAY');
    await archiveAndDelete('market_news_feed', 'created_at', '90 DAY');
    console.log('🛡️ [보안 IP 30일 보관 정책] 이용약관 기준 30일 경과 접속 IP/보안 로그 아카이브 및 정돈 완료');
  } catch (err) {
    console.warn('⚠️ DB 로그 정돈 경고:', err.message);
  }
}

setInterval(cleanupOldDatabaseLogs, 10 * 60 * 1000).unref?.();

// 유저 자동 가입 / 조회 함수
async function getOrCreateUser(discordId, username = null, avatar = null) {
  const [rows] = await pool.query('SELECT * FROM users WHERE discord_id = ?', [discordId]);
  if (rows.length > 0) {
    if (username || avatar) {
      await pool.query(
        'UPDATE users SET username = COALESCE(?, username), avatar = COALESCE(?, avatar) WHERE discord_id = ?',
        [username, avatar, discordId]
      );
      rows[0].username = username || rows[0].username;
      rows[0].avatar = avatar || rows[0].avatar;
    }
    return rows[0];
  }
  await pool.query(
    'INSERT INTO users (discord_id, username, avatar, cash, bank) VALUES (?, ?, ?, ?, 0)',
    [discordId, username, avatar, config.initialBalance]
  );
  const [newRows] = await pool.query('SELECT * FROM users WHERE discord_id = ?', [discordId]);
  return newRows[0];
}

module.exports = {
  pool,
  initDatabase,
  getOrCreateUser,
  cleanupOldDatabaseLogs,
  ensureDecimal65
};
