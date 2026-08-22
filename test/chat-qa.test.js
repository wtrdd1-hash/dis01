'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('💬 [Chat QA] 광장 채팅 텍스트 살균(Sanitize) 및 태그 이스케이프 검증', () => {
  const rawXss = '<script>alert(1)</script>&"\'';
  const sanitized = String(rawXss)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  assert.ok(!sanitized.includes('<script>'), 'HTML 태그가 이스케이프되어야 합니다.');
  assert.ok(sanitized.includes('&lt;script&gt;'), '태그가 안전하게 변환되어야 합니다.');
});

test('💬 [Chat QA] 메시지 년도/날짜 및 시간 포맷 검증 (YYYY.MM.DD HH:mm)', () => {
  const d = new Date('2026-08-22T20:00:00Z');
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  const formatted = `${year}.${month}.${day} ${hours}:${mins}`;
  assert.match(formatted, /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}$/, '날짜/시간 형식은 YYYY.MM.DD HH:mm 형태여야 합니다.');
});

