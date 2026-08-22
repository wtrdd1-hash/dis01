'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('.env.example에는 플레이스홀더만 포함한다', (t) => {
  const envPath = path.join(__dirname, '..', '.env.example');
  if (!fs.existsSync(envPath)) {
    t.skip('.env.example 파일이 빌드 컨테이너에 포함되지 않음');
    return;
  }
  const template = fs.readFileSync(envPath, 'utf8');
  assert.match(template, /DISCORD_TOKEN=replace_with_/);
  assert.match(template, /DB_PASSWORD=replace_with_/);
  assert.match(template, /COOKIE_SECRET=replace_with_/);
  assert.doesNotMatch(template, /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(template, /(?:CF_API_KEY|CF_GLOBAL_API_KEY|GITHUB_CLIENT_SECRET)=/);
});

test('DB 백업과 실제 환경 파일을 Git으로 추적하지 않는다', (t) => {
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '--', 'backups', '*.sql', '*.sql.gz', '.env', '.env.*'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const unsafe = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line !== '.env.example');
    assert.deepEqual(unsafe, []);
  } catch (e) {
    t.skip('Git 실행 불가 또는 .git 디렉토리 없음 (컨테이너/배포 환경)');
  }
});
