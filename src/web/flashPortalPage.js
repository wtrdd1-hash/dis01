/**
 * 🎮 NowPlayz - 클래식 플래시 게임 아케이드 포털 v1
 *
 * Ruffle WebAssembly 에뮬레이터 기반 플래시 게임 플레이 플랫폼
 * nowplayz.com 전용 뷰 템플릿
 */

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const FLASH_GAMES = [
  {
    id: 'boxhead',
    title: '박스헤드 2인용 (Boxhead 2Play)',
    category: 'action',
    categoryName: '액션/슈팅',
    desc: '좀비 무리를 처치하며 살아남는 최고의 2인용 협동 플래시 슈팅 게임',
    emoji: '🧟',
    tag: '인기 명작',
    swfUrl: 'https://cdn.jsdelivr.net/gh/ruffle-rs/ruffle@master/web/packages/core/test/swfs/boxhead2play.swf'
  },
  {
    id: 'eye_escape',
    title: '아이탈출 (Eye Escape 1)',
    category: 'escape',
    categoryName: '방탈출/퍼즐',
    desc: '외눈박이 외계인의 기상천외한 연구소 탈출 퍼즐 어드벤처',
    emoji: '👁️',
    tag: '추천',
    swfUrl: ''
  },
  {
    id: 'prison_break',
    title: '감옥탈출 (Prison Escape)',
    category: 'escape',
    categoryName: '방탈출',
    desc: '찰나의 순발력과 판단력으로 교도소를 탈출하는 국민 플래시 명작',
    emoji: '⛓️',
    tag: '스피드',
    swfUrl: ''
  },
  {
    id: 'dodge_poo',
    title: '똥피하기 (Dodge Poo)',
    category: 'casual',
    categoryName: '캐주얼/회피',
    desc: '하늘에서 떨어지는 장애물을 피하며 최고 기록을 달성하는 고전 명작',
    emoji: '💩',
    tag: '고전',
    swfUrl: ''
  },
  {
    id: 'snowcraft',
    title: '스노우크래프트 (Snowcraft)',
    category: 'strategy',
    categoryName: '전략/대전',
    desc: '3명의 빨간 모자 아이들과 함께하는 눈싸움 대전 전략 게임',
    emoji: '⛄',
    tag: '전략',
    swfUrl: ''
  },
  {
    id: 'henry_stickmin',
    title: '헨리 스틱민 (Escaping the Prison)',
    category: 'adventure',
    categoryName: '어드벤처/선택',
    desc: '황당하고 기발한 선택지로 결말을 찾아가는 레전드 졸라맨 어드벤처',
    emoji: '🏃',
    tag: '스토리',
    swfUrl: ''
  },
  {
    id: 'eye_love',
    title: '눈빛보내기 (Eye Catching)',
    category: 'casual',
    categoryName: '캐주얼',
    desc: '지나가는 남학생들의 마음을 사로잡는 타이밍 배틀 플래시 게임',
    emoji: '💖',
    tag: '추억',
    swfUrl: ''
  },
  {
    id: 'gogunbuntu',
    title: '고군분투 (Go Gun Bun Too)',
    category: 'action',
    categoryName: '러닝/액션',
    desc: '와이어를 타고 지붕을 질주하는 고양이 닌자의 초스피드 액션',
    emoji: '🐱',
    tag: '리듬/점프',
    swfUrl: ''
  }
];

