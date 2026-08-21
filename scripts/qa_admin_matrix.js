'use strict';

// Run inside the deployed application container through stdin.
// It never prints the administrator id, cookie secret, or signed cookie.
const config = require('./src/config/config');
const session = require('./src/web/session');

const baseUrl = process.env.QA_BASE_URL || 'http://127.0.0.1:8085';
const domain = process.env.QA_DOMAIN || 'test.easy-scraping.com';
const adminId = config.adminIds[0];

if (!adminId) {
  throw new Error('No configured administrator is available for QA');
}

const signed = session.signValue(JSON.stringify({
  id: String(adminId),
  username: 'qa_admin',
  avatar: ''
}), session.getCookieSecret());

const headers = {
  cookie: `${session.SESSION_COOKIE}=${encodeURIComponent(signed)}`,
  host: domain,
  'x-forwarded-host': domain,
  'x-forwarded-proto': 'https'
};

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_) {}
  return {
    path,
    status: response.status,
    location: response.headers.get('location') || '',
    contentType: response.headers.get('content-type') || '',
    length: text.length,
    body,
    text
  };
}

function print(section, result) {
  const error = result.body && (result.body.error || result.body.message);
  console.log([
    section,
    result.path,
    result.status,
    result.location,
    result.contentType,
    result.length,
    error ? String(error).replace(/[\r\n|]+/g, ' ').slice(0, 160) : ''
  ].join('|'));
}

async function main() {
  console.log('SECTION|PATH|STATUS|LOCATION|CONTENT_TYPE|LENGTH|ERROR');

  const pages = [
    '/admin', '/admin/users', '/admin/economy', '/admin/audit',
    '/admin/stocks', '/admin/tax', '/admin/loans', '/admin/console',
    '/admin/announcements', '/admin/security', '/admin/inquiries',
    '/admin/logs', '/admin/spending', '/admin/admins'
  ];
  for (const path of pages) print('PAGE', await request(path));

  const apis = [
    '/api/admin/announcements',
    '/api/admin/spending/catalog',
    '/api/admin/spending/workshop',
    '/api/admin/spending/ledger'
  ];
  for (const path of apis) print('API', await request(path));

  const invalidNotice = await request('/api/admin/announcements', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${domain}` },
    body: '{}'
  });
  print('INVALID_WRITE', invalidNotice);

  const evilOrigin = await request('/api/admin/economy/give', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.invalid' },
    body: JSON.stringify({ userId: '0', amount: 1, confirm: true })
  });
  print('ORIGIN', evilOrigin);

  const marker = `QA_TMP_${Date.now()}`;
  let createdId = null;
  try {
    const create = await request('/api/admin/announcements', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `https://${domain}` },
      body: JSON.stringify({
        title: marker,
        content: 'Temporary automated QA notice; delete immediately.',
        type: 'GENERAL',
        isPopup: true,
        endsAt: new Date(Date.now() + 60000).toISOString()
      })
    });
    print('CRUD_CREATE', create);
    createdId = Number(create.body?.announcement?.id || create.body?.data?.id || create.body?.id || 0) || null;

    if (create.status >= 200 && create.status < 300) {
      const popup = await request('/api/announcements/popup');
      const containsMarker = popup.text.includes(marker);
      console.log(`CRUD_VERIFY|/api/announcements/popup|${popup.status}|||${popup.length}|marker=${containsMarker}`);
    }
  } finally {
    if (createdId) {
      const cleanup = await request(`/api/admin/announcements/${createdId}`, {
        method: 'DELETE',
        headers: { origin: `https://${domain}` }
      });
      print('CRUD_CLEANUP', cleanup);
    } else {
      console.log('CRUD_CLEANUP|not-created|SKIP||||');
    }
  }
}

main().catch((error) => {
  console.error(`FATAL|${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
