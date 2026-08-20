'use strict';
/**
 * admin_qa_runner.js (v3 - Final)
 * 실제 등록된 관리자 ID 기반으로 관리자 페이지 10종 및 관리자 API 전수 QA
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

function logTest(category, name, status, detail) {
  const item = { category, name, status, detail, timestamp: new Date().toISOString() };
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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Admin-QA-Runner/3.0',
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

        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json
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

async function runAdminQA() {
  console.log('====================================================');
  console.log('👑 [ADMIN QA RUNNER v3] 관리자 전용 기능 전수 QA');
  console.log(`🎯 대상 URL: ${BASE_URL} (Host: ${ORIGIN_HOST})`);
  console.log('====================================================');

  const { pool } = require('../src/config/database');
  const session = require('../src/web/session');
  const cookieSecret = session.getCookieSecret();

  // 환경변수 등록된 실제 관리자 ID 사용
  const adminDiscordId = '886478189520637992';
  const adminUsername = '월덕';

  const adminCookieVal = makeSignedCookieValue({
    id: adminDiscordId,
    username: adminUsername,
    avatar: ''
  }, cookieSecret);

  const adminCookies = {
    discord_user: adminCookieVal
  };

  // 테스트용 일반 사용자 계정 생성 (18자리 Snowflake ID)
  const tempSuffix = String(Math.floor(Math.random() * 8999999999 + 1000000000));
  const targetDiscordId = `11${tempSuffix}1234`;
  const targetUsername = `qa_target_${tempSuffix.slice(-4)}`;

  try {
    await pool.query(`
      INSERT INTO users (discord_id, username, cash, bank)
      VALUES (?, ?, 100000, 50000)
      ON DUPLICATE KEY UPDATE username = ?
    `, [targetDiscordId, targetUsername, targetUsername]);

    console.log(`\n--- 1. 관리자 HTML 페이지 10종 렌더링 검사 ---`);
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
        logTest('AdminWeb', `GET ${page.path} (${page.name})`, 'FAIL', `상태 코드 ${pageRes.statusCode}`);
      }
    }

    console.log(`\n--- 2. 관리자 API 엔드포인트 검사 ---`);

    // (1) 전체 주식 포트폴리오 조회
    const stockPortfoliosRes = await request('GET', '/admin/stocks/portfolios/all', {
      cookies: adminCookies
    });
    if (stockPortfoliosRes.statusCode === 200 && stockPortfoliosRes.json) {
      logTest('AdminApi', 'GET /admin/stocks/portfolios/all (주주 명부)', 'PASS', '주주 명부 조회 성공');
    } else {
      logTest('AdminApi', 'GET /admin/stocks/portfolios/all (주주 명부)', 'WARN', `응답: ${stockPortfoliosRes.statusCode}`);
    }

    // (2) 경제 조절 스냅샷 조회
    const ecoSnapshotRes = await request('GET', '/admin/api/economy-controls/snapshot', {
      cookies: adminCookies
    });
    if (ecoSnapshotRes.statusCode === 200 && ecoSnapshotRes.json) {
      logTest('AdminApi', 'GET /admin/api/economy-controls/snapshot (경제 엔진 스냅샷)', 'PASS', `상태: ${ecoSnapshotRes.json.regime || ecoSnapshotRes.json.status || '정상'}`);
    } else {
      logTest('AdminApi', 'GET /admin/api/economy-controls/snapshot (경제 엔진 스냅샷)', 'WARN', `응답: ${ecoSnapshotRes.statusCode}`);
    }

    // (3) 유저 자산 지급/차감 액션 테스트 (18자리 Snowflake ID 대상)
    const giveRes = await request('POST', '/admin/action/give', {
      cookies: adminCookies,
      body: { userId: targetDiscordId, amount: 7777, reason: 'QA 관리자 자금 지급', confirm: true }
    });
    if (giveRes.statusCode === 200 && giveRes.json && giveRes.json.success) {
      logTest('AdminApi', 'POST /admin/action/give (유저 자금 지급)', 'PASS', `7,777원 정상 지급 완료 (${giveRes.json.message || 'OK'})`);
    } else {
      logTest('AdminApi', 'POST /admin/action/give (유저 자금 지급)', 'FAIL', `응답: ${JSON.stringify(giveRes.json)}`);
    }

    const takeRes = await request('POST', '/admin/action/take', {
      cookies: adminCookies,
      body: { userId: targetDiscordId, amount: 3333, reason: 'QA 관리자 자금 차감', confirm: true }
    });
    if (takeRes.statusCode === 200 && takeRes.json && takeRes.json.success) {
      logTest('AdminApi', 'POST /admin/action/take (유저 자금 차감)', 'PASS', `3,333원 정상 차감 완료 (${takeRes.json.message || 'OK'})`);
    } else {
      logTest('AdminApi', 'POST /admin/action/take (유저 자금 차감)', 'FAIL', `응답: ${JSON.stringify(takeRes.json)}`);
    }

    // (4) 유저 제재 (Ban) 및 해제 (Unban)
    const banRes = await request('POST', '/admin/action/user-ban', {
      cookies: adminCookies,
      body: { userId: targetDiscordId, durationHours: 1, reason: 'QA 관리자 제재 테스트', confirm: true }
    });
    if (banRes.statusCode === 200 && banRes.json && banRes.json.success) {
      logTest('AdminApi', 'POST /admin/action/user-ban (유저 일시 제재)', 'PASS', `1시간 제재 성공 (${banRes.json.message || 'OK'})`);
    } else {
      logTest('AdminApi', 'POST /admin/action/user-ban (유저 일시 제재)', 'FAIL', `응답: ${JSON.stringify(banRes.json)}`);
    }

    const unbanRes = await request('POST', '/admin/action/user-unban', {
      cookies: adminCookies,
      body: { userId: targetDiscordId, reason: 'QA 관리자 제재 해제', confirm: true }
    });
    if (unbanRes.statusCode === 200 && unbanRes.json && unbanRes.json.success) {
      logTest('AdminApi', 'POST /admin/action/user-unban (유저 제재 해제)', 'PASS', `제재 해제 성공 (${unbanRes.json.message || 'OK'})`);
    } else {
      logTest('AdminApi', 'POST /admin/action/user-unban (유저 제재 해제)', 'FAIL', `응답: ${JSON.stringify(unbanRes.json)}`);
    }

    // (5) 1:1 문의 답변 테스트
    const [inqResult] = await pool.query(`
      INSERT INTO inquiries (user_id, username, category, title, content, status)
      VALUES (?, ?, '일반문의', 'QA 테스트 문의', 'QA 내용입니다.', 'WAITING')
    `, [targetDiscordId, targetUsername]);
    const inquiryId = inqResult.insertId;

    const replyRes = await request('POST', '/api/admin/inquiry/reply', {
      cookies: adminCookies,
      body: { ticketId: inquiryId, answer: 'QA 자동화 답변입니다.', confirm: true }
    });
    if (replyRes.statusCode === 200 && replyRes.json && replyRes.json.success) {
      logTest('AdminApi', 'POST /api/admin/inquiry/reply (1:1 문의 답변)', 'PASS', '문의 답변 등록 성공');
    } else {
      logTest('AdminApi', 'POST /api/admin/inquiry/reply (1:1 문의 답변)', 'FAIL', `응답: ${JSON.stringify(replyRes.json)}`);
    }

  } catch (err) {
    logTest('AdminQA', '관리자 기능 테스트 예외', 'FAIL', err.message);
  } finally {
    // 클린업
    console.log(`\n--- 3. 테스트 대상 유저 클린업 ---`);
    try {
      await pool.query('DELETE FROM users WHERE discord_id = ?', [targetDiscordId]);
      await pool.query('DELETE FROM inquiries WHERE user_id = ?', [targetDiscordId]).catch(() => {});
      await pool.query('DELETE FROM transaction_logs WHERE user_id = ?', [targetDiscordId]).catch(() => {});
      await pool.query('DELETE FROM admin_action_logs WHERE target_id = ?', [targetDiscordId]).catch(() => {});
      logTest('CleanUp', '테스트 유저 삭제 완료', 'PASS', '정리 완료');
    } catch (e) {
      logTest('CleanUp', '클린업 예외', 'WARN', e.message);
    }
  }

  console.log('\n====================================================');
  console.log('📊 [ADMIN QA FINAL SUMMARY]');
  console.log(`✅ 성공 (PASS): ${results.passed}`);
  console.log(`❌ 실패 (FAIL): ${results.failed}`);
  console.log(`⚠️ 경고/미지원 (WARN): ${results.warnings}`);
  console.log('====================================================');

  process.exit(0);
}

runAdminQA().catch(e => {
  console.error('Fatal Admin QA Error:', e);
  process.exit(1);
});
