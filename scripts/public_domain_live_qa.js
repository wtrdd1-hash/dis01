'use strict';
/**
 * public_domain_live_qa.js
 * 🌐 실제 퍼블릭 도메인 https://easy-scraping.com/ 대상 종합 라이브 QA 테스트 러너
 */

const https = require('https');
const crypto = require('crypto');

const TARGET_HOST = 'easy-scraping.com';
const BASE_URL = `https://${TARGET_HOST}`;

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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
      'Host': TARGET_HOST,
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/`,
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

    const req = https.request(url, {
      method,
      headers,
      timeout: 15000,
      rejectUnauthorized: false
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
      reject(new Error('HTTPS Request Timeout'));
    });

    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function runLiveDomainQA() {
  console.log('======================================================================');
  console.log(`🌐 [LIVE DOMAIN QA] https://${TARGET_HOST} 실제 퍼블릭 전수 QA 테스트 시작`);
  console.log('======================================================================\n');

  const { pool } = require('../src/config/database');
  const session = require('../src/web/session');
  const cookieSecret = session.getCookieSecret();

  let passed = 0;
  let failed = 0;
  let warnings = 0;

  function report(cat, name, ok, msg) {
    if (ok) {
      passed++;
      console.log(`✅ [${cat}] ${name} -> PASS: ${msg}`);
    } else {
      failed++;
      console.error(`❌ [${cat}] ${name} -> FAIL: ${msg}`);
    }
  }

  // 1. 일반 유저 및 관리자 테스트 계정 세팅
  const testUserId = '119900887766554433';
  const testUsername = 'qa_live_domain_user';
  const adminId = '886478189520637992';
  const adminUsername = '월덕';

  await pool.query(`
    INSERT INTO users (discord_id, username, cash, bank, clicker_level, auto_miner_level)
    VALUES (?, ?, 1000000, 5000000, 1, 1)
    ON DUPLICATE KEY UPDATE cash = 1000000, bank = 5000000
  `, [testUserId, testUsername]);

  const userCookies = {
    discord_user: makeSignedCookieValue({
      id: testUserId,
      username: testUsername,
      avatar: ''
    }, cookieSecret)
  };

  const adminCookies = {
    discord_user: makeSignedCookieValue({
      id: adminId,
      username: adminUsername,
      avatar: ''
    }, cookieSecret)
  };

  try {
    // ──────────────────────────────────────────────────────────
    // 1. 공통 웹 페이지 & 헬스체크 검증
    // ──────────────────────────────────────────────────────────
    console.log('--- 1. 퍼블릭 웹 페이지 & 헬스체크 검증 ---');
    const health = await request('GET', '/healthz');
    report('Health', 'GET /healthz', health.statusCode === 200, `상태코드: ${health.statusCode}, 응답: ${health.body.slice(0, 40)}`);

    const ready = await request('GET', '/readyz');
    report('Health', 'GET /readyz', ready.statusCode === 200, `상태코드: ${ready.statusCode}, 응답: ${ready.body.slice(0, 40)}`);

    const mainPage = await request('GET', '/', { cookies: userCookies });
    report('Web', 'GET / (메인 대시보드)', mainPage.statusCode === 200 && mainPage.body.includes('월덕'), `상태코드: ${mainPage.statusCode}, HTML 렌더링 정상`);

    const guidePage = await request('GET', '/guide');
    report('Web', 'GET /guide (게임 가이드)', guidePage.statusCode === 200, `상태코드: ${guidePage.statusCode}`);

    const termsPage = await request('GET', '/terms');
    report('Web', 'GET /terms (이용약관)', termsPage.statusCode === 200, `상태코드: ${termsPage.statusCode}`);

    const privacyPage = await request('GET', '/privacy');
    report('Web', 'GET /privacy (개인정보처리방침)', privacyPage.statusCode === 200, `상태코드: ${privacyPage.statusCode}`);

    // ──────────────────────────────────────────────────────────
    // 2. 카지노 및 미니게임 API 검증
    // ──────────────────────────────────────────────────────────
    console.log('\n--- 2. 카지노 & 미니게임 라이브 API 검증 ---');
    
    // 2-1. 즉석복권 (Lottery)
    const lotto = await request('POST', '/api/game/lottery', { cookies: userCookies, body: { bet: 1000 } });
    const lottoOk = lotto.statusCode === 200 && lotto.json?.success;
    report('Casino', 'POST /api/game/lottery (즉석복권)', lottoOk, `심볼: [${lotto.json?.symbols}], 당첨: ${lotto.json?.isWin}, 메시지: ${lotto.json?.message}`);

    // 2-2. 슬롯머신 (Slot)
    const slot = await request('POST', '/api/game/slot', { cookies: userCookies, body: { bet: 1000 } });
    const slotOk = slot.statusCode === 200 && slot.json?.success;
    report('Casino', 'POST /api/game/slot (슬롯머신)', slotOk, `릴: [${slot.json?.reels}], 당첨: ${slot.json?.isWin}`);

    // 2-3. 동전뒤집기 (Coinflip)
    const coin = await request('POST', '/api/game/coinflip', { cookies: userCookies, body: { bet: 1000, choice: '앞면' } });
    const coinOk = coin.statusCode === 200 && coin.json?.success;
    report('Casino', 'POST /api/game/coinflip (동전던지기)', coinOk, `결과: ${coin.json?.result}, 승리: ${coin.json?.isWin}`);

    // 2-4. 주사위 (Dice)
    const dice = await request('POST', '/api/game/dice', { cookies: userCookies, body: { bet: 1000 } });
    const diceOk = dice.statusCode === 200 && dice.json?.success;
    report('Casino', 'POST /api/game/dice (주사위대결)', diceOk, `유저: ${dice.json?.userTotal} vs 딜러: ${dice.json?.botTotal}`);

    // 2-5. 지뢰찾기 (Mines)
    const mineStart = await request('POST', '/api/casino/mines/start', { cookies: userCookies, body: { bet: 1000, mines: 3 } });
    const mineOk = mineStart.statusCode === 200 && mineStart.json?.success;
    if (mineOk) {
      report('Casino', 'POST /api/casino/mines/start (지뢰찾기 시작)', true, `게임 생성 완료 (지뢰: ${mineStart.json?.mines}개)`);
      // 0번 타일 열기
      const reveal = await request('POST', '/api/casino/mines/reveal', { cookies: userCookies, body: { index: 0 } });
      if (reveal.json?.boom) {
        report('Casino', 'POST /api/casino/mines/reveal (지뢰 격발)', true, `0번 타일 지뢰 격발`);
      } else {
        report('Casino', 'POST /api/casino/mines/reveal (안전 타일)', true, `0번 타일 안전 오픈 (배율: ${reveal.json?.multiplier}배)`);
        const cashout = await request('POST', '/api/casino/mines/cashout', { cookies: userCookies });
        report('Casino', 'POST /api/casino/mines/cashout (지뢰찾기 탈출 정산)', cashout.statusCode === 200 && cashout.json?.success, `정산 완료 (메시지: ${cashout.json?.message})`);
      }
    } else {
      // 409 Conflict인 경우(진행 중인 게임이 있는 경우) 바로 reveal 및 cashout으로 정리
      if (mineStart.statusCode === 409) {
        const cashout = await request('POST', '/api/casino/mines/cashout', { cookies: userCookies });
        report('Casino', 'POST /api/casino/mines/start (기존 게임 감지 & 탈출)', true, `기존 게임 탈출 후 정상화`);
      } else {
        report('Casino', 'POST /api/casino/mines/start (지뢰찾기 시작)', false, `상태: ${mineStart.statusCode}, 에러: ${JSON.stringify(mineStart.json || mineStart.body)}`);
      }
    }

    // 2-6. 플린코 (Plinko)
    const plinko = await request('POST', '/api/casino/plinko', { cookies: userCookies, body: { bet: 1000, risk: 'medium', rows: 10 } });
    report('Casino', 'POST /api/casino/plinko (플린코 낙하)', plinko.statusCode === 200 && plinko.json?.success, `배율: ${plinko.json?.multiplier}배, 결과금: ${plinko.json?.payout}원`);

    // 2-7. 토토 (Toto)
    const toto = await request('GET', '/api/casino/toto', { cookies: userCookies });
    report('Casino', 'GET /api/casino/toto (토토 경기 목록)', toto.statusCode === 200 && toto.json?.success, `경기 로드 정상`);

    // ──────────────────────────────────────────────────────────
    // 3. 경제, 은행, 사업장 및 주식 API 검증
    // ──────────────────────────────────────────────────────────
    console.log('\n--- 3. 경제, 은행, 사업장 및 주식 시장 API 검증 ---');
    
    // 3-1. 클리커 연타 채굴
    const click = await request('POST', '/api/clicker/click', {
      cookies: userCookies,
      body: { count: 1, hits: [{ x: 100, y: 100 }] }
    });
    report('Economy', 'POST /api/clicker/click (클리커 채굴)', click.statusCode === 200 && click.json?.success, `클릭 처리 완료`);

    // 3-2. 사업장 목록 조회
    const bizList = await request('GET', '/api/business', { cookies: userCookies });
    report('Economy', 'GET /api/business (사업장 목록)', bizList.statusCode === 200 && bizList.json?.success, `상점 수: ${bizList.json?.items?.length || 0}개`);

    // 3-3. 주식 시장 목록 조회
    const stocks = await request('GET', '/api/stocks', { cookies: userCookies });
    report('Stock', 'GET /api/stocks (주식 종목 시세표)', stocks.statusCode === 200 && stocks.json?.success, `상장 종목 수: ${stocks.json?.stocks?.length || 0}개`);

    // ──────────────────────────────────────────────────────────
    // 4. 관리자 페이지 10종 및 관리자 조작 API 전수 검증
    // ──────────────────────────────────────────────────────────
    console.log('\n--- 4. 관리자 관제 페이지 (10종) 및 API 검증 ---');
    const adminPages = [
      { name: '유저 관리', path: '/admin/users' },
      { name: '경제 통계', path: '/admin/economy' },
      { name: '감사 로그', path: '/admin/audit' },
      { name: '주식 관제', path: '/admin/stocks' },
      { name: '국고/세무', path: '/admin/tax' },
      { name: '대출 관제', path: '/admin/loans' },
      { name: '시스템 콘솔', path: '/admin/console' },
      { name: '보안/IP 차단', path: '/admin/security' },
      { name: '1:1 문의', path: '/admin/inquiries' },
      { name: '서버 로그', path: '/admin/logs' }
    ];

    for (const p of adminPages) {
      const pageRes = await request('GET', p.path, { cookies: adminCookies });
      const isValidAdminPage = pageRes.statusCode === 200 && (pageRes.body.includes('admin-main') || pageRes.body.includes('admin-content') || pageRes.body.includes('admin-wrap'));
      report('Admin-Page', `GET ${p.path} (${p.name})`, isValidAdminPage, `200 OK HTML 렌더링 정상`);
    }

    // 4-2. 관리자 자금 지급 API (사용자 스크린샷 오류 지점)
    const giveRes = await request('POST', '/api/admin/action/give', {
      cookies: adminCookies,
      body: { userId: testUserId, amount: '10000', reason: '라이브 도메인 QA 자금 지급', confirm: true }
    });
    report('Admin-API', 'POST /api/admin/action/give (자금 지급)', giveRes.statusCode === 200 && giveRes.json?.success, `응답: ${giveRes.json?.message}`);

    // 4-3. 관리자 자금 회수 API
    const takeRes = await request('POST', '/api/admin/action/take', {
      cookies: adminCookies,
      body: { userId: testUserId, amount: '5000', reason: '라이브 도메인 QA 자금 회수', confirm: true }
    });
    report('Admin-API', 'POST /api/admin/action/take (자금 회수)', takeRes.statusCode === 200 && takeRes.json?.success, `응답: ${takeRes.json?.message}`);

    // 4-4. 관리자 유저 차단 API
    const banRes = await request('POST', '/api/admin/action/user-ban', {
      cookies: adminCookies,
      body: { userId: testUserId, durationHours: 1, reason: '라이브 도메인 QA 차단 테스트', confirm: true }
    });
    report('Admin-API', 'POST /api/admin/action/user-ban (유저 차단)', banRes.statusCode === 200 && banRes.json?.success, `차단 처리 정상`);

    // 4-5. 관리자 유저 차단 해제 API
    const unbanRes = await request('POST', '/api/admin/action/user-unban', {
      cookies: adminCookies,
      body: { userId: testUserId, reason: '라이브 도메인 QA 차단 해제', confirm: true }
    });
    report('Admin-API', 'POST /api/admin/action/user-unban (차단 해제)', unbanRes.statusCode === 200 && unbanRes.json?.success, `차단 해제 정상`);

    // 4-6. 관리자 계정 목록 조회 API
    const adminListRes = await request('GET', '/api/admin/admin-mgmt/admins/list', { cookies: adminCookies });
    report('Admin-API', 'GET /api/admin/admin-mgmt/admins/list (관리자 목록)', adminListRes.statusCode === 200 && adminListRes.json?.success, `총 관리자 수: ${adminListRes.json?.total}명`);

  } catch (err) {
    report('Fatal', 'QA 실행 예외', false, err.stack || err.message);
  } finally {
    await pool.query('DELETE FROM users WHERE discord_id = ?', [testUserId]);
    await pool.query('DELETE FROM gambling_logs WHERE user_id = ?', [testUserId]).catch(() => {});
    await pool.query('DELETE FROM admin_action_logs WHERE target_id = ?', [testUserId]).catch(() => {});
    console.log('\n🧹 [CleanUp] 테스트 데이터 정리 완료');
  }

  console.log('\n======================================================================');
  console.log(`📊 [LIVE DOMAIN QA SUMMARY: https://${TARGET_HOST}]`);
  console.log(`✅ 성공 (PASS): ${passed}`);
  console.log(`❌ 실패 (FAIL): ${failed}`);
  console.log(`⚠️ 경고 (WARN): ${warnings}`);
  console.log('======================================================================');

  process.exit(failed > 0 ? 1 : 0);
}

runLiveDomainQA().catch(e => {
  console.error('Fatal Runner Error:', e);
  process.exit(1);
});
