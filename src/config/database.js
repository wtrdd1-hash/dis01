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

    // 도박 및 이력 로그 테이블 (자산 스냅샷 및 롤백 복구 지원)
    await connection.query(`
      CREATE TABLE IF NOT EXISTS gambling_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        game VARCHAR(32) NOT NULL,
        bet BIGINT NOT NULL,
        payout BIGINT NOT NULL,
        profit BIGINT NOT NULL,
        balance_before BIGINT NOT NULL DEFAULT 0,
        balance_after BIGINT NOT NULL DEFAULT 0,
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
        prev_price BIGINT NOT NULL,
        new_price BIGINT NOT NULL,
        change_rate DECIMAL(6,2) NOT NULL,
        diff BIGINT NOT NULL,
        regime VARCHAR(64) NOT NULL,
        reason VARCHAR(255) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_stock_id (stock_id),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 주식 매수/매도 실시간 체결 로그 테이블
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stock_transactions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(100) NOT NULL,
        stock_id VARCHAR(16) NOT NULL,
        stock_name VARCHAR(64) NOT NULL,
        action VARCHAR(16) NOT NULL,
        amount BIGINT NOT NULL,
        price BIGINT NOT NULL,
        total_price BIGINT NOT NULL,
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
        amount BIGINT NOT NULL,
        balance_before BIGINT NOT NULL DEFAULT 0,
        balance_after BIGINT NOT NULL DEFAULT 0,
        description VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id),
        INDEX idx_type (type),
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
        total_money BIGINT NOT NULL DEFAULT 0,
        avg_wealth BIGINT NOT NULL DEFAULT 0,
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

    // 구버전 외래 종목(NVDA, BTC, ETH, AAPL, SAM, BIO)이 남아있을 경우 새로운 커뮤니티 주식으로 정리
    await connection.query(`DELETE FROM stocks WHERE stock_id NOT IN ('WTRD', 'MINE', 'CASN', 'BANK', 'NEKO', 'CHKN', 'SLOT', 'SCRP')`);

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

// 오래된 로그 데이터 자동 정돈 (웹 접속 및 보안 로그 1일 보관 정책)
async function cleanupOldDatabaseLogs() {
  try {
    // 🛡️ 웹 접속/보안 로그는 1일(24시간)만 보관 후 자동 영구 삭제
    await pool.query('DELETE FROM web_access_logs WHERE created_at < NOW() - INTERVAL 1 DAY');
    await pool.query('DELETE FROM security_events WHERE created_at < NOW() - INTERVAL 1 DAY');

    // 일반 시스템/경제 로그 30일 보관
    await pool.query('DELETE FROM command_logs WHERE created_at < NOW() - INTERVAL 30 DAY');
    await pool.query('DELETE FROM gambling_logs WHERE created_at < NOW() - INTERVAL 30 DAY');
    await pool.query('DELETE FROM admin_logs WHERE created_at < NOW() - INTERVAL 30 DAY');
    await pool.query('DELETE FROM stock_price_logs WHERE created_at < NOW() - INTERVAL 30 DAY');
    await pool.query('DELETE FROM stock_transactions WHERE created_at < NOW() - INTERVAL 30 DAY');
    await pool.query('DELETE FROM economy_logs WHERE created_at < NOW() - INTERVAL 30 DAY');
    await pool.query('DELETE FROM market_news_feed WHERE created_at < NOW() - INTERVAL 30 DAY');
    await pool.query('DELETE FROM stock_history WHERE recorded_at < NOW() - INTERVAL 30 DAY');
    console.log('🧹 [로그 정돈] 웹 접속/보안 로그(1일 초과) 및 일반 로그 자동 정돈 완료');
  } catch (err) {
    console.warn('⚠️ DB 로그 정돈 경고:', err.message);
  }
}

// 1시간 주기로 1일 초과 웹 접속/보안 로그 자동 정돈 스케줄러 등록
setInterval(cleanupOldDatabaseLogs, 60 * 60 * 1000);

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
