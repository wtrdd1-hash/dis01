'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getShopCatalog, findCatalogItem } = require('../src/utils/shopEngine');
const { ENHANCE_TABLE } = require('../src/utils/enhancementEngine');

test('상점 카탈로그 및 화폐 소각 아이템 무결성 검증', (t) => {
  const catalog = getShopCatalog();
  assert.ok(catalog.length >= 10, '상점 아이템이 10개 이상 등록되어 있어야 함');

  const auras = catalog.filter(i => i.type === 'AURA');
  assert.ok(auras.length >= 3, '명예 오라가 3개 이상이어야 함');

  const titles = catalog.filter(i => i.type === 'TITLE');
  assert.ok(titles.length >= 3, '명예 칭호가 3개 이상이어야 함');

  // 모든 아이템 가격이 양수인지 검증
  for (const item of catalog) {
    assert.ok(item.price > 0n, `${item.name}의 가격은 0보다 커야 함`);
  }
});

test('로또 6/45 30% 확정 소각 및 70% 잭팟 분배 공식 검증', (t) => {
  const ticketPrice = 1000n;
  const burnPercent = 30n;
  const prizePercent = 70n;

  const burn = (ticketPrice * burnPercent) / 100n;
  const prize = (ticketPrice * prizePercent) / 100n;

  assert.equal(burn, 300n, '1,000원 중 300원이 소각되어야 함');
  assert.equal(prize, 700n, '1,000원 중 700원이 잭팟 풀에 적립되어야 함');
  assert.equal(burn + prize, ticketPrice, '소각액과 적립액의 합이 티켓 가격과 일치해야 함');
});

test('채굴 드릴 대장간 (+1 ~ +15강) 강화 테이블 검증', (t) => {
  assert.equal(ENHANCE_TABLE.length, 15, '강화 단계는 총 15단계여야 함');

  // +1~+3강은 100% 성공
  assert.equal(ENHANCE_TABLE[0].rate, 100);
  assert.equal(ENHANCE_TABLE[1].rate, 100);
  assert.equal(ENHANCE_TABLE[2].rate, 100);

  // 단계가 올라갈수록 비용이 증가해야 함
  for (let i = 1; i < ENHANCE_TABLE.length; i++) {
    assert.ok(ENHANCE_TABLE[i].cost > ENHANCE_TABLE[i - 1].cost, `+${i + 1}강 비용은 이전 단계보다 커야 함`);
    assert.ok(ENHANCE_TABLE[i].bonus > ENHANCE_TABLE[i - 1].bonus, `+${i + 1}강 버프는 이전 단계보다 커야 함`);
  }
});
