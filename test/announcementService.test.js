'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeAnnouncement,
  createAnnouncement,
  toggleAnnouncement,
  deleteAnnouncement
} = require('../src/utils/announcementService');

test('공지 입력값을 검증하고 허용된 구분만 받는다', () => {
  const normalized = normalizeAnnouncement({
    title: '  점검 안내  ',
    content: '  테스트 본문  ',
    type: 'maintenance',
    isPopup: true,
    author: '관리자'
  });
  assert.equal(normalized.title, '점검 안내');
  assert.equal(normalized.content, '테스트 본문');
  assert.equal(normalized.type, 'MAINTENANCE');
  assert.equal(normalized.isPopup, true);
  assert.throws(
    () => normalizeAnnouncement({ title: 'x', content: 'y', type: '<script>' }),
    /지원하지 않는 공지 구분/
  );
});

test('공지 생성은 파라미터 쿼리를 사용하고 팝업 이벤트를 전송한다', async () => {
  const calls = [];
  const emitted = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return [{ insertId: 42 }];
    }
  };
  const io = { emit: (...args) => emitted.push(args) };
  const created = await createAnnouncement({
    title: '<img src=x onerror=alert(1)>',
    content: '<script>alert(1)</script>',
    type: 'IMPORTANT',
    isPopup: true,
    author: 'qa-admin'
  }, { db, io });

  assert.equal(created.id, 42);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].sql.includes('VALUES (?, ?, ?, ?, 1, ?, COALESCE(?, NOW()), ?)'));
  assert.equal(calls[0].params[0], '<img src=x onerror=alert(1)>');
  assert.deepEqual(emitted[0], ['announcement:popup', created]);
});

test('공지 토글과 삭제는 존재하지 않는 ID를 안전하게 처리한다', async () => {
  const db = {
    async query(sql) {
      if (sql.startsWith('SELECT')) return [[]];
      return [{ affectedRows: 0 }];
    }
  };
  assert.equal(await toggleAnnouncement(7, { db, io: null }), null);
  assert.equal(await deleteAnnouncement(7, { db }), false);
  await assert.rejects(() => deleteAnnouncement('not-an-id', { db }), /공지 ID/);
});

test('디스코드 관리자 공지 명령 스키마가 네 가지 관리 동작을 제공한다', () => {
  const command = require('../src/commands/admin/adminNotice');
  const json = command.data.toJSON();
  assert.equal(json.name, 'admin_notice');
  assert.deepEqual(json.options.map((option) => option.name), ['create', 'list', 'toggle', 'delete']);
});
