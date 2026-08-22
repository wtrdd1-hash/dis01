'use strict';

/**
 * Focused QA runner for /admin/economy.
 *
 * Run against the test deployment only. The runner creates one temporary user,
 * restores economy_settings values that it touches, and removes its own rows.
 * It never prints the administrator id, session cookie, or cookie secret.
 */

const path = require('path');

const appRoot = process.env.QA_APP_ROOT || path.resolve(__dirname, '..');
const { pool } = require(path.join(appRoot, 'src/config/database'));
const config = require(path.join(appRoot, 'src/config/config'));
const session = require(path.join(appRoot, 'src/web/session'));

const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:8085';
const domain = process.env.QA_DOMAIN || 'test.easy-scraping.com';
const adminId = config.adminIds[0];

if (!adminId) throw new Error('No configured administrator is available for QA');

const signed = session.signValue(JSON.stringify({
  id: String(adminId),
  username: 'qa_admin',
  avatar: ''
}), session.getCookieSecret());

const authHeaders = {
  cookie: `${session.SESSION_COOKIE}=${encodeURIComponent(signed)}`,
  host: domain,
  'x-forwarded-host': domain,
  'x-forwarded-proto': 'https'
};

const results = [];

function record(section, name, ok, detail, severity = '') {
  const status = ok ? 'PASS' : 'FAIL';
  results.push({ section, name, status, detail, severity });
  console.log([status, section, name, severity, String(detail).replace(/[\r\n|]+/g, ' ').slice(0, 500)].join('|'));
}

function sameValue(actual, expected) {
  if (expected === null) return actual === null;
  if (typeof expected === 'number') {
    return Number.isFinite(Number(actual)) && Math.abs(Number(actual) - expected) < 1e-12;
  }
  return String(actual) === String(expected);
}

async function request(pathname, options = {}, authenticated = true) {
  const headers = {
    ...(authenticated ? authHeaders : {}),
    ...(options.headers || {})
  };
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    ...options,
    headers
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) {}
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    location: response.headers.get('location') || '',
    text,
    body
  };
}

function jsonOptions(body, origin = `https://${domain}`) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body)
  };
}

async function snapshot() {
  return request('/admin/api/economy-controls/snapshot');
}

