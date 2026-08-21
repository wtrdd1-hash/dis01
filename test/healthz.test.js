'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerHealthz } = require('../src/web/healthz');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function captureRoutes(pool) {
  const routes = new Map();
  registerHealthz({ get(path, handler) { routes.set(path, handler); } }, pool);
  return routes;
}

test('readyz는 DB와 Discord 봇이 준비되면 200을 반환한다', async () => {
  global.__discordClient = { isReady: () => true };
  const routes = captureRoutes({ query: async () => [[{ ok: 1 }]] });
  const res = createResponse();
  await routes.get('/readyz')({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

test('readyz는 의존성이 준비되지 않으면 503을 반환한다', async () => {
  global.__discordClient = { isReady: () => false };
  const routes = captureRoutes({ query: async () => { throw new Error('db down'); } });
  const res = createResponse();
  await routes.get('/readyz')({}, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.db, false);
  assert.equal(res.body.bot, false);
});

test('웹 전용 프로세스의 readyz는 DB만 준비되면 200을 반환한다', async () => {
  const previousProcessType = process.env.PROCESS_TYPE;
  process.env.PROCESS_TYPE = 'web';
  global.__discordClient = null;
  try {
    const routes = captureRoutes({ query: async () => [[{ ok: 1 }]] });
    const res = createResponse();
    await routes.get('/readyz')({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.db, true);
    assert.equal(res.body.bot, false);
    assert.equal(res.body.botRequired, false);
  } finally {
    if (previousProcessType === undefined) delete process.env.PROCESS_TYPE;
    else process.env.PROCESS_TYPE = previousProcessType;
  }
});
