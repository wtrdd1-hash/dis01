'use strict';
/**
 * verify_live_admin_endpoints.js
 * 사용자가 겪은 /api/admin/action/give 및 전체 /api/admin/* 엔드포인트 완벽 검증
 */

const http = require('http');
const crypto = require('crypto');

const BASE_URL = 'http://127.0.0.1:8080';
const ORIGIN_HOST = 'easy-scraping.com';

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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
      'Host': ORIGIN_HOST,
      'Origin': `https://${ORIGIN_HOST}`,
      'Referer': `https://${ORIGIN_HOST}/admin/users`,
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

    const req = http.request(url, {
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
      reject(new Error('Request timeout'));
    });

    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function verifyAll() {
  console.log('====================================================');
  console.log('🔍 [실서버 긴급 패치 검증] /api/admin/* API 전수 테스트');
  console.log('====================================================');

  const { pool } = require('../src/config/database');
  const session = require('../src/web/session');
  const cookieSecret = session.getCookieSecret();

  const adminDiscordId = '886478189520637992';
  const adminUsername = '월덕';

  const adminCookies = {
    discord_user: makeSignedCookieValue({
      id: adminDiscordId,
      username: adminUsername,
      avatar: ''
    }, cookieSecret)
  };

  // 테스트용 타겟 유저 생성 (18자리 Snowflake)
  const targetId = '119988776655443322';
  const targetName = 'qa_live_verify_target';

  try {
    await pool.query(`
      INSERT INTO users (discord_id, username, cash, bank)
      VALUES (?, ?, 10000, 5000)
      ON DUPLICATE KEY UPDATE username = ?
    `, [targetId, targetName, targetName]);

    // 1. POST /api/admin/action/give 검증 (사용자 스크린샷 404 발생 지점)
    console.log('\n[1] POST /api/admin/action/give 테스트 (스크린샷 에러 지점)');
    const giveRes = await request('POST', '/api/admin/action/give', {
      cookies: adminCookies,
      body: { userId: targetId, amount: '1000', reason: '실시간 QA 자금 지급 테스트', confirm: true }
    });
    console.log(`응답 상태: ${giveRes.statusCode}`);
    console.log(`응답 데이터:`, giveRes.json || giveRes.body);
    if (giveRes.statusCode === 200 && giveRes.json && giveRes.json.success) {
      console.log('✅ POST /api/admin/action/give: 성공 (200 OK)');
    } else {
      console.error('❌ POST /api/admin/action/give: 실패', giveRes.statusCode, giveRes.json);
    }

    // 2. POST /api/admin/action/take 검증
    console.log('\n[2] POST /api/admin/action/take 테스트');
    const takeRes = await request('POST', '/api/admin/action/take', {
      cookies: adminCookies,
      body: { userId: targetId, amount: '500', reason: '실시간 QA 자금 회수 테스트', confirm: true }
    });
    console.log(`응답 상태: ${takeRes.statusCode}`);
    console.log(`응답 데이터:`, takeRes.json || takeRes.body);
    if (takeRes.statusCode === 200 && takeRes.json && takeRes.json.success) {
      console.log('✅ POST /api/admin/action/take: 성공 (200 OK)');
    } else {
      console.error('❌ POST /api/admin/action/take: 실패', takeRes.statusCode, takeRes.json);
    }

    // 3. POST /api/admin/action/user-ban 검증
    console.log('\n[3] POST /api/admin/action/user-ban 테스트');
    const banRes = await request('POST', '/api/admin/action/user-ban', {
      cookies: adminCookies,
      body: { userId: targetId, durationHours: 1, reason: '실시간 QA 제재 테스트', confirm: true }
    });
    console.log(`응답 상태: ${banRes.statusCode}`);
    console.log(`응답 데이터:`, banRes.json || banRes.body);
    if (banRes.statusCode === 200 && banRes.json && banRes.json.success) {
      console.log('✅ POST /api/admin/action/user-ban: 성공 (200 OK)');
    } else {
      console.error('❌ POST /api/admin/action/user-ban: 실패', banRes.statusCode, banRes.json);
    }

    // 4. POST /api/admin/action/user-unban 검증
    console.log('\n[4] POST /api/admin/action/user-unban 테스트');
    const unbanRes = await request('POST', '/api/admin/action/user-unban', {
      cookies: adminCookies,
      body: { userId: targetId, reason: '실시간 QA 제재 해제', confirm: true }
    });
    console.log(`응답 상태: ${unbanRes.statusCode}`);
    console.log(`응답 데이터:`, unbanRes.json || unbanRes.body);
    if (unbanRes.statusCode === 200 && unbanRes.json && unbanRes.json.success) {
      console.log('✅ POST /api/admin/action/user-unban: 성공 (200 OK)');
    } else {
      console.error('❌ POST /api/admin/action/user-unban: 실패', unbanRes.statusCode, unbanRes.json);
    }

    // 5. GET /api/admin/admin-mgmt/admins/list & /api/admin/admins/list 검증
    console.log('\n[5] GET /api/admin/admin-mgmt/admins/list 테스트');
    const listRes = await request('GET', '/api/admin/admin-mgmt/admins/list', { cookies: adminCookies });
    console.log(`응답 상태: ${listRes.statusCode}`);
    console.log(`응답 데이터:`, listRes.json || listRes.body);
    if (listRes.statusCode === 200 && listRes.json && listRes.json.success) {
      console.log('✅ GET /api/admin/admin-mgmt/admins/list: 성공 (200 OK)');
    } else {
      console.error('❌ GET /api/admin/admin-mgmt/admins/list: 실패', listRes.statusCode);
    }

  } finally {
    await pool.query('DELETE FROM users WHERE discord_id = ?', [targetId]);
    await pool.query('DELETE FROM admin_action_logs WHERE target_id = ?', [targetId]).catch(() => {});
    console.log('\n🧹 [CleanUp] 테스트 데이터 정리 완료');
  }

  process.exit(0);
}

verifyAll().catch(e => {
  console.error(e);
  process.exit(1);
});