function renderFlashPortalPage(options = {}) {
  const gamesJson = JSON.stringify(FLASH_GAMES);

  return `<!DOCTYPE html>
<html lang="ko" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NowPlayz - 클래식 플래시 게임 아케이드 (Retro Flash Games)</title>
  <meta name="description" content="플래시 플러그인 없이 웹 브라우저에서 바로 즐기는 클래식 명작 플래시 게임 플랫폼 NowPlayz. Ruffle WASM 에뮬레이터 지원.">
  <meta property="og:title" content="NowPlayz - 레트로 플래시 게임 아케이드">
  <meta property="og:description" content="추억의 플래시 게임을 브라우저에서 무설치로 바로 플레이하세요!">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700;800;900&family=Pretendard:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&family=Press+Start+2P&display=swap" rel="stylesheet">
  <!-- Ruffle Web Player (WASM Flash Emulator) -->
  <script src="https://unpkg.com/@ruffle-rs/ruffle"></script>
  <style>
    :root {
      --np-bg: #0b0f19;
      --np-card: #131b2e;
      --np-card-hover: #1c2742;
      --np-border: rgba(255, 255, 255, 0.08);
      --np-neon-blue: #00f0ff;
      --np-neon-pink: #ff007f;
      --np-neon-green: #00ff66;
      --np-neon-yellow: #ffe600;
      --np-text: #f0f4fc;
      --np-text-muted: #8a99b5;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Pretendard', sans-serif;
      background: var(--np-bg);
      color: var(--np-text);
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* 상단 네비게이션 */
    .np-nav {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(11, 15, 25, 0.85);
      backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--np-border);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .np-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      text-decoration: none;
      color: var(--np-text);
    }
    .np-logo-icon {
      font-size: 28px;
      filter: drop-shadow(0 0 12px var(--np-neon-pink));
    }
    .np-logo-text {
      font-family: 'Outfit', sans-serif;
      font-weight: 900;
      font-size: 24px;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, var(--np-neon-blue), var(--np-neon-pink));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .np-nav-badge {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 6px;
      background: rgba(0, 240, 255, 0.15);
      color: var(--np-neon-blue);
      border: 1px solid rgba(0, 240, 255, 0.3);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* 히어로 섹션 */
    .np-hero {
      padding: 48px 24px 32px;
      max-width: 1200px;
      margin: 0 auto;
      text-align: center;
    }
    .np-hero-tag {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      background: rgba(255, 0, 127, 0.12);
      border: 1px solid rgba(255, 0, 127, 0.3);
      border-radius: 100px;
      font-size: 13px;
      font-weight: 700;
      color: var(--np-neon-pink);
      margin-bottom: 20px;
    }
    .np-hero-title {
      font-family: 'Outfit', sans-serif;
      font-size: clamp(32px, 5vw, 54px);
      font-weight: 900;
      line-height: 1.15;
      margin-bottom: 16px;
      letter-spacing: -1px;
    }
    .np-hero-title span {
      background: linear-gradient(135deg, var(--np-neon-yellow), var(--np-neon-pink));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .np-hero-subtitle {
      color: var(--np-text-muted);
      font-size: clamp(15px, 2vw, 18px);
      max-width: 640px;
      margin: 0 auto 32px;
      line-height: 1.6;
    }

    /* 플래시 에뮬레이터 뷰어 컨테이너 */
    .np-stage-wrap {
      max-width: 960px;
      margin: 0 auto 48px;
      padding: 0 16px;
    }
    .np-stage {
      background: #000;
      border: 2px solid var(--np-neon-blue);
      border-radius: 16px;
      box-shadow: 0 0 30px rgba(0, 240, 255, 0.2), inset 0 0 20px rgba(0, 0, 0, 0.8);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .np-stage-head {
      background: #101626;
      padding: 12px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--np-border);
    }
    .np-stage-title {
      font-weight: 700;
      font-size: 15px;
      color: var(--np-neon-blue);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .np-stage-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .np-btn {
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 700;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .np-btn--primary {
      background: var(--np-neon-pink);
      color: #fff;
    }
    .np-btn--primary:hover {
      box-shadow: 0 0 15px var(--np-neon-pink);
      transform: translateY(-1px);
    }
    .np-btn--ghost {
      background: rgba(255, 255, 255, 0.08);
      color: var(--np-text);
    }
    .np-btn--ghost:hover {
      background: rgba(255, 255, 255, 0.15);
    }

    #flash-player-screen {
      width: 100%;
      height: 540px;
      background: #050811;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
    }
    #flash-player-screen ruffle-player {
      width: 100%;
      height: 100%;
    }

    /* 드래그 앤 드롭 영역 */
    .np-dropzone {
      border: 2px dashed rgba(0, 240, 255, 0.4);
      border-radius: 12px;
      padding: 32px 24px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
      background: rgba(0, 240, 255, 0.03);
      margin: 20px;
    }
    .np-dropzone:hover, .np-dropzone.is-dragover {
      border-color: var(--np-neon-pink);
      background: rgba(255, 0, 127, 0.08);
    }

    /* 게임 그리드 */
    .np-grid-section {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 24px 64px;
    }
    .np-section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }
    .np-section-title {
      font-size: 22px;
      font-weight: 800;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .np-games-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 20px;
    }
    .np-game-card {
      background: var(--np-card);
      border: 1px solid var(--np-border);
      border-radius: 14px;
      padding: 20px;
      cursor: pointer;
      transition: all 0.25s ease;
      display: flex;
      flex-direction: column;
      position: relative;
      overflow: hidden;
    }
    .np-game-card:hover {
      transform: translateY(-4px);
      border-color: var(--np-neon-blue);
      box-shadow: 0 10px 25px rgba(0, 240, 255, 0.15);
      background: var(--np-card-hover);
    }
    .np-game-card__icon {
      font-size: 36px;
      margin-bottom: 12px;
    }
    .np-game-card__title {
      font-size: 16px;
      font-weight: 700;
      margin-bottom: 6px;
      color: #fff;
    }
    .np-game-card__desc {
      font-size: 13px;
      color: var(--np-text-muted);
      line-height: 1.5;
      margin-bottom: 16px;
      flex-grow: 1;
    }
    .np-game-card__foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.05);
    }
    .np-game-card__tag {
      font-size: 11px;
      font-weight: 600;
      padding: 3px 8px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      color: var(--np-neon-yellow);
    }
    .np-game-card__play-btn {
      font-size: 12px;
      font-weight: 700;
      color: var(--np-neon-blue);
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* 푸터 */
    .np-footer {
      border-top: 1px solid var(--np-border);
      padding: 32px 24px;
      text-align: center;
      color: var(--np-text-muted);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <!-- 상단 네비게이션 -->
  <header class="np-nav">
    <a href="/" class="np-brand">
      <span class="np-logo-icon">🕹️</span>
      <span class="np-logo-text">NowPlayz</span>
      <span class="np-nav-badge">Flash Arcade</span>
    </a>
    <div style="display:flex;align-items:center;gap:12px;">
      <button type="button" onclick="document.getElementById('swf-file-input').click()" class="np-btn np-btn--primary">
        📁 내 SWF 파일 실행
      </button>
    </div>
  </header>

  <!-- 히어로 섹션 -->
  <section class="np-hero">
    <div class="np-hero-tag">
      <span>⚡</span>
      <span>No Plugin Required · WebAssembly Flash Engine</span>
    </div>
    <h1 class="np-hero-title">추억의 <span>클래식 플래시 게임</span><br>지금 바로 브라우저에서 플레이</h1>
    <p class="np-hero-subtitle">
      Adobe Flash Player 플러그인 없이 Ruffle WASM 에뮬레이터로 안전하고 쾌적하게 구동되는 플래시 게임 아케이드입니다.
    </p>
  </section>

  <!-- 플래시 에뮬레이터 스테이지 -->
  <section class="np-stage-wrap">
    <div class="np-stage">
      <div class="np-stage-head">
        <div class="np-stage-title" id="stage-game-title">
          <span>🎮</span>
          <span id="current-title-text">NowPlayz Flash Studio</span>
        </div>
        <div class="np-stage-actions">
          <button type="button" onclick="toggleFullscreen()" class="np-btn np-btn--ghost">⛶ 전체화면</button>
          <button type="button" onclick="document.getElementById('swf-file-input').click()" class="np-btn np-btn--ghost">📂 SWF 열기</button>
        </div>
      </div>
      <div id="flash-player-screen">
        <div id="welcome-box" style="text-align:center;padding:24px;">
          <div style="font-size:48px;margin-bottom:12px;">👾</div>
          <h2 style="font-size:20px;margin-bottom:8px;color:var(--np-neon-blue);">아래 게임 목록에서 선택하거나 내 SWF 파일을 실행하세요</h2>
          <p style="color:var(--np-text-muted);font-size:14px;max-width:480px;margin:0 auto 16px;">
            컴퓨터에 보관 중인 추억의 플래시 파일(.swf)을 드래그해서 올려놓으면 즉시 완벽 구동됩니다.
          </p>
          <div class="np-dropzone" id="drop-area" onclick="document.getElementById('swf-file-input').click()">
            <div style="font-size:32px;margin-bottom:8px;">📥</div>
            <div style="font-weight:700;color:#fff;margin-bottom:4px;">여기로 .swf 파일을 끌어다 놓으세요</div>
            <div style="font-size:12px;color:var(--np-text-muted);">또는 클릭하여 파일 선택</div>
          </div>
        </div>
        <div id="player-container" style="width:100%;height:100%;display:none;"></div>
      </div>
    </div>
    <input type="file" id="swf-file-input" accept=".swf" style="display:none;" onchange="handleFileSelect(event)">
  </section>

  <!-- 게임 라이브러리 목록 -->
  <section class="np-grid-section">
    <div class="np-section-head">
      <h2 class="np-section-title">
        <span>🔥</span>
        <span>인기 명작 플래시 게임 모음</span>
      </h2>
      <span style="font-size:13px;color:var(--np-text-muted);">8개 타이틀 제공 중</span>
    </div>

    <div class="np-games-grid">
      ${FLASH_GAMES.map(g => `
        <div class="np-game-card" onclick="loadGame('${g.id}')">
          <div class="np-game-card__icon">${g.emoji}</div>
          <h3 class="np-game-card__title">${escapeHtml(g.title)}</h3>
          <p class="np-game-card__desc">${escapeHtml(g.desc)}</p>
          <div class="np-game-card__foot">
            <span class="np-game-card__tag">${escapeHtml(g.tag)}</span>
            <span class="np-game-card__play-btn">플레이 ▶</span>
          </div>
        </div>
      `).join('')}
    </div>
  </section>

  <!-- 푸터 -->
  <footer class="np-footer">
    <p>© 2026 NowPlayz.com · WebAssembly Flash Game Emulator Platform</p>
    <p style="margin-top:8px;font-size:12px;opacity:0.7;">Powered by Ruffle Flash Player · All Rights Reserved</p>
  </footer>

  <script>
    const games = ${gamesJson};
    let ruffleInstance = null;
    let player = null;

    window.addEventListener('DOMContentLoaded', () => {
      if (window.RufflePlayer) {
        ruffleInstance = window.RufflePlayer.newest();
      }
    });

    function initPlayer() {
      const container = document.getElementById('player-container');
      const welcome = document.getElementById('welcome-box');
      welcome.style.display = 'none';
      container.style.display = 'block';
      container.innerHTML = '';

      if (!ruffleInstance && window.RufflePlayer) {
        ruffleInstance = window.RufflePlayer.newest();
      }

      if (ruffleInstance) {
        player = ruffleInstance.createPlayer();
        player.style.width = '100%';
        player.style.height = '100%';
        container.appendChild(player);
        return player;
      }
      return null;
    }

    function loadGame(gameId) {
      const game = games.find(g => g.id === gameId);
      if (!game) return;

      document.getElementById('current-title-text').innerText = game.title;
      const p = initPlayer();

      if (game.swfUrl && p) {
        p.load(game.swfUrl).catch(err => {
          console.warn('SWF 로드 안내:', err);
          promptCustomFile(game.title);
        });
      } else {
        promptCustomFile(game.title);
      }

      window.scrollTo({ top: document.querySelector('.np-stage').offsetTop - 80, behavior: 'smooth' });
    }

    function promptCustomFile(title) {
      const container = document.getElementById('player-container');
      const welcome = document.getElementById('welcome-box');
      container.style.display = 'none';
      welcome.style.display = 'block';
      alert('[' + title + '] 게임을 플레이하려면 해당 .swf 파일을 선택하거나 드래그해 주세요!');
      document.getElementById('swf-file-input').click();
    }

    function handleFileSelect(e) {
      const file = e.target.files[0];
      if (!file) return;
      playSwfFile(file);
    }

    function playSwfFile(file) {
      document.getElementById('current-title-text').innerText = file.name;
      const p = initPlayer();
      if (!p) {
        alert('Ruffle 에뮬레이터 초기화에 실패했습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const arrayBuffer = e.target.result;
        p.load({ data: arrayBuffer }).catch(err => {
          alert('SWF 파일 로드 중 오류가 발생했습니다: ' + err.message);
        });
      };
      reader.readAsArrayBuffer(file);
    }

    // 드래그 앤 드롭 이벤트
    const dropArea = document.getElementById('drop-area');
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      dropArea.addEventListener(eventName, preventDefaults, false);
      document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }

    ['dragenter', 'dragover'].forEach(eventName => {
      dropArea.addEventListener(eventName, () => dropArea.classList.add('is-dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropArea.addEventListener(eventName, () => dropArea.classList.remove('is-dragover'), false);
    });

    dropArea.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const files = dt.files;
      if (files.length > 0 && files[0].name.toLowerCase().endsWith('.swf')) {
        playSwfFile(files[0]);
      } else {
        alert('.swf 확장자의 플래시 게임 파일만 지원합니다.');
      }
    });

    function toggleFullscreen() {
      const screen = document.getElementById('flash-player-screen');
      if (!document.fullscreenElement) {
        if (screen.requestFullscreen) screen.requestFullscreen();
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
      }
    }
  </script>
</body>
</html>`;
}

module.exports = { renderFlashPortalPage };
