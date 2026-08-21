'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('관리자 사이드바에서 공지 등록 폼으로 바로 이동할 수 있다', () => {
  const header = fs.readFileSync(path.join(root, 'src/web/views/admin/header.ejs'), 'utf8');
  const consoleView = fs.readFileSync(path.join(root, 'src/web/views/admin/console.ejs'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src/web/adminPageRoutes.js'), 'utf8');

  assert.match(header, /href="\/admin\/announcements"/);
  assert.match(header, /공지-팝업/);
  assert.match(consoleView, /id="announcement-manager"/);
  assert.match(routes, /\/admin\/console#announcement-manager/);
});
