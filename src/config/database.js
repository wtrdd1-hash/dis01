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
  timezone: 'Z',
  dateStrings: false,
  charset: 'utf8mb4_unicode_ci',
  supportBigNumbers: true,
  bigNumberStrings: false,
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

  const connection = await pool.getConnection();
  try {
    console.log('🔄 WSL MySQL 데이터베이스 테이블 검사 및 생성 중...');

    // 유저 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        discord_id VARCHAR(32) PRIMARY KEY,
        username VARCHAR(100) NULL,
        avatar VARCHAR(255) NULL,
        cash DECIMAL(65,0) NOT NULL DEFAULT 10000,
        bank DECIMAL(65,0) NOT NULL DEFAULT 0,
        last_daily DATETIME NULL,
        daily_streak INT NOT NULL DEFAULT 0,
        last_work DATETIME NULL,
        last_subsidy DATETIME NULL,
        github_id VARCHAR(64) NULL,
        github_username VARCHAR(100) NULL,
        github_linked_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 기존 users 테이블에 username / avatar / last_subsidy 컬럼 추가 (안전 대처)
    const [userCols] = await connection.query(`SHOW COLUMNS FROM users LIKE 'username';`);
    if (userCols.length === 0) {
      await connection.query(`
        ALTER TABLE users 
        ADD COLUMN username VARCHAR(100) NULL,
        ADD COLUMN avatar VARCHAR(255) NULL;
      `);
      console.log('✅ users 테이블에 username 및 avatar 컬럼이 추가되었습니다.');
    }

    const [subsidyCols] = await connection.query(`SHOW COLUMNS FROM users LIKE 'last_subsidy';`);
    if (subsidyCols.length === 0) {
      await connection.query(`
        ALTER TABLE users 
        ADD COLUMN last_subsidy DATETIME NULL;
      `);
      console.log('✅ users 테이블에 last_subsidy 컬럼이 추가되었습니다.');
    }

    const [gambleCols] = await connection.query(`SHOW COLUMNS FROM users LIKE 'gamble_turns';`);
    if (gambleCols.length === 0) {
      await connection.query(`
        ALTER TABLE users 
        ADD COLUMN gamble_turns INT NOT NULL DEFAULT 50,
        ADD COLUMN last_turn_update DATETIME DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN clicker_level INT NOT NULL DEFAULT 1,
        ADD COLUMN auto_miner_level INT NOT NULL DEFAULT 0,
        ADD COLUMN total_clicks BIGINT NOT NULL DEFAULT 0;
      `);
      console.log('✅ users 테이블에 도박 턴(gamble_turns) 및 클리커 지표 컬럼이 추가되었습니다.');
    }

    const [mineGenreCol] = await connection.query("SHOW COLUMNS FROM users LIKE 'mine_genre'");
    if (!mineGenreCol.length) {
      await connection.query("ALTER TABLE users ADD COLUMN mine_genre VARCHAR(16) NOT NULL DEFAULT 'classic'");
    }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS mine_genre_stats (
        user_id VARCHAR(32) NOT NULL,
        genre_id VARCHAR(16) NOT NULL,
        unlocked TINYINT(1) NOT NULL DEFAULT 0,
        clicks BIGINT NOT NULL DEFAULT 0,
        max_combo INT NOT NULL DEFAULT 0,
        max_depth INT NOT NULL DEFAULT 0,
        unlocked_at DATETIME NULL,
        PRIMARY KEY (user_id, genre_id),
        INDEX idx_genre_clicks (genre_id, clicks)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 🚫 유저 로그인 차단 (시간 단위 & 영구) 컬럼 마이그레이션
    const [banCols] = await connection.query("SHOW COLUMNS FROM users LIKE 'is_banned'");
    if (banCols.length === 0) {
      await connection.query(`
        ALTER TABLE users
        ADD COLUMN is_banned TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN banned_until DATETIME NULL DEFAULT NULL,
        ADD COLUMN ban_reason VARCHAR(255) NULL DEFAULT NULL,
        ADD COLUMN banned_at DATETIME NULL DEFAULT NULL,
        ADD COLUMN banned_by VARCHAR(64) NULL DEFAULT NULL;
      `);
      console.log('✅ users 테이블에 유저 로그인 차단(is_banned, banned_until 등) 컬럼이 추가되었습니다.');
    }

    // 📜 유저 차단 및 차단 해제 감사 로그 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_ban_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NULL,
        admin_id VARCHAR(32) NOT NULL,
        admin_username VARCHAR(100) NULL,
        action VARCHAR(20) NOT NULL,
        duration_hours INT NULL,
        banned_until DATETIME NULL,
        reason VARCHAR(255) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ban_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 📋 지정가 예약 주문 테이블 (예약 매수/매도)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock_limit_orders (
        id            BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id       VARCHAR(32) NOT NULL,
        username      VARCHAR(100) NOT NULL,
        stock_id      VARCHAR(16) NOT NULL,
        order_type    ENUM('BUY','SELL') NOT NULL,
        limit_price   DECIMAL(65,0) NOT NULL,
        amount        DECIMAL(38,4) NOT NULL,
        status        ENUM('PENDING','FILLED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'PENDING',
        filled_price  DECIMAL(65,0) DEFAULT NULL,
        expires_at    DATETIME DEFAULT NULL,
        filled_at     DATETIME DEFAULT NULL,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_lo_user     (user_id, status),
        INDEX idx_lo_stock    (stock_id, status),
        INDEX idx_lo_pending  (status, expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);



    // 주식 종목 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stocks (
        stock_id VARCHAR(16) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        price DECIMAL(65,0) NOT NULL,
        prev_price DECIMAL(65,0) NOT NULL,
        volatility DECIMAL(5,4) NOT NULL DEFAULT 0.05,
        sector VARCHAR(64) NOT NULL DEFAULT 'IT/기술',
        description TEXT NULL,
        high_24h DECIMAL(65,0) NOT NULL DEFAULT 0,
        low_24h DECIMAL(65,0) NOT NULL DEFAULT 0,
        volume_24h DECIMAL(65,0) NOT NULL DEFAULT 0,
        market_cap DECIMAL(65,0) NOT NULL DEFAULT 0,
        pe_ratio DECIMAL(6,2) NOT NULL DEFAULT 15.00,
        dividend_yield DECIMAL(5,2) NOT NULL DEFAULT 2.50,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 주식 상세 컬럼 존재 여부 체크 및 추가 (안전 마이그레이션)
    const [stockCols] = await connection.query("SHOW COLUMNS FROM stocks LIKE 'sector'");
    if (stockCols.length === 0) {
      await connection.query(`
        ALTER TABLE stocks
        ADD COLUMN sector VARCHAR(64) NOT NULL DEFAULT 'IT/기술',
        ADD COLUMN description TEXT NULL,
        ADD COLUMN high_24h BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN low_24h BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN volume_24h BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN market_cap BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN pe_ratio DECIMAL(6,2) NOT NULL DEFAULT 15.00,
        ADD COLUMN dividend_yield DECIMAL(5,2) NOT NULL DEFAULT 2.50;
      `);
      console.log('✅ stocks 테이블에 종목 상세 지표 컬럼(sector, description, high_24h 등)이 추가되었습니다.');
    }

    // 📉 상장폐지(Delisting) 관리 상태 컬럼 마이그레이션
    const [statusCols] = await connection.query("SHOW COLUMNS FROM stocks LIKE 'status'");
    if (statusCols.length === 0) {
      await connection.query(`
        ALTER TABLE stocks
        ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        ADD COLUMN delisted_at DATETIME NULL,
        ADD COLUMN liquidation_price DECIMAL(65,0) NOT NULL DEFAULT 0;
      `);
      console.log('✅ stocks 테이블에 상장폐지 상태 컬럼(status, delisted_at, liquidation_price)이 추가되었습니다.');
    }

    // 🛡️ 종목별 1회 최대 매수 한도 (max_buy_limit) 컬럼 마이그레이션
    const [buyLimitCols] = await connection.query("SHOW COLUMNS FROM stocks LIKE 'max_buy_limit'");
    if (buyLimitCols.length === 0) {
      await connection.query(`
        ALTER TABLE stocks
        ADD COLUMN max_buy_limit BIGINT NULL DEFAULT NULL;
      `);
      console.log('✅ stocks 테이블에 max_buy_limit 컬럼이 추가되었습니다.');
    }

    // 🏛️ 상장폐지 및 청산 내역 감사 로그 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock_delistings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        stock_id VARCHAR(16) NOT NULL,
        stock_name VARCHAR(64) NOT NULL,
        reason VARCHAR(255) NOT NULL,
        liquidation_price DECIMAL(65,0) NOT NULL DEFAULT 0,
        liquidated_users_count INT NOT NULL DEFAULT 0,
        total_shares_liquidated DECIMAL(18, 4) NOT NULL DEFAULT 0,
        total_payout DECIMAL(65,0) NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_stock_delisted (stock_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 주식 가격 히스토리 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        stock_id VARCHAR(16) NOT NULL,
        price DECIMAL(65,0) NOT NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_stock_id_recorded (stock_id, recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 시장 실시간 뉴스 & 공시 이벤트 피드 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS market_news_feed (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        impact_sector VARCHAR(64) NULL,
        related_stock VARCHAR(16) NULL,
        impact_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0000,
        sentiment VARCHAR(16) NOT NULL DEFAULT 'BULL',
        importance VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created_at (created_at),
        INDEX idx_event_type (event_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [newsCols] = await connection.query("SHOW COLUMNS FROM market_news_feed LIKE 'sentiment'");
    if (newsCols.length === 0) {
      await connection.query(`
        ALTER TABLE market_news_feed
        ADD COLUMN sentiment VARCHAR(16) NOT NULL DEFAULT 'BULL',
        ADD COLUMN importance VARCHAR(16) NOT NULL DEFAULT 'NORMAL';
      `);
    }

    // 유저 보유 주식 테이블 (소수점 거래 지원 DECIMAL(38, 4))
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_stocks (
        user_id VARCHAR(32) NOT NULL,
        stock_id VARCHAR(16) NOT NULL,
        amount DECIMAL(38, 4) NOT NULL DEFAULT 0.0000,
        total_spent DECIMAL(65,0) NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, stock_id),
        INDEX idx_user_id (user_id),
        INDEX idx_stock_id (stock_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 도박 및 이력 로그 테이블 (자산 스냅샷 및 롤백 복구 지원)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS gambling_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        game VARCHAR(32) NOT NULL,
        bet DECIMAL(65,0) NOT NULL,
        payout DECIMAL(65,0) NOT NULL,
        profit DECIMAL(65,0) NOT NULL,
        balance_before DECIMAL(65,0) NOT NULL DEFAULT 0,
        balance_after DECIMAL(65,0) NOT NULL DEFAULT 0,
        details JSON NULL,
        is_rolled_back TINYINT(1) NOT NULL DEFAULT 0,
        rolled_back_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_game (user_id, game),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [gambleSnapCols] = await connection.query("SHOW COLUMNS FROM gambling_logs LIKE 'balance_before'");
    if (gambleSnapCols.length === 0) {
      await connection.query(`
        ALTER TABLE gambling_logs
        ADD COLUMN balance_before BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN balance_after BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN details JSON NULL,
        ADD COLUMN is_rolled_back TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN rolled_back_at DATETIME NULL;
      `);
      console.log('✅ gambling_logs 테이블에 자산 스냅샷 및 롤백(balance_before, is_rolled_back) 컬럼이 추가되었습니다.');
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS blackjack_sessions (
        user_id VARCHAR(32) PRIMARY KEY,
        source VARCHAR(16) NOT NULL,
        bet DECIMAL(65,0) NOT NULL,
        balance_before DECIMAL(65,0) NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'playing',
        state_json JSON NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS poker_sessions (
        user_id VARCHAR(32) PRIMARY KEY,
        source VARCHAR(16) NOT NULL,
        bet DECIMAL(65,0) NOT NULL,
        balance_before DECIMAL(65,0) NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'playing',
        state_json JSON NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_pk_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS seven_poker_sessions (
        user_id VARCHAR(32) PRIMARY KEY,
        source VARCHAR(16) NOT NULL,
        bet DECIMAL(65,0) NOT NULL,
        balance_before DECIMAL(65,0) NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'playing',
        state_json JSON NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_sp_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 모든 슬래시 명령어 실행 로그 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS command_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NOT NULL,
        guild_id VARCHAR(32) NULL,
        channel_id VARCHAR(32) NULL,
        command_name VARCHAR(64) NOT NULL,
        options TEXT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'SUCCESS',
        execution_time_ms INT NOT NULL DEFAULT 0,
        error_message TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_command_name (command_name),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 실시간 주가 변동 틱 로그 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock_price_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        stock_id VARCHAR(16) NOT NULL,
        stock_name VARCHAR(64) NOT NULL,
        prev_price DECIMAL(65,0) NOT NULL,
        new_price DECIMAL(65,0) NOT NULL,
        change_rate DECIMAL(6,2) NOT NULL,
        diff DECIMAL(65,0) NOT NULL,
        regime VARCHAR(64) NOT NULL,
        reason VARCHAR(255) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_stock_id (stock_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 주식 매수/매도 실시간 체결 로그 테이블 (소수점 거래 지원 DECIMAL(38, 4))
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock_transactions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NOT NULL,
        stock_id VARCHAR(16) NOT NULL,
        stock_name VARCHAR(64) NOT NULL,
        action VARCHAR(16) NOT NULL,
        amount DECIMAL(38, 4) NOT NULL,
        price DECIMAL(65,0) NOT NULL,
        total_price DECIMAL(65,0) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_stock_id (stock_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 출석체크, 지원금, 은행 이체 등 경제 이벤트 로그 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS economy_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NOT NULL,
        type VARCHAR(32) NOT NULL,
        amount DECIMAL(65,0) NOT NULL,
        balance_before DECIMAL(65,0) NOT NULL DEFAULT 0,
        balance_after DECIMAL(65,0) NOT NULL DEFAULT 0,
        description VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_type (type),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_businesses (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        business_key VARCHAR(32) NOT NULL,
        level INT NOT NULL DEFAULT 1,
        invested DECIMAL(65,0) NOT NULL DEFAULT 0,
        last_collect_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_biz (user_id, business_key),
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [bizStaffCols] = await connection.query(`SHOW COLUMNS FROM user_businesses LIKE 'staff'`);
    if (bizStaffCols.length === 0) {
      await connection.query(`ALTER TABLE user_businesses ADD COLUMN staff INT NOT NULL DEFAULT 0`);
      console.log('✅ user_businesses.staff 컬럼 추가');
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_business_meta (
        user_id VARCHAR(32) PRIMARY KEY,
        auto_collect TINYINT(1) NOT NULL DEFAULT 0,
        hq_level INT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 웹 접속 및 관리자 접속 상세 로그 테이블 (IP, 국가, @유저명, JSON 데이터)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS web_access_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(64) NOT NULL,
        country VARCHAR(10) NULL,
        country_name VARCHAR(100) NULL,
        city VARCHAR(100) NULL,
        method VARCHAR(16) NOT NULL,
        url VARCHAR(255) NOT NULL,
        status_code INT NOT NULL,
        duration_ms INT NOT NULL DEFAULT 0,
        user_id VARCHAR(32) NULL,
        username VARCHAR(100) NULL,
        is_admin TINYINT(1) NOT NULL DEFAULT 0,
        user_agent VARCHAR(500) NULL,
        json_data JSON NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ip (ip),
        INDEX idx_user_id (user_id),
        INDEX idx_is_admin (is_admin),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 관리자 전용 작업 감사 로그 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        admin_id VARCHAR(32) NOT NULL,
        admin_username VARCHAR(100) NOT NULL,
        action VARCHAR(64) NOT NULL,
        target_user_id VARCHAR(32) NULL,
        details JSON NULL,
        ip VARCHAR(64) NULL,
        country VARCHAR(10) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_admin_id (admin_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 관리자 계정 테이블 (.env 의 ADMIN_IDS + DB 의 admin_roles 합집합 사용)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS admin_roles (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        discord_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NOT NULL DEFAULT '',
        granted_by VARCHAR(32) NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        note VARCHAR(255) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_discord_id (discord_id),
        INDEX idx_active (is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 1:1 고객센터 문의 & 관리자 답변 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NOT NULL,
        avatar VARCHAR(255) NULL,
        category VARCHAR(64) NOT NULL DEFAULT '일반문의',
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        image_url TEXT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'WAITING',
        answer TEXT NULL,
        answered_by VARCHAR(100) NULL,
        answered_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [inquiryImgCols] = await connection.query("SHOW COLUMNS FROM inquiries LIKE 'image_url'");
    if (inquiryImgCols.length === 0) {
      await connection.query(`
        ALTER TABLE inquiries
        ADD COLUMN image_url TEXT NULL;
      `);
      console.log('✅ inquiries 테이블에 image_url 컬럼이 추가되었습니다.');
    }

    // ========== 자동 경제 조절 시스템 테이블 ==========
    // 동적 경제 설정값 (자동 조절로 런타임에 덮어씀)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS economy_settings (
        key_name VARCHAR(64) PRIMARY KEY,
        value VARCHAR(255) NOT NULL DEFAULT '1.0',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 경제 건강 분석 이력 로그
    await connection.query(`
      CREATE TABLE IF NOT EXISTS economy_health_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        total_money DECIMAL(65,0) NOT NULL DEFAULT 0,
        avg_wealth DECIMAL(65,0) NOT NULL DEFAULT 0,
        gini_coefficient DECIMAL(5,4) NOT NULL DEFAULT 0.0000,
        top10_ratio DECIMAL(5,4) NOT NULL DEFAULT 0.0000,
        avg_gamble_profit_rate DECIMAL(8,4) NOT NULL DEFAULT 0.0000,
        health_score INT NOT NULL DEFAULT 100,
        status VARCHAR(32) NOT NULL DEFAULT 'HEALTHY',
        actions_taken TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created_at (created_at),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // ====================================================

    // 🛡️ 보안 이벤트 로그 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        ip VARCHAR(64) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        path VARCHAR(500) NOT NULL,
        reason VARCHAR(255) NOT NULL,
        country VARCHAR(10) NULL,
        country_name VARCHAR(100) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ip (ip),
        INDEX idx_event_type (event_type),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 💬 실시간 유저 커뮤니티 채팅 메시지 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(64) NOT NULL,
        avatar VARCHAR(255) NULL,
        message VARCHAR(500) NOT NULL,
        is_admin TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created_at (created_at),
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [chatRoomIdCol] = await connection.query("SHOW COLUMNS FROM chat_messages LIKE 'room_id'");
    if (!chatRoomIdCol.length) {
      await connection.query('ALTER TABLE chat_messages ADD COLUMN room_id BIGINT NOT NULL DEFAULT 1');
      await connection.query('ALTER TABLE chat_messages ADD INDEX idx_room_id (room_id)');
    }
    await connection.query(`
      CREATE TABLE IF NOT EXISTS chat_rooms (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(16) NOT NULL,
        slug VARCHAR(64) NULL,
        title VARCHAR(100) NOT NULL,
        parent_room_id BIGINT NULL,
        parent_message_id BIGINT NULL,
        created_by VARCHAR(32) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_type (type),
        INDEX idx_parent_room (parent_room_id),
        UNIQUE KEY uniq_slug (slug)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS chat_room_members (
        room_id BIGINT NOT NULL,
        user_id VARCHAR(32) NOT NULL,
        last_read_id BIGINT NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (room_id, user_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(
      `INSERT IGNORE INTO chat_rooms (id, type, slug, title) VALUES
       (1, 'channel', 'plaza', '광장'),
       (2, 'channel', 'trade', '거래'),
       (3, 'channel', 'lounge', '잡담')`
    );
    await connection.query('ALTER TABLE chat_rooms AUTO_INCREMENT = 10');

    // 우리만의 독창적인 가상 커뮤니티 기업/종목 초기화 시드
    const defaultStocks = [
      { 
        stock_id: 'WTRD', 
        name: '월덕 인터내셔널 (지주사)', 
        price: 50000, 
        prev_price: 49500, 
        volatility: 0.03,
        sector: '커뮤니티 지주 & AI 플랫폼',
        description: '월덕 봇과 디스코드 커뮤니티 전반의 인프라를 총괄 운영하는 핵심 지주회사입니다. 안정적인 배당과 탄탄한 수익 기반을 보유하고 있습니다.',
        market_cap: 5000000000000,
        pe_ratio: 18.50,
        dividend_yield: 4.20
      },
      { 
        stock_id: 'MINE', 
        name: '월덕 광업 & 제련 (채굴/골드)', 
        price: 12500, 
        prev_price: 12100, 
        volatility: 0.05,
        sector: '자원 개발 & 골드 채굴',
        description: '클리커 광산에서 유저들이 채굴한 원석과 다이아몬드를 제련하여 서버 경제에 공급하는 자원 개발 대표 기업입니다.',
        market_cap: 1800000000000,
        pe_ratio: 12.00,
        dividend_yield: 2.80
      },
      { 
        stock_id: 'CASN', 
        name: '황금오리 카지노 & 엔터 (게이밍)', 
        price: 35000, 
        prev_price: 33800, 
        volatility: 0.07,
        sector: '카지노 게이밍 & 엔터테인먼트',
        description: '3릴 슬롯머신, 주사위 배틀, 코인플립 등 서버 내 모든 카지노 시설을 독점 운영하는 최대 엔터테인먼트 복합 기업입니다.',
        market_cap: 2500000000000,
        pe_ratio: 24.00,
        dividend_yield: 3.50
      },
      { 
        stock_id: 'BANK', 
        name: '덕스 중앙은행 & 파이낸스 (금융)', 
        price: 85000, 
        prev_price: 84200, 
        volatility: 0.02,
        sector: '서버 기축 금융 & 예금/지원금',
        description: '커뮤니티 내 유저 예금 보관, 기본소득 구제 지원금 집행 및 이자 지급을 전담하는 초우량 국책 금융기관입니다.',
        market_cap: 4200000000000,
        pe_ratio: 9.80,
        dividend_yield: 5.50
      },
      { 
        stock_id: 'NEKO', 
        name: '네코 에너지 & 냥코 랩스 (양자)', 
        price: 8800, 
        prev_price: 9200, 
        volatility: 0.09,
        sector: '초전도 양자 & 미래 에너지',
        description: '신비한 고양이 꾹꾹이 에너지로 봇 서버 냉각 및 초전도 양자 컴퓨팅을 연구하는 최고 변동성의 미래 혁신 벤처입니다.',
        market_cap: 680000000000,
        pe_ratio: 65.00,
        dividend_yield: 0.50
      },
      { 
        stock_id: 'CHKN', 
        name: '황금닭 치킨 & 푸드 테크 (소비재)', 
        price: 3500, 
        prev_price: 3450, 
        volatility: 0.02,
        sector: '식음료 & 스테미나 푸드',
        description: '밤샘 도박과 주식 투자를 즐기는 유저들에게 바삭한 치킨과 스테미나 음료를 공급하는 국민 프랜차이즈 기업입니다.',
        market_cap: 450000000000,
        pe_ratio: 14.50,
        dividend_yield: 3.80
      },
      { 
        stock_id: 'SLOT', 
        name: '럭키세븐 다이아 복권 (초보입문/국민주)', 
        price: 100,  
        prev_price: 100, 
        volatility: 0.06,
        sector: '초보자 입문 & 복권/테마',
        description: '💡 [신규 유저 추천] 1주당 100원의 국민 입문주! 가입 직후 초기 자금으로도 부담 없이 수십 주를 즉시 매수하여 주식 투자를 시작할 수 있습니다.',
        market_cap: 50000000000,
        pe_ratio: 15.00,
        dividend_yield: 1.50
      },
      { 
        stock_id: 'SCRP', 
        name: '이지스크랩 데이터 테크 (빅데이터)', 
        price: 120000, 
        prev_price: 118000, 
        volatility: 0.04,
        sector: '빅데이터 & 고속 웹 인프라',
        description: '초당 10만 건의 웹 데이터를 가공 분석하여 실시간 차트와 증시 정보를 제공하는 이지스크랩의 데이터 테크놀로지 기업입니다.',
        market_cap: 3800000000000,
        pe_ratio: 32.00,
        dividend_yield: 1.20
      },
      {
        stock_id: 'AICH',
        name: '오리 인공지능 & 퀀텀 칩스 (AI 반도체)',
        price: 150000,
        prev_price: 148000,
        volatility: 0.05,
        sector: 'AI 반도체 & NPU 가속기',
        description: '차세대 뉴럴 프로세서(NPU) 및 고성능 AI 가속기를 설계·양산하는 월덕 생태계 최고 기술력의 반도체 대장주입니다.',
        market_cap: 5200000000000,
        pe_ratio: 38.00,
        dividend_yield: 1.80
      },
      {
        stock_id: 'SPAC',
        name: '덕스 에어로스페이스 & 방산 (우주항공)',
        price: 65000,
        prev_price: 63500,
        volatility: 0.05,
        sector: '우주항공 & 국방 방위산업',
        description: '우주 로켓 발사체, 통신 인공위성 및 무인 방산 드론을 생산하는 국가 안보 핵심 우주항공 기업입니다.',
        market_cap: 2900000000000,
        pe_ratio: 21.00,
        dividend_yield: 3.00
      },
      {
        stock_id: 'BIOX',
        name: '월덕 바이오 파마 (생명공학/신약)',
        price: 42000,
        prev_price: 41000,
        volatility: 0.07,
        sector: '바이오 헬스케어 & 신약 개발',
        description: '불로장생 항암 신약 물질 및 고효능 바이오 펩타이드 치료제를 임상 개발하는 고수익 바이오테크 혁신 기업입니다.',
        market_cap: 1750000000000,
        pe_ratio: 45.00,
        dividend_yield: 0.80
      },
      {
        stock_id: 'LUXU',
        name: '황금오리 럭셔리 & 부티크 (명품/소비재)',
        price: 280000,
        prev_price: 279000,
        volatility: 0.03,
        sector: '글로벌 명품 패션 & 하이엔드 쥬얼리',
        description: '다이아몬드 오리 시계, VIP 한정판 가죽 제품 및 프리미엄 명품 브랜드를 독점 전개하는 최고가 명품 지주사입니다.',
        market_cap: 6400000000000,
        pe_ratio: 18.50,
        dividend_yield: 4.50
      },
      {
        stock_id: 'AUTO',
        name: '덕스 모빌리티 & 자율주행 (전기차)',
        price: 38000,
        prev_price: 37200,
        volatility: 0.06,
        sector: '자율주행 전기차 & 미래 모빌리티',
        description: '레벨 4 완전 자율주행 알고리즘과 차세대 수소/전기 하이퍼카를 양산하는 스마트 모빌리티 혁신 선도 기업입니다.',
        market_cap: 2100000000000,
        pe_ratio: 28.00,
        dividend_yield: 2.20
      },
      { stock_id: 'NVAI', name: '엔비덕스 AI 칩셋 & 가속기 (반도체/AI)', price: 45000, prev_price: 45000, volatility: 0.06, sector: 'AI 반도체', description: '생성형 AI 전용 NPU 및 초고대역폭 메모리 가속기를 설계/공급하는 글로벌 반도체 팹리스 기업입니다.', market_cap: 4500000000000, pe_ratio: 35.2, dividend_yield: 1.2 },
      { stock_id: 'QNTM', name: '퀀텀 넥서스 컴퓨팅 (양자컴퓨팅)', price: 18000, prev_price: 18000, volatility: 0.08, sector: '양자컴퓨팅', description: '초전도 큐비트 기반 차세대 양자 암호 및 초고속 양자 시뮬레이터를 개발하는 미래 기술 기업입니다.', market_cap: 1800000000000, pe_ratio: 58.0, dividend_yield: 0.5 },
      { stock_id: 'ROBX', name: '사이버덕스 휴머노이드 로보틱스 (로봇)', price: 28000, prev_price: 28000, volatility: 0.07, sector: '지능형 로봇', description: '산업용 협동 로봇 및 딥러닝 비전 기반 이족보행 휴머노이드 로봇을 양산하는 자동화 전문 기업입니다.', market_cap: 2800000000000, pe_ratio: 42.0, dividend_yield: 1.0 },
      { stock_id: 'CLOD', name: '하이퍼스케일 클라우드 인프라 (클라우드)', price: 34000, prev_price: 34000, volatility: 0.04, sector: '데이터/클라우드', description: '대규모 분산 서버 센터와 초저지연 CDN 및 엔터프라이즈 SaaS 인프라를 독점 운영하는 클라우드 기업입니다.', market_cap: 3400000000000, pe_ratio: 22.5, dividend_yield: 2.5 },
      { stock_id: 'SATL', name: '스타링크 스페이스 궤도통신 (우주항공)', price: 22000, prev_price: 22000, volatility: 0.06, sector: '우주/위성', description: '저궤도 군집 인공위성을 통한 초고속 글로벌 우주 인터넷망 구축 및 발사체 수송 기업입니다.', market_cap: 2200000000000, pe_ratio: 38.0, dividend_yield: 0.8 },
      { stock_id: 'SEMI', name: '파운드리 실리콘 팹 (초미세공정)', price: 52000, prev_price: 52000, volatility: 0.03, sector: '반도체 제조', description: '2나노 이하 차세대 게이트올어라운드(GAA) 초미세 파운드리 생산 라인을 가동하는 제조 파운드리입니다.', market_cap: 5200000000000, pe_ratio: 16.8, dividend_yield: 3.2 },
      { stock_id: 'CYBR', name: '아이언실드 사이버 시큐리티 (보안)', price: 16500, prev_price: 16500, volatility: 0.05, sector: '정보보안', description: '제로 트러스트 아키텍처 및 AI 기반 지능형 위협 탐지 시스템을 공급하는 국가 핵심 보안 기업입니다.', market_cap: 1650000000000, pe_ratio: 25.0, dividend_yield: 2.0 },
      { stock_id: 'META', name: '홀로그램 메타버스 & VR (가상현실)', price: 14000, prev_price: 14000, volatility: 0.08, sector: '메타버스/XR', description: '공간 컴퓨팅 헤드셋과 초실감 버추얼 월드 플랫폼을 구축하는 몰입형 XR 엔터테인먼트 기업입니다.', market_cap: 1400000000000, pe_ratio: 45.0, dividend_yield: 0.6 },
      { stock_id: 'GENE', name: '유전자 가위 테라퓨틱스 (유전자치료)', price: 26000, prev_price: 26000, volatility: 0.07, sector: '바이오/신약', description: 'CRISPR-Cas9 유전체 교정 기술로 난치성 유전 질환 치료제를 임상 개발하는 혁신 바이오텍입니다.', market_cap: 2600000000000, pe_ratio: 50.0, dividend_yield: 0.5 },
      { stock_id: 'MEDI', name: '스마트 메디컬 AI 진단 (헬스케어)', price: 19500, prev_price: 19500, volatility: 0.05, sector: '디지털 헬스', description: 'CT·MRI 영상 판독 인공지능 솔루션과 원격 스마트 헬스케어 플랫폼을 제공하는 의료 AI 선도기업입니다.', market_cap: 1950000000000, pe_ratio: 28.0, dividend_yield: 1.5 },
      { stock_id: 'VACC', name: '나노 백신 바이오로직스 (면역항암제)', price: 31000, prev_price: 31000, volatility: 0.06, sector: '바이오/항암제', description: 'mRNA 플랫폼과 지질나노입자(LNP) 전달체를 활용한 표적 면역 항암 신약을 개발하는 바이오 기업입니다.', market_cap: 3100000000000, pe_ratio: 34.0, dividend_yield: 1.0 },
      { stock_id: 'CARE', name: '실버케어 & 바이오 에이징 (항노화)', price: 15000, prev_price: 15000, volatility: 0.04, sector: '항노화/실버', description: '세포 역노화 치료제 및 초고령 사회 맞춤형 프리미엄 스마트 실버 케어 타운을 운영하는 기업입니다.', market_cap: 1500000000000, pe_ratio: 18.0, dividend_yield: 2.8 },
      { stock_id: 'BATT', name: '전고체 기가 팩토리 2차전지 (배터리)', price: 42000, prev_price: 42000, volatility: 0.06, sector: '2차전지', description: '화재 위험이 없는 차세대 전고체 배터리와 LFP 고밀도 배터리 셀을 대량 양산하는 에너지 기업입니다.', market_cap: 4200000000000, pe_ratio: 29.0, dividend_yield: 1.8 },
      { stock_id: 'SOLR', name: '넥스트 퓨처 태양광 & 신재생 (친환경)', price: 11500, prev_price: 11500, volatility: 0.05, sector: '친환경 에너지', description: '페로브스카이트 탠덤 태양광 패널과 대용량 산업용 ESS 전력망을 구축하는 클린테크 기업입니다.', market_cap: 1150000000000, pe_ratio: 15.0, dividend_yield: 3.5 },
      { stock_id: 'HYDR', name: '블루 하이드로겐 수소 에너지 (수소)', price: 23000, prev_price: 23000, volatility: 0.06, sector: '수소 경제', description: '청정 수전해 그린 수소 생산 및 액화 수소 운송 충전 인프라를 공급하는 수소 밸류체인 기업입니다.', market_cap: 2300000000000, pe_ratio: 32.0, dividend_yield: 1.2 },
      { stock_id: 'EVMD', name: '자율주행 모빌리티 디바이스 (미래차)', price: 38000, prev_price: 38000, volatility: 0.05, sector: '미래 모빌리티', description: '레벨4 도심 자율주행 소프트웨어 및 전동화 플랫폼을 완성차에 공급하는 모빌리티 테크 기업입니다.', market_cap: 3800000000000, pe_ratio: 26.0, dividend_yield: 2.0 },
      { stock_id: 'ATOM', name: 'SMR 차세대 소형원자로 (원자력)', price: 27500, prev_price: 27500, volatility: 0.05, sector: '차세대 원전', description: '무탄소 청정 에너지원인 4세대 소형 모듈 원자로(SMR) 설계 및 주기기 제작 대표 기업입니다.', market_cap: 2750000000000, pe_ratio: 21.0, dividend_yield: 2.6 },
      { stock_id: 'GAME', name: '넥서스 인터랙티브 AAA 게임즈 (게임)', price: 29000, prev_price: 29000, volatility: 0.06, sector: '게임 개발', description: '언리얼 엔진5 기반 글로벌 크로스플랫폼 오픈월드 AAA RPG 대작을 개발하는 게임 스튜디오입니다.', market_cap: 2900000000000, pe_ratio: 24.0, dividend_yield: 2.2 },
      { stock_id: 'KPOP', name: '스타덤 글로벌 엔터테인먼트 (K-POP)', price: 36000, prev_price: 36000, volatility: 0.07, sector: 'K-POP/엔터', description: '빌보드 핫100 1위 글로벌 최정상 아이돌 그룹 및 팬덤 커뮤니티 플랫폼을 운영하는 종합 엔터테인먼트사입니다.', market_cap: 3600000000000, pe_ratio: 31.0, dividend_yield: 2.0 },
      { stock_id: 'TOON', name: 'K-스토리 글로벌 웹툰 & 애니 (콘텐츠)', price: 17500, prev_price: 17500, volatility: 0.05, sector: '웹툰/콘텐츠', description: '글로벌 1억 뷰 웹툰 IP를 보유하고 넷플릭스·OTT 드라마 영상화 판권을 수출하는 K-스토리 대표 기업입니다.', market_cap: 1750000000000, pe_ratio: 27.0, dividend_yield: 1.6 },
      { stock_id: 'FILM', name: '시네마틱 유니버스 스튜디오 (미디어)', price: 21000, prev_price: 21000, volatility: 0.05, sector: '영화/미디어', description: '헐리우드급 버추얼 프로덕션 VFX 특수효과 및 글로벌 블록버스터 영화 제작을 총괄하는 스튜디오입니다.', market_cap: 2100000000000, pe_ratio: 20.0, dividend_yield: 2.4 },
      { stock_id: 'SPRT', name: 'e스포츠 프로리그 & 스트리밍 (방송)', price: 13000, prev_price: 13000, volatility: 0.06, sector: 'e스포츠/방송', description: '롤드컵/발로란트 명문 프로게임단 운영 및 라이브 인터랙티브 게임 스트리밍 플랫폼 기업입니다.', market_cap: 1300000000000, pe_ratio: 23.0, dividend_yield: 1.5 },
      { stock_id: 'RAMN', name: 'K-스파이시 불닭 라면 인터내셔널 (K-푸드)', price: 16000, prev_price: 16000, volatility: 0.03, sector: '식음료/식품', description: '전 세계 100개국에 K-매운맛 신드롬을 일으키며 연간 20억 봉지의 라면을 수출하는 글로벌 식품사입니다.', market_cap: 1600000000000, pe_ratio: 16.0, dividend_yield: 3.8 },
      { stock_id: 'BEAU', name: 'K-글로우 코스메틱 & 뷰티 (K-뷰티)', price: 24500, prev_price: 24500, volatility: 0.04, sector: '화장품/뷰티', description: '피부 장벽 강화 바이오 코스메슈티컬 및 글로벌 인디 뷰티 브랜드를 아마존 1위에 올린 K-뷰티 기업입니다.', market_cap: 2450000000000, pe_ratio: 19.5, dividend_yield: 3.0 },
      { stock_id: 'FASH', name: '하이엔드 스트리트웨어 패션 (패션)', price: 19000, prev_price: 19000, volatility: 0.05, sector: '패션/의류', description: 'MZ세대 워너비 디자이너 스트리트 패션 브랜드와 한정판 스니커즈 리셀 플랫폼을 운영하는 기업입니다.', market_cap: 1900000000000, pe_ratio: 22.0, dividend_yield: 2.1 },
      { stock_id: 'MART', name: '초신선 로켓 물류 & e커머스 (유통)', price: 33000, prev_price: 33000, volatility: 0.04, sector: '물류/유통', description: '새벽 배송 풀필먼트 물류 센터와 AI 수요 예측 풀필먼트 네트워크를 독점 보유한 유통 공룡입니다.', market_cap: 3300000000000, pe_ratio: 25.0, dividend_yield: 1.8 },
      { stock_id: 'COFF', name: '프리미엄 로스터리 커피 & 카페 (음료)', price: 12000, prev_price: 12000, volatility: 0.03, sector: '카페/프랜차이즈', description: '스페셜티 원두 직수입 로스팅 및 전국 3,000개 스마트 드라이브스루 매장을 직영하는 카페 브랜드입니다.', market_cap: 1200000000000, pe_ratio: 15.5, dividend_yield: 4.0 },
      { stock_id: 'PAYX', name: '글로벌 핀테크 & 간편결제 (전자결제)', price: 28500, prev_price: 28500, volatility: 0.04, sector: '핀테크/금융', description: '초간편 원터치 QR/NFC 온오프라인 결제 게이트웨이 및 소액 해외 송금을 독점 제공하는 금융 플랫폼입니다.', market_cap: 2850000000000, pe_ratio: 26.5, dividend_yield: 2.2 },
      { stock_id: 'REIT', name: '월덕 강남 프라임 오피스 리츠 (부동산)', price: 9500, prev_price: 9500, volatility: 0.02, sector: '부동산 리츠', description: '테헤란로 초고층 랜드마크 프라임 빌딩을 소유하여 매월 안정적인 임대 수익 배당을 지급하는 리츠입니다.', market_cap: 950000000000, pe_ratio: 11.0, dividend_yield: 6.8 },
      { stock_id: 'ARMS', name: '썬더볼트 첨단 유도미사일 방산 (K-방산)', price: 48000, prev_price: 48000, volatility: 0.05, sector: '방위산업', description: '스텔스 무인 전투기, 천궁 유도무기 및 K2 전차 자주포를 나토(NATO)에 대량 수출하는 K-방산 대표 기업입니다.', market_cap: 4800000000000, pe_ratio: 17.5, dividend_yield: 3.5 }
    ];

    for (const stock of defaultStocks) {
      await connection.query(`
        INSERT INTO stocks (stock_id, name, price, prev_price, volatility, sector, description, market_cap, pe_ratio, dividend_yield)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
          name=VALUES(name), 
          volatility=VALUES(volatility),
          sector=VALUES(sector),
          description=VALUES(description),
          market_cap=VALUES(market_cap),
          pe_ratio=VALUES(pe_ratio),
          dividend_yield=VALUES(dividend_yield);
      `, [
        stock.stock_id, stock.name, stock.price, stock.prev_price, stock.volatility,
        stock.sector, stock.description, stock.market_cap, stock.pe_ratio, stock.dividend_yield
      ]);
    }

    // ✅ defaultStocks에 정의된 종목코드 목록만 추출 (인적분할·관리자 IPO·재상장 종목은 절대 삭제 안 함)
    const defaultStockIds = defaultStocks.map(s => `'${s.stock_id}'`).join(', ');
    // 기본 목록에 없어도 관리자가 생성하거나 이벤트로 상장된 종목은 모두 보존:
    // - market_news_feed에 STOCK_SPINOFF(인적분할) / STOCK_IPO(관리자 상장) / STOCK_RELIST(재상장) 공시가 있는 종목
    await connection.query(`
      DELETE FROM stocks
      WHERE stock_id NOT IN (${defaultStockIds})
        AND stock_id NOT IN (
          SELECT DISTINCT related_stock FROM market_news_feed
          WHERE event_type IN ('STOCK_SPINOFF', 'STOCK_IPO', 'STOCK_RELIST')
            AND related_stock IS NOT NULL
        )
    `);



    await connection.query(`
      CREATE TABLE IF NOT EXISTS bank_loans (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        user_id VARCHAR(32) NOT NULL,
        principal DECIMAL(65,0) NOT NULL DEFAULT 0,
        interest_accrued DECIMAL(65,0) NOT NULL DEFAULT 0,
        collateral DECIMAL(65,0) NOT NULL DEFAULT 0,
        original_principal DECIMAL(65,0) NOT NULL DEFAULT 0,
        from_treasury DECIMAL(65,0) NOT NULL DEFAULT 0,
        from_mint DECIMAL(65,0) NOT NULL DEFAULT 0,
        opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        due_at DATETIME NOT NULL,
        last_accrue_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        defaulted TINYINT NOT NULL DEFAULT 0,
        INDEX idx_loan_user_status (user_id, status),
        INDEX idx_loan_due (status, due_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_loan_credit (
        user_id VARCHAR(32) PRIMARY KEY,
        defaults INT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    console.log('✅ 데이터베이스 테이블 및 주식 초기 종목 로드 완료!');

    await ensureWideMoneyColumns(connection);
    await ensureRuntimeIndexes(connection);

    // DB 유지보수 자동 정리 실행
    await cleanupOldDatabaseLogs();
  } catch (error) {
    console.error('❌ 데이터베이스 초기화 실패:', error);
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
