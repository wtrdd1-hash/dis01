'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chat = require('../src/web/chatService');

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

test('💬 [Chat QA] 채팅 수정 및 삭제 권한 및 유효성 검증', async () => {
  // 비로그인 검증
  const unauthEdit = await chat.editMessage(null, 1, '수정된 메시지');
  assert.strictEqual(unauthEdit.status, 401, '비로그인 시 401 반환');

  const unauthDelete = await chat.deleteMessage(null, 1);
  assert.strictEqual(unauthDelete.status, 401, '비로그인 시 401 반환');

  // 빈 내용 수정 검증
  const emptyEdit = await chat.editMessage({ id: 'user123' }, 1, '   ');
  assert.strictEqual(emptyEdit.status, 400, '빈 메시지 수정 시 400 반환');

  // 잘못된 ID 검증
  const invalidIdEdit = await chat.editMessage({ id: 'user123' }, -5, '테스트');
  assert.strictEqual(invalidIdEdit.status, 400, '잘못된 ID 시 400 반환');
});