async function restoreSettingRows(originalRows, keys) {
  const byKey = new Map(originalRows.map((row) => [String(row.key_name), String(row.value)]));
  for (const key of keys) {
    if (byKey.has(key)) {
      await pool.query(
        `INSERT INTO economy_settings (key_name, value) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [key, byKey.get(key)]
      );
    } else {
      await pool.query('DELETE FROM economy_settings WHERE key_name = ?', [key]);
    }
  }
}

async function main() {
  const settingKeys = [
    'taxRate', 'bankInterestRate', 'wealthTaxMultiplier',
    'forcedRegimeIndex', 'wealthThresholdForTax', 'subsidyMultiplier'
  ];
  const [originalSettingRows] = await pool.query(
    `SELECT key_name, value FROM economy_settings
     WHERE key_name IN (${settingKeys.map(() => '?').join(',')})`,
    settingKeys
  );

  const suffix = String(Date.now()).slice(-12);
  const tempUserId = `99${suffix}1234`.slice(0, 18);
  const tempUsername = `qa_economy_${suffix}`;
  let originalMode = 'auto';

  console.log('STATUS|SECTION|TEST|SEVERITY|DETAIL');

  try {
    const unauthPage = await request('/admin/economy', {}, false);
    record('AUTH', 'anonymous page denied', unauthPage.status === 403, `HTTP ${unauthPage.status}`, 'P0');

    const unauthApi = await request('/admin/api/economy-controls/snapshot', {}, false);
    record('AUTH', 'anonymous controls API denied', unauthApi.status === 403, `HTTP ${unauthApi.status}`, 'P0');

    const evilOrigin = await request(
      '/admin/api/economy-controls/auto-mode',
      jsonOptions({ mode: 'auto' }, 'https://evil.invalid')
    );
    record('AUTH', 'cross-origin write denied', evilOrigin.status === 403, `HTTP ${evilOrigin.status}`, 'P0');

    const page = await request('/admin/economy');
    const requiredMarkers = [
      '실시간 서버 자금 흐름 관제',
      'id="eco-search-form"',
      'id="economy-table-tbody"',
      'id="range-taxRate"',
      'id="range-wealthTaxMultiplier"',
      'id="range-bankInterestRate"',
      'id="range-subsidyMultiplier"',
      'id="input-wealthThresholdForTax"',
      'id="select-forcedRegimeIndex"',
      'id="quick-money-modal"'
    ];
    const missingMarkers = requiredMarkers.filter((marker) => !page.text.includes(marker));
    record('PAGE', 'base page and all controls render', page.status === 200 && missingMarkers.length === 0,
      `HTTP ${page.status}; missing=${missingMarkers.join(',') || 'none'}`, 'P0');

    for (const limit of [50, 100, 200]) {
      const limited = await request(`/admin/economy?lines=${limit}`);
      const rowCount = (limited.text.match(/<tr data-type=/g) || []).length;
      record('PAGE', `page size ${limit}`, limited.status === 200 && rowCount <= limit,
        `HTTP ${limited.status}; rows=${rowCount}`, 'P2');
    }

    const clampedLow = await request('/admin/economy?lines=1');
    const lowRows = (clampedLow.text.match(/<tr data-type=/g) || []).length;
    record('PAGE', 'page-size lower bound clamps to 10', clampedLow.status === 200 && lowRows <= 10,
      `HTTP ${clampedLow.status}; rows=${lowRows}`, 'P3');

    const clampedHigh = await request('/admin/economy?lines=9999');
    const highRows = (clampedHigh.text.match(/<tr data-type=/g) || []).length;
    record('PAGE', 'page-size upper bound clamps to 200', clampedHigh.status === 200 && highRows <= 200,
      `HTTP ${clampedHigh.status}; rows=${highRows}`, 'P3');

    const noMatch = await request('/admin/economy?search=__QA_NO_MATCH_42F9__');
    record('PAGE', 'no-result search state', noMatch.status === 200 && noMatch.text.includes('조건에 일치하는 자금 이동 기록이 없습니다.'),
      `HTTP ${noMatch.status}`, 'P2');

    const injection = encodeURIComponent(`%' OR 1=1 --`);
    const injectionSearch = await request(`/admin/economy?search=${injection}`);
    record('SECURITY', 'SQL-injection-shaped search is harmless', injectionSearch.status === 200,
      `HTTP ${injectionSearch.status}`, 'P0');

    const xssPayload = `\"><script>qa_xss_marker()</script>`;
    const xssSearch = await request(`/admin/economy?search=${encodeURIComponent(xssPayload)}`);
    record('SECURITY', 'search value is HTML-escaped', xssSearch.status === 200 && !xssSearch.text.includes(`value="${xssPayload}"`),
      `HTTP ${xssSearch.status}; rawValueReflected=${xssSearch.text.includes(`value="${xssPayload}"`)}`, 'P0');

    const hugePage = await request('/admin/economy?page=999999&lines=50');
    const pageMatch = hugePage.text.match(/([\d,]+)\s*\/\s*([\d,]+)\s*페이지/);
    const shownPage = pageMatch ? Number(pageMatch[1].replace(/,/g, '')) : null;
    const totalPages = pageMatch ? Number(pageMatch[2].replace(/,/g, '')) : null;
    record('PAGE', 'out-of-range page is clamped to last page', shownPage !== null && totalPages !== null && shownPage <= totalPages,
      `shown=${shownPage}; total=${totalPages}; empty=${hugePage.text.includes('조건에 일치하는 자금 이동 기록이 없습니다.')}`, 'P2');

    const filterTokens = ['BUSINESS', 'ADMIN', 'GAMBLE', 'STOCK', 'INFLOW', 'OUTFLOW', 'TAX', 'LOAN', 'TRANSFER'];
    for (const token of filterTokens) {
      const filtered = await request(`/admin/economy?type=${token}&lines=200`);
      const types = [...filtered.text.matchAll(/<tr data-type="([^"]*)">/g)].map((match) => match[1]);
      const allMatch = types.every((type) => type.toUpperCase().includes(token));
      record('FILTER', token, filtered.status === 200 && allMatch,
        `HTTP ${filtered.status}; visibleRows=${types.length}; sample=${types.slice(0, 4).join(',') || 'none'}`, 'P2');
    }

    const [typeRows] = await pool.query(
      'SELECT type, COUNT(*) AS count FROM economy_logs GROUP BY type ORDER BY count DESC, type ASC'
    );
    const gambleLike = typeRows.filter((row) => /GAMBL|CASINO|SLOT|DICE|COIN|ROULETTE|HORSE|LOTTERY/i.test(String(row.type)));
    const gambleChipCoverage = gambleLike.every((row) => String(row.type).toUpperCase().includes('GAMBLE'));
    record('FILTER', 'gambling chip covers gambling/casino ledger types', gambleChipCoverage,
      `semanticTypes=${gambleLike.map((row) => `${row.type}:${row.count}`).join(',') || 'no gambling types currently present'}`, 'P2');

    const initialSnapshot = await snapshot();
    const snapshotOk = initialSnapshot.status === 200 && initialSnapshot.body?.success && initialSnapshot.body?.settings;
    record('CONTROLS', 'snapshot loads', Boolean(snapshotOk), `HTTP ${initialSnapshot.status}`, 'P0');
    if (!snapshotOk) throw new Error('Cannot continue control QA without a valid snapshot');
    originalMode = initialSnapshot.body.settings.autoMode || initialSnapshot.body.manual?.autoMode || 'auto';

    const history = await request('/admin/api/economy-controls/history');
    record('CONTROLS', 'history loads', history.status === 200 && history.body?.success && Array.isArray(history.body.history),
      `HTTP ${history.status}; entries=${history.body?.history?.length ?? 'n/a'}`, 'P2');

    const badMode = await request('/admin/api/economy-controls/auto-mode', jsonOptions({ mode: 'invalid' }));
    record('VALIDATION', 'invalid auto mode rejected', badMode.status === 400 && badMode.body?.success === false,
      `HTTP ${badMode.status}; error=${badMode.body?.error || ''}`, 'P1');

    for (const mode of ['auto', 'manual', 'paused']) {
      const changed = await request('/admin/api/economy-controls/auto-mode', jsonOptions({ mode }));
      const after = await snapshot();
      record('CONTROLS', `auto mode ${mode}`, changed.status === 200 && changed.body?.success && after.body?.settings?.autoMode === mode,
        `write=${changed.status}; snapshot=${after.body?.settings?.autoMode}; locked=${after.body?.manual?.taxPolicyLocked}`, 'P1');
    }
    await request('/admin/api/economy-controls/auto-mode', jsonOptions({ mode: originalMode }));

    const invalidUpdates = [
      ['taxRate below minimum', { taxRate: -0.01 }],
      ['taxRate above maximum', { taxRate: 0.151 }],
      ['bank interest above maximum', { bankInterestRate: 0.000101 }],
      ['wealth-tax multiplier below minimum', { wealthTaxMultiplier: 0.09 }],
      ['wealth threshold below minimum', { wealthThresholdForTax: 99999 }],
      ['subsidy multiplier above maximum', { subsidyMultiplier: 5.01 }],
      ['unknown setting key', { qaUnknownKey: 1 }]
    ];
    for (const [name, updates] of invalidUpdates) {
      const invalid = await request('/admin/api/economy-controls/bulk-update', jsonOptions({ updates }));
      record('VALIDATION', name, invalid.status === 400 && invalid.body?.success === false,
        `HTTP ${invalid.status}; skipped=${JSON.stringify(invalid.body?.skipped || [])}`, 'P1');
    }

    const originalSettings = initialSnapshot.body.settings;
    const effectiveUpdates = [
      ['taxRate', 0.0137],
      ['wealthTaxMultiplier', 1.37],
      ['bankInterestRate', 0.000000133],
      ['subsidyMultiplier', 1.37],
      ['wealthThresholdForTax', 7654321]
    ];
    for (const [key, value] of effectiveUpdates) {
      const changed = await request('/admin/api/economy-controls/bulk-update', jsonOptions({ updates: { [key]: value } }));
      const after = await snapshot();
      const [[dbRow]] = await pool.query('SELECT value FROM economy_settings WHERE key_name = ? LIMIT 1', [key]);
      const effective = sameValue(after.body?.settings?.[key], value);
      record('CONTROLS', `${key} applies immediately`, changed.status === 200 && changed.body?.success && effective,
        `requested=${value}; response=${JSON.stringify(changed.body?.applied || [])}; snapshot=${after.body?.settings?.[key]}; db=${dbRow?.value ?? 'missing'}`, 'P1');

      if (originalSettings[key] !== undefined && originalSettings[key] !== null) {
        await request('/admin/api/economy-controls/bulk-update', jsonOptions({ updates: { [key]: originalSettings[key] } }));
      }
    }

    const forceNine = await request('/admin/api/economy-controls/bulk-update', jsonOptions({ updates: { forcedRegimeIndex: 9 } }));
    record('VALIDATION', 'market regime index 9 rejected (UI/engine only expose 0-8)', forceNine.status === 400 && forceNine.body?.success === false,
      `HTTP ${forceNine.status}; response=${JSON.stringify(forceNine.body)}`, 'P1');

    const clearRegime = await request('/admin/api/economy-controls/bulk-update', jsonOptions({ updates: { forcedRegimeIndex: null } }));
    record('CONTROLS', 'automatic market regime stores null', clearRegime.status === 200 && clearRegime.body?.applied?.[0]?.value === null,
      `HTTP ${clearRegime.status}; response=${JSON.stringify(clearRegime.body?.applied || [])}`, 'P1');

    await pool.query(
      `INSERT INTO users (discord_id, username, cash, bank)
       VALUES (?, ?, 100000, 50000)
       ON DUPLICATE KEY UPDATE username = VALUES(username), cash = VALUES(cash), bank = VALUES(bank)`,
      [tempUserId, tempUsername]
    );

    const give = await request('/api/admin/action/give', jsonOptions({
      userId: tempUserId,
      amount: 777,
      reason: 'QA economy page give',
      confirm: true
    }));
    const [[afterGive]] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [tempUserId]);
    record('QUICK_MONEY', 'give succeeds and changes cash', give.status === 200 && give.body?.success && String(afterGive?.cash) === '100777',
      `HTTP ${give.status}; cash=${afterGive?.cash}`, 'P0');

    const take = await request('/api/admin/action/take', jsonOptions({
      userId: tempUserId,
      amount: 333,
      reason: 'QA economy page take',
      confirm: true
    }));
    const [[afterTake]] = await pool.query('SELECT cash FROM users WHERE discord_id = ?', [tempUserId]);
    record('QUICK_MONEY', 'take succeeds and changes cash', take.status === 200 && take.body?.success && String(afterTake?.cash) === '100444',
      `HTTP ${take.status}; cash=${afterTake?.cash}`, 'P0');

    const withoutConfirm = await request('/api/admin/action/take', jsonOptions({
      userId: tempUserId,
      amount: 1,
      reason: 'QA missing confirmation check'
    }));
    record('QUICK_MONEY', 'server requires confirm=true for balance mutation', withoutConfirm.status === 400 && withoutConfirm.body?.success === false,
      `HTTP ${withoutConfirm.status}; success=${withoutConfirm.body?.success}; afterCash=${withoutConfirm.body?.afterCash}`, 'P1');

    const invalidMoneyCases = [
      ['give zero', '/api/admin/action/give', { userId: tempUserId, amount: 0, confirm: true }],
      ['give nonnumeric', '/api/admin/action/give', { userId: tempUserId, amount: 'abc', confirm: true }],
      ['give all-in', '/api/admin/action/give', { userId: tempUserId, amount: '전액', confirm: true }],
      ['take zero', '/api/admin/action/take', { userId: tempUserId, amount: 0, confirm: true }],
      ['take unknown user', '/api/admin/action/take', { userId: '990000000000000000', amount: 1, confirm: true }]
    ];
    for (const [name, endpoint, body] of invalidMoneyCases) {
      const invalid = await request(endpoint, jsonOptions(body));
      record('VALIDATION', name, invalid.status >= 400 && invalid.status < 500 && invalid.body?.success === false,
        `HTTP ${invalid.status}; error=${invalid.body?.error || ''}`, 'P1');
    }

    const userSearch = await request(`/admin/economy?search=${encodeURIComponent(tempUsername)}&lines=50`);
    record('QUICK_MONEY', 'new ledger rows are searchable and expose money action', userSearch.status === 200 && userSearch.text.includes(tempUsername) && userSearch.text.includes('openQuickMoneyModal'),
      `HTTP ${userSearch.status}; rows=${(userSearch.text.match(/<tr data-type=/g) || []).length}`, 'P1');
  } finally {
    try {
      await request('/admin/api/economy-controls/auto-mode', jsonOptions({ mode: originalMode }));
    } catch (_) {}
    await restoreSettingRows(originalSettingRows, settingKeys);
    await pool.query('DELETE FROM economy_logs WHERE user_id = ?', [tempUserId]).catch(() => {});
    await pool.query('DELETE FROM admin_action_logs WHERE target_id = ?', [tempUserId]).catch(() => {});
    await pool.query('DELETE FROM transaction_logs WHERE user_id = ?', [tempUserId]).catch(() => {});
    await pool.query('DELETE FROM users WHERE discord_id = ?', [tempUserId]).catch(() => {});
  }

  const passed = results.filter((result) => result.status === 'PASS').length;
  const failed = results.filter((result) => result.status === 'FAIL').length;
  console.log(`SUMMARY|PASS=${passed}|FAIL=${failed}|TOTAL=${results.length}`);
  process.exitCode = failed ? 2 : 0;
}

main().catch((error) => {
  console.error(`FATAL|${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end().catch(() => {});
});
