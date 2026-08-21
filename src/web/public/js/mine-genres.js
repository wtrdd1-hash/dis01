(function () {
  if (window.__mineHubInstalled) return;
  window.__mineHubInstalled = true;

  var state = null;
  var genre = 'classic';
  var combo = 0;
  var comboTimer = null;
  var raf = 0;
  var running = false;
  var entities = [];
  var needle = 0;
  var needleDir = 1;
  var well = 0;
  var lastSpawn = 0;
  var cartX = 8;
  var cartDir = 1;
  var iceHp = 6;
  var iceResetting = false;
  var matchOpen = [];
  var matchBusy = false;
  var veinLit = 0;
  var hashSwitchAt = 0;
  var selectionPending = false;

  function $(id) { return document.getElementById(id); }
  function stage() { return $('mine-stage'); }

  function fakeEvent(x, y) {
    return { clientX: x, clientY: y };
  }

  function setText(id, v) {
    var el = $(id);
    if (el) el.textContent = v;
  }

  function currentGenreMeta() {
    var list = (state && state.genres) || [];
    return list.find(function (g) { return g.id === genre; }) || { id: 'classic', name: '보석 연타', desc: '', hint: '', unlocked: true, depth: 0, badge: { name: '견습', emoji: '🌱' }, unlockCost: 0, rewardMultiplier: 1 };
  }

  function currentRewardMultiplier() {
    var mult = Number(currentGenreMeta().rewardMultiplier || 1);
    return Number.isFinite(mult) && mult >= 1 ? mult : 1;
  }

  function refreshPowerDisplay() {
    var el = $('clicker-power-val');
    if (!el) return;
    var rawBase = el.getAttribute('data-base-power');
    var base = parseInt(rawBase || '', 10);
    if (!Number.isFinite(base) || base <= 0) {
      base = parseInt((el.textContent || '').replace(/[^0-9]/g, ''), 10) || 1;
      el.setAttribute('data-base-power', String(base));
    }
    var mult = currentRewardMultiplier();
    var adjusted = Math.max(1, Math.floor(base * mult));
    el.setAttribute('data-genre-multiplier', String(mult));
    el.textContent = '+' + adjusted.toLocaleString('ko-KR') + '원';
    setText('mine-reward-mult', 'x' + mult.toFixed(2));
  }

  function burst(e, crit) {
    var zone = $('clicker-zone') || stage();
    if (!zone) return;
    var rect = zone.getBoundingClientRect();
    var x = e && e.clientX ? e.clientX - rect.left : rect.width / 2;
    var y = e && e.clientY ? e.clientY - rect.top : rect.height / 2;
    var colors = crit ? ['#fbbf24', '#f59e0b', '#fff'] : ['#60a5fa', '#34d399', '#c4b5fd'];
    for (var i = 0; i < 8; i++) {
      var s = document.createElement('span');
      s.className = 'mine-spark';
      var ang = (Math.PI * 2 * i) / 8;
      var dist = 18 + Math.random() * 22;
      s.style.left = x + 'px';
      s.style.top = y + 'px';
      s.style.background = colors[i % colors.length];
      s.style.setProperty('--dx', (Math.cos(ang) * dist) + 'px');
      s.style.setProperty('--dy', (Math.sin(ang) * dist) + 'px');
      zone.appendChild(s);
      setTimeout(function (node) { node.remove(); }, 460, s);
    }
  }

  function tickCombo() {
    combo += 1;
    setText('mine-combo', combo);
    var pop = $('mine-combo-pop');
    if (pop) pop.textContent = combo >= 2 ? combo + ' COMBO' : '';
    clearTimeout(comboTimer);
    comboTimer = setTimeout(function () {
      combo = 0;
      setText('mine-combo', '0');
      if (pop) pop.textContent = '';
    }, 800);
  }

  function mineClick(e, extra) {
    extra = extra || {};
    if (selectionPending) {
      setText('click-feedback-msg', '장르 보상을 서버에 적용하는 중입니다. 잠시만 기다려 주세요.');
      return;
    }
    var meta = currentGenreMeta();
    if (meta && meta.unlocked === false) {
      renderUnlock(meta);
      return;
    }
    if (typeof handleClickMining === 'function') handleClickMining(e || fakeEvent());
    if (extra.perfect && $('click-feedback-msg')) {
      $('click-feedback-msg').textContent = extra.perfectText || 'PERFECT! 현재 장르 보너스가 적용됩니다.';
    }
  }

  window.MineHub = {
    genre: function () { return genre; },
    rewardMultiplier: currentRewardMultiplier,
    refreshPower: refreshPowerDisplay,
    combo: function () { return combo; },
    depth: function () {
      var g = currentGenreMeta();
      return (g.depth || 0) + Math.floor(combo / 8);
    },
    onEarned: function (e, isCrit, gain) {
      tickCombo();
      burst(e, isCrit);
      if (gain && typeof window.applyUserLiveSnapshot === 'function') {
        try {
          var cashEl = $('my-cash');
          var raw = cashEl ? (cashEl.getAttribute('data-raw') || '0') : '0';
          var nextBig = BigInt(raw) + BigInt(gain);
          window.applyUserLiveSnapshot({ cash: nextBig.toString() });
        } catch (_) {}
      }
    }
  };

  // ⚡ 자동 채굴기 실시간 1초 틱 (초당 +X원 자동 지갑 반응)
  if (!window.__mineAutoTickerStarted) {
    window.__mineAutoTickerStarted = true;
    setInterval(function () {
      if (document.hidden) return;
      try {
        var autoEl = $('clicker-auto-val');
        if (!autoEl) return;
        var autoIncomeStr = (autoEl.textContent || autoEl.innerText || '').replace(/[^0-9]/g, '');
        var autoIncome = parseInt(autoIncomeStr, 10) || 0;
        if (autoIncome > 0 && typeof window.applyUserLiveSnapshot === 'function') {
          var cashEl = $('my-cash');
          var raw = cashEl ? (cashEl.getAttribute('data-raw') || '0') : '0';
          var nextBig = BigInt(raw) + BigInt(autoIncome);
          window.applyUserLiveSnapshot({ cash: nextBig.toString() });
        }
      } catch (_) {}
    }, 1000);
  }

  function stopLoop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    entities = [];
  }

  function loop(ts) {
    if (!running) return;
    var st = stage();
    if (!st) return;
    var w = st.clientWidth;
    var h = st.clientHeight;
    if (genre === 'catch') stepCatch(ts, w, h);
    else if (genre === 'space') stepSpace(ts, w, h);
    else if (genre === 'ocean') stepOcean(ts, w, h);
    else if (genre === 'drill') stepDrill(ts, w);
    else if (genre === 'crypto') stepCrypto(ts);
    else if (genre === 'mole') stepMole(ts);
    else if (genre === 'cart') stepCart();
    else if (genre === 'lava') stepLava(ts, w, h);
    raf = requestAnimationFrame(loop);
  }

  function startLoop() {
    stopLoop();
    running = genre === 'catch' || genre === 'space' || genre === 'ocean' || genre === 'drill'
      || genre === 'crypto' || genre === 'mole' || genre === 'cart' || genre === 'lava';
    if (running) raf = requestAnimationFrame(loop);
  }

  function bindEntity(el) {
    el.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      mineClick(ev);
    });
  }

  function renderClassic() {
    var st = stage();
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>' +
      '<button type="button" class="big-click-gem" id="gem-clicker">채굴</button>';
    $('gem-clicker').onclick = function (ev) { handleClickMining(ev); };
  }

  function renderShaft() {
    var st = stage();
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>';
    var layers = 5;
    for (var i = 0; i < layers; i++) {
      var rock = document.createElement('button');
      rock.type = 'button';
      rock.className = 'mine-entity mine-rock';
      rock.textContent = i % 2 ? '🪨' : '⛏️';
      rock.style.left = (8 + (i % 3) * 30) + '%';
      rock.style.top = (12 + Math.floor(i / 3) * 38) + '%';
      rock.onclick = function (ev) {
        ev.preventDefault();
        mineClick(ev);
        this.style.transform = 'scale(0.7)';
        var node = this;
        setTimeout(function () {
          node.style.left = (8 + Math.random() * 70) + '%';
          node.style.top = (10 + Math.random() * 60) + '%';
          node.style.transform = '';
        }, 90);
      };
      st.appendChild(rock);
    }
  }

  function spawnFalling(kind) {
    var st = stage();
    if (!st) return;
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'mine-entity ' + kind;
    if (kind === 'mine-ore') el.textContent = ['💎', '🪨', '🪙', '🔶'][Math.floor(Math.random() * 4)];
    if (kind === 'mine-pearl') el.textContent = '🫧';
    if (kind === 'mine-rock-astro') el.textContent = '☄️';
    el.style.left = (6 + Math.random() * 78) + '%';
    el.style.top = kind === 'mine-pearl' ? (60 + Math.random() * 25) + '%' : '-12%';
    el.dataset.vy = String(0.12 + Math.random() * 0.22);
    el.dataset.vx = String((Math.random() - 0.5) * 0.12);
    bindEntity(el);
    st.appendChild(el);
    entities.push(el);
  }

  function stepCatch(ts, w, h) {
    if (ts - lastSpawn > 520) {
      lastSpawn = ts;
      spawnFalling('mine-ore');
    }
    entities = entities.filter(function (el) {
      var y = parseFloat(el.style.top) || 0;
      y += parseFloat(el.dataset.vy) * 12;
      el.style.top = y + '%';
      if (y > 110) {
        el.remove();
        return false;
      }
      return true;
    });
  }

  function stepSpace(ts, w, h) {
    if (ts - lastSpawn > 700 && entities.length < 7) {
      lastSpawn = ts;
      spawnFalling('mine-rock-astro');
    }
    entities = entities.filter(function (el) {
      var y = parseFloat(el.style.top) || 0;
      var x = parseFloat(el.style.left) || 0;
      y += parseFloat(el.dataset.vy) * 7;
      x += parseFloat(el.dataset.vx) * 8;
      if (x < 0 || x > 90) el.dataset.vx = String(-parseFloat(el.dataset.vx));
      el.style.top = y + '%';
      el.style.left = x + '%';
      if (y > 110) {
        el.remove();
        return false;
      }
      return true;
    });
  }

  function stepOcean(ts) {
    if (entities.length < 5 && ts - lastSpawn > 400) {
      lastSpawn = ts;
      spawnFalling('mine-pearl');
      var last = entities[entities.length - 1];
      if (last) last.style.top = (20 + Math.random() * 55) + '%';
    }
    entities.forEach(function (el) {
      var y = parseFloat(el.style.top) || 40;
      y += Math.sin(ts / 400 + parseFloat(el.style.left)) * 0.15;
      el.style.top = Math.max(8, Math.min(78, y)) + '%';
    });
  }

  function stepDrill() {
    needle += needleDir * 1.6;
    if (needle >= 100) { needle = 100; needleDir = -1; }
    if (needle <= 0) { needle = 0; needleDir = 1; }
    var n = $('mine-needle');
    if (n) n.style.left = needle + '%';
  }

  function renderDrill() {
    var st = stage();
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>' +
      '<div class="mine-gauge"><div class="mine-gauge-sweet" style="left:38%;width:24%"></div><div class="mine-gauge-needle" id="mine-needle"></div></div>' +
      '<button type="button" class="big-click-gem" id="gem-clicker" style="margin-top:28px">굴착</button>';
    $('gem-clicker').onclick = function (ev) {
      var perfect = needle >= 38 && needle <= 62;
      if (!perfect) {
        flashMiss();
        return;
      }
      mineClick(ev, { perfect: true, perfectText: 'PERFECT 드릴! 장르 보너스 x' + currentRewardMultiplier().toFixed(2) + ' 적용!' });
    };
  }

  function activateCryptoBlock(next) {
    var st = stage();
    if (!st) return;
    var blocks = st.querySelectorAll('.mine-block');
    blocks.forEach(function (b) {
      b.classList.remove('hot');
      b.removeAttribute('id');
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', '대기 중인 해시 블록');
    });
    if (!next && blocks.length) next = blocks[Math.floor(Math.random() * blocks.length)];
    if (next) {
      next.classList.add('hot');
      next.id = 'mine-hot-block';
      next.setAttribute('aria-pressed', 'true');
      next.setAttribute('aria-label', '빛나는 채굴 대상 해시 블록');
    }
  }

  function stepCrypto(ts) {
    if (ts < hashSwitchAt) return;
    activateCryptoBlock();
    hashSwitchAt = ts + 1200;
  }

  function renderCrypto() {
    var st = stage();
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>';
    for (var i = 0; i < 8; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mine-entity mine-block' + (i === 0 ? ' hot' : '');
      b.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      b.setAttribute('aria-label', i === 0 ? '빛나는 채굴 대상 해시 블록' : '대기 중인 해시 블록');
      if (i === 0) b.id = 'mine-hot-block';
      b.textContent = Math.random().toString(16).slice(2, 8);
      b.style.left = (6 + (i % 4) * 24) + '%';
      b.style.top = (18 + Math.floor(i / 4) * 40) + '%';
      b.onclick = function (ev) {
        if (!this.classList.contains('hot')) {
          flashMiss();
          return;
        }
        this.textContent = Math.random().toString(16).slice(2, 8);
        mineClick(ev);
        activateCryptoBlock();
        hashSwitchAt = performance.now() + 1200;
      };
      st.appendChild(b);
    }
    hashSwitchAt = performance.now() + 1200;
  }

  function renderOil() {
    var st = stage();
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>' +
      '<div class="mine-derrick"><button type="button" class="mine-derrick-btn" id="oil-hit">시추</button><div class="mine-well"><span id="oil-well"></span></div></div>';
    $('oil-hit').onclick = function (ev) {
      well = Math.min(100, well + 8);
      var bar = $('oil-well');
      if (bar) bar.style.width = well + '%';
      if (well >= 100) well = 0;
      mineClick(ev);
    };
  }

  function flashMiss() {
    var fb = $('click-feedback-msg');
    if (!fb) return;
    var prev = fb.textContent;
    fb.textContent = '타이밍이 아닙니다. 다시!';
    setTimeout(function () {
      var meta = currentGenreMeta();
      if (fb) fb.textContent = meta.hint || prev;
    }, 700);
  }

  function renderMole() {
    var st = stage();
    var html = '<div class="mine-combo-pop" id="mine-combo-pop"></div><div class="mine-mole-grid">';
    for (var i = 0; i < 9; i++) html += '<button type="button" class="mine-hole" data-hole="' + i + '"></button>';
    html += '</div>';
    st.innerHTML = html;
    st.querySelectorAll('.mine-hole').forEach(function (hole) {
      hole.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!this.classList.contains('up')) return;
        this.classList.remove('up');
        this.textContent = '';
        mineClick(ev);
      };
    });
    lastSpawn = 0;
  }

  function stepMole(ts) {
    if (ts - lastSpawn < 780) return;
    lastSpawn = ts;
    var holes = stage() ? stage().querySelectorAll('.mine-hole') : [];
    if (!holes.length) return;
    holes.forEach(function (h) {
      h.classList.remove('up');
      h.textContent = '';
    });
    var pick = holes[Math.floor(Math.random() * holes.length)];
    if (!pick) return;
    pick.classList.add('up');
    pick.textContent = ['💎', '🐹', '🪙'][Math.floor(Math.random() * 3)];
  }

  function shuffle(list) {
    var arr = list.slice();
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function renderMatch() {
    var st = stage();
    var syms = ['💎', '🪙', '🔶', '🪨', '⭐', '💠'];
    var deck = shuffle(syms.concat(syms));
    matchOpen = [];
    matchBusy = false;
    var html = '<div class="mine-combo-pop" id="mine-combo-pop"></div><div class="mine-match-grid">';
    for (var i = 0; i < deck.length; i++) {
      html += '<button type="button" class="mine-card" data-sym="' + deck[i] + '">▪</button>';
    }
    html += '</div>';
    st.innerHTML = html;
    st.querySelectorAll('.mine-card').forEach(function (card) {
      card.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (matchBusy || this.classList.contains('on') || this.classList.contains('done')) return;
        this.classList.add('on');
        this.textContent = this.getAttribute('data-sym');
        matchOpen.push(this);
        if (matchOpen.length < 2) return;
        matchBusy = true;
        var a = matchOpen[0];
        var b = matchOpen[1];
        matchOpen = [];
        if (a.getAttribute('data-sym') === b.getAttribute('data-sym')) {
          a.classList.add('done');
          b.classList.add('done');
          matchBusy = false;
          // 💎 원석 짝맞추기 보상 강화: 짝 맞춤 성공 시 2회 클릭 보상 + 올클리어 보너스
          mineClick(ev, { perfect: true, perfectText: '✨ 원석 짝 완성! 2배 채굴 보상!' });
          mineClick(ev, { perfect: true });
          var left = st.querySelectorAll('.mine-card:not(.done)');
          if (!left.length) {
            matchBusy = true;
            setTimeout(function () {
              for (var bonus = 0; bonus < 5; bonus++) {
                mineClick(ev, { perfect: true, perfectText: '🎉 원석 짝맞추기 올클리어 보너스! (+5연타)' });
              }
              renderMatch();
            }, 500);
          }
        } else {
          setTimeout(function () {
            a.classList.remove('on');
            b.classList.remove('on');
            a.textContent = '▪';
            b.textContent = '▪';
            matchBusy = false;
          }, 480);
        }
      };
    });
  }

  function renderCart() {
    var st = stage();
    cartX = 8;
    cartDir = 1;
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>' +
      '<div class="mine-cart-track"><span class="mine-cart-sweet"></span><button type="button" class="mine-cart" id="mine-cart">🛒</button></div>' +
      '<button type="button" class="mine-cart-hit" id="mine-cart-hit">적재</button>';
    $('mine-cart-hit').onclick = function (ev) {
      if (cartX >= 38 && cartX <= 62) mineClick(ev, { perfect: true, perfectText: '적재 성공! 장르 보너스 x' + currentRewardMultiplier().toFixed(2) + ' 적용!' });
      else flashMiss();
    };
  }

  function stepCart() {
    cartX += cartDir * 1.35;
    if (cartX >= 88) { cartX = 88; cartDir = -1; }
    if (cartX <= 4) { cartX = 4; cartDir = 1; }
    var c = $('mine-cart');
    if (c) c.style.left = cartX + '%';
  }

  function renderIce() {
    iceHp = 6;
    iceResetting = false;
    var st = stage();
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>' +
      '<button type="button" class="mine-ice" id="mine-ice">🧊</button>' +
      '<div class="mine-ice-hp" id="mine-ice-hp">내구 6</div>';
    $('mine-ice').onclick = function (ev) {
      if (iceResetting) return;
      iceHp -= 1;
      this.style.setProperty('--crack', String(1 - iceHp / 6));
      this.textContent = iceHp <= 0 ? '💎' : '🧊';
      var hp = $('mine-ice-hp');
      if (hp) hp.textContent = iceHp <= 0 ? '원석!' : ('내구 ' + iceHp);
      mineClick(ev);
      if (iceHp <= 0) {
        iceResetting = true;
        var node = this;
        node.classList.add('revealed');
        node.disabled = true;
        setTimeout(function () {
          iceHp = 6;
          iceResetting = false;
          node.textContent = '🧊';
          node.classList.remove('revealed');
          node.disabled = false;
          node.style.setProperty('--crack', '0');
          if (hp) hp.textContent = '내구 6';
        }, 700);
      }
    };
  }

  function renderLava() {
    var st = stage();
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>';
    st.style.background = 'radial-gradient(circle at 50% 120%, #7c2d12, #1c1917 58%, #020617)';
    entities = [];
    lastSpawn = 0;
  }

  function stepLava(ts) {
    if (ts - lastSpawn > 640 && entities.length < 6) {
      lastSpawn = ts;
      var st = stage();
      if (!st) return;
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'mine-entity mine-lava-ore';
      el.textContent = ['🔶', '💎', '🪨'][Math.floor(Math.random() * 3)];
      el.style.left = (8 + Math.random() * 74) + '%';
      el.style.top = (18 + Math.random() * 58) + '%';
      el.dataset.life = '18';
      el.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        el.remove();
        entities = entities.filter(function (n) { return n !== el; });
        mineClick(ev);
      };
      st.appendChild(el);
      entities.push(el);
    }
    entities = entities.filter(function (el) {
      var life = Number(el.dataset.life || 0) - 1;
      el.dataset.life = String(life);
      el.style.opacity = String(Math.max(0.2, life / 18));
      if (life <= 0) {
        el.remove();
        return false;
      }
      return true;
    });
  }

  function renderVein() {
    var st = stage();
    var html = '<div class="mine-combo-pop" id="mine-combo-pop"></div><div class="mine-vein-grid">';
    for (var i = 0; i < 9; i++) html += '<button type="button" class="mine-vein-cell" data-cell="' + i + '"></button>';
    html += '</div>';
    st.innerHTML = html;
    veinLit = Math.floor(Math.random() * 9);
    paintVein();
    st.querySelectorAll('.mine-vein-cell').forEach(function (cell) {
      cell.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (Number(this.getAttribute('data-cell')) !== veinLit) {
          flashMiss();
          return;
        }
        mineClick(ev);
        veinLit = Math.floor(Math.random() * 9);
        paintVein();
      };
    });
  }

  function paintVein() {
    var cells = stage() ? stage().querySelectorAll('.mine-vein-cell') : [];
    cells.forEach(function (c) {
      var on = Number(c.getAttribute('data-cell')) === veinLit;
      c.classList.toggle('lit', on);
      c.textContent = on ? '✦' : '';
    });
  }

  function renderOcean() {
    var st = stage();
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>';
    st.style.background = 'radial-gradient(circle at 50% 120%, #0e7490, #082f49 55%, #020617)';
    entities = [];
    lastSpawn = 0;
  }

  function renderCatch() {
    var st = stage();
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>';
    st.style.background = '#1a1b1e';
    entities = [];
    lastSpawn = 0;
  }

  function renderSpace() {
    var st = stage();
    st.innerHTML = '<div class="mine-combo-pop" id="mine-combo-pop"></div>';
    st.style.background = 'radial-gradient(circle at 20% 20%, #1e1b4b, #020617 60%)';
    entities = [];
    lastSpawn = 0;
  }

  function renderGenre() {
    var st = stage();
    if (!st) return;
    st.setAttribute('data-genre', genre);
    st.style.background = '';
    if (state && state.weather) st.setAttribute('data-weather', state.weather.id);
    stopLoop();
    if (genre === 'shaft') renderShaft();
    else if (genre === 'mole') renderMole();
    else if (genre === 'catch') renderCatch();
    else if (genre === 'match') renderMatch();
    else if (genre === 'drill') renderDrill();
    else if (genre === 'cart') renderCart();
    else if (genre === 'ocean') renderOcean();
    else if (genre === 'ice') renderIce();
    else if (genre === 'space') renderSpace();
    else if (genre === 'oil') renderOil();
    else if (genre === 'lava') renderLava();
    else if (genre === 'vein') renderVein();
    else if (genre === 'crypto') renderCrypto();
    else renderClassic();
    startLoop();
  }

  function renderUnlock(meta) {
    var bar = $('mine-unlock-bar');
    if (!bar) return;
    if (meta.unlocked) {
      bar.classList.remove('show');
      bar.innerHTML = '';
      return;
    }
    bar.classList.add('show');
    bar.innerHTML = '<span>🔒 ' + meta.name + ' 해금 ' + Number(meta.unlockCost).toLocaleString('ko-KR') + '원 · 한 번이면 유지</span>' +
      '<button type="button" id="mine-unlock-btn">해금</button>';
    $('mine-unlock-btn').onclick = function () { unlock(meta.id); };
  }

  function renderHud() {
    var meta = currentGenreMeta();
    setText('mine-depth', (meta.depth || 0) + 'm');
    setText('mine-badge', (meta.badge && (meta.badge.emoji + ' ' + meta.badge.name)) || '견습');
    setText('mine-genre-desc', meta.desc || '');
    refreshPowerDisplay();
    var fb = $('click-feedback-msg');
    if (fb) fb.textContent = meta.hint || '';
    if (state && state.weather) {
      setText('mine-weather', state.weather.emoji + ' ' + state.weather.label);
    }
    renderUnlock(meta);
  }

  function renderTabs() {
    var box = $('mine-genre-tabs');
    if (!box || !state) return;
    box.innerHTML = (state.genres || []).map(function (g) {
      var cls = 'mine-tab' + (g.id === genre ? ' active' : '') + (g.unlocked ? '' : ' locked');
      var extra = g.unlocked ? '' : ' 🔒';
      return '<button type="button" class="' + cls + '" data-genre="' + g.id + '">' + g.emoji + ' ' + g.name + extra + '</button>';
    }).join('');
    box.querySelectorAll('[data-genre]').forEach(function (btn) {
      btn.onclick = function () { selectGenre(btn.getAttribute('data-genre')); };
    });
  }

  function renderBoard() {
    var box = $('mine-leaderboard');
    if (box) {
      var rows = (state && state.leaderboard) || [];
      box.innerHTML = rows.length
        ? '<ol>' + rows.map(function (r) {
          return '<li>' + r.username + ' · ' + Number(r.clicks).toLocaleString('ko-KR') + '회</li>';
        }).join('') + '</ol>'
        : '<p style="color:#949ba4;font-size:13px">아직 기록이 없습니다.</p>';
    }
    var badges = $('mine-badges');
    if (badges && state && state.genres) {
      badges.innerHTML = state.genres.map(function (g) {
        var on = g.unlocked ? ' on' : '';
        var b = g.badge || {};
        return '<span class="mine-badge-chip' + on + '">' + g.emoji + ' ' + (b.emoji || '') + ' ' + g.name + '</span>';
      }).join('');
    }
  }

  function applyState(data) {
    if (!data) return;
    state = data;
    if (data.selected) genre = data.selected;
    try { localStorage.setItem('wtrdd_mine_genre', genre); } catch (e) {}
    renderTabs();
    renderHud();
    renderBoard();
    renderGenre();
  }

  async function loadState() {
    try {
      var res = await fetch('/api/mine/state', { credentials: 'same-origin', cache: 'no-store' });
      var data = await res.json();
      if (data.success) applyState(data);
    } catch (e) {}
  }

  async function selectGenre(id) {
    var meta = ((state && state.genres) || []).find(function (g) { return g.id === id; });
    if (!meta) return;
    genre = id;
    try { localStorage.setItem('wtrdd_mine_genre', id); } catch (e) {}
    renderTabs();
    renderHud();
    renderGenre();
    if (!meta.unlocked) return;
    selectionPending = true;
    var st = stage();
    if (st) st.classList.add('is-switching');
    try {
      var res = await fetch('/api/mine/select', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ genre: id })
      });
      var data = await res.json();
      if (data.success) applyState(data);
      else await loadState();
    } catch (e) {
      await loadState();
    } finally {
      selectionPending = false;
      if (st) st.classList.remove('is-switching');
    }
  }

  async function unlock(id) {
    try {
      var res = await fetch('/api/mine/unlock', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ genre: id })
      });
      var data = await res.json();
      if (!data.success) {
        if (typeof showToast === 'function') showToast('error', '해금 실패', data.error);
        return;
      }
      if (data.newCash && typeof updateUserCashDisplay === 'function') updateUserCashDisplay(data.newCash);
      if (typeof showToast === 'function') showToast('success', '장르 해금', data.message);
      applyState(data);
    } catch (e) {
      if (typeof showToast === 'function') showToast('error', '통신 오류', '서버와 연결할 수 없습니다.');
    }
  }

  function pauseIfHidden() {
    var pane = $('tab-clicker');
    var on = pane && pane.classList.contains('active');
    if (!on) stopLoop();
    else if (!running) startLoop();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopLoop();
    else pauseIfHidden();
  });

  var origSwitch = window.switchTab;
  if (typeof origSwitch === 'function') {
    window.switchTab = function (id) {
      origSwitch(id);
      setTimeout(pauseIfHidden, 30);
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadState);
  } else {
    loadState();
  }
  setInterval(function () {
    var pane = $('tab-clicker');
    if (pane && pane.classList.contains('active')) loadState();
  }, 20000);
})();
