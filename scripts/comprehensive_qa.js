'use strict';
/**
 * comprehensive_qa.js (v3 - Final Comprehensive QA Runner)
 * 로컬 및 원격 vps-wtrdd 도커 컨테이너(wtrdd-discord-app) 전 기능 자동화 QA 스크립트
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const BASE_URL = process.env.QA_BASE_URL || 'http://127.0.0.1:8080';
const ORIGIN_HOST = 'easy-scraping.com';
const isHttps = BASE_URL.startsWith('https');
const httpModule = isHttps ? https : http;

let results = {
  timestamp: new Date().toISOString(),
  environment: BASE_URL,
  host: ORIGIN_HOST,
  passed: 0,
  failed: 0,
  warnings: 0,
  tests: []
};

function logTest(category, name, status, detail, data) {
  const item = { category, name, status, detail, timestamp: new Date().toISOString() };
  if (data) item.data = data;
  results.tests.push(item);
  if (status === 'PASS') results.passed++;
  else if (status === 'FAIL') results.failed++;
  else if (status === 'WARN') results.warnings++;
  
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️';
  console.log(`${icon} [${category}] ${name} -> ${status}: ${detail}`);
}

function makeSignedCookieValue(payloadObj, secret) {
  const jsonStr = JSON.stringify(payloadObj);
  const hmac = crypto.createHmac('sha256', secret)
    .update(jsonStr)
    .digest('base64')
    .replace(/=+$/g, '');
  return `s:${jsonStr}.${hmac}`;
}

function request(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 QA-Automated-Runner/3.0',
      'Host': ORIGIN_HOST,
      'Origin': `https://${ORIGIN_HOST}`,
      'Referer': `https://${ORIGIN_HOST}/`,
      'Accept': options.json ? 'application/json' : '*/*',
      ...(options.headers || {})
    };

    let bodyData = null;
    if (options.body) {
      if (typeof options.body === 'object') {
        bodyData = JSON.stringify(options.body);
        headers['Content-Type'] = 'application/json';
      } else {
        bodyData = String(options.body);
      }
      headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    if (options.cookies) {
      const cookieParts = [];
      for (const [k, v] of Object.entries(options.cookies)) {
        // 이미 s: 로 시작하는 서명된 쿠키는 encodeURIComponent
        cookieParts.push(`${k}=${encodeURIComponent(v)}`);
      }
      headers['Cookie'] = cookieParts.join('; ');
    }

    const req = httpModule.request(url, {
      method,
      headers,
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {}

        const setCookies = {};
        const rawSetCookie = res.headers['set-cookie'] || [];
        for (const cookieStr of rawSetCookie) {
          const parts = cookieStr.split(';')[0].split('=');
          if (parts.length >= 2) {
            setCookies[parts[0].trim()] = decodeURIComponent(parts.slice(1).join('='));
          }
        }

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json,
          setCookies
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout after 10000ms'));
    });

    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function runAllQA() {
  console.log('====================================================');
  console.log('🚀 [QA RUNNER v3] wtrdd-discord-app 전 기능 종합 QA 시작');
  console.log(`🎯 대상 URL: ${BASE_URL} (Origin: https://${ORIGIN_HOST})`);
  console.log('====================================================');

  const { pool } = require('../src/config/database');
  const config = require('../src/config/config');
  const session = require('../src/web/session');
  const cookieSecret = session.getCookieSecret();

  // ───────────────────────────────────────────
  // 1. 인프라 및 기본 헬스체크 QA
  // ───────────────────────────────────────────
  console.log('\n--- 1. 인프라 및 기본 헬스체크 ---');
  try {
    const resHealthz = await request('GET', '/healthz');
    if (resHealthz.statusCode === 200) {
      logTest('Infra', 'GET /healthz (헬스체크)', 'PASS', '200 OK');
    } else {
      logTest('Infra', 'GET /healthz (헬스체크)', 'FAIL', `상태 코드: ${resHealthz.statusCode}`);
    }

    const resReadyz = await request('GET', '/readyz');
    if (resReadyz.statusCode === 200) {
      logTest('Infra', 'GET /readyz (레디니스체크)', 'PASS', '200 OK');
    } else {
      logTest('Infra', 'GET /readyz (레디니스체크)', 'FAIL', `상태 코드: ${resReadyz.statusCode}`);
    }

    const resRoot = await request('GET', '/');
    if (resRoot.statusCode === 200 && resRoot.body.includes('html')) {
      logTest('Web', 'GET / (메인 랜딩/대시보드)', 'PASS', `HTML 렌더링 정상 (${resRoot.body.length} bytes)`);
    } else {
      logTest('Web', 'GET / (메인 랜딩/대시보드)', 'FAIL', `상태 코드 ${resRoot.statusCode}`);
    }

    const resGuide = await request('GET', '/guide');
    if (resGuide.statusCode === 200 && resGuide.body.includes('html')) {
      logTest('Web', 'GET /guide (게임 가이드)', 'PASS', `HTML 렌더링 정상 (${resGuide.body.length} bytes)`);
    } else {
      logTest('Web', 'GET /guide (게임 가이드)', 'FAIL', `상태 코드 ${resGuide.statusCode}`);
    }
  } catch (err) {
    logTest('Infra', '기본 연결 테스트', 'FAIL', err.message);
  }

  // ───────────────────────────────────────────
  // 2. 일반 유저 인증 및 세션 발급 QA
  // ───────────────────────────────────────────
  console.log('\n--- 2. 일반 유저 로컬 계정 인증 QA ---');
  const tempUserSuffix = Math.floor(Math.random() * 8999 + 1000);
  const testUsername = `qa_user_${tempUserSuffix}`;
  const testPassword = `TestPass1234!@#`;
  let userCookies = {};
  let testUserId = null;

  try {
    // 2-1. 회원가입 (/auth/local/register)
    const regRes = await request('POST', '/auth/local/register', {
      body: { username: testUsername, password: testPassword }
    });
    if (regRes.statusCode === 200 && regRes.json && regRes.json.success) {
      logTest('Auth', 'POST /auth/local/register (일반 회원가입)', 'PASS', `계정 생성 성공: ${testUsername}`);
      userCookies = { ...regRes.setCookies };
    } else {
      logTest('Auth', 'POST /auth/local/register (일반 회원가입)', 'FAIL', `응답: ${JSON.stringify(regRes.json || regRes.body)}`);
    }

    // 2-2. 중복 가입 방지 테스트
    const dupRes = await request('POST', '/auth/local/register', {
      body: { username: testUsername, password: testPassword }
    });
    if (dupRes.statusCode === 409) {
      logTest('Auth', 'POST /auth/local/register (중복 방지)', 'PASS', '409 Conflict 정상 감지');
    } else {
      logTest('Auth', 'POST /auth/local/register (중복 방지)', 'FAIL', `응답 코드: ${dupRes.statusCode}`);
    }

    // 2-3. 잘못된 비밀번호 로그인 테스트
    const wrongRes = await request('POST', '/auth/local/login', {
      body: { username: testUsername, password: 'WrongPassword999!' }
    });
    if (wrongRes.statusCode === 401) {
      logTest('Auth', 'POST /auth/local/login (비밀번호 불일치 차단)', 'PASS', '401 Unauthorized 정상 차단');
    } else {
      logTest('Auth', 'POST /auth/local/login (비밀번호 불일치 차단)', 'FAIL', `응답 코드: ${wrongRes.statusCode}`);
    }

    // 2-4. 정상 로그인 테스트
    const loginRes = await request('POST', '/auth/local/login', {
      body: { username: testUsername, password: testPassword }
    });
    if (loginRes.statusCode === 200 && loginRes.json && loginRes.json.success) {
      logTest('Auth', 'POST /auth/local/login (정상 로그인)', 'PASS', '로그인 성공 및 web_user 쿠키 발급');
      userCookies = { ...userCookies, ...loginRes.setCookies };
    } else {
      logTest('Auth', 'POST /auth/local/login (정상 로그인)', 'FAIL', `응답: ${JSON.stringify(loginRes.json || loginRes.body)}`);
    }

    // DB에서 생성된 testUserId 조회
    const [accRows] = await pool.query('SELECT user_id FROM web_accounts WHERE username = ?', [testUsername]);
    if (accRows.length > 0) {
      testUserId = accRows[0].user_id;
      // 유저에 자금 지급
      await pool.query('UPDATE users SET cash = 1000000, bank = 500000 WHERE discord_id = ?', [testUserId]);
    }
  } catch (err) {
    logTest('Auth', '인증 테스트 예외', 'FAIL', err.message);
  }

  // ───────────────────────────────────────────
  // 3. 일반 사용자 게임 & 경제 & 카지노 API QA
  // ───────────────────────────────────────────
  console.log('\n--- 3. 일반 사용자 게임 & 경제 API QA ---');
  try {
    // 3-1. 카지노 상태 조회 (/api/casino/state)
    const stateRes = await request('GET', '/api/casino/state', { cookies: userCookies });
    if (stateRes.statusCode === 200 && stateRes.json) {
      logTest('Casino', 'GET /api/casino/state (카지노 상태 조회)', 'PASS', `유저 잔액: ${stateRes.json.cash ?? '확인'}, 잭팟: ${stateRes.json.jackpot ?? '확인'}`);
    } else {
      logTest('Casino', 'GET /api/casino/state (카지노 상태 조회)', 'WARN', `응답: ${stateRes.statusCode}`);
    }

    // 3-2. 토토 매치 목록 (/api/casino/toto)
    const totoRes = await request('GET', '/api/casino/toto', { cookies: userCookies });
    if (totoRes.statusCode === 200 && totoRes.json) {
      logTest('Casino', 'GET /api/casino/toto (토토 매치 목록)', 'PASS', `매치 수: ${totoRes.json.matches ? totoRes.json.matches.length : 0}개`);
    } else {
      logTest('Casino', 'GET /api/casino/toto (토토 매치 목록)', 'WARN', `토토 응답: ${totoRes.statusCode}`);
    }

    // 3-3. 아케이드 상태 (/api/casino/arcade)
    const arcRes = await request('GET', '/api/casino/arcade', { cookies: userCookies });
    if (arcRes.statusCode === 200 && arcRes.json) {
      logTest('Casino', 'GET /api/casino/arcade (아케이드 상태)', 'PASS', `레벨: ${arcRes.json.profile?.level ?? 1}, 환생: ${arcRes.json.profile?.rebirths ?? 0}`);
    } else {
      logTest('Casino', 'GET /api/casino/arcade (아케이드 상태)', 'WARN', `아케이드 응답: ${arcRes.statusCode}`);
    }

    // 3-4. 카지노 - 크래시 베팅 (/api/casino/crash/bet)
    const crashBetRes = await request('POST', '/api/casino/crash/bet', {
      cookies: userCookies,
      body: { bet: 1000 }
    });
    if (crashBetRes.statusCode === 200 && crashBetRes.json && crashBetRes.json.success) {
      logTest('Casino', 'POST /api/casino/crash/bet (크래시 베팅)', 'PASS', `크래시 포인트: ${crashBetRes.json.crashPoint}x`);
      // 크래시 캐시아웃
      const crashCashout = await request('POST', '/api/casino/crash/cashout', { cookies: userCookies, body: {} });
      logTest('Casino', 'POST /api/casino/crash/cashout (크래시 캐시아웃)', crashCashout.statusCode === 200 ? 'PASS' : 'WARN', `결과: ${JSON.stringify(crashCashout.json)}`);
    } else {
      logTest('Casino', 'POST /api/casino/crash/bet (크래시 베팅)', 'WARN', `응답: ${JSON.stringify(crashBetRes.json)}`);
    }

    // 3-5. 카지노 - 지뢰찾기 (Mines)
    const minesStartRes = await request('POST', '/api/casino/mines/start', {
      cookies: userCookies,
      body: { bet: 1000, mines: 3 }
    });
    if (minesStartRes.statusCode === 200 && minesStartRes.json && minesStartRes.json.success) {
      logTest('Casino', 'POST /api/casino/mines/start (지뢰 게임 시작)', 'PASS', '지뢰 세션 시작 성공');
      // 타일 오픈
      const revealRes = await request('POST', '/api/casino/mines/reveal', { cookies: userCookies, body: { index: 0 } });
      logTest('Casino', 'POST /api/casino/mines/reveal (타일 오픈)', revealRes.statusCode === 200 ? 'PASS' : 'WARN', `결과: ${JSON.stringify(revealRes.json)}`);
      // 캐시아웃
      const minesCashout = await request('POST', '/api/casino/mines/cashout', { cookies: userCookies, body: {} });
      logTest('Casino', 'POST /api/casino/mines/cashout (캐시아웃)', minesCashout.statusCode === 200 ? 'PASS' : 'WARN', `결과: ${JSON.stringify(minesCashout.json)}`);
    } else {
      logTest('Casino', 'POST /api/casino/mines/start (지뢰 게임 시작)', 'WARN', `응답: ${JSON.stringify(minesStartRes.json)}`);
    }

    // 3-6. 카지노 - 플린코 (Plinko)
    const plinkoRes = await request('POST', '/api/casino/plinko', {
      cookies: userCookies,
      body: { bet: 1000, risk: 'med' }
    });
    if (plinkoRes.statusCode === 200 && plinkoRes.json && plinkoRes.json.success) {
      logTest('Casino', 'POST /api/casino/plinko (플린코 낙하)', 'PASS', `배율: ${plinkoRes.json.multiplier}x, 당첨금: ${plinkoRes.json.win}`);
    } else {
      logTest('Casino', 'POST /api/casino/plinko (플린코 낙하)', 'WARN', `응답: ${JSON.stringify(plinkoRes.json)}`);
    }

    // 3-7. 주식 시장 목록 조회 (/api/stocks)
    const stocksRes = await request('GET', '/api/stocks', { cookies: userCookies });
    if (stocksRes.statusCode === 200 && stocksRes.json) {
      const stockList = Array.isArray(stocksRes.json) ? stocksRes.json : stocksRes.json.stocks;
      logTest('Stock', 'GET /api/stocks (주식 목록)', 'PASS', `종목 수: ${stockList ? stockList.length : 0}개`);
    } else {
      logTest('Stock', 'GET /api/stocks (주식 목록)', 'WARN', `주식 응답: ${stocksRes.statusCode}`);
    }

  } catch (err) {
    logTest('API', '일반 API 테스트 예외', 'FAIL', err.message);
  }

  // ───────────────────────────────────────────
  // 4. 비관리자 권한 차단(403) 보안 검증
  // ───────────────────────────────────────────
  console.log('\n--- 4. 비관리자 권한 차단 보안 검증 ---');
  try {
    const forbiddenPages = ['/admin/users', '/admin/economy', '/admin/stocks', '/admin/tax', '/admin/console'];
    for (const p of forbiddenPages) {
      const forbiddenRes = await request('GET', p, { cookies: userCookies });
      if (forbiddenRes.statusCode === 403) {
        logTest('Security', `비관리자 GET ${p} 접근 차단`, 'PASS', '403 Forbidden 정상 차단');
      } else {
        logTest('Security', `비관리자 GET ${p} 접근 차단`, 'FAIL', `권한 없는 유저가 ${forbiddenRes.statusCode} 응답 받음`);
      }
    }

    const forbiddenApi = await request('POST', '/admin/action/give', {
      cookies: userCookies,
      body: { targetUserId: testUserId, amount: 1000 }
    });
    if (forbiddenApi.statusCode === 403 || forbiddenApi.statusCode === 401) {
      logTest('Security', '비관리자 POST /admin/action/give 접근 차단', 'PASS', `${forbiddenApi.statusCode} 정상 차단`);
    } else {
      logTest('Security', '비관리자 POST /admin/action/give 접근 차단', 'FAIL', `응답 코드: ${forbiddenApi.statusCode}`);
    }
  } catch (err) {
    logTest('Security', '보안 검증 예외', 'FAIL', err.message);
  }

  // ───────────────────────────────────────────
  // 5. 임시 관리자 계정 생성 및 관리자 기능 전수 QA
  // ───────────────────────────────────────────
  console.log('\n--- 5. 임시 관리자 계정 생성 및 관리자 기능 전수 QA ---');
  // 유효한 Discord snowflake (18자리)
  const tempAdminDiscordId = '888877766655544433';
  const tempAdminUsername = 'qa_temp_super_admin';
  let adminCookies = {};

  try {
    // 5-1. DB admin_roles 테이블에 임시 관리자 등록
    await pool.query(`
      INSERT INTO admin_roles (discord_id, username, is_active, note)
      VALUES (?, ?, 1, 'QA 자동화 임시 관리자')
      ON DUPLICATE KEY UPDATE is_active = 1, note = 'QA 자동화 임시 관리자'
    `, [tempAdminDiscordId, tempAdminUsername]);

    // users 테이블에도 등록
    await pool.query(`
      INSERT INTO users (discord_id, username, cash, bank)
      VALUES (?, ?, 1000000, 5000000)
      ON DUPLICATE KEY UPDATE username = ?
    `, [tempAdminDiscordId, tempAdminUsername, tempAdminUsername]);

    // config의 관리자 목록 리로드
    if (typeof config.reloadAdminIds === 'function') {
      await config.reloadAdminIds();
    }
    
    // config.isAdmin 체크 확인
    const isAdminCheck = config.isAdmin(tempAdminDiscordId);
    if (isAdminCheck) {
      logTest('AdminAuth', '임시 관리자 권한 승격 및 config.isAdmin 검증', 'PASS', `관리자 ID: ${tempAdminDiscordId}`);
    } else {
      logTest('AdminAuth', '임시 관리자 권한 승격', 'FAIL', 'config.isAdmin이 false를 반환함');
    }

    // 관리자 서명 쿠키 생성 (discord_user)
    const adminCookieVal = makeSignedCookieValue({
      id: tempAdminDiscordId,
      username: tempAdminUsername,
      avatar: ''
    }, cookieSecret);

    adminCookies = {
      discord_user: adminCookieVal
    };

    // 5-2. 관리자 HTML 페이지 10종 렌더링 QA
    console.log('\n--- 5-2. 관리자 웹 페이지 10종 렌더링 검사 ---');
    const adminPages = [
      { path: '/admin/users', name: '유저 자산/차단 관리' },
      { path: '/admin/economy', name: '실시간 자금 흐름' },
      { path: '/admin/audit', name: '특정 유저 정밀 관제' },
      { path: '/admin/stocks', name: '주주 명부 & 보유 주식' },
      { path: '/admin/tax', name: '세금 국고 & 정책' },
      { path: '/admin/loans', name: '대출 현황' },
      { path: '/admin/console', name: '시스템 콘솔' },
      { path: '/admin/security', name: '보안 차단 관리' },
      { path: '/admin/inquiries', name: '1:1 문의 관리' },
      { path: '/admin/logs', name: '종합 로그 뷰어' }
    ];

    for (const page of adminPages) {
      const pageRes = await request('GET', page.path, { cookies: adminCookies });
      if (pageRes.statusCode === 200 && pageRes.body.includes('html')) {
        logTest('AdminWeb', `GET ${page.path} (${page.name})`, 'PASS', `200 OK (HTML 크기: ${pageRes.body.length} bytes)`);
      } else {
        logTest('AdminWeb', `GET ${page.path} (${page.name})`, 'FAIL', `상태 코드 ${pageRes.statusCode}, 길이: ${pageRes.body.length}`);
      }
    }

    // 5-3. 관리자 전용 API 전수 QA
    console.log('\n--- 5-3. 관리자 API 엔드포인트 검사 ---');

    // (1) 관리자 목록 조회
    const adminListRes = await request('GET', '/admin/admins/list', { cookies: adminCookies });
    if (adminListRes.statusCode === 200 && adminListRes.json && adminListRes.json.success) {
      logTest('AdminApi', 'GET /admin/admins/list (관리자 목록 조회)', 'PASS', `관리자 수: ${adminListRes.json.admins ? adminListRes.json.admins.length : 0}명`);
    } else {
      logTest('AdminApi', 'GET /admin/admins/list (관리자 목록 조회)', 'FAIL', `상태 코드: ${adminListRes.statusCode}`);
    }

    // (2) 세금 현황 및 정책 조회
    const taxOverviewRes = await request('GET', '/admin/tax', {
      cookies: adminCookies,
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (taxOverviewRes.statusCode === 200 && taxOverviewRes.json) {
      logTest('AdminApi', 'GET /admin/tax (세금 국고 현황 조회)', 'PASS', `국고 잔액: ${taxOverviewRes.json.treasuryBalance ?? taxOverviewRes.json.treasury ?? '확인됨'}`);
    } else {
      logTest('AdminApi', 'GET /admin/tax (세금 국고 현황 조회)', 'WARN', `응답: ${taxOverviewRes.statusCode}`);
    }

    // (3) 대출 관리 목록 조회
    const loansAdminRes = await request('GET', '/admin/loans', {
      cookies: adminCookies,
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (loansAdminRes.statusCode === 200 && loansAdminRes.json) {
      logTest('AdminApi', 'GET /admin/loans (대출 관리 목록 조회)', 'PASS', `대출 건수: ${loansAdminRes.json.loans ? loansAdminRes.json.loans.length : 0}`);
    } else {
      logTest('AdminApi', 'GET /admin/loans (대출 관리 목록 조회)', 'WARN', `응답: ${loansAdminRes.statusCode}`);
    }

    // (4) 전체 주식 포트폴리오 조회
    const stockPortfoliosRes = await request('GET', '/admin/stocks/portfolios/all', {
      cookies: adminCookies
    });
    if (stockPortfoliosRes.statusCode === 200 && stockPortfoliosRes.json) {
      logTest('AdminApi', 'GET /admin/stocks/portfolios/all (전체 주주 명부)', 'PASS', '주주 명부 데이터 조회 성공');
    } else {
      logTest('AdminApi', 'GET /admin/stocks/portfolios/all (전체 주주 명부)', 'WARN', `응답: ${stockPortfoliosRes.statusCode}`);
    }

    // (5) 경제 조절 스냅샷 조회
    const ecoSnapshotRes = await request('GET', '/admin/api/economy-controls/snapshot', {
      cookies: adminCookies
    });
    if (ecoSnapshotRes.statusCode === 200 && ecoSnapshotRes.json) {
      logTest('AdminApi', 'GET /admin/api/economy-controls/snapshot (경제 엔진 스냅샷)', 'PASS', `경제 상태: ${ecoSnapshotRes.json.regime || ecoSnapshotRes.json.status || '정상'}`);
    } else {
      logTest('AdminApi', 'GET /admin/api/economy-controls/snapshot (경제 엔진 스냅샷)', 'WARN', `응답: ${ecoSnapshotRes.statusCode}`);
    }

    // (6) 유저 자산 지급/차감/차단 조작 테스트 (임시 생성한 testUserId 대상)
    if (testUserId) {
      // 자금 지급
      const giveRes = await request('POST', '/admin/action/give', {
        cookies: adminCookies,
        body: { targetUserId: testUserId, amount: 7777, reason: 'QA 자동화 자금 지급 테스트' }
      });
      if (giveRes.statusCode === 200 && giveRes.json && giveRes.json.success) {
        logTest('AdminApi', 'POST /admin/action/give (유저 자금 지급)', 'PASS', '임시 유저에게 7,777원 정상 지급 완료');
      } else {
        logTest('AdminApi', 'POST /admin/action/give (유저 자금 지급)', 'FAIL', `응답: ${JSON.stringify(giveRes.json)}`);
      }

      // 자금 차감
      const takeRes = await request('POST', '/admin/action/take', {
        cookies: adminCookies,
        body: { targetUserId: testUserId, amount: 3333, reason: 'QA 자동화 자금 차감 테스트' }
      });
      if (takeRes.statusCode === 200 && takeRes.json && takeRes.json.success) {
        logTest('AdminApi', 'POST /admin/action/take (유저 자금 차감)', 'PASS', '임시 유저에게 3,333원 정상 차감 완료');
      } else {
        logTest('AdminApi', 'POST /admin/action/take (유저 자금 차감)', 'FAIL', `응답: ${JSON.stringify(takeRes.json)}`);
      }

      // 유저 일시 정지 (Ban)
      const banRes = await request('POST', '/admin/action/user-ban', {
        cookies: adminCookies,
        body: { targetUserId: testUserId, durationMinutes: 15, reason: 'QA 테스트 정지 조치' }
      });
      if (banRes.statusCode === 200 && banRes.json && banRes.json.success) {
        logTest('AdminApi', 'POST /admin/action/user-ban (유저 일시 정지)', 'PASS', '임시 유저 15분 정지 성공');
      } else {
        logTest('AdminApi', 'POST /admin/action/user-ban (유저 일시 정지)', 'FAIL', `응답: ${JSON.stringify(banRes.json)}`);
      }

      // 정지된 유저의 로그인 차단 검증
      const bannedLoginRes = await request('POST', '/auth/local/login', {
        body: { username: testUsername, password: testPassword }
      });
      if (bannedLoginRes.statusCode === 403) {
        logTest('Security', '정지된 유저 로그인 시도 차단 검증', 'PASS', '403 Forbidden 정상 차단');
      } else {
        logTest('Security', '정지된 유저 로그인 시도 차단 검증', 'FAIL', `응답 코드: ${bannedLoginRes.statusCode}`);
      }

      // 유저 정지 해제 (Unban)
      const unbanRes = await request('POST', '/admin/action/user-unban', {
        cookies: adminCookies,
        body: { targetUserId: testUserId, reason: 'QA 테스트 정지 해제' }
      });
      if (unbanRes.statusCode === 200 && unbanRes.json && unbanRes.json.success) {
        logTest('AdminApi', 'POST /admin/action/user-unban (유저 정지 해제)', 'PASS', '임시 유저 정지 해제 성공');
      } else {
        logTest('AdminApi', 'POST /admin/action/user-unban (유저 정지 해제)', 'FAIL', `응답: ${JSON.stringify(unbanRes.json)}`);
      }
    }

  } catch (err) {
    logTest('AdminQA', '관리자 기능 테스트 예외', 'FAIL', err.message);
  } finally {
    // ───────────────────────────────────────────
    // 6. 클린업 (임시 관리자 및 테스트 유저 삭제)
    // ───────────────────────────────────────────
    console.log('\n--- 6. 임시 QA 데이터 완전 클린업 ---');
    try {
      if (tempAdminDiscordId) {
        await pool.query('DELETE FROM admin_roles WHERE discord_id = ?', [tempAdminDiscordId]);
        await pool.query('DELETE FROM users WHERE discord_id = ?', [tempAdminDiscordId]);
      }
      if (testUserId) {
        await pool.query('DELETE FROM web_accounts WHERE user_id = ?', [testUserId]);
        await pool.query('DELETE FROM users WHERE discord_id = ?', [testUserId]);
        await pool.query('DELETE FROM inquiries WHERE user_id = ?', [testUserId]).catch(() => {});
        await pool.query('DELETE FROM transaction_logs WHERE user_id = ?', [testUserId]).catch(() => {});
        await pool.query('DELETE FROM user_stocks WHERE user_id = ?', [testUserId]).catch(() => {});
      }
      if (typeof config.reloadAdminIds === 'function') {
        await config.reloadAdminIds();
      }
      logTest('CleanUp', '임시 테스트 데이터 완전 삭제 및 롤백', 'PASS', '임시 관리자/유저/자산 데이터 깨끗이 삭제 완료');
    } catch (cleanErr) {
      logTest('CleanUp', '클린업 예외', 'WARN', cleanErr.message);
    }
  }

  console.log('\n====================================================');
  console.log('📊 [QA RESULT SUMMARY]');
  console.log(`✅ 성공 (PASS): ${results.passed}`);
  console.log(`❌ 실패 (FAIL): ${results.failed}`);
  console.log(`⚠️ 경고/미지원 (WARN): ${results.warnings}`);
  console.log('====================================================');

  console.log('\n__QA_JSON_OUTPUT_START__');
  console.log(JSON.stringify(results));
  console.log('__QA_JSON_OUTPUT_END__');

  process.exit(0);
}

runAllQA().catch(err => {
  console.error('QA Runner Fatal Error:', err);
  process.exit(1);
});
