'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  GENRES,
  publicGenreList,
  rewardPercentForGenre,
  applyGenreReward
} = require('../src/utils/mineGenres');

test('유료 채굴 장르는 해금 비용이 높을수록 클릭 보상이 증가한다', () => {
  const ordered = [...GENRES].sort((a, b) => a.unlockCost - b.unlockCost);
  for (let i = 1; i < ordered.length; i += 1) {
    assert.ok(
      ordered[i].rewardPercent >= ordered[i - 1].rewardPercent,
      `${ordered[i].id} 보상 배율이 더 저렴한 장르보다 낮으면 안 됩니다.`
    );
  }
  assert.equal(rewardPercentForGenre('classic'), 100);
  assert.equal(rewardPercentForGenre('ice'), 165);
  assert.equal(rewardPercentForGenre('crypto'), 225);
});

test('장르 배율은 정수와 BigInt 보상에 동일하게 적용된다', () => {
  assert.equal(applyGenreReward(100, 'classic'), 100);
  assert.equal(applyGenreReward(100, 'ice'), 165);
  assert.equal(applyGenreReward(100, 'crypto'), 225);
  assert.equal(applyGenreReward(100n, 'crypto'), 225n);
  assert.equal(applyGenreReward(0, 'crypto'), 0);
});

test('공개 광산 카탈로그가 화면 표시용 배율을 제공한다', () => {
  const catalog = publicGenreList();
  const classic = catalog.find((genre) => genre.id === 'classic');
  const ice = catalog.find((genre) => genre.id === 'ice');
  const crypto = catalog.find((genre) => genre.id === 'crypto');

  assert.equal(classic.rewardMultiplier, 1);
  assert.equal(ice.rewardMultiplier, 1.65);
  assert.equal(ice.rewardBonusPercent, 65);
  assert.equal(crypto.rewardMultiplier, 2.25);
});

test('드릴 타이밍은 스위트스팟 밖 클릭을 채굴 요청으로 보내지 않는다', () => {
  const client = fs.readFileSync(path.join(__dirname, '../src/web/public/js/mine-genres.js'), 'utf8');
  assert.match(
    client,
    /var perfect = needle >= 38 && needle <= 62;\s*if \(!perfect\) \{\s*flashMiss\(\);\s*return;\s*\}\s*mineClick\(ev, \{ perfect: true/
  );
});
