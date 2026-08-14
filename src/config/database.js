const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool(config.db);

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
    console.warn('⚠️ 데이터베이스 연결 실패로 인해 테이블 초기화를 건너뜁니다.');
    return;
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
        cash BIGINT NOT NULL DEFAULT 50000,
        bank BIGINT NOT NULL DEFAULT 0,
        last_daily DATETIME NULL,
        daily_streak INT NOT NULL DEFAULT 0,
        last_work DATETIME NULL,
        github_id VARCHAR(64) NULL,
        github_username VARCHAR(100) NULL,
        github_linked_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 기존 users 테이블에 username / avatar 컬럼 추가 (안전 대처)
    const [userCols] = await connection.query(`SHOW COLUMNS FROM users LIKE 'username';`);
    if (userCols.length === 0) {
      await connection.query(`
        ALTER TABLE users 
        ADD COLUMN username VARCHAR(100) NULL,
        ADD COLUMN avatar VARCHAR(255) NULL;
      `);
      console.log('✅ users 테이블에 username 및 avatar 컬럼이 추가되었습니다.');
    }


    // 주식 종목 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stocks (
        stock_id VARCHAR(16) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        price BIGINT NOT NULL,
        prev_price BIGINT NOT NULL,
        volatility DECIMAL(5,4) NOT NULL DEFAULT 0.05,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 주식 가격 히스토리 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        stock_id VARCHAR(16) NOT NULL,
        price BIGINT NOT NULL,
        recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_stock_id_recorded (stock_id, recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 유저 보유 주식 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS user_stocks (
        user_id VARCHAR(32) NOT NULL,
        stock_id VARCHAR(16) NOT NULL,
        amount BIGINT NOT NULL DEFAULT 0,
        total_spent BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, stock_id),
        INDEX idx_user_id (user_id),
        INDEX idx_stock_id (stock_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 도박 및 이력 로그 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS gambling_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        game VARCHAR(32) NOT NULL,
        bet BIGINT NOT NULL,
        payout BIGINT NOT NULL,
        profit BIGINT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_game (user_id, game)
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

    // 기본 주식 종목 초기화 시드 (현실적인 실시간 주가 시세 기준)
    const defaultStocks = [
      { stock_id: 'BTC', name: '비트코인 (가상자산)', price: 82193159, prev_price: 93839069, volatility: 0.08 },
      { stock_id: 'ETH', name: '이더리움 (가상자산)', price: 5767959, prev_price: 5575796, volatility: 0.06 },
      { stock_id: 'AAPL', name: '애플 (빅테크)', price: 248149, prev_price: 257958, volatility: 0.03 },
      { stock_id: 'NVDA', name: '엔비디아 (AI)', price: 211105, prev_price: 211657, volatility: 0.04 },
      { stock_id: 'SAM', name: '삼성전자 (반도체)', price: 90418, prev_price: 92922, volatility: 0.03 },
      { stock_id: 'BIO', name: 'K-바이오 (제약)', price: 36354, prev_price: 39427, volatility: 0.05 }
    ];

    for (const stock of defaultStocks) {
      await connection.query(`
        INSERT INTO stocks (stock_id, name, price, prev_price, volatility)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE name=VALUES(name), price=VALUES(price), prev_price=VALUES(prev_price), volatility=VALUES(volatility);
      `, [stock.stock_id, stock.name, stock.price, stock.prev_price, stock.volatility]);
    }

    console.log('✅ 데이터베이스 테이블 및 주식 초기 종목 로드 완료!');
    
    // DB 유지보수 자동 정리 실행
    await cleanupOldDatabaseLogs();
  } catch (error) {
    console.error('❌ 데이터베이스 초기화 실패:', error);
    throw error;
  } finally {
    connection.release();
  }
}

// 오래된 로그 데이터 자동 정돈 (DB 성능 유지 및 용량 최적화)
async function cleanupOldDatabaseLogs() {
  try {
    await pool.query('DELETE FROM command_logs WHERE created_at < NOW() - INTERVAL 14 DAY');
    await pool.query('DELETE FROM gambling_logs WHERE created_at < NOW() - INTERVAL 30 DAY');
    console.log('🧹 DB 성능 최적화: 오래된 수집 로그 자동 정돈 완료');
  } catch (err) {
    console.warn('⚠️ DB 로그 정돈 경고:', err.message);
  }
}

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
  cleanupOldDatabaseLogs
};
