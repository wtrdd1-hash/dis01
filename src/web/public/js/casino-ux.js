(function () {
  if (window.__casinoUxInstalled) return;
  window.__casinoUxInstalled = true;

  function playSound(kind, game) {
    if (window.CasinoAudio) window.CasinoAudio.play(kind, game);
  }

  function won(n) {
    if (typeof window.formatMoneyCompact === 'function') return window.formatMoneyCompact(n);
    try { return Number(n || 0).toLocaleString('ko-KR') + '원'; } catch (e) { return n + '원'; }
  }

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  function renderTicker(winners) {
    const inner = document.getElementById('cx-ticker-inner');
    if (!inner) return;
    const items = (winners && winners.length) ? winners : [{ text: '첫 당첨을 노려보세요! 배팅마다 잭팟 팟이 쌓입니다.' }];
    const html = items.map(function (w) { return '<span>' + (w.text || '') + '</span>'; }).join('');
    inner.innerHTML = html + html;
  }

  function renderMissions(me) {
    const box = document.getElementById('cx-missions');
    if (!box || !me) {
      if (box) box.innerHTML = '<div class="cx-mission">로그인하면 일일 미션이 열립니다.</div>';
      return;
    }
    box.innerHTML = (me.missions || []).map(function (m) {
      const can = m.done && !m.claimed;
      return '<div class="cx-mission"><div>' + m.title + ' · ' + m.progress + '/' + m.target +
        '<div style="color:#fbbf24;font-weight:800">+' + won(m.reward) + '</div></div>' +
        '<button type="button" data-mission="' + m.key + '"' + (can ? '' : ' disabled') + '>' +
        (m.claimed ? '완료' : (m.done ? '받기' : '진행중')) + '</button></div>';
    }).join('');
    box.querySelectorAll('[data-mission]').forEach(function (btn) {
      btn.onclick = function () { claimMission(btn.getAttribute('data-mission')); };
    });
  }

  let vipTimer = null;

  function applyState(data) {
    if (!data) return;
    setText('cx-jackpot', won(data.jackpot));
    const happy = document.getElementById('cx-happy');
    if (happy) {
      happy.textContent = data.happyHour ? '🔥 ON · 승리 +10%' : '대기 · 매시 정각 (1시간마다)';
      happy.classList.toggle('on', !!data.happyHour);
    }
    renderTicker(data.winners);
    if (data.me) {
      setText('cx-streak', (data.me.winStreak || 0) + '연승 / ' + (data.me.loseStreak || 0) + '연패');
      setText('cx-vip', data.me.vipName + (data.me.vipClaimed ? ' · 쿨타임' : ''));
      const vipBtn = document.getElementById('cx-vip-claim');
      if (vipBtn) {
        if (vipTimer) { clearInterval(vipTimer); vipTimer = null; }
        
        if (data.me.vip === 'none') {
          vipBtn.disabled = true;
          vipBtn.textContent = 'VIP 10만원부터';
        } else if (data.me.vipClaimed || (data.me.vipRemainSec && data.me.vipRemainSec > 0)) {
          vipBtn.disabled = true;
          let remaining = Number(data.me.vipRemainSec || 3600);
          
          const updateVipBtnText = () => {
            if (remaining <= 0) {
              vipBtn.disabled = false;
              vipBtn.textContent = '1시간 +' + won(data.me.vipDaily);
              if (vipTimer) { clearInterval(vipTimer); vipTimer = null; }
              return;
            }
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            vipBtn.textContent = '대기 (' + (mins > 0 ? mins + '분 ' : '') + secs + '초)';
            remaining--;
          };
          
          updateVipBtnText();
          vipTimer = setInterval(updateVipBtnText, 1000);
        } else {
          vipBtn.disabled = false;
          vipBtn.textContent = '1시간 +' + won(data.me.vipDaily);
        }
      }
      renderMissions(data.me);
    }
  }

  async function loadState() {
    try {
      const res = await fetch('/api/casino/state', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json();
      if (data.success) applyState(data);
    } catch (e) {}
  }

  let missionBusy = false;
  let vipBusy = false;

  async function claimMission(key) {
    if (missionBusy) return;
    missionBusy = true;
    try {
      const res = await fetch('/api/casino/mission/claim', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      if (!data.success) return toast('error', data.error);
      playSound('win');
      if (data.newCash && window.updateUserCashDisplay) window.updateUserCashDisplay(data.newCash);
      toast('success', '미션 보상 +' + won(data.reward));
    } catch (e) {}
    finally {
      missionBusy = false;
      loadState();
    }
  }

  async function claimVip() {
    if (vipBusy) return;
    const vipBtn = document.getElementById('cx-vip-claim');
    if (vipBtn && (vipBtn.disabled || vipBtn.getAttribute('disabled') !== null)) return;
    vipBusy = true;
    if (vipBtn) {
      vipBtn.disabled = true;
      vipBtn.textContent = '수령 처리 중...';
    }
    try {
      const res = await fetch('/api/casino/vip/claim', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await res.json();
      if (!data.success) {
        toast('error', data.error || '수령에 실패했습니다.');
        // 이미 수령했거나 쿨타임 중이면 즉시 버튼을 잠그고 쿨타임 모드로 전환
        if (vipBtn) {
          vipBtn.disabled = true;
          if (data.error && data.error.includes('수령 가능')) {
            const match = data.error.match(/(\d+)분/);
            const remainMin = match ? parseInt(match[1], 10) : 60;
            vipBtn.textContent = '대기 (' + remainMin + '분)';
          } else {
            vipBtn.textContent = '쿨타임 대기 중';
          }
        }
        return;
      }
      playSound('win');
      if (data.newCash && window.updateUserCashDisplay) window.updateUserCashDisplay(data.newCash);
      toast('success', data.vip + ' 지원금 +' + won(data.reward));
      
      // 즉시 3600초 카운트다운 가동
      if (vipBtn) {
        vipBtn.disabled = true;
        let sec = 3600;
        if (vipTimer) { clearInterval(vipTimer); vipTimer = null; }
        const tick = () => {
          if (sec <= 0) {
            vipBtn.disabled = false;
            vipBtn.textContent = '1시간 +' + won(data.reward);
            if (vipTimer) { clearInterval(vipTimer); vipTimer = null; }
            return;
          }
          const m = Math.floor(sec / 60);
          const s = sec % 60;
          vipBtn.textContent = '대기 (' + (m > 0 ? m + '분 ' : '') + s + '초)';
          sec--;
        };
        tick();
        vipTimer = setInterval(tick, 1000);
      }
    } catch (e) {
      toast('error', '서버 통신 중 오류가 발생했습니다.');
    } finally {
      vipBusy = false;
      setTimeout(loadState, 1500);
    }
  }

  function toast(type, msg) {
    const fn = window.showToast || (typeof showToast === 'function' ? showToast : null);
    if (fn) fn(type === 'success' ? 'success' : 'error', '지원금', msg);
  }

  function onGameResult(data) {
    if (!data) return;
    if (window.CasinoAudio) window.CasinoAudio.onResult(data);
    else if (data.jackpotHit && Number(data.jackpotHit) > 0) playSound('jackpot');
    else if (data.nearMiss) playSound('near');
    else if (data.isWin) playSound('win');
    else if (data.success && data.isWin === false) playSound('lose');
    if (data.displayReels && data.displayReels.length === 3) {
      const ids = data.game === '즉석복권'
        ? ['lottery-slot-1', 'lottery-slot-2', 'lottery-slot-3']
        : ['reel-1', 'reel-2', 'reel-3'];
      ids.forEach(function (id, i) {
        const el = document.getElementById(id);
        if (el) {
          el.textContent = data.displayReels[i];
          el.classList.add('cx-near');
          setTimeout(function () { el.classList.remove('cx-near'); }, 600);
        }
      });
    }
    if (data.loop && data.loop.jackpot) setText('cx-jackpot', won(data.loop.jackpot));
    loadState();
  }

  window.CasinoUX = { onGameResult: onGameResult, play: playSound, reload: loadState };

  function bindSound() {
    if (window.CasinoAudio) window.CasinoAudio.boot();
  }

  async function loadToto() {
    const box = document.getElementById('toto-list');
    if (!box) return;
    try {
      const res = await fetch('/api/casino/toto', { credentials: 'same-origin' });
      const data = await res.json();
      if (!data.success) return;
      box.innerHTML = (data.matches || []).map(function (m) {
        const closed = m.status !== 'open';
        const call = m.call || (m.result ? ('결과 ' + m.result) : '대기');
        const clock = closed ? '' : (' · ' + Math.max(0, Number(m.remainSec) || 0) + '초');
        return '<div class="toto-match' + (closed ? ' settled' : ' live') + '"><div><b>' + m.sport + '</b><div class="toto-call">' + call + clock + '</div></div>' +
          '<div><div style="font-weight:800;margin-bottom:6px">' + m.home + ' vs ' + m.away + '</div>' +
          '<div class="toto-odds">' +
          '<button type="button" data-toto="' + m.id + '" data-pick="home" ' + (closed ? 'disabled' : '') + '>홈 ' + m.oddsHome + '</button>' +
          '<button type="button" data-toto="' + m.id + '" data-pick="draw" ' + (closed ? 'disabled' : '') + '>무 ' + m.oddsDraw + '</button>' +
          '<button type="button" data-toto="' + m.id + '" data-pick="away" ' + (closed ? 'disabled' : '') + '>원정 ' + m.oddsAway + '</button>' +
          '</div></div></div>';
      }).join('');
      box.querySelectorAll('[data-toto]').forEach(function (btn) {
        btn.onclick = function () { betToto(btn.getAttribute('data-toto'), btn.getAttribute('data-pick')); };
      });
    } catch (e) {}
  }

  async function betToto(matchId, pick) {
    const input = document.getElementById('toto-bet');
    const bet = input && (input.getAttribute('data-all-in') === '1' ? 'all' : input.value);
    try {
      playSound('toto', '토토');
      const res = await fetch('/api/casino/toto/bet', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: Number(matchId), pick: pick, bet: bet })
      });
      const data = await res.json();
      if (!data.success) return toast('error', data.error);
      if (data.newCash && window.updateUserCashDisplay) window.updateUserCashDisplay(data.newCash);
      toast('success', data.message);
      loadToto();
    } catch (e) {}
  }

  function paintCrash(s) {
    const board = document.getElementById('crash-board');
    const mult = document.getElementById('crash-mult');
    const phase = document.getElementById('crash-phase');
    const call = document.getElementById('crash-call');
    const hist = document.getElementById('crash-history');
    if (!board || !mult) return;
    board.classList.toggle('crash', s.phase === 'crash');
    board.classList.toggle('flying', s.phase === 'flying');
    if (s.phase === 'betting') {
      const left = Math.max(0, Math.ceil((s.betUntil - Date.now()) / 1000));
      mult.textContent = '1.00x';
      if (phase) phase.textContent = '배팅 ' + left + '초';
      if (call) call.textContent = '이륙 전. 배팅 창이 열려 있습니다.';
      if (window.CasinoAudio) window.CasinoAudio.setCrashPhase('betting', 1);
    } else if (s.phase === 'flying') {
      const m = Number(s.multiplier) || 1;
      mult.textContent = m.toFixed(2) + 'x';
      if (phase) phase.textContent = '지금 탈출!';
      if (call) {
        if (m < 1.3) call.textContent = '이륙. 아직 낮습니다.';
        else if (m < 2) call.textContent = '상승 중. 탈출 타이밍을 재세요.';
        else call.textContent = m.toFixed(2) + 'x 비행 중. 욕심과 타이밍.';
      }
      if (window.CasinoAudio) window.CasinoAudio.setCrashPhase('flying', s.multiplier);
      else playSound('tick');
    } else {
      mult.textContent = Number(s.crashAt || s.multiplier).toFixed(2) + 'x';
      if (phase) phase.textContent = 'CRASH';
      if (call) call.textContent = 'CRASH ' + Number(s.crashAt || s.multiplier).toFixed(2) + 'x';
      if (window.CasinoAudio) window.CasinoAudio.setCrashPhase('crash', s.crashAt || s.multiplier);
      else playSound('lose');
    }
    if (hist && Array.isArray(s.history)) {
      hist.innerHTML = s.history.map(function (v) {
        const n = Number(v);
        const cls = n >= 2 ? 'hot' : (n <= 1.2 ? 'cold' : '');
        return '<span class="' + cls + '">' + n.toFixed(2) + 'x</span>';
      }).join('');
    }
  }

  async function crashBet() {
    const input = document.getElementById('crash-bet');
    const bet = input && (input.getAttribute('data-all-in') === '1' ? 'all' : input.value);
    try {
      const res = await fetch('/api/casino/crash/bet', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bet: bet })
      });
      const data = await res.json();
      if (!data.success) return toast('error', data.error);
      if (data.newCash && window.updateUserCashDisplay) window.updateUserCashDisplay(data.newCash);
      playSound('spin', '크래시');
    } catch (e) {}
  }

  async function crashOut() {
    try {
      const res = await fetch('/api/casino/crash/cashout', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await res.json();
      if (!data.success) return toast('error', data.error);
      onGameResult(data);
      if (data.newCash && window.updateUserCashDisplay) window.updateUserCashDisplay(data.newCash);
      toast('success', data.message);
    } catch (e) {}
  }

  let mineLive = false;

  function paintMines(revealed, bombs, boomIdx) {
    const grid = document.getElementById('mines-grid');
    if (!grid) return;
    if (!grid.childElementCount) {
      for (let i = 0; i < 25; i++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mines-cell';
        b.dataset.i = String(i);
        b.textContent = '?';
        b.onclick = function () { revealMine(i); };
        grid.appendChild(b);
      }
    }
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

  async function startMines() {
    const input = document.getElementById('mines-bet');
    const mines = document.getElementById('mines-count');
    try {
      const res = await fetch('/api/casino/mines/start', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bet: input && (input.getAttribute('data-all-in') === '1' ? 'all' : input.value),
          mines: mines ? mines.value : 5
        })
      });
      const data = await res.json();
      if (!data.success) return toast('error', data.error);
      mineLive = true;
      paintMines([], null, null);
      if (data.newCash && window.updateUserCashDisplay) window.updateUserCashDisplay(data.newCash);
      setText('mines-result', data.message);
      if (window.CasinoAudio) window.CasinoAudio.setScene('mines');
      playSound('mines', '마인즈');
    } catch (e) {}
  }

  async function revealMine(index) {
    if (!mineLive) return;
    try {
      const res = await fetch('/api/casino/mines/reveal', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: index })
      });
      const data = await res.json();
      if (!data.success) return toast('error', data.error);
      if (data.boom) {
        mineLive = false;
        paintMines(data.revealed || [], data.bombs, data.index);
        onGameResult(data);
        if (data.newCash && window.updateUserCashDisplay) window.updateUserCashDisplay(data.newCash);
        setText('mines-result', data.message);
        const boom = document.querySelector('#mines-grid .mines-cell.boom');
        if (boom) boom.classList.add('pop');
      } else {
        paintMines(data.revealed, null, null);
        setText('mines-result', '현재 ' + data.multiplier + '배 · 더 열거나 탈출');
        playSound('plinko', '마인즈');
        const last = (data.revealed || []).slice(-1)[0];
        const cell = document.querySelector('#mines-grid .mines-cell[data-i="' + last + '"]');
        if (cell) cell.classList.add('pop');
      }
    } catch (e) {}
  }

  async function cashoutMines() {
    try {
      const res = await fetch('/api/casino/mines/cashout', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await res.json();
      if (!data.success) return toast('error', data.error);
      mineLive = false;
      paintMines(null, data.bombs, null);
      onGameResult(data);
      if (data.newCash && window.updateUserCashDisplay) window.updateUserCashDisplay(data.newCash);
      setText('mines-result', data.message);
    } catch (e) {}
  const PLINKO_CONFIG = {
    rows: 12,
    mult: {
      low: [8.8, 4.0, 2.5, 1.4, 1.1, 0.8, 0.7, 0.8, 1.1, 1.4, 2.5, 4.0, 8.8],
      med: [24.0, 8.0, 4.5, 1.8, 0.9, 0.6, 0.5, 0.6, 0.9, 1.8, 4.5, 8.0, 24.0],
      high: [55.0, 15.0, 6.0, 2.2, 0.7, 0.4, 0.3, 0.4, 0.7, 2.2, 6.0, 15.0, 55.0]
    }
  };

  function initPlinkoBoard(boardId = 'plinko-board', riskSelectId = 'plinko-risk') {
    const board = document.getElementById(boardId);
    if (!board) return;

    const riskEl = document.getElementById(riskSelectId);
    const risk = riskEl ? riskEl.value : 'med';
    const multipliers = PLINKO_CONFIG.mult[risk] || PLINKO_CONFIG.mult.med;

    let html = '<div class="plinko-pegs-container">';
    const totalRows = PLINKO_CONFIG.rows;
    for (let r = 0; r < totalRows; r++) {
      const pinCount = r + 3;
      const topPct = ((r + 1) / (totalRows + 1)) * 82;
      html += `<div class="plinko-peg-row" style="top:${topPct}%;">`;
      for (let p = 0; p < pinCount; p++) {
        html += `<div class="plinko-peg" id="${boardId}-peg-${r}-${p}"></div>`;
      }
      html += '</div>';
    }
    html += '</div>';

    // 하단 배율 버킷
    html += '<div class="plinko-buckets">';
    multipliers.forEach((m, idx) => {
      let riskClass = 'zero-risk';
      if (m >= 10) riskClass = 'high-risk';
      else if (m >= 2) riskClass = 'med-risk';
      else if (m >= 1) riskClass = 'low-risk';
      html += `<div class="plinko-bucket ${riskClass}" id="${boardId}-bucket-${idx}">${m}x</div>`;
    });
    html += '</div>';

    board.innerHTML = html;
  }

  async function playPlinko() {
    const input = document.getElementById('plinko-bet');
    const risk = document.getElementById('plinko-risk');
    try {
      if (window.CasinoAudio) window.CasinoAudio.setScene('plinko');
      playSound('plinko', '플링코');
      const res = await fetch('/api/casino/plinko', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bet: input && (input.getAttribute('data-all-in') === '1' ? 'all' : input.value),
          risk: risk ? risk.value : 'med'
        })
      });
      const data = await res.json();
      if (!data.success) return toast('error', data.error);
      animatePlinko(data, 'plinko-board');
      const wait = Math.max(420, ((data.path || []).length * 65) + 200);
      setTimeout(function () {
        onGameResult(data);
        if (data.newCash && window.updateUserCashDisplay) window.updateUserCashDisplay(data.newCash);
        setText('plinko-result', data.message);
      }, wait);
    } catch (e) {}
  }

  function animatePlinko(data, boardId = 'plinko-board') {
    const board = document.getElementById(boardId);
    if (!board) return;

    board.querySelectorAll('.plinko-bucket').forEach(b => b.classList.remove('win-hit'));
    board.querySelectorAll('.plinko-peg').forEach(p => p.classList.remove('hit'));

    let ball = document.getElementById(boardId + '-ball');
    if (!ball) {
      ball = document.createElement('div');
      ball.id = boardId + '-ball';
      ball.className = 'plinko-ball';
      board.appendChild(ball);
    }

    const path = data.path || [];
    const totalRows = path.length || PLINKO_CONFIG.rows;
    let r = 0;
    let pinIndex = 1;

    ball.style.display = 'block';
    ball.style.top = '8px';
    ball.style.left = '50%';

    const step = function () {
      if (r >= totalRows) {
        const bucketIdx = data.bucket !== undefined ? data.bucket : Math.min(12, pinIndex);
        const bucketEl = document.getElementById(`${boardId}-bucket-${bucketIdx}`);
        if (bucketEl) {
          bucketEl.classList.add('win-hit');
          setTimeout(() => bucketEl.classList.remove('win-hit'), 2200);
        }
        setTimeout(() => {
          ball.style.display = 'none';
        }, 500);
        return;
      }

      const goRight = path[r] === 1;
      if (goRight) pinIndex += 1;
      
      const pinCount = r + 3;
      const topPct = ((r + 1) / (totalRows + 1)) * 82;
      const leftOffset = (pinIndex / (pinCount - 1)) * 74 + 13;

      ball.style.top = `${topPct}%`;
      ball.style.left = `${leftOffset}%`;

      const pegEl = document.getElementById(`${boardId}-peg-${r}-${pinIndex}`);
      if (pegEl) {
        pegEl.classList.add('hit');
        setTimeout(() => pegEl.classList.remove('hit'), 250);
      }

      r += 1;
      setTimeout(step, 60);
    };

    setTimeout(step, 30);
  }

  async function adminJackpot() {
    const input = document.getElementById('admin-jackpot-amt');
    if (!input) return;
    const res = await fetch('/api/casino/admin/jackpot', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: input.value })
    });
    const data = await res.json();
    if (!data.success) return toast('error', data.error);
    toast('success', '잭팟 설정 ' + won(data.jackpot));
    loadState();
  }

  async function adminHappy(mode) {
    const res = await fetch('/api/casino/admin/happy-hour', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode })
    });
    const data = await res.json();
    if (!data.success) return toast('error', data.error);
    toast('success', '행운의시간 ' + (data.mode || '자동'));
    loadState();
  }

  async function adminToto() {
    const id = document.getElementById('admin-toto-id');
    const result = document.getElementById('admin-toto-result');
    if (!id) return;
    const res = await fetch('/api/casino/admin/toto-settle', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchId: Number(id.value), result: result ? result.value : null })
    });
    const data = await res.json();
    if (!data.success) return toast('error', data.error);
    toast('success', '토토 정산 #' + data.id);
    loadToto();
  }

  function bindHot() {
    const vip = document.getElementById('cx-vip-claim');
    if (vip) vip.onclick = claimVip;
    const tb = document.getElementById('btn-toto-reload');
    if (tb) tb.onclick = loadToto;
    const cb = document.getElementById('btn-crash-bet');
    if (cb) cb.onclick = crashBet;
    const co = document.getElementById('btn-crash-out');
    if (co) co.onclick = crashOut;
    const ms = document.getElementById('btn-mines-start');
    if (ms) ms.onclick = startMines;
    const mc = document.getElementById('btn-mines-cashout');
    if (mc) mc.onclick = cashoutMines;
    const pb = document.getElementById('btn-plinko');
    if (pb) pb.onclick = playPlinko;
    const pr = document.getElementById('plinko-risk');
    if (pr) pr.onchange = function () { initPlinkoBoard('plinko-board', 'plinko-risk'); };
    initPlinkoBoard('plinko-board', 'plinko-risk');
    const aj = document.getElementById('btn-admin-jackpot');
    if (aj) aj.onclick = adminJackpot;
    const ahOn = document.getElementById('btn-admin-happy-on');
    if (ahOn) ahOn.onclick = function () { adminHappy('on'); };
    const ahOff = document.getElementById('btn-admin-happy-off');
    if (ahOff) ahOff.onclick = function () { adminHappy('off'); };
    const ahAuto = document.getElementById('btn-admin-happy-auto');
    if (ahAuto) ahAuto.onclick = function () { adminHappy('auto'); };
    const at = document.getElementById('btn-admin-toto');
    if (at) at.onclick = adminToto;
    paintMines([], null, null);
  }

  function bindSocket() {
    const sock = window.__liveSocket || window.socket || (window.io && !window.__cxSock ? null : window.__cxSock);
    let s = window.__liveSocket;
    if (!s && window.io) {
      try { s = window.io({ transports: ['websocket', 'polling'] }); } catch (e) {}
    }
    if (!s || s.__cxBound) return;
    s.__cxBound = true;
    s.on('casino:win', function (p) {
      const inner = document.getElementById('cx-ticker-inner');
      if (inner && p && p.text) {
        inner.insertAdjacentHTML('afterbegin', '<span>' + p.text + '</span>');
      }
      playSound('win');
    });
    s.on('casino:jackpot', function (p) {
      if (p && p.text) toast('success', p.text);
      playSound('jackpot');
      loadState();
    });
    s.on('crash:tick', paintCrash);
  }

  function boot() {
    bindSound();
    bindHot();
    loadState();
    loadToto();
    bindSocket();
    setInterval(loadState, 12000);
    setInterval(loadToto, 20000);
    setTimeout(bindSocket, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
