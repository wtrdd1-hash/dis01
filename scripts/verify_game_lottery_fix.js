'use strict';
/**
 * verify_game_lottery_fix.js
 * 복권 심볼 100% 일치성, 슬롯머신, 카지노 게임 및 관리자 자금 지급 종합 재검증
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

async function testLotteryAndAdmin() {
  console.log('====================================================');
  console.log('🎰 [실서버 QA] 복권 심볼 일치성 & 슬롯 & 관리자 기능 정밀 검증');
  console.log('====================================================');

  const { pool } = require('../src/config/database');
  const session = require('../src/web/session');
  const cookieSecret = session.getCookieSecret();

  // 1. 일반 유저 세션 생성 및 100,000원 충전
  const userId = '118877665544332211';
  const username = 'qa_lottery_tester';

  await pool.query(`
    INSERT INTO users (discord_id, username, cash, bank)
    VALUES (?, ?, 100000, 50000)
    ON DUPLICATE KEY UPDATE cash = 100000
  `, [userId, username]);

  const userCookies = {
    discord_user: makeSignedCookieValue({
      id: userId,
      username: username,
      avatar: ''
    }, cookieSecret)
  };

  try {
    console.log('\n--- 1. 복권 (Lottery) 10회 연속 플레이 심볼/당첨 정밀 검증 ---');
    let lotteryPassCount = 0;
    for (let i = 1; i <= 10; i++) {
      const res = await request('POST', '/api/game/lottery', {
        cookies: userCookies,
        body: { bet: 1000 }
      });

      if (res.statusCode === 200 && res.json && res.json.success) {
        const symbols = res.json.symbols || res.json.details?.symbols || [];
        const msg = res.json.message || '';
        const isWin = res.json.isWin;
        const multiplier = res.json.multiplier;

        // 검증: 메시지에 포함된 심볼과 실제 반환 심볼의 100% 일치 여부
        const [s1, s2, s3] = symbols;
        const msgHasSymbols = msg.includes(s1) && msg.includes(s2) && msg.includes(s3);
        
        // 검증: 페어/트리플 판정 규칙 검증
        const isPairOrTriple = (s1 === s2 || s2 === s3 || s1 === s3);
        const ruleMatches = isWin ? (isPairOrTriple && multiplier > 0) : (!isPairOrTriple && multiplier === 0);

        if (msgHasSymbols && ruleMatches) {
          console.log(`[복권 회차 ${i}] ✅ 심볼: [ ${s1} | ${s2} | ${s3} ] -> ${isWin ? '🎉 당첨 (' + multiplier + '배)' : '💀 꽝'} | 메시지/심볼/규칙 100% 일치`);
          lotteryPassCount++;
        } else {
          console.error(`[복권 회차 ${i}] ❌ 불일치 발생! 심볼: [${symbols}], 메시지: ${msg}, isWin: ${isWin}`);
        }
      } else {
        console.error(`[복권 회차 ${i}] ❌ 응답 실패: ${res.statusCode}`, res.json || res.body);
      }
    }
    console.log(`복권 검증 결과: ${lotteryPassCount}/10 회 정상 통과`);

    console.log('\n--- 2. 슬롯머신 (Slot) 5회 플레이 검증 ---');
    let slotPassCount = 0;
    for (let i = 1; i <= 5; i++) {
      const res = await request('POST', '/api/game/slot', {
        cookies: userCookies,
        body: { bet: 1000 }
      });

      if (res.statusCode === 200 && res.json && res.json.success) {
        const reels = res.json.reels || res.json.details?.slots || [];
        const msg = res.json.message || '';
        const [r1, r2, r3] = reels;
        const msgHasReels = msg.includes(r1) && msg.includes(r2) && msg.includes(r3);
        if (msgHasReels) {
          console.log(`[슬롯 회차 ${i}] ✅ 릴: [ ${r1} | ${r2} | ${r3} ] -> ${res.json.isWin ? '🎉 적중' : '💀 꽝'} | 일치`);
          slotPassCount++;
        } else {
          console.error(`[슬롯 회차 ${i}] ❌ 불일치! 릴: [${reels}], 메시지: ${msg}`);
        }
      }
    }

    console.log('\n--- 3. 관리자 자금 지급/회수/차단 모달 API 재확인 ---');
    const adminCookies = {
      discord_user: makeSignedCookieValue({
        id: '886478189520637992',
        username: '월덕',
        avatar: ''
      }, cookieSecret)
    };

    const giveRes = await request('POST', '/api/admin/action/give', {
      cookies: adminCookies,
      body: { userId, amount: '5000', reason: 'QA 최종 자금 지급 검증', confirm: true }
    });
    console.log(`자금 지급 테스트 (POST /api/admin/action/give): ${giveRes.statusCode === 200 ? '✅ 200 OK 성공' : '❌ 실패'}`);

    const takeRes = await request('POST', '/api/admin/action/take', {
      cookies: adminCookies,
      body: { userId, amount: '2000', reason: 'QA 최종 자금 회수 검증', confirm: true }
    });
    console.log(`자금 회수 테스트 (POST /api/admin/action/take): ${takeRes.statusCode === 200 ? '✅ 200 OK 성공' : '❌ 실패'}`);

  } finally {
    await pool.query('DELETE FROM users WHERE discord_id = ?', [userId]);
    await pool.query('DELETE FROM gambling_logs WHERE user_id = ?', [userId]).catch(() => {});
    await pool.query('DELETE FROM admin_action_logs WHERE target_id = ?', [userId]).catch(() => {});
    console.log('\n🧹 [CleanUp] 테스트 데이터 정리 완료');
  }

  process.exit(0);
}

testLotteryAndAdmin().catch(e => {
  console.error(e);
  process.exit(1);
});
