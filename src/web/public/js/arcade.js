/**
 * 아케이드 로비 + 모드별 다른 GUI. 실제 정산은 기존 API를 그대로 쓴다.
 */
(function () {
  if (window.Arcade) return;

  var state = null;
  var current = null;
  var crashTimer = null;
  var horsePick = 1;
  var horsePick2 = 0;
  var horseMode = 'win';
  var horseCard = { horses: [] };
  var MAX_LEVEL = 40;

  function won(n) {
    if (typeof window.formatMoneyCompact === 'function') return window.formatMoneyCompact(n);
    try { return Number(n || 0).toLocaleString('ko-KR') + '원'; } catch (e) { return n + '원'; }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(type, msg) {
    if (typeof showToast === 'function') showToast(type === 'success' ? 'success' : (type === 'info' ? 'info' : 'error'), '아케이드', msg);
  }

  function cash(v) {
    if (v != null && window.updateUserCashDisplay) window.updateUserCashDisplay(v);
  }

  function resultHook(data, game) {
    if (window.CasinoUX) window.CasinoUX.onGameResult(Object.assign({ game: game }, data || {}));
    load(true);
  }

  function parseBetValue(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { allIn: false, amount: 0n };
    if (/^(all|max|전액|올인|전량|전체|최대)$/i.test(s)) return { allIn: true, amount: 0n };
    if (typeof window.parseClientMoney === 'function') {
      var p = window.parseClientMoney(s);
      if (p === 'ALL') return { allIn: true, amount: 0n };
      try { return { allIn: false, amount: BigInt(p) }; } catch (e) { return { allIn: false, amount: 0n }; }
    }
    try {
      return { allIn: false, amount: BigInt(s.replace(/[^\d-]/g, '') || '0') };
    } catch (e) {
      return { allIn: false, amount: 0n };
    }
  }

  function betOf(id, minBet) {
    var el = document.getElementById(id);
    if (!el) return String(minBet || 1000);
    if (el.getAttribute('data-all-in') === '1') return 'all';
    var parsed = parseBetValue(el.value);
    if (parsed.allIn) return 'all';
    var n = parsed.amount;
    var minN = BigInt(minBet || 0);
    if (minN > 0n && n < minN) {
      el.value = String(minBet);
      n = minN;
    }
    if (n <= 0n) return '0';
    return n.toString();
  }

  function addBet(id, amt) {
    var el = document.getElementById(id);
    if (!el) return;
    if (amt === 'reset') {
      el.value = '1000';
      el.removeAttribute('data-all-in');
      return;
    }
    if (amt === 'all') {
      el.setAttribute('data-all-in', '1');
      el.value = '올인';
      return;
    }
    el.removeAttribute('data-all-in');
    var parsed = parseBetValue(el.value);
    var cur = parsed.allIn ? 0n : parsed.amount;
    var addn = 0n;
    try { addn = typeof amt === 'bigint' ? amt : BigInt(String(Math.trunc(Number(amt) || 0))); } catch (e) { addn = 0n; }
    var next = cur + addn;
    if (next < 0n) next = 0n;
    el.value = next.toString();
  }

  function chips(id) {
    return '<div class="arc-bet">' +
      '<input type="text" id="' + id + '" inputmode="decimal" value="5000" placeholder="5천 또는 올인">' +
      '<button type="button" class="arc-chip" data-add="' + id + '" data-n="1000">+1천</button>' +
      '<button type="button" class="arc-chip" data-add="' + id + '" data-n="5000">+5천</button>' +
      '<button type="button" class="arc-chip" data-add="' + id + '" data-n="10000">+1만</button>' +
      '<button type="button" class="arc-chip" data-add="' + id + '" data-n="reset">리셋</button>' +
      '<button type="button" class="arc-chip" data-add="' + id + '" data-n="all">올인</button>' +
      '</div>';
  }

  function bindChips(root) {
    root.querySelectorAll('[data-add]').forEach(function (btn) {
      btn.onclick = function () {
        var n = btn.getAttribute('data-n');
        addBet(btn.getAttribute('data-add'), n === 'reset' || n === 'all' ? n : Number(n));
      };
    });
  }

  async function post(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    return res.json();
  }

  async function load(silent) {
    try {
      var res = await fetch('/api/casino/arcade', { credentials: 'same-origin', cache: 'no-store' });
      var data = await res.json();
      if (!data.success) return;
      state = data;
      ensureUi();
      if (data.shop) applyWorld(data.shop.world);
      paintHud();
      paintLobby();
      paintRanks(data);
      if (!silent && data.leveledUp) {
        showLevelUp(data);
        ack(data.level);
      }
    } catch (e) {}
  }

  async function ack(level) {
    try { await post('/api/casino/arcade/ack-level', { level: level }); } catch (e) {}
  }

  function paintLevelBars(data) {
    if (!data) return;
    var pct = data.maxed ? 100 : Math.min(100, Math.round(((data.into || 0) / Math.max(1, data.need || 140)) * 100));
    var lv = String(data.level || 1);
    var label;
    if (data.guest) label = '로그인 후 XP';
    else if (data.maxed) label = data.canRebirth ? ('만렙 · 초과 ' + fmtXp(data.overflow || 0) + ' XP') : 'MAX';
    else label = fmtXp(data.into || 0) + ' / ' + fmtXp(data.need || 140) + ' XP';
    var next = (data.modes || []).find(function (m) { return !m.unlocked; });
    var nextText;
    if (data.guest) nextText = '로그인하면 레벨이 쌓입니다';
    else if (data.canRebirth) nextText = '환생 가능 · #아케이드에서 진행';
    else if (next) nextText = '다음 해금 Lv.' + next.level + ' ' + next.name;
    else nextText = (data.rebirth ? ('환생 ' + data.rebirth + ' · ') : '') + '최고 구간';
    document.querySelectorAll('[data-lvl-num]').forEach(function (el) { el.textContent = lv; });
    document.querySelectorAll('[data-lvl-fill]').forEach(function (el) { el.style.width = pct + '%'; });
    document.querySelectorAll('[data-lvl-label]').forEach(function (el) { el.textContent = label; });
    document.querySelectorAll('[data-lvl-next]').forEach(function (el) { el.textContent = nextText; });
    document.querySelectorAll('[data-lvl-rebirth]').forEach(function (el) {
      var n = Number(data.rebirth || 0);
      if (n > 0) { el.hidden = false; el.textContent = '환생 ' + n; }
      else { el.hidden = true; el.textContent = ''; }
    });
    document.querySelectorAll('[data-lvl-rp]').forEach(function (el) {
      el.textContent = 'RP ' + (data.rp || 0);
    });
    var rb = document.getElementById('arc-btn-rebirth');
    if (rb) {
      rb.disabled = false;
      rb.classList.toggle('ready', !!data.canRebirth);
      rb.title = data.canRebirth
        ? '만렙입니다. 환생할 수 있습니다.'
        : ('만렙(Lv.' + MAX_LEVEL + ')에 도달해야 환생할 수 있습니다. 현재 Lv.' + (data.level || 1));
    }
    var hint = document.getElementById('arc-rebirth-hint');
    if (hint) {
      if (data.guest) hint.textContent = '로그인하면 환생 · 상점 · 세계 포탈을 쓸 수 있습니다.';
      else if (data.canRebirth) hint.textContent = '만렙입니다. 환생하면 RP +10, 레벨과 경험치는 0부터 다시 쌓입니다.';
      else hint.textContent = '만렙(Lv.' + MAX_LEVEL + ')에 도달하면 환생할 수 있습니다. 지금 Lv.' + (data.level || 1) + ' · 남은 레벨 ' + Math.max(0, MAX_LEVEL - (data.level || 1)) + '.';
    }
  }

  function paintHud() {
    if (!state) return;
    paintLevelBars(state);
    if (state.shop && state.shop.world) applyWorld(state.shop.world);
    var lv = document.getElementById('arc-level');
    var label = document.getElementById('arc-xp-label');
    var fill = document.getElementById('arc-xp-fill');
    var life = document.getElementById('arc-life');
    if (lv) lv.textContent = String(state.level || 1);
    if (label) {
      label.textContent = state.maxed
        ? (state.canRebirth ? ('만렙 · 초과 ' + fmtXp(state.overflow || 0) + ' XP') : 'MAX')
        : (fmtXp(state.into || 0) + ' / ' + fmtXp(state.need || 140) + ' XP');
    }
    if (fill) fill.style.width = (state.maxed ? 100 : Math.min(100, Math.round(((state.into || 0) / Math.max(1, state.need || 140)) * 100))) + '%';
    if (life && state.lifetime) {
      life.innerHTML = state.guest
        ? '로그인하면 예전에 번 돈까지 경험치로 환산됩니다. 게스트는 클래식 홀만 열립니다.'
        : ((state.rebirth ? ('환생 ' + state.rebirth + '회 · ') : '') +
          '누적 이익 ' + won(state.lifetime.won) + ' · 경제 수령 ' + won(state.lifetime.economy) +
          ' · 배팅 ' + won(state.lifetime.wagered) + ' · 승리 ' + (state.lifetime.wins || 0) + '회가 XP입니다.');
    }
  }

  function paintLobby() {
    var box = document.getElementById('arc-lobby');
    if (!box || !state) return;
    box.innerHTML = (state.modes || []).map(function (m) {
      var lock = m.unlocked ? 'OPEN' : ('Lv.' + m.level + ' 해금');
        return '<button type="button" class="arc-card m-' + m.id + (m.unlocked ? '' : ' locked') + '" data-mode="' + m.id + '">' +
        '<span class="arc-badge">' + lock + '</span>' +
        '<div class="arc-name">' + esc(m.name) + '</div>' +
        '<div class="arc-blurb">' + esc(m.blurb) + '</div></button>';
    }).join('');
    box.querySelectorAll('[data-mode]').forEach(function (btn) {
      btn.onclick = function () { openMode(btn.getAttribute('data-mode')); };
    });
  }

  function showLevelUp(data) {
    var names = (data.newUnlocks || []).map(function (m) { return m.name; }).join(', ');
    var el = document.createElement('div');
    el.className = 'arc-toast';
    el.textContent = 'LEVEL ' + data.level + (names ? ' · 해금 ' + names : ' UP');
    document.body.appendChild(el);
    if (window.CasinoAudio) window.CasinoAudio.play('win');
    setTimeout(function () { el.remove(); }, 3200);
    toast('success', '레벨 ' + data.level + (names ? ' · ' + names + ' 해금' : ''));
  }

  function findMode(id) {
    return ((state && state.modes) || []).find(function (m) { return m.id === id; });
  }

  function openMode(id) {
    var mode = findMode(id);
    if (!mode) return;
    if (!mode.unlocked) {
      toast('error', 'Lv.' + mode.level + '에 해금됩니다.');
      return;
    }
    if (mode.kind === 'tab') {
      if (typeof switchTab === 'function') switchTab(mode.tab || 'tab-casino');
      return;
    }
    current = mode;
    var stage = document.getElementById('arcade-stage');
    if (!stage) return;
    stage.hidden = false;
    stage.innerHTML = buildOverlay(mode);
    bindOverlay(mode, stage);
    if (window.CasinoAudio) {
      var scene = { crash: 'crashBet', mines: 'mines', plinko: 'plinko', toto: 'toto', horse: 'horse' }[mode.kind] || 'arcade';
      window.CasinoAudio.setScene(scene);
    }
  }

  function closeStage() {
    var stage = document.getElementById('arcade-stage');
    if (stage) {
      stage.hidden = true;
      stage.innerHTML = '';
    }
    current = null;
    if (crashTimer) {
      clearInterval(crashTimer);
      crashTimer = null;
    }
    if (window.CasinoAudio && document.body.dataset.tab === 'tab-arcade') {
      window.CasinoAudio.setScene('arcade');
    }
  }

  function cabinet(skin, title, sub, body) {
    return '<div class="arc-cabinet ' + skin + '">' +
      '<button type="button" class="arc-close" id="arc-close" aria-label="닫기">×</button>' +
      '<h2>' + title + '</h2><p class="arc-sub">' + sub + '</p>' + body + '</div>';
  }

  function slotBody(extra) {
    return (extra || '') +
      '<div class="arc-reels"><div class="arc-reel" id="arc-r1">🍒</div><div class="arc-reel" id="arc-r2">🍋</div><div class="arc-reel" id="arc-r3">🔔</div></div>' +
      chips('arc-slot-bet') +
      '<button type="button" class="arc-go" id="arc-slot-go">레버</button>' +
      '<div class="arc-result" id="arc-slot-res">같은 슬롯 API입니다. 화면만 다릅니다.</div>';
  }

  function buildOverlay(mode) {
    if (mode.kind === 'slot') {
      var skin = mode.id === 'high' ? 'arc-skin-high' : (mode.id === 'jackpot' ? 'arc-skin-jackpot' : 'arc-skin-neon');
      var extra = mode.id === 'jackpot' ? '<div class="arc-pot" id="arc-pot">JACKPOT</div>' : (mode.minBet ? '<p class="arc-sub">최소 배팅 ' + won(mode.minBet) + '</p>' : '');
      return cabinet(skin, mode.name, mode.blurb, slotBody(extra));
    }
    if (mode.kind === 'crash') {
      return cabinet('arc-skin-crash', mode.name, '그래프가 터지기 전에 탈출하세요.',
        '<div class="arc-crash-mult" id="arc-crash-mult">1.00x</div>' +
        '<div class="arc-result" id="arc-crash-phase">배팅 대기</div>' +
        chips('arc-crash-bet') +
        '<div style="display:flex;gap:8px"><button type="button" class="arc-go" id="arc-crash-in">배팅</button>' +
        '<button type="button" class="arc-go" id="arc-crash-out">탈출</button></div>' +
        '<div class="arc-result" id="arc-crash-res">핫게임 크래시와 같은 라운드입니다.</div>');
    }
    if (mode.kind === 'mines') {
      var cells = '';
      for (var i = 0; i < 25; i++) cells += '<button type="button" data-mine="' + i + '">?</button>';
      return cabinet('arc-skin-mines', mode.name, '지뢰를 피해 시료를 회수하세요.',
        '<div class="arc-mines" id="arc-mines">' + cells + '</div>' +
        chips('arc-mines-bet') +
        '<select id="arc-mines-n"><option>3</option><option selected>5</option><option>8</option><option>10</option></select>' +
        '<div style="display:flex;gap:8px"><button type="button" class="arc-go" id="arc-mines-start">실험 시작</button>' +
        '<button type="button" class="arc-go" id="arc-mines-out">회수</button></div>' +
        '<div class="arc-result" id="arc-mines-res">기존 마인즈와 같은 판입니다.</div>');
    }
    if (mode.kind === 'plinko') {
      return cabinet('arc-skin-plinko', mode.name, '축제 공을 떨어뜨립니다.',
        '<div class="arc-plinko" id="arc-plinko"><div class="arc-plinko-ball" id="arc-plinko-ball"></div></div>' +
        chips('arc-plinko-bet') +
        '<select id="arc-plinko-risk"><option value="low">로우</option><option value="med" selected>미디엄</option><option value="high">하이</option></select>' +
        '<button type="button" class="arc-go" id="arc-plinko-go">떨어뜨리기</button>' +
        '<div class="arc-result" id="arc-plinko-res">기존 플링코 API입니다.</div>');
    }
    if (mode.kind === 'toto') {
      return cabinet('arc-skin-toto', mode.name, '관중석에서 승부를 고릅니다.',
        chips('arc-toto-bet') +
        '<div class="arc-toto" id="arc-toto-list">경기를 불러오는 중...</div>' +
        '<div class="arc-result" id="arc-toto-res">핫게임 토토와 같은 경기입니다.</div>');
    }
    if (mode.kind === 'horse') {
      return cabinet('arc-skin-horse', mode.name, '야간 전용 경마 UI. 배당은 기존 경마와 같습니다.',
        '<div id="arc-horse-cond" class="arc-result">주로 불러오는 중</div>' +
        '<div class="arc-bet" id="arc-horse-modes">' +
        '<button type="button" class="arc-chip" data-hm="win">단승</button>' +
        '<button type="button" class="arc-chip" data-hm="place">복승</button>' +
        '<button type="button" class="arc-chip" data-hm="show">연승</button>' +
        '</div>' +
        '<div class="arc-horses" id="arc-horses"></div>' +
        chips('arc-horse-bet') +
        '<div class="arc-track" id="arc-track"></div>' +
        '<button type="button" class="arc-go" id="arc-horse-go">게이트 오픈</button>' +
        '<div class="arc-result" id="arc-horse-res">말을 고르고 출발하세요.</div>');
    }
    return cabinet('arc-skin-neon', mode.name, mode.blurb, '<p>준비 중입니다.</p>');
  }

  function bindOverlay(mode, root) {
    var close = document.getElementById('arc-close');
    if (close) close.onclick = closeStage;
    bindChips(root);
    if (mode.kind === 'slot') bindSlot(mode);
    if (mode.kind === 'crash') bindCrash();
    if (mode.kind === 'mines') bindMines();
    if (mode.kind === 'plinko') bindPlinko();
    if (mode.kind === 'toto') bindToto();
    if (mode.kind === 'horse') bindHorse();
  }

  function bindSlot(mode) {
    var minBet = Number(mode.minBet || 1000);
    var input = document.getElementById('arc-slot-bet');
    if (input) {
      input.min = String(minBet);
      input.value = String(Math.max(minBet, 5000));
    }
    if (mode.jackpotFocus) loadPot();
    var go = document.getElementById('arc-slot-go');
    if (go) go.onclick = function () { spinSlot(minBet); };
  }

  async function loadPot() {
    try {
      var res = await fetch('/api/casino/state', { credentials: 'same-origin' });
      var data = await res.json();
      var pot = document.getElementById('arc-pot');
      if (pot && data.jackpot != null) pot.textContent = 'POT ' + won(data.jackpot);
    } catch (e) {}
  }

  async function spinSlot(minBet) {
    var input = document.getElementById('arc-slot-bet');
    if (input && input.getAttribute('data-all-in') !== '1') {
      var parsed = parseBetValue(input.value);
      if (!parsed.allIn && parsed.amount < BigInt(minBet || 0)) {
        toast('error', '이 모드는 최소 ' + won(minBet) + '입니다.');
        return;
      }
    }
    var r1 = document.getElementById('arc-r1');
    var r2 = document.getElementById('arc-r2');
    var r3 = document.getElementById('arc-r3');
    [r1, r2, r3].forEach(function (el) { if (el) el.classList.add('spin'); });
    if (window.CasinoAudio) window.CasinoAudio.play('slot', '슬롯머신');
    try {
      var data = await post('/api/game/slot', { bet: betOf('arc-slot-bet', minBet) });
      setTimeout(function () {
        [r1, r2, r3].forEach(function (el) { if (el) el.classList.remove('spin'); });
        if (!data.success) {
          setText('arc-slot-res', data.error || '오류');
          toast('error', data.error);
          return;
        }
        var reels = data.displayReels || data.slots || data.reels || [];
        if (r1) r1.textContent = reels[0] || '?';
        if (r2) r2.textContent = reels[1] || '?';
        if (r3) r3.textContent = reels[2] || '?';
        setText('arc-slot-res', data.message || '');
        cash(data.newCash);
        resultHook(data, '슬롯머신');
        if (current && current.jackpotFocus) loadPot();
      }, 700);
    } catch (e) {
      [r1, r2, r3].forEach(function (el) { if (el) el.classList.remove('spin'); });
      toast('error', '서버와 연결할 수 없습니다.');
    }
  }

  function setText(id, v) {
    var el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  function paintCrash(s) {
    var mult = document.getElementById('arc-crash-mult');
    var phase = document.getElementById('arc-crash-phase');
    if (!mult) return;
    mult.classList.remove('fly', 'dead');
    if (s.phase === 'betting') {
      var left = Math.max(0, Math.ceil((s.betUntil - Date.now()) / 1000));
      mult.textContent = '1.00x';
      if (phase) phase.textContent = '배팅 ' + left + '초';
    } else if (s.phase === 'flying') {
      mult.textContent = Number(s.multiplier).toFixed(2) + 'x';
      mult.classList.add('fly');
      if (phase) phase.textContent = '지금 탈출!';
      if (window.CasinoAudio) window.CasinoAudio.setCrashPhase('flying', s.multiplier);
    } else {
      mult.textContent = Number(s.crashAt || s.multiplier).toFixed(2) + 'x';
      mult.classList.add('dead');
      if (phase) phase.textContent = 'CRASH';
    }
  }

  function bindCrash() {
    tickCrash();
    if (crashTimer) clearInterval(crashTimer);
    crashTimer = setInterval(tickCrash, 400);
    var inn = document.getElementById('arc-crash-in');
    var out = document.getElementById('arc-crash-out');
    if (inn) inn.onclick = async function () {
      var data = await post('/api/casino/crash/bet', { bet: betOf('arc-crash-bet') });
      if (!data.success) return toast('error', data.error);
      cash(data.newCash);
      if (window.CasinoAudio) window.CasinoAudio.play('spin', '크래시');
      setText('arc-crash-res', data.message || '배팅됨');
    };
    if (out) out.onclick = async function () {
      var data = await post('/api/casino/crash/cashout', {});
      if (!data.success) return toast('error', data.error);
      cash(data.newCash);
      setText('arc-crash-res', data.message || '');
      resultHook(data, '크래시');
    };
  }

  async function tickCrash() {
    if (!document.getElementById('arc-crash-mult')) return;
    try {
      var res = await fetch('/api/casino/crash', { credentials: 'same-origin' });
      var data = await res.json();
      if (data.success) paintCrash(data);
    } catch (e) {}
  }

  function paintMines(revealed, bombs, boomIdx) {
    var grid = document.getElementById('arc-mines');
    if (!grid) return;
    Array.prototype.forEach.call(grid.children, function (cell, i) {
      cell.classList.remove('safe', 'boom');
      if (revealed && revealed.indexOf(i) >= 0) {
        cell.classList.add('safe');
        cell.textContent = '💎';
      } else if (bombs && bombs.indexOf(i) >= 0) {
        cell.classList.add('boom');
        cell.textContent = '💣';
      } else if (boomIdx === i) {
        cell.classList.add('boom');
        cell.textContent = '💣';
      } else {
        cell.textContent = '?';
      }
    });
  }

  function bindMines() {
    document.querySelectorAll('#arc-mines [data-mine]').forEach(function (btn) {
      btn.onclick = function () { revealMine(Number(btn.getAttribute('data-mine'))); };
    });
    var start = document.getElementById('arc-mines-start');
    var out = document.getElementById('arc-mines-out');
    if (start) start.onclick = async function () {
      var n = document.getElementById('arc-mines-n');
      var data = await post('/api/casino/mines/start', { bet: betOf('arc-mines-bet'), mines: n ? n.value : 5 });
      if (!data.success) return toast('error', data.error);
      cash(data.newCash);
      paintMines([], null, null);
      setText('arc-mines-res', data.message || '');
      if (window.CasinoAudio) window.CasinoAudio.play('mines', '마인즈');
    };
    if (out) out.onclick = async function () {
      var data = await post('/api/casino/mines/cashout', {});
      if (!data.success) return toast('error', data.error);
      paintMines(null, data.bombs, null);
      cash(data.newCash);
      setText('arc-mines-res', data.message || '');
      resultHook(data, '마인즈');
    };
  }

  async function revealMine(index) {
    var data = await post('/api/casino/mines/reveal', { index: index });
    if (!data.success) return toast('error', data.error);
    if (data.boom) {
      paintMines(data.revealed || [], data.bombs, data.index);
      cash(data.newCash);
      setText('arc-mines-res', data.message || '지뢰');
      resultHook(data, '마인즈');
    } else {
      paintMines(data.revealed, null, null);
      setText('arc-mines-res', '현재 ' + data.multiplier + '배');
    }
  }

  function bindPlinko() {
    var go = document.getElementById('arc-plinko-go');
    if (!go) return;
    go.onclick = async function () {
      var risk = document.getElementById('arc-plinko-risk');
      if (window.CasinoAudio) window.CasinoAudio.play('plinko', '플링코');
      var data = await post('/api/casino/plinko', { bet: betOf('arc-plinko-bet'), risk: risk ? risk.value : 'med' });
      if (!data.success) return toast('error', data.error);
      animatePlinko(data);
      cash(data.newCash);
      setText('arc-plinko-res', data.message || '');
      resultHook(data, '플링코');
    };
  }

  function animatePlinko(data) {
    var ball = document.getElementById('arc-plinko-ball');
    if (!ball) return;
    var path = data.path || [];
    var x = 50;
    var y = 6;
    var i = 0;
    ball.style.left = '50%';
    ball.style.top = '8px';
    var step = function () {
      if (i >= path.length) return;
      x += path[i] ? 4.2 : -4.2;
      y += 14;
      ball.style.left = x + '%';
      ball.style.top = y + 'px';
      i += 1;
      setTimeout(step, 70);
    };
    step();
  }

  async function bindToto() {
    await loadToto();
  }

  async function loadToto() {
    var box = document.getElementById('arc-toto-list');
    if (!box) return;
    try {
      var res = await fetch('/api/casino/toto', { credentials: 'same-origin' });
      var data = await res.json();
      if (!data.success) return;
      box.innerHTML = (data.matches || []).map(function (m) {
        var closed = m.status !== 'open';
        return '<div class="arc-toto-row"><b>' + esc(m.sport) + '</b> ' + esc(m.home) + ' vs ' + esc(m.away) +
          '<div class="arc-toto-odds">' +
          '<button type="button" data-toto="' + m.id + '" data-pick="home" ' + (closed ? 'disabled' : '') + '>홈 ' + m.oddsHome + '</button>' +
          '<button type="button" data-toto="' + m.id + '" data-pick="draw" ' + (closed ? 'disabled' : '') + '>무 ' + m.oddsDraw + '</button>' +
          '<button type="button" data-toto="' + m.id + '" data-pick="away" ' + (closed ? 'disabled' : '') + '>원정 ' + m.oddsAway + '</button>' +
          '</div></div>';
      }).join('') || '<div class="arc-result">열린 경기가 없습니다.</div>';
      box.querySelectorAll('[data-toto]').forEach(function (btn) {
        btn.onclick = function () { betToto(btn.getAttribute('data-toto'), btn.getAttribute('data-pick')); };
      });
    } catch (e) {}
  }

  async function betToto(matchId, pick) {
    if (window.CasinoAudio) window.CasinoAudio.play('toto', '토토');
    var data = await post('/api/casino/toto/bet', { matchId: Number(matchId), pick: pick, bet: betOf('arc-toto-bet') });
    if (!data.success) return toast('error', data.error);
    cash(data.newCash);
    setText('arc-toto-res', data.message || '배팅됨');
    toast('success', data.message);
    loadToto();
    load(true);
  }

  async function bindHorse() {
    horsePick = 1;
    horsePick2 = 0;
    horseMode = 'win';
    document.querySelectorAll('[data-hm]').forEach(function (btn) {
      btn.onclick = function () {
        horseMode = btn.getAttribute('data-hm');
        paintHorses();
      };
    });
    var go = document.getElementById('arc-horse-go');
    if (go) go.onclick = runHorse;
    await refreshHorse();
  }

  async function refreshHorse() {
    try {
      var res = await fetch('/api/game/horse-card', { credentials: 'same-origin' });
      var data = await res.json();
      if (!data.success) return;
      horseCard = data;
      var cond = data.condition || {};
      setText('arc-horse-cond', (cond.emoji || '') + ' ' + (cond.name || '') + ' · ' + (cond.desc || ''));
      var track = document.getElementById('arc-track');
      if (track) {
        track.innerHTML = (data.horses || []).map(function (h) {
          return '<div class="arc-lane"><div class="arc-runner" id="arc-run-' + h.id + '">' + (h.emoji || '🏇') + '</div></div>';
        }).join('');
      }
      paintHorses();
    } catch (e) {}
  }

  function paintHorses() {
    var box = document.getElementById('arc-horses');
    if (!box) return;
    box.innerHTML = (horseCard.horses || []).map(function (h) {
      var on = h.id === horsePick || h.id === horsePick2;
      var odds = horseMode === 'place' ? h.placeOdds : (horseMode === 'show' ? h.showOdds : h.winOdds);
      var oddsLabel = (!Number(odds) || Number(odds) <= 1) ? '마감' : (Number(odds).toFixed(1) + '배');
      return '<button type="button" class="arc-horse' + (on ? ' on' : '') + '" data-hid="' + h.id + '">' +
        esc(h.emoji || '') + ' ' + esc(h.name) + '<div>' + oddsLabel + '</div></button>';
    }).join('');
    box.querySelectorAll('[data-hid]').forEach(function (btn) {
      btn.onclick = function () {
        var id = Number(btn.getAttribute('data-hid'));
        if (horseMode === 'quinella' || horseMode === 'exacta') {
          if (horsePick === id) horsePick = horsePick2 || id;
          else if (!horsePick2 || horsePick2 === id) horsePick2 = id === horsePick ? 0 : id;
          else { horsePick = id; horsePick2 = 0; }
        } else {
          horsePick = id;
          horsePick2 = 0;
        }
        paintHorses();
      };
    });
  }

  async function runHorse() {
    if (window.CasinoAudio) window.CasinoAudio.play('horse', '월덕경마');
    var data = await post('/api/game/horse-race', {
      mode: horseMode,
      horseId: horsePick,
      horseId2: horsePick2 || undefined,
      bet: betOf('arc-horse-bet')
    });
    if (!data.success) return toast('error', data.error);
    var ranking = data.ranking || [];
    ranking.forEach(function (h, idx) {
      var el = document.getElementById('arc-run-' + h.id);
      if (el) el.style.left = (86 - idx * 10) + '%';
    });
    cash(data.newCash);
    setText('arc-horse-res', data.message || (data.isWin ? '적중' : '낙첨'));
    resultHook(data, '월덕경마');
  }

  function boot() {
    var root = document.documentElement;
    root.removeAttribute('data-world');
    root.onclick = null;
    load();
    if (window.CasinoUX && !window.CasinoUX.__arcadeHooked) {
      var orig = window.CasinoUX.onGameResult;
      window.CasinoUX.onGameResult = function (data) {
        orig(data);
        load(true);
      };
      window.CasinoUX.__arcadeHooked = true;
    }
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var ov = document.getElementById('arc-overlay');
      if (ov && !ov.hidden) { closeOverlay(); return; }
      if (current) closeStage();
    });
  }

  function fmtXp(n) {
    try { return Math.floor(Number(n) || 0).toLocaleString('ko-KR'); } catch (e) { return String(n || 0); }
  }

  function applyWorld(id) {
    var w = id || 'origin';
    var root = document.documentElement;
    root.setAttribute('data-arcade-world', w);
    root.removeAttribute('data-world');
    root.onclick = null;
    try { localStorage.setItem('wtrdd-world', w); } catch (e) {}
    var badge = document.getElementById('arc-world-now');
    if (badge) {
      var shop = state && state.shop;
      var found = shop && (shop.worlds || []).find(function (x) { return x.id === w; });
      badge.textContent = found ? found.name : (w === 'origin' ? '본세계' : w);
      badge.hidden = false;
    }
  }

  function closeOverlay() {
    var el = document.getElementById('arc-overlay');
    if (el) el.hidden = true;
  }

  function overlayCard() {
    return document.getElementById('arc-overlay-card');
  }

  function bindCardClicks(selector, handler) {
    var card = overlayCard();
    if (!card) return;
    card.querySelectorAll(selector).forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        handler(btn, ev);
      });
    });
  }

  async function ensureState() {
    if (state) return state;
    await load(true);
    return state;
  }

  function bindOnce(id, fn) {
    var el = document.getElementById(id);
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      fn();
    });
  }

  function ensureUi() {
    if (!document.getElementById('arc-overlay')) {
      var el = document.createElement('div');
      el.id = 'arc-overlay';
      el.className = 'arc-overlay';
      el.hidden = true;
      el.innerHTML = '<div class="arc-overlay-card" id="arc-overlay-card" role="dialog" aria-modal="true"></div>';
      el.addEventListener('click', function (ev) { if (ev.target === el) closeOverlay(); });
      document.body.appendChild(el);
    }
    var hud = document.querySelector('#tab-arcade .arc-hud');
    if (hud && !document.getElementById('arc-actions')) {
      var bar = document.createElement('div');
      bar.id = 'arc-actions';
      bar.className = 'arc-actions';
      bar.innerHTML =
        '<button type="button" class="arc-act" id="arc-btn-rebirth">환생</button>' +
        '<button type="button" class="arc-act" id="arc-btn-shop">환생 상점</button>' +
        '<button type="button" class="arc-act" id="arc-btn-portal">세계 포탈</button>' +
        '<span class="arc-rp" data-lvl-rp>RP 0</span>' +
        '<span class="arc-rebirth-hint" id="arc-rebirth-hint">만렙(Lv.40)에 도달하면 환생할 수 있습니다.</span>';
      hud.parentNode.insertBefore(bar, hud.nextSibling);
    }
    if (hud && !document.getElementById('arc-world-now')) {
      var badge = document.createElement('span');
      badge.id = 'arc-world-now';
      badge.className = 'arc-world-now';
      badge.hidden = true;
      var rp = document.querySelector('#arc-actions [data-lvl-rp]');
      if (rp && rp.parentNode) rp.parentNode.insertBefore(badge, rp);
      else {
        var actions = document.getElementById('arc-actions');
        if (actions) actions.appendChild(badge);
      }
    }
    bindOnce('arc-btn-rebirth', openRebirth);
    bindOnce('arc-btn-shop', openShop);
    bindOnce('arc-btn-portal', openPortal);
    if (hud && !document.getElementById('arc-ranks')) {
      var ranks = document.createElement('div');
      ranks.id = 'arc-ranks';
      ranks.className = 'arc-ranks';
      var lobby = document.getElementById('arc-lobby');
      if (lobby) lobby.parentNode.insertBefore(ranks, lobby);
    }
  }

  function openOverlay(html) {
    ensureUi();
    var el = document.getElementById('arc-overlay');
    var card = document.getElementById('arc-overlay-card');
    if (!el || !card) return;
    card.innerHTML = html;
    el.hidden = false;
    card.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = closeOverlay; });
  }

  async function openRebirth() {
    await ensureState();
    if (!state || state.guest) return toast('error', '로그인하면 환생할 수 있습니다.');
    if (!state.canRebirth) {
      var left = Math.max(0, MAX_LEVEL - (state.level || 1));
      openOverlay(
        '<div class="arc-ov-k">환생</div>' +
        '<h3 class="arc-ov-title">만렙(Lv.' + MAX_LEVEL + ')에 도달하면 환생할 수 있습니다</h3>' +
        '<p class="arc-ov-p">지금 레벨은 <b>Lv.' + (state.level || 1) + '</b> 입니다. 앞으로 <b>' + left + '레벨</b>이 남았습니다. 현재 RP ' + (state.rp || 0) + '.</p>' +
        '<ul class="arc-ov-warn">' +
          '<li>만렙이 되면 레벨과 경험치가 0부터 다시 쌓입니다. 남은 XP는 이월되지 않습니다.</li>' +
          '<li>현금 · 예금 · 주식 · 클리커는 그대로입니다.</li>' +
          '<li>환생할 때마다 환생 포인트(RP) +10, 칭호 「회귀자」를 받습니다.</li>' +
          '<li>RP는 환생 상점과 세계 포탈에서 씁니다.</li>' +
        '</ul>' +
        '<div class="arc-ov-actions">' +
          '<button type="button" class="arc-act" id="arc-ov-shop">환생 상점</button>' +
          '<button type="button" class="arc-act" id="arc-ov-portal">세계 포탈</button>' +
          '<button type="button" class="arc-act ghost" data-close>닫기</button>' +
        '</div>'
      );
      var shopBtn = document.getElementById('arc-ov-shop');
      var portalBtn = document.getElementById('arc-ov-portal');
      if (shopBtn) shopBtn.onclick = openShop;
      if (portalBtn) portalBtn.onclick = openPortal;
      return;
    }
    openOverlay(
      '<div class="arc-ov-k">환생</div>' +
      '<h3 class="arc-ov-title">만렙 구간을 접고 다음 세계로 가시겠습니까?</h3>' +
      '<ul class="arc-ov-warn">' +
        '<li>화면 레벨이 1로 돌아가고, 현재 경험치 ' + fmtXp(state.xp || 0) + ' XP가 전부 초기화됩니다.</li>' +
        '<li>만렙을 넘긴 초과분 ' + fmtXp(state.overflow || 0) + ' XP도 함께 사라집니다. 이월되지 않습니다.</li>' +
        '<li>이미 연 아케이드 모드는 그대로 유지됩니다.</li>' +
        '<li>현금 · 예금 · 주식 · 클리커는 변하지 않습니다.</li>' +
        '<li>환생 포인트 +10, 칭호 「회귀자」가 생깁니다.</li>' +
      '</ul>' +
      '<div class="arc-ov-actions">' +
        '<button type="button" class="arc-act ghost" data-close>취소</button>' +
        '<button type="button" class="arc-act danger" id="arc-rebirth-go">환생한다</button>' +
      '</div>'
    );
    var go = document.getElementById('arc-rebirth-go');
    if (go) go.onclick = runRebirth;
  }

  async function runRebirth() {
    var go = document.getElementById('arc-rebirth-go');
    if (go) go.disabled = true;
    var data = await post('/api/casino/arcade/rebirth', {});
    if (!data.success) {
      if (go) go.disabled = false;
      return toast('error', data.error);
    }
    state = data;
    closeOverlay();
    paintHud();
    paintLobby();
    toast('success', '환생 ' + (data.rebirth || 1) + '회 · RP +' + (data.gainedRp || 10));
    if (window.CasinoAudio) window.CasinoAudio.play('win');
  }

  async function openShop() {
    await ensureState();
    if (!state || state.guest) return toast('error', '로그인하면 상점을 쓸 수 있습니다.');
    var shop = state.shop || { worlds: [], titles: [], rp: 0 };
    function row(kind, item) {
      var owned = item.unlocked;
      var btn = owned
        ? (kind === 'world' && shop.world === item.id ? '현재' : (kind === 'title' && shop.title === item.id ? '착용 중' : (kind === 'world' ? '이동' : '착용')))
        : (item.cost ? ('RP ' + item.cost) : '해금');
      var dis = owned && ((kind === 'world' && shop.world === item.id) || (kind === 'title' && shop.title === item.id));
      return '<div class="arc-shop-row">' +
        '<div><b>' + esc(item.name) + '</b><span>' + esc(item.blurb || '') + '</span></div>' +
        '<button type="button" class="arc-act" data-buy="' + kind + '" data-id="' + esc(item.id) + '"' + (dis ? ' disabled' : '') + '>' + btn + '</button>' +
      '</div>';
    }
    openOverlay(
      '<div class="arc-ov-k">환생 상점 · RP ' + (shop.rp || 0) + '</div>' +
      '<p class="arc-ov-p">환생 포인트로 세계와 칭호를 엽니다. 현금은 쓰지 않습니다.</p>' +
      '<div class="arc-ov-sec">세계</div>' +
      (shop.worlds || []).map(function (w) { return row('world', w); }).join('') +
      '<div class="arc-ov-sec">칭호</div>' +
      (shop.titles || []).map(function (t) { return row('title', t); }).join('') +
      '<div class="arc-ov-actions"><button type="button" class="arc-act ghost" data-close>닫기</button></div>'
    );
    bindCardClicks('[data-buy]', function (btn) {
      buyItem(btn.getAttribute('data-buy'), btn.getAttribute('data-id'));
    });
  }

  async function buyItem(kind, id) {
    var shop = (state && state.shop) || { worlds: [], titles: [] };
    var list = kind === 'world' ? shop.worlds : shop.titles;
    var item = (list || []).find(function (x) { return x.id === id; });
    if (item && item.unlocked) {
      if (kind === 'world') return travel(id, false);
      var equipped = await post('/api/casino/arcade/shop', { kind: kind, id: id });
      if (!equipped.success) return toast('error', equipped.error);
      state = equipped;
      paintHud();
      openShop();
      return;
    }
    var data = await post('/api/casino/arcade/shop', { kind: kind, id: id });
    if (!data.success) return toast('error', data.error);
    state = data;
    paintHud();
    paintLobby();
    toast('success', '해금했습니다.');
    openShop();
  }

  async function openPortal() {
    await ensureState();
    if (!state || state.guest) return toast('error', '로그인하면 포탈을 쓸 수 있습니다.');
    var shop = state.shop || { worlds: [], world: 'origin', prevWorld: 'origin' };
    var worlds = (shop.worlds || []).map(function (w) {
      var locked = !w.unlocked;
      return '<button type="button" class="arc-world' + (shop.world === w.id ? ' on' : '') + (locked ? ' locked' : '') + '" data-world="' + esc(w.id) + '" ' + (locked ? 'disabled' : '') + '>' +
        '<b>' + esc(w.name) + '</b><span>' + (locked ? ('RP ' + w.cost + ' 해금') : esc(w.blurb || '')) + '</span></button>';
    }).join('');
    openOverlay(
      '<div class="arc-ov-k">세계 포탈</div>' +
      '<p class="arc-ov-p">다른 세계의 GUI로 넘어가거나, 이전 세계로 돌아갑니다. 게임 배당은 같습니다.</p>' +
      '<div class="arc-worlds">' + worlds + '</div>' +
      '<div class="arc-ov-actions">' +
        '<button type="button" class="arc-act" id="arc-world-back">이전 세계로</button>' +
        '<button type="button" class="arc-act ghost" data-close>닫기</button>' +
      '</div>'
    );
    bindCardClicks('.arc-world[data-world]', function (btn) {
      if (btn.disabled) return;
      travel(btn.getAttribute('data-world'), false);
    });
    bindCardClicks('#arc-world-back', function () {
      travel(shop.prevWorld || 'origin', true);
    });
  }

  async function travel(id, back) {
    var cur = (state && state.shop && state.shop.world) || 'origin';
    var target = back
      ? ((state && state.shop && state.shop.prevWorld) || 'origin')
      : String(id || 'origin');
    if (!back && String(cur) === String(target)) {
      closeOverlay();
      return;
    }
    var data = await post('/api/casino/arcade/world', { world: id, back: !!back });
    if (!data.success) return toast('error', data.error);
    state = data;
    applyWorld(data.shop && data.shop.world);
    paintHud();
    closeOverlay();
    var next = (data.shop && data.shop.world) || target;
    if (String(next) === String(cur) && !back) return;
    var name = ((data.shop && data.shop.worlds) || []).find(function (w) { return w.id === next; });
    toast('success', back
      ? ('이전 세계(' + ((name && name.name) || '본세계') + ')로 돌아왔습니다.')
      : ((name && name.name ? name.name : '다른 세계') + '로 이동했습니다.'));
  }

  function paintRanks(data) {
    var box = document.getElementById('arc-ranks');
    if (!box) return;
    var rows = (data && data.ranks) || [];
    if (!rows.length) {
      box.innerHTML = '<div class="arc-ov-k">환생 순위</div><p class="arc-ov-p">아직 환생한 사람이 없습니다.</p>';
      return;
    }
    box.innerHTML = '<div class="arc-ov-k">환생 순위</div>' + rows.map(function (r) {
      return '<div class="arc-rank-row"><span>' + r.rank + '</span><b>@' + esc(r.name) + '</b><i>' + esc(r.title || '회귀자') + '</i><em>환생 ' + r.rebirth + '</em></div>';
    }).join('');
  }


  window.Arcade = { load: load, open: openMode, close: closeStage, rebirth: openRebirth, shop: openShop, portal: openPortal };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
