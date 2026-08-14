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


    // 주식 종목 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stocks (
        stock_id VARCHAR(16) PRIMARY KEY,
        name VARCHAR(64) NOT NULL,
        price BIGINT NOT NULL,
        prev_price BIGINT NOT NULL,
        volatility DECIMAL(5,4) NOT NULL DEFAULT 0.05,
        sector VARCHAR(64) NOT NULL DEFAULT 'IT/기술',
        description TEXT NULL,
        high_24h BIGINT NOT NULL DEFAULT 0,
        low_24h BIGINT NOT NULL DEFAULT 0,
        volume_24h BIGINT NOT NULL DEFAULT 0,
        market_cap BIGINT NOT NULL DEFAULT 0,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created_at (created_at)
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

    // 기본 주식 종목 초기화 시드 (가상 패러디 명칭 및 상세 기업 분석 데이터)
    const defaultStocks = [
      { 
        stock_id: 'NVDA', 
        name: '엔비칩스 (AI반도체)', 
        price: 211105, 
        prev_price: 211657, 
        volatility: 0.04,
        sector: '인공지능 & GPU 반도체',
        description: '글로벌 초거대 생성형 AI 모델 학습용 가속기 칩 시장을 90% 이상 점유하는 최고 기술력의 빅테크 기업입니다.',
        market_cap: 3500000000000,
        pe_ratio: 42.50,
        dividend_yield: 0.50
      },
      { 
        stock_id: 'BTC', 
        name: '디스코인 (가상자산)', 
        price: 82193159, 
        prev_price: 93839069, 
        volatility: 0.08,
        sector: '디지털 자산 & 블록체인',
        description: '탈중앙화 디지털 화폐의 상징이자 가상자산 시장 전반의 유동성을 주도하는 대표 기축 코인입니다.',
        market_cap: 1600000000000,
        pe_ratio: 0.00,
        dividend_yield: 0.00
      },
      { 
        stock_id: 'ETH', 
        name: '에테르코인 (가상자산)', 
        price: 5767959, 
        prev_price: 5575796, 
        volatility: 0.06,
        sector: '스마트 컨트랙트 & Web3',
        description: '디파이(DeFi), NFT, 스마트 컨트랙트 생태계의 기반이 되는 세계 2위 블록체인 네트워크 코인입니다.',
        market_cap: 420000000000,
        pe_ratio: 0.00,
        dividend_yield: 3.20
      },
      { 
        stock_id: 'AAPL', 
        name: '사과전자 (빅테크)', 
        price: 248149, 
        prev_price: 257958, 
        volatility: 0.03,
        sector: '모바일 & 온디바이스 AI',
        description: '전 세계 수억 명의 충성 고객층을 보유한 프리미엄 스마트 디바이스 및 독자 AI 생태계 선두 기업입니다.',
        market_cap: 3200000000000,
        pe_ratio: 28.40,
        dividend_yield: 1.80
      },
      { 
        stock_id: 'SAM', 
        name: '삼송전자 (전자/반도체)', 
        price: 90418, 
        prev_price: 92922, 
        volatility: 0.03,
        sector: '종합 전자 & 메모리 반도체',
        description: 'DRAM, NAND 플래시 메모리 및 차세대 HBM 공급 역량을 보유한 아시아 대표 하드웨어 제조 기업입니다.',
        market_cap: 580000000000,
        pe_ratio: 14.20,
        dividend_yield: 2.70
      },
      { 
        stock_id: 'BIO', 
        name: '알약바이오 (초보자/안정주)', 
        price: 1000, 
        prev_price: 1000, 
        volatility: 0.01,
        sector: '바이오 & 신약 파이프라인',
        description: '난치성 질환 표적 치료제 및 글로벌 제약사 기술 수출 파이프라인을 보유한 바이오벤처 기업입니다.',
        market_cap: 120000000000,
        pe_ratio: 18.90,
        dividend_yield: 4.10
      }
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

    // 알약바이오(BIO)를 초보자가 구매하기 쉬운 저가/안정주(1,000원, 변동성 1%)로 DB 가격 갱신
    await connection.query(`
      UPDATE stocks
      SET name = '알약바이오 (초보자/안정주)', price = 1000, prev_price = 1000, volatility = 0.01
      WHERE stock_id = 'BIO';
    `);

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
