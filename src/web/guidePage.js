'use strict';
/**
 * 📖 게임 가이드 & 상세 설명서 페이지 템플릿
 */

const { getAppVersion, getAppVersionLabel } = require('./autoRefreshPatch');

function renderGuidePage(options = {}) {
  const { user = null } = options;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0">
  <title>게임 가이드 & 상세 설명서 | 월덕 경제 가상 서버</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
  <link rel="stylesheet" href="/static/css/app.css">
  <link rel="stylesheet" href="/static/css/dashboard-ux.css">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #0f172a;
      --card-bg-alt: #131d33;
      --border: rgba(255, 255, 255, 0.08);
      --border-accent: rgba(56, 189, 248, 0.3);
      --primary: #6366f1;
      --accent: #38bdf8;
      --gold: #fbbf24;
      --green: #34d399;
      --rose: #f43f5e;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-sub: #cbd5e1;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, Roboto, sans-serif;
      background-color: var(--bg);
      color: var(--text-main);
      line-height: 1.6;
      padding-bottom: 80px;
    }
    a { color: var(--accent); text-decoration: none; transition: color 0.2s; }
    a:hover { color: #818cf8; }

    /* Sticky Navigation Header */
    .guide-header {
      position: sticky; top: 0; z-index: 100;
      background: rgba(9, 13, 22, 0.88); backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--border);
      padding: 14px 28px; display: flex; justify-content: space-between; align-items: center;
    }
    .guide-brand {
      font-size: 1.25rem; font-weight: 800; color: #fff;
      display: flex; align-items: center; gap: 10px;
    }
    .guide-brand span {
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .guide-nav-actions { display: flex; gap: 12px; align-items: center; }
    .btn-guide-action {
      background: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.3);
      color: var(--accent); padding: 8px 16px; border-radius: 10px; font-size: 0.85rem; font-weight: 700;
      display: inline-flex; align-items: center; gap: 6px; cursor: pointer; transition: all 0.2s;
    }
    .btn-guide-action:hover {
      background: var(--accent); color: #090d16; border-color: var(--accent);
      transform: translateY(-1px); box-shadow: 0 4px 12px rgba(56, 189, 248, 0.3);
    }

    /* Hero Banner */
    .hero-section {
      text-align: center; padding: 48px 20px 32px;
      background: radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.12), transparent 70%);
      border-bottom: 1px solid var(--border);
    }
    .hero-badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 12px; border-radius: 999px; font-size: 0.8rem; font-weight: 700;
      background: rgba(99, 102, 241, 0.15); border: 1px solid rgba(99, 102, 241, 0.3); color: #818cf8;
      margin-bottom: 14px;
    }
    .hero-title { font-size: 2.2rem; font-weight: 900; letter-spacing: -0.02em; margin-bottom: 12px; }
    .hero-subtitle { color: var(--text-muted); font-size: 1.05rem; max-width: 680px; margin: 0 auto 24px; }

    /* Search & Filter Bar */
    .filter-wrap {
      max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px;
    }
    .search-box {
      position: relative; width: 100%;
    }
    .search-input {
      width: 100%; padding: 14px 20px 14px 46px; border-radius: 14px;
      background: #0f172a; border: 1px solid var(--border-accent);
      color: #fff; font-size: 0.98rem; outline: none; transition: all 0.2s;
    }
    .search-input:focus {
      border-color: var(--accent); box-shadow: 0 0 16px rgba(56, 189, 248, 0.25);
    }
    .search-icon {
      position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
      font-size: 1.1rem; color: var(--text-muted);
    }

    /* Category Tabs */
    .tab-bar {
      display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-top: 10px;
    }
    .tab-btn {
      background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border);
      color: var(--text-muted); padding: 8px 16px; border-radius: 999px;
      font-size: 0.88rem; font-weight: 700; cursor: pointer; transition: all 0.2s;
    }
    .tab-btn:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
    .tab-btn.active {
      background: linear-gradient(135deg, #38bdf8, #6366f1);
      color: #fff; border-color: transparent; box-shadow: 0 4px 12px rgba(56, 189, 248, 0.3);
    }

    /* Content Layout */
    .guide-container {
      max-width: 1180px; margin: 36px auto 0; padding: 0 20px;
    }

    .guide-section {
      margin-bottom: 48px;
    }
    .section-title {
      font-size: 1.45rem; font-weight: 800; margin-bottom: 18px;
      display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--border);
      padding-bottom: 10px; color: #fff;
    }

    /* Cards Grid */
    .cards-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 20px;
    }

    .guide-card {
      background: var(--card-bg); border: 1px solid var(--border); border-radius: 16px;
      padding: 22px; transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
      display: flex; flex-direction: column; justify-content: space-between;
    }
    .guide-card:hover {
      transform: translateY(-3px); border-color: var(--border-accent);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    .guide-card.highlight {
      border: 1px solid rgba(251, 191, 36, 0.4);
      background: linear-gradient(145deg, #131d33, #0f172a);
    }

    .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .card-icon-title { display: flex; align-items: center; gap: 12px; }
    .card-icon { font-size: 1.8rem; }
    .card-name { font-size: 1.15rem; font-weight: 800; color: #fff; }
    .card-badge {
      font-size: 0.75rem; font-weight: 700; padding: 4px 8px; border-radius: 6px;
      background: rgba(56, 189, 248, 0.12); color: var(--accent); border: 1px solid rgba(56, 189, 248, 0.25);
    }
    .card-badge.gold {
      background: rgba(251, 191, 36, 0.15); color: var(--gold); border-color: rgba(251, 191, 36, 0.3);
    }
    .card-badge.green {
      background: rgba(52, 211, 153, 0.15); color: var(--green); border-color: rgba(52, 211, 153, 0.3);
    }

    .card-desc { font-size: 0.92rem; color: var(--text-sub); margin-bottom: 14px; line-height: 1.55; }
    
    .card-rules {
      background: rgba(0, 0, 0, 0.25); border-radius: 10px; padding: 12px 14px;
      font-size: 0.85rem; color: var(--text-muted); margin-bottom: 14px;
    }
    .card-rules ul { padding-left: 18px; }
    .card-rules li { margin-bottom: 4px; }
    .card-rules li:last-child { margin-bottom: 0; }

    .card-footer {
      display: flex; align-items: center; justify-content: space-between;
      border-top: 1px solid rgba(255, 255, 255, 0.05); padding-top: 12px; margin-top: auto;
    }
    .card-stat { font-size: 0.82rem; font-weight: 700; color: var(--accent); }
    .btn-play-mini {
      background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border);
      color: #fff; padding: 5px 12px; border-radius: 8px; font-size: 0.78rem; font-weight: 700;
      transition: all 0.2s;
    }
    .btn-play-mini:hover { background: var(--accent); color: #090d16; border-color: var(--accent); }

    /* Footer */
    .guide-footer {
      text-align: center; margin-top: 60px; padding-top: 30px;
      border-top: 1px solid var(--border); color: var(--text-muted); font-size: 0.85rem;
    }

    @media (max-width: 640px) {
      .hero-title { font-size: 1.6rem; }
      .cards-grid { grid-template-columns: 1fr; }
      .guide-header { padding: 12px 16px; }
    }
  </style>
</head>
<body>
  <!-- Sticky Header -->
  <header class="guide-header">
    <div class="guide-brand">
      ✦ <span>월덕 가이드 & 상세 설명서</span>
    </div>
    <div class="guide-nav-actions">
      <a href="/" class="btn-guide-action">🎮 대시보드 바로가기</a>
    </div>
  </header>

  <!-- Hero Section -->
  <section class="hero-section">
    <div class="hero-badge">📖 OFFICIAL GAME GUIDE</div>
    <h1 class="hero-title">월덕 경제 & 게임 상세 설명서</h1>
    <p class="hero-subtitle">14가지 채굴 미니게임, 8가지 카지노 베팅, 주식 시장 국면, 세금 & 이자 시스템의 모든 공식과 규칙을 한눈에 확인하세요.</p>

    <!-- Search & Filters -->
    <div class="filter-wrap">
      <div class="search-box">
        <span class="search-icon">🔍</span>
        <input type="text" id="guide-search" class="search-input" placeholder="게임 이름, 룰, 배당률, 세금, 규칙 검색..." oninput="filterGuides()">
      </div>
      <div class="tab-bar">
        <button type="button" class="tab-btn active" onclick="setTab('all', this)">전체</button>
        <button type="button" class="tab-btn" onclick="setTab('mining', this)">⛏️ 채굴 & 클리커</button>
        <button type="button" class="tab-btn" onclick="setTab('casino', this)">🎰 카지노 & 베팅</button>
        <button type="button" class="tab-btn" onclick="setTab('stock', this)">📈 주식 & 펀드</button>
        <button type="button" class="tab-btn" onclick="setTab('economy', this)">🏦 은행 & 세금</button>
        <button type="button" class="tab-btn" onclick="setTab('bot', this)">🤖 디스코드 봇</button>
      </div>
    </div>
  </section>

  <!-- Content Container -->
  <main class="guide-container">

    <!-- ⛏️ 채굴 & 클리커 아케이드 -->
    <section class="guide-section" data-cat="mining">
      <h2 class="section-title">⛏️ 채굴 & 클리커 아케이드 (14가지 채굴 장르)</h2>
      <div class="cards-grid">
        
        <!-- 원석 짝맞추기 (강조) -->
        <div class="guide-card highlight" data-keywords="원석 짝맞추기 match 퍼즐 암기 카드 보상">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🃏</span>
                <span class="card-name">원석 짝맞추기</span>
              </div>
              <span class="card-badge gold">✨ 2배 보상 + 올클리어 혜택</span>
            </div>
            <p class="card-desc">12장(6쌍)의 원석 카드를 뒤집어 동일한 원석 짝을 찾는 기억력 퍼즐 채굴 게임입니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>짝 맞춤 보상</strong>: 짝 완성 시 <strong>2회분 채굴 클릭 보상</strong> 지급!</li>
                <li><strong>올클리어 보너스</strong>: 6쌍 모두 완성 시 <strong>+5연타 보너스</strong> 자동 지급!</li>
                <li><strong>해금 비용</strong>: 10,000원 (최초 1회만 해금하면 무제한 유효).</li>
                <li><strong>전략 팁</strong>: 틀린 카드의 위치를 잘 기억해 두면 연타보다 높은 초당 2.4클릭 대등 수익률 달성 가능!</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">최대 수익률: 초당 2.4회 클릭 대등</span>
            <a href="/" class="btn-play-mini">채굴하러 가기</a>
          </div>
        </div>

        <!-- 보석 연타 -->
        <div class="guide-card" data-keywords="보석 연타 classic 기본 터치 연타 크리티컬">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">💎</span>
                <span class="card-name">보석 연타</span>
              </div>
              <span class="card-badge green">기본 제공</span>
            </div>
            <p class="card-desc">화면 중앙의 거대한 보석을 연속 탭하여 현금을 법니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>크리티컬</strong>: 10% 확률로 3배 대박 크리티컬 채굴!</li>
                <li><strong>안티치트</strong>: 초당 2.5클릭 방지 쿨다운 적용.</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">기본 채굴 모드</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

        <!-- 갱도 탐험 -->
        <div class="guide-card" data-keywords="갱도 탐험 shaft 바위 채굴">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">⛏️</span>
                <span class="card-name">갱도 탐험</span>
              </div>
              <span class="card-badge">해금 5,000원</span>
            </div>
            <p class="card-desc">깊은 갱도 암반층을 깨고 들어가며 심층 보석을 발굴합니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>규칙</strong>: 스폰되는 암반 노두를 탭하여 갱도 심도를 갱신합니다.</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">탐험형 장르</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

        <!-- 두더지 광맥 -->
        <div class="guide-card" data-keywords="두더지 광맥 mole 아케이드 타격">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🐹</span>
                <span class="card-name">두더지 광맥</span>
              </div>
              <span class="card-badge">해금 6,000원</span>
            </div>
            <p class="card-desc">9개 구멍에서 튀어나오는 광석과 두더지만 타격합니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>규칙</strong>: 올라온 두더지/보석만 터치. 빈 구멍 클릭 시 무효 처리.</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">순발력 아케이드</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

        <!-- 드릴 타이밍 -->
        <div class="guide-card" data-keywords="드릴 타이밍 drill 리듬 스위트스팟">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🔩</span>
                <span class="card-name">드릴 타이밍</span>
              </div>
              <span class="card-badge">해금 12,000원</span>
            </div>
            <p class="card-desc">움직이는 드릴 바늘이 초록 구간(38%~62%)에 올 때 굴착합니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>PERFECT 성공</strong>: 초록 스위트스팟 적중 시 정밀 굴착 이펙트발동!</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">타이밍 리듬</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

        <!-- 광차 적재 -->
        <div class="guide-card" data-keywords="광차 적재 cart 적재 타이밍">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🛒</span>
                <span class="card-name">광차 적재</span>
              </div>
              <span class="card-badge">해금 16,000원</span>
            </div>
            <p class="card-desc">레일을 지나는 광차가 중앙 적재 존에 왔을 때 광석을 싣습니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>규칙</strong>: 적재 존 밖에서 누르면 적재 미스 미세 쿨다운 발생.</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">동적 타이밍</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

        <!-- 빙하 깨기 -->
        <div class="guide-card" data-keywords="빙하 깨기 ice 연타 얼음 내구도">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🧊</span>
                <span class="card-name">빙하 깨기</span>
              </div>
              <span class="card-badge">해금 24,000원</span>
            </div>
            <p class="card-desc">내구도 6의 빙하 층을 타격하여 깨부수고 봉인된 원석을 꺼냅니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>규칙</strong>: 6번 타격 시 얼음이 파쇄되며 원석 보상 획득!</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">타격감 연타</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

      </div>
    </section>


    <!-- 🎰 카지노 & 베팅 -->
    <section class="guide-section" data-cat="casino">
      <h2 class="section-title">🎰 카지노 & 베팅 (8가지 미니 게임)</h2>
      <div class="cards-grid">

        <!-- 블랙잭 -->
        <div class="guide-card highlight" data-keywords="블랙잭 blackjack 카드 21 딜러 배당">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">♠️</span>
                <span class="card-name">블랙잭</span>
              </div>
              <span class="card-badge gold">인기 Top 1</span>
            </div>
            <p class="card-desc">딜러와 1대1로 겨루어 카드 숫자의 합이 21에 가장 가까운 사람이 승리합니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>블랙잭(A + 10/J/Q/K)</strong>: 2.5배 지급 (1.5배 순이익).</li>
                <li><strong>일반 승리</strong>: 2.0배 지급 (1.0배 순이익).</li>
                <li><strong>Push (무승부)</strong>: 베팅금 전액 반환.</li>
                <li><strong>전략 팁</strong>: 딜러 업카드가 2~6일 때는 12 이상에서 스탠드(Stay) 권장!</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">환급률: 약 99.2%</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

        <!-- 슬롯머신 -->
        <div class="guide-card" data-keywords="슬롯머신 slot 릴 잭팟 777 배당">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🎰</span>
                <span class="card-name">슬롯머신</span>
              </div>
              <span class="card-badge">최대 50배 + 잭팟</span>
            </div>
            <p class="card-desc">3개의 릴을 돌려 심볼을 일치시키는 클래식 슬롯머신입니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>7️⃣ 7️⃣ 7️⃣</strong>: 50배 + 서버 누적 잭팟금 전액 수령!</li>
                <li><strong>💎 💎 💎</strong>: 20배 / <strong>🔔 🔔 🔔</strong>: 10배</li>
                <li><strong>🍉 🍉 🍉</strong>: 5배 / <strong>🍒 🍒</strong>: 2배</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">잭팟 누적 시스템</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

        <!-- 그래프 크래시 -->
        <div class="guide-card highlight" data-keywords="크래시 crash 실시간 배율 폭발 현금화">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">📈</span>
                <span class="card-name">그래프 크래시</span>
              </div>
              <span class="card-badge gold">실시간 배율</span>
            </div>
            <p class="card-desc">실시간으로 상승하는 배율 그래프가 폭발하기 전에 스톱 버튼을 눌러 현금화합니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>배율 범위</strong>: 1.01배 ~ 최대 100.00배 이상!</li>
                <li><strong>위험성</strong>: 폭발(Crash) 전에 현금화하지 못하면 베팅금 전액 소멸.</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">스릴 넘치는 현금화</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

        <!-- 코인플립 -->
        <div class="guide-card" data-keywords="코인플립 coinflip 동전 앞면 뒷면">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🪙</span>
                <span class="card-name">코인플립</span>
              </div>
              <span class="card-badge">승률 50%</span>
            </div>
            <p class="card-desc">동전의 앞면 또는 뒷면을 예측하는 직관적인 확률 게임입니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>배당률</strong>: 1.95배 (5% 카지노 수수료 차감).</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">초단기 승부</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

        <!-- 룰렛 -->
        <div class="guide-card" data-keywords="룰렛 roulette 레드 블랙 숫자 배당">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🎯</span>
                <span class="card-name">룰렛</span>
              </div>
              <span class="card-badge">최대 35배</span>
            </div>
            <p class="card-desc">0~36 숫자 판에 공이 멈추는 위치를 예측하는 유러피안 룰렛입니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>단일 숫자 적중</strong>: 35배 / <strong>컬럼·다즌</strong>: 3배</li>
                <li><strong>레드/블랙 & 홀/짝</strong>: 2배</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">다양한 베팅 옵션</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

        <!-- 경마 레이스 -->
        <div class="guide-card" data-keywords="경마 race 우승마 배당 역배">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🏇</span>
                <span class="card-name">경마 레이스</span>
              </div>
              <span class="card-badge">최대 12배 역배당</span>
            </div>
            <p class="card-desc">5마리의 정예 출전마 중 우승할 말에 베팅합니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>1번마 (우승 후보)</strong>: 승률 높음 / 1.8배 낮음 배당</li>
                <li><strong>5번마 (아웃사이더)</strong>: 역배당 / 최대 12.0배 고배당</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">레이스 관전</span>
            <a href="/" class="btn-play-mini">플레이</a>
          </div>
        </div>

      </div>
    </section>


    <!-- 📈 주식 & 펀드 -->
    <section class="guide-section" data-cat="stock">
      <h2 class="section-title">📈 주식 시장 & 5가지 국면 시스템</h2>
      <div class="cards-grid">

        <div class="guide-card highlight" data-keywords="주식 시장 국면 강세장 약세장 대폭락 황금비 버블">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">📈</span>
                <span class="card-name">5가지 시장 국면 (Market Regimes)</span>
              </div>
              <span class="card-badge gold">실시간 동적 변동</span>
            </div>
            <p class="card-desc">월덕 주식 시장은 뉴스 및 알고리즘에 의해 5가지 국면이 무작위 전환됩니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>🐂 강세장 (Bull)</strong>: 주가 급등 확률 +30%, 전 종목 호재 빈발.</li>
                <li><strong>🐻 약세장 (Bear)</strong>: 주가 하락 및 거래량 축소.</li>
                <li><strong>💥 대폭락장 (Crash)</strong>: 서킷브레이커 발동 및 저가 매수 찬스!</li>
                <li><strong>✨ 황금비 (Golden Era)</strong>: 주주 배당금 2배 및 거래세 50% 감면.</li>
                <li><strong>🎈 버블 (Bubble)</strong>: 주가 폭등 후 급격한 거품 붕괴 주의.</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">24개 주요 상장 기업</span>
            <a href="/" class="btn-play-mini">주식 시장 이동</a>
          </div>
        </div>

      </div>
    </section>

    <!-- 🏦 은행 & 세금 -->
    <section class="guide-section" data-cat="economy">
      <h2 class="section-title">🏦 은행 이자 · 대출 · 누진 자산세</h2>
      <div class="cards-grid">

        <div class="guide-card" data-keywords="은행 예금 이자 금리 시간당 대출 만기 담보">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🏦</span>
                <span class="card-name">은행 예금 & 담보 대출</span>
              </div>
              <span class="card-badge green">시간당 0.05% 이자</span>
            </div>
            <p class="card-desc">자산을 안전하게 보관하고 복리 이자를 받거나 담보 대출을 실행합니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>예금 이자</strong>: 시간당 0.05% (1분마다 분할 자동 지급).</li>
                <li><strong>담보 대출</strong>: 예금액의 50%까지 대출 (이자: 시간당 0.15%, 만기 24시간).</li>
                <li><strong>연체 주의</strong>: 만기 미상환 시 담보 예금이 자동 몰수됩니다.</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">안전한 자산 증식</span>
            <a href="/" class="btn-play-mini">은행 이용하기</a>
          </div>
        </div>

        <div class="guide-card" data-keywords="세금 자산세 거래세 국고 누진세">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">🏛️</span>
                <span class="card-name">누진 자산세 & 거래세</span>
              </div>
              <span class="card-badge">시중 통화량 조절</span>
            </div>
            <p class="card-desc">과도한 빈부격차 및 인플레이션을 방지하기 위해 자동 징수되는 세금 체계입니다.</p>
            <div class="card-rules">
              <ul>
                <li><strong>자산세</strong>: 고자산가의 유동 현금+예금에서 10분마다 최대 0.20% 자동 징수 (국고 흡수).</li>
                <li><strong>거래세</strong>: 주식 매매 및 유저간 송금 시 붙는 거래 세금.</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">건전한 가상 경제</span>
            <a href="/" class="btn-play-mini">내 세금 확인</a>
          </div>
        </div>

      </div>
    </section>

    <!-- 🤖 디스코드 봇 명령어 -->
    <section class="guide-section" data-cat="bot">
      <h2 class="section-title">🤖 디스코드 봇 핵심 슬래시 명령어</h2>
      <div class="cards-grid">
        <div class="guide-card" data-keywords="디스코드 봇 명령어 출석 지갑 주식 카지노 송금">
          <div>
            <div class="card-head">
              <div class="card-icon-title">
                <span class="card-icon">💬</span>
                <span class="card-name">디스코드 슬래시(/) 명령어</span>
              </div>
              <span class="card-badge gold">Discord 연동</span>
            </div>
            <p class="card-desc">디스코드 서버 채널에서 바로 실행할 수 있는 명령어 모음입니다.</p>
            <div class="card-rules">
              <ul>
                <li><code>/출석</code>: 매일 1회 무료 현금 지원금 수령</li>
                <li><code>/지갑</code>: 내 현금, 예금, 주식 평가액, 순자산 조회</li>
                <li><code>/주식 매수</code> / <code>/주식 매도</code>: 실시간 주식 거래</li>
                <li><code>/카지노 블랙잭</code> / <code>/카지노 슬롯</code>: 디스코드 내 즉시 베팅</li>
                <li><code>/은행 저금</code> / <code>/은행 인출</code>: 예금 관리</li>
              </ul>
            </div>
          </div>
          <div class="card-footer">
            <span class="card-stat">웹-디스코드 100% 동기화</span>
            <a href="/" class="btn-play-mini">대시보드로 가기</a>
          </div>
        </div>
      </div>
    </section>

    <footer class="guide-footer">
      <p>© 2026 월덕(WTRDD) 가상 경제 시스템 · 버전 ${getAppVersion()} (${getAppVersionLabel()})</p>
      <p style="margin-top: 6px;"><a href="/privacy">개인정보처리방침</a> · <a href="/terms">이용약관</a> · <a href="/auth/guide">OAuth 안내</a></p>
    </footer>
  </main>

  <script>
    let currentTab = 'all';

    function setTab(tab, btn) {
      currentTab = tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      filterGuides();
    }

    function filterGuides() {
      const query = (document.getElementById('guide-search').value || '').toLowerCase().trim();
      const sections = document.querySelectorAll('.guide-section');

      sections.forEach(sec => {
        const cat = sec.getAttribute('data-cat');
        const matchTab = (currentTab === 'all' || currentTab === cat);

        let visibleCards = 0;
        const cards = sec.querySelectorAll('.guide-card');
        cards.forEach(card => {
          const kw = (card.getAttribute('data-keywords') || '').toLowerCase();
          const text = card.innerText.toLowerCase();
          const matchSearch = !query || kw.includes(query) || text.includes(query);

          if (matchTab && matchSearch) {
            card.style.display = 'flex';
            visibleCards++;
          } else {
            card.style.display = 'none';
          }
        });

        sec.style.display = visibleCards > 0 ? 'block' : 'none';
      });
    }
  </script>
</body>
</html>`;
}

module.exports = { renderGuidePage };
