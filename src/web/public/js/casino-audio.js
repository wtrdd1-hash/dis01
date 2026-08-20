/**
 * 게임별 BGM / 효과음 (Web Audio, 파일 없음)
 */
(function () {
  if (window.CasinoAudio) return;

  const SOUND_KEY = 'duck_casino_sound';
  const BGM_KEY = 'duck_casino_bgm';
  let soundOn = localStorage.getItem(SOUND_KEY) !== '0';
  let bgmOn = localStorage.getItem(BGM_KEY) !== '0';
  let audioCtx = null;
  let master = null;
  let sfxBus = null;
  let bgmBus = null;
  let bgmTimer = null;
  let bgmNodes = [];
  let scene = 'idle';
  let trackName = '';
  let crashMult = 1;
  let step = 0;
  let unlocked = false;

  const TRACKS = {
    idle: { title: '대기', bpm: 90 },
    casino: { title: '네온 라운지', bpm: 108 },
    casino2: { title: '골드 룸', bpm: 96 },
    hot: { title: '핫게임 로비', bpm: 124 },
    crashBet: { title: '크래시 대기', bpm: 100 },
    crashFly: { title: '크래시 상승', bpm: 132 },
    toto: { title: '토토 아레나', bpm: 118 },
    mines: { title: '마인즈 지하', bpm: 88 },
    plinko: { title: '플링코 드롭', bpm: 140 },
    horse: { title: '경마 질주', bpm: 136 },
    arcade: { title: '아케이드 로비', bpm: 128 },
    clicker: { title: '채굴 비트', bpm: 112 },
    stocks: { title: '장중 앰비언트', bpm: 80 }
  };

  function ctx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
      master = audioCtx.createGain();
      master.gain.value = 0.55;
      master.connect(audioCtx.destination);
      sfxBus = audioCtx.createGain();
      sfxBus.gain.value = 0.7;
      sfxBus.connect(master);
      bgmBus = audioCtx.createGain();
      bgmBus.gain.value = 0.22;
      bgmBus.connect(master);
    }
    return audioCtx;
  }

  function unlock() {
    const c = ctx();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    unlocked = true;
  }

  function envGain(bus, peak, dur, when) {
    const c = ctx();
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    g.connect(bus || sfxBus);
    return g;
  }

  function osc(freq, type, dur, peak, when, bus, slide) {
    const c = ctx();
    if (!c || !soundOn) return;
    const t = when || c.currentTime;
    const o = c.createOscillator();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    const g = envGain(bus || sfxBus, peak || 0.05, dur, t);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function noise(dur, peak, when, hp) {
    const c = ctx();
    if (!c || !soundOn) return;
    const t = when || c.currentTime;
    const n = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, n, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const filter = c.createBiquadFilter();
    filter.type = hp ? 'highpass' : 'lowpass';
    filter.frequency.value = hp || 900;
    const g = envGain(sfxBus, peak || 0.04, dur, t);
    src.connect(filter);
    filter.connect(g);
    src.start(t);
    src.stop(t + dur);
  }

  function chord(freqs, dur, peak, when, type) {
    freqs.forEach(function (f, i) {
      osc(f, type || 'triangle', dur, (peak || 0.03) / (1 + i * 0.15), when, sfxBus);
    });
  }

  function arp(notes, gap, peak, type) {
    const c = ctx();
    if (!c) return;
    notes.forEach(function (f, i) {
      osc(f, type || 'square', 0.12, peak || 0.045, c.currentTime + i * gap);
    });
  }

  const SFX = {
    spin: function () {
      noise(0.12, 0.03, 0, 400);
      osc(180, 'sawtooth', 0.1, 0.03, 0, sfxBus, 90);
    },
    slot: function () {
      const c = ctx();
      if (!c) return;
      for (let i = 0; i < 8; i++) {
        osc(140 + i * 18, 'square', 0.05, 0.02, c.currentTime + i * 0.07);
        noise(0.04, 0.015, c.currentTime + i * 0.07, 800);
      }
    },
    coin: function () {
      osc(880, 'square', 0.08, 0.04);
      osc(1320, 'triangle', 0.16, 0.035, ctx().currentTime + 0.07);
    },
    dice: function () {
      noise(0.08, 0.05, 0, 1200);
      osc(200, 'square', 0.05, 0.03);
      osc(160, 'square', 0.05, 0.025, ctx().currentTime + 0.06);
    },
    roulette: function () {
      const c = ctx();
      for (let i = 0; i < 10; i++) {
        osc(220 + i * 12, 'triangle', 0.06, 0.02, c.currentTime + i * 0.08, sfxBus, 180);
      }
    },
    horse: function () {
      const c = ctx();
      for (let i = 0; i < 6; i++) {
        noise(0.05, 0.035, c.currentTime + i * 0.11, 300);
        osc(90, 'triangle', 0.06, 0.03, c.currentTime + i * 0.11);
      }
    },
    toto: function () {
      chord([392, 493.88, 587.33], 0.18, 0.04);
      osc(784, 'square', 0.12, 0.03, ctx().currentTime + 0.16);
    },
    mines: function () {
      osc(70, 'sawtooth', 0.16, 0.04);
      noise(0.1, 0.025, 0, 200);
    },
    plinko: function () {
      osc(988, 'triangle', 0.06, 0.035);
      osc(1318, 'triangle', 0.08, 0.03, ctx().currentTime + 0.05);
    },
    tick: function () {
      osc(720 + crashMult * 40, 'square', 0.03, 0.02);
    },
    near: function () {
      osc(466, 'square', 0.1, 0.04);
      osc(349, 'sawtooth', 0.22, 0.035, ctx().currentTime + 0.1);
      noise(0.12, 0.02, ctx().currentTime + 0.08, 600);
    },
    lose: function () {
      osc(196, 'triangle', 0.18, 0.04, 0, sfxBus, 98);
      osc(130, 'sawtooth', 0.28, 0.03, ctx().currentTime + 0.12, sfxBus, 70);
    },
    boom: function () {
      noise(0.28, 0.08, 0, 180);
      osc(55, 'sawtooth', 0.35, 0.06, 0, sfxBus, 30);
    },
    win: function () {
      arp([523.25, 659.25, 783.99, 1046.5], 0.09, 0.05, 'square');
      chord([261.63, 329.63, 392], 0.35, 0.03, ctx().currentTime + 0.28, 'triangle');
    },
    winBig: function () {
      arp([523.25, 659.25, 783.99, 987.77, 1174.66, 1567.98], 0.08, 0.055, 'square');
      chord([261.63, 329.63, 392, 523.25], 0.5, 0.04, ctx().currentTime + 0.4);
    },
    jackpot: function () {
      const c = ctx();
      [261.63, 329.63, 392, 523.25, 659.25, 783.99].forEach(function (f, i) {
        osc(f, 'square', 0.22, 0.05, c.currentTime + i * 0.07);
        osc(f * 2, 'triangle', 0.28, 0.03, c.currentTime + i * 0.07);
      });
      noise(0.4, 0.03, c.currentTime + 0.35, 2000);
    },
    cashout: function () {
      osc(587, 'square', 0.08, 0.04);
      osc(880, 'triangle', 0.16, 0.04, ctx().currentTime + 0.07);
      osc(1174, 'triangle', 0.2, 0.035, ctx().currentTime + 0.14);
    }
  };

  function stopBgm() {
    if (bgmTimer) {
      clearInterval(bgmTimer);
      bgmTimer = null;
    }
    bgmNodes.forEach(function (n) {
      try { n.stop(); } catch (e) {}
    });
    bgmNodes = [];
    step = 0;
  }

  function bgmNote(freq, dur, peak, type) {
    const c = ctx();
    if (!c || !soundOn || !bgmOn) return;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = type || 'triangle';
    o.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak || 0.04, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(bgmBus);
    o.start(t);
    o.stop(t + dur + 0.02);
    bgmNodes.push(o);
  }

  function tickBgm() {
    if (!soundOn || !bgmOn) return;
    const c = ctx();
    if (!c) return;
    step += 1;
    const s = step;

    if (scene === 'casino' || scene === 'casino2') {
      const bass = scene === 'casino2' ? [73.42, 82.41, 98, 87.31] : [65.41, 82.41, 98, 73.42];
      if (s % 2 === 0) bgmNote(bass[(s / 2) % 4], 0.28, 0.05, 'triangle');
      if (s % 8 === 0) {
        const ch = scene === 'casino2'
          ? [[246.94, 311.13, 369.99], [220, 277.18, 329.63], [196, 246.94, 293.66], [174.61, 220, 261.63]]
          : [[261.63, 329.63, 392], [220, 277.18, 329.63], [246.94, 311.13, 369.99], [174.61, 220, 261.63]];
        const chordN = ch[Math.floor(s / 8) % 4];
        chordN.forEach(function (f) { bgmNote(f, 0.7, 0.018, 'sine'); });
      }
      if (s % 16 === 12) bgmNote(523.25, 0.12, 0.02, 'square');
    } else if (scene === 'hot' || scene === 'toto') {
      const hook = [392, 440, 493.88, 587.33, 493.88, 440];
      if (s % 2 === 0) bgmNote(hook[(s / 2) % hook.length], 0.16, 0.035, 'square');
      if (s % 4 === 0) bgmNote(98, 0.2, 0.045, 'sawtooth');
      if (scene === 'toto' && s % 8 === 0) bgmNote(784, 0.1, 0.025, 'triangle');
    } else if (scene === 'crashBet') {
      if (s % 4 === 0) bgmNote(55, 0.35, 0.05, 'sine');
      if (s % 8 === 4) bgmNote(82.41, 0.25, 0.03, 'triangle');
    } else if (scene === 'crashFly') {
      const lift = Math.min(2.2, crashMult);
      bgmNote(110 * lift, 0.12, 0.04, 'sawtooth');
      if (s % 2 === 0) bgmNote(220 * lift, 0.08, 0.02, 'square');
    } else if (scene === 'mines') {
      if (s % 4 === 0) bgmNote(49, 0.4, 0.045, 'sine');
      if (s % 8 === 3) bgmNote(73.42, 0.2, 0.02, 'triangle');
      if (s % 16 === 15) bgmNote(185, 0.08, 0.015, 'square');
    } else if (scene === 'plinko') {
      const penta = [523.25, 587.33, 659.25, 783.99, 880];
      bgmNote(penta[s % 5], 0.1, 0.03, 'triangle');
      if (s % 5 === 0) bgmNote(130.81, 0.14, 0.03, 'sine');
    } else if (scene === 'horse') {
      if (s % 2 === 0) bgmNote(87.31, 0.1, 0.04, 'triangle');
      if (s % 2 === 1) bgmNote(110, 0.08, 0.03, 'sawtooth');
      if (s % 8 === 0) bgmNote(349.23, 0.12, 0.02, 'square');
    } else if (scene === 'arcade') {
      const hook = [329.63, 392, 493.88, 587.33, 493.88, 392];
      if (s % 2 === 0) bgmNote(hook[(s / 2) % hook.length], 0.14, 0.03, 'square');
      if (s % 4 === 0) bgmNote(82.41, 0.18, 0.04, 'triangle');
      if (s % 16 === 8) bgmNote(659.25, 0.08, 0.02, 'triangle');
    } else if (scene === 'clicker') {
      if (s % 2 === 0) bgmNote(130.81, 0.12, 0.03, 'square');
      if (s % 4 === 2) bgmNote(196, 0.1, 0.02, 'triangle');
    } else if (scene === 'stocks') {
      if (s % 8 === 0) bgmNote(196, 0.8, 0.02, 'sine');
      if (s % 16 === 8) bgmNote(246.94, 0.8, 0.015, 'sine');
    }
  }

  function startBgm(name) {
    const spec = TRACKS[name] || TRACKS.idle;
    if (scene === name && bgmTimer) {
      paintNow();
      return;
    }
    stopBgm();
    scene = name;
    trackName = spec.title;
    paintNow();
    if (!soundOn || !bgmOn || name === 'idle') return;
    const c = ctx();
    if (!c) return;
    const interval = Math.max(90, Math.round(60000 / spec.bpm / 2));
    bgmTimer = setInterval(tickBgm, interval);
    tickBgm();
  }

  function sceneFromTab(tabId) {
    if (tabId === 'tab-casino') return Math.random() < 0.5 ? 'casino' : 'casino2';
    if (tabId === 'tab-hot') return 'hot';
    if (tabId === 'tab-arcade') return 'arcade';
    if (tabId === 'tab-horse') return 'horse';
    if (tabId === 'tab-clicker') return 'clicker';
    if (tabId === 'tab-stocks' || tabId === 'tab-news') return 'stocks';
    return 'idle';
  }

  function paintNow() {
    const el = document.getElementById('cx-nowplay');
    if (el) el.textContent = (!soundOn || !bgmOn || scene === 'idle') ? '♪ 음악 꺼짐' : ('♪ ' + trackName);
    const btn = document.getElementById('cx-sound-btn');
    if (btn) btn.textContent = soundOn ? '사운드 ON' : '사운드 OFF';
    const bgmBtn = document.getElementById('cx-bgm-btn');
    if (bgmBtn) bgmBtn.textContent = bgmOn ? 'BGM ON' : 'BGM OFF';
  }

  function play(kind, game) {
    if (!soundOn) return;
    unlock();
    const mapped = {
      '슬롯머신': 'slot',
      '즉석복권': 'slot',
      '동전뒤집기': 'coin',
      '주사위대결': 'dice',
      '룰렛': 'roulette',
      '월덕경마': 'horse',
      '토토': 'toto',
      '마인즈': 'mines',
      '플링코': 'plinko',
      '크래시': 'tick',
      '포커': 'dice',
      '세븐포커': 'dice'
    };
    if (kind === 'spin' && game && mapped[game]) kind = mapped[game];
    const fn = SFX[kind] || SFX.spin;
    try { fn(); } catch (e) {}
  }

  function onResult(data) {
    if (!data) return;
    const game = data.game || '';
    if (data.jackpotHit && Number(data.jackpotHit) > 0) return play('jackpot');
    if (data.nearMiss) return play('near');
    if (data.boom) return play('boom');
    if (data.isWin) {
      const profit = Number(data.profit || 0);
      if (profit >= 100000) return play('winBig');
      if (game === '크래시') return play('cashout');
      return play('win');
    }
    if (data.success && data.isWin === false) play('lose');
  }

  function setEnabled(on) {
    soundOn = !!on;
    localStorage.setItem(SOUND_KEY, soundOn ? '1' : '0');
    if (!soundOn) stopBgm();
    else startBgm(scene === 'idle' ? sceneFromTab(document.body.dataset.tab) : scene);
    paintNow();
  }

  function setBgm(on) {
    bgmOn = !!on;
    localStorage.setItem(BGM_KEY, bgmOn ? '1' : '0');
    if (!bgmOn) stopBgm();
    else startBgm(scene === 'idle' ? sceneFromTab(document.body.dataset.tab) : scene);
    paintNow();
  }

  function nextTrack() {
    const order = ['casino', 'casino2', 'hot', 'arcade', 'toto', 'crashBet', 'mines', 'plinko', 'horse', 'clicker'];
    const i = Math.max(0, order.indexOf(scene));
    startBgm(order[(i + 1) % order.length]);
    play('win');
  }

  function hookTab() {
    if (window.switchTab && !window.switchTab.__audioHooked) {
      const orig = window.switchTab;
      const wrapped = function (tabId) {
        orig(tabId);
        startBgm(sceneFromTab(tabId));
      };
      wrapped.__audioHooked = true;
      window.switchTab = wrapped;
    }
  }

  function ensureHud() {
    const soundBtn = document.getElementById('cx-sound-btn');
    if (!soundBtn || document.getElementById('cx-nowplay')) return;
    const wrap = document.createElement('div');
    wrap.className = 'cx-music-box';
    wrap.innerHTML =
      '<div class="cx-nowplay" id="cx-nowplay">♪ 준비</div>' +
      '<button type="button" class="cx-sound-btn" id="cx-bgm-btn">BGM ON</button>' +
      '<button type="button" class="cx-sound-btn" id="cx-next-btn">다음 곡</button>';
    soundBtn.parentNode.insertBefore(wrap, soundBtn.nextSibling);
    document.getElementById('cx-bgm-btn').onclick = function () { setBgm(!bgmOn); };
    document.getElementById('cx-next-btn').onclick = function () { unlock(); nextTrack(); };
  }

  function boot() {
    ensureHud();
    hookTab();
    const btn = document.getElementById('cx-sound-btn');
    if (btn && !btn.__audioBound) {
      btn.__audioBound = true;
      btn.onclick = function () {
        unlock();
        setEnabled(!soundOn);
        if (soundOn) play('win');
      };
    }
    ['pointerdown', 'keydown'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        unlock();
        if (soundOn && bgmOn && !bgmTimer) startBgm(sceneFromTab(document.body.dataset.tab || 'tab-stocks'));
      }, { once: true });
    });
    paintNow();
  }

  window.CasinoAudio = {
    play: play,
    onResult: onResult,
    setScene: startBgm,
    setCrashPhase: function (phase, mult) {
      crashMult = Number(mult) || 1;
      if (phase === 'flying') startBgm('crashFly');
      else if (phase === 'betting') startBgm('crashBet');
      else if (phase === 'crash' && scene !== 'crashBoom') {
        scene = 'crashBoom';
        play('boom');
        setTimeout(function () { if (scene === 'crashBoom') startBgm('hot'); }, 900);
      }
    },
    setEnabled: setEnabled,
    setBgm: setBgm,
    nextTrack: nextTrack,
    isOn: function () { return soundOn; },
    boot: boot
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
