/**
 * 랜딩 페이지 뷰 (비로그인 사용자 대상)
 * 2026 모던 다크 테마 디자인 시스템 적용
 */
const { cssTag } = require('./assetUrl');

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCurrency(val) {
  if (val === null || val === undefined) return '0';
  const num = typeof val === 'bigint' ? Number(val) : Number(String(val).split('.')[0] || 0);
  if (isNaN(num)) return '0';
  return num.toLocaleString('ko-KR');
}

function renderTicker(stocks) {
  const safeStocks = Array.isArray(stocks) ? stocks.slice(0, 10) : [];
  if (safeStocks.length === 0) return '';

  const items = safeStocks.map(s => {
    const change = Number(s.change_pct || 0);
    const sign = change > 0 ? '+' : '';
    const badgeClass = change > 0 ? 'w-badge--up' : change < 0 ? 'w-badge--down' : '';
    return `
      <div class="w-ticker__item">
        <span class="w-ticker__symbol">${escapeHtml(s.stock_id || s.symbol || '')}</span>
        <span class="w-badge ${badgeClass} w-badge--sm">${sign}${change.toFixed(2)}%</span>
      </div>
    `;
  }).join('');

  return `
    <div class="w-ticker">
      <div class="w-ticker__track">
        ${items}
        ${items}
      </div>
    </div>
  `;
}

function renderNav(stocks, regime) {
  return `
    <nav class="w-landing__nav">
      <div class="w-landing__nav-brand">
        <div class="w-landing__nav-logo">🦆</div>
        <div class="w-landing__nav-title">
          <span>월덕</span>
          <span style="font-size:12px;color:var(--w-text-muted, #94a3b8);font-weight:normal;">(WTRD)</span>
        </div>
      </div>
      <div class="w-landing__nav-ticker">
        ${renderTicker(stocks)}
      </div>
      <div class="w-landing__nav-links">
        <a href="#markets" class="w-landing__nav-link">시세</a>
        <a href="#features" class="w-landing__nav-link">기능</a>
        <a href="/auth/guide" class="w-landing__nav-link">도움말</a>
        <a href="/auth/discord" onclick="openLoginModal(); return false;" class="w-btn w-btn--primary w-btn--sm">
          로그인 / 시작하기
        </a>
      </div>
    </nav>
  `;
}

function renderHero(treasuryBalance, stockCount, userCount) {
  const formattedTreasury = formatCurrency(treasuryBalance);
  const formattedUsers = (userCount || 158).toLocaleString('ko-KR');

  return `
    <section class="w-landing__hero">
      <div class="w-landing__hero-badge">
        <span>🚀</span>
        <span>디스코드 가상 경제 플랫폼</span>
      </div>
      <h1 class="w-landing__hero-title">디스코드 최대 규모의<br>가상 경제 & 거래 플랫폼</h1>
      <p class="w-landing__hero-subtitle">
        18개 상장 종목의 실시간 주식 거래, 자동 배당, 중앙은행 정책, 카지노/아케이드 게이밍까지.<br>
        Discord 계정 하나면 무료로 시작할 수 있습니다.
      </p>
      <a href="/auth/discord" onclick="openLoginModal(); return false;" class="w-landing__hero-cta">
        <span style="font-size:20px;">🎮</span>
        <span>Discord로 무료 시작</span>
        <span style="font-size:18px;">→</span>
      </a>

      <div class="w-landing__stats">
        <div class="w-landing__stat">
          <div class="w-landing__stat-num">${stockCount || 18}</div>
          <div class="w-landing__stat-label">상장 종목</div>
        </div>
        <div class="w-landing__stat">
          <div class="w-landing__stat-num">${formattedUsers}</div>
          <div class="w-landing__stat-label">활동 유저</div>
        </div>
        <div class="w-landing__stat">
          <div class="w-landing__stat-num">${formattedTreasury}</div>
          <div class="w-landing__stat-label">국고 잔액</div>
        </div>
        <div class="w-landing__stat">
          <div class="w-landing__stat-num">24/7</div>
          <div class="w-landing__stat-label">실시간 운영</div>
        </div>
      </div>
    </section>
  `;
}

function renderStockRow(stock) {
  const change = Number(stock.change_pct || 0);
  const sign = change > 0 ? '+' : '';
  const color = change > 0 ? 'var(--w-up)' : change < 0 ? 'var(--w-down)' : 'inherit';
  const badgeClass = change > 0 ? 'w-badge--up' : change < 0 ? 'w-badge--down' : '';

  return `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:18px;">${escapeHtml(stock.icon || '📈')}</span>
          <div>
            <div style="font-weight:600;">${escapeHtml(stock.name || stock.stock_id)}</div>
            <div style="font-size:11px;color:var(--w-text-muted);">${escapeHtml(stock.stock_id)}</div>
          </div>
        </div>
      </td>
      <td style="text-align:right;font-family:var(--w-font-mono);font-weight:600;">
        ${formatCurrency(stock.price)}원
      </td>
      <td style="text-align:right;">
        <span class="w-badge ${badgeClass}">${sign}${change.toFixed(2)}%</span>
      </td>
      <td style="text-align:right;font-family:var(--w-font-mono);color:var(--w-text-secondary);">
        ${formatCurrency(stock.volume || 0)}
      </td>
    </tr>
  `;
}

function renderLeaderboardRow(user, index) {
  const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}`;
  return `
    <li class="w-leaderboard__item">
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-weight:700;font-size:14px;width:24px;text-align:center;">${medal}</span>
        <div>
          <div style="font-weight:600;font-size:14px;">${escapeHtml(user.username || '익명')}</div>
          <div style="font-size:11px;color:var(--w-text-muted);">순자산</div>
        </div>
      </div>
      <div style="font-family:var(--w-font-mono);font-weight:700;color:var(--w-accent-glow);">
        ${formatCurrency(user.net_worth || user.cash || 0)}원
      </div>
    </li>
  `;
}

function renderMarkets(stocks, leaderboard, regime, news) {
  const topStocks = (stocks || []).slice(0, 6);
  const topUsers = (leaderboard || []).slice(0, 5);

  return `
    <section id="markets" class="w-landing__markets">
      <h2 class="w-landing__features-title">실시간 증시 & 랭킹</h2>
      <p class="w-landing__features-subtitle">디스코드 봇과 100% 동기화되는 실시간 경제 데이터</p>

      <div class="w-landing__markets-grid">
        <div class="w-card">
          <div class="w-card__head">
            <h3 class="w-card__title">주요 상장 종목</h3>
            <span class="w-badge w-badge--sm" style="background:rgba(99,102,241,0.2);color:var(--w-primary);">실시간</span>
          </div>
          <div class="w-card__body" style="padding:0;">
            <div style="overflow-x:auto;">
              <table class="w-table">
                <thead>
                  <tr>
                    <th>종목</th>
                    <th style="text-align:right;">현재가</th>
                    <th style="text-align:right;">변동률</th>
                    <th style="text-align:right;">거래량</th>
                  </tr>
                </thead>
                <tbody>
                  ${topStocks.map(renderStockRow).join('')}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="w-card">
          <div class="w-card__head">
            <h3 class="w-card__title">부자 순위 TOP 5</h3>
            <span class="w-badge w-badge--sm" style="background:rgba(234,179,8,0.2);color:var(--w-yellow);">명예의 전당</span>
          </div>
          <div class="w-card__body" style="padding:12px 16px;">
            <ul class="w-leaderboard">
              ${topUsers.map(renderLeaderboardRow).join('')}
            </ul>
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderFeatures() {
  return `
    <section id="features" class="w-landing__features">
      <h2 class="w-landing__features-title">왜 월덕인가요?</h2>
      <p class="w-landing__features-subtitle">디스코드 봇 하나로 즐기는 완벽한 경제 생태계</p>

      <div class="w-landing__features-grid">
        <div class="w-feature-card">
          <div class="w-feature-card__icon">📈</div>
          <h3 class="w-feature-card__title">18개 상장 종목 실시간 증시</h3>
          <p class="w-feature-card__desc">
            실제 주식 시장처럼 작동하는 주문 체결, 지정가 주문, 차트 분석, 배당 시스템을 지원합니다.
          </p>
        </div>

        <div class="w-feature-card">
          <div class="w-feature-card__icon">🎲</div>
          <h3 class="w-feature-card__title">합법적 카지노 & 아케이드</h3>
          <p class="w-feature-card__desc">
            블랙잭, 룰렛, 슬롯머신, 토토 베팅, 경마, 마인스위퍼 등 10종 이상의 미니게임을 제공합니다.
          </p>
        </div>

        <div class="w-feature-card">
          <div class="w-feature-card__icon">🏛️</div>
          <h3 class="w-feature-card__title">중앙은행 & 세금 정책</h3>
          <p class="w-feature-card__desc">
            유통량 조절, 소득세/부유세 자동 징수, 국고 지원금 분배로 인플레이션을 철저히 관리합니다.
          </p>
        </div>

        <div class="w-feature-card">
          <div class="w-feature-card__icon">⛏️</div>
          <h3 class="w-feature-card__title">자동 채굴 & 사업체 운영</h3>
          <p class="w-feature-card__desc">
            클리커 및 자동 채굴기를 업그레이드하고 사업체를 설립하여 오프라인 상태에서도 수익을 얻으세요.
          </p>
        </div>

        <div class="w-feature-card">
          <div class="w-feature-card__icon">💬</div>
          <h3 class="w-feature-card__title">실시간 광장 채팅</h3>
          <p class="w-feature-card__desc">
            웹과 디스코드 서버가 실시간으로 연결된 광장에서 다른 유저들과 소통하고 팁을 주고받으세요.
          </p>
        </div>

        <div class="w-feature-card">
          <div class="w-feature-card__icon">🎁</div>
          <h3 class="w-feature-card__title">10,000원 기본 정착금</h3>
          <p class="w-feature-card__desc">
            Discord로 로그인하면 즉시 1만 정착금이 지급됩니다. 무료 출석과 지원금으로 무한 성장 가능합니다.
          </p>
          <a href="/auth/discord" onclick="openLoginModal(); return false;" class="w-btn w-btn--primary" style="margin-top:16px;width:100%;text-align:center;display:block;">
            🎮 Discord로 시작
          </a>
        </div>
      </div>
    </section>
  `;
}

function renderLoginModal(discordLoginUrl) {
  return `
    <div id="wtrd-login-modal" class="w-modal-backdrop">
      <div class="w-modal">
        <div class="w-modal__head">
          <h3 class="w-modal__title">
            <span style="font-size:24px;">🔐</span>
            <span>Discord 로그인</span>
          </h3>
          <button type="button" class="w-modal__close" onclick="closeLoginModal()">×</button>
        </div>
        <div class="w-modal__body">
          <p style="color:var(--w-text-secondary);margin-bottom:16px;">
            디스코드 계정으로 로그인하면 다음이 가능합니다:
          </p>
          <ul style="margin:0 0 20px 20px;color:var(--w-text-secondary);line-height:1.8;">
            <li>월덕 가상 경제 전체 기능</li>
            <li>주식 거래, 카지노, 사업, 채굴</li>
            <li>다른 유저와 송금/채팅</li>
            <li>관리자 페이지 접근 (권한자)</li>
          </ul>
          <a href="${escapeHtml(discordLoginUrl)}" class="w-btn w-btn--primary w-btn--lg w-btn--block" style="text-align:center;display:block;">
            <span style="font-size:18px;">🎮</span>
            <span>Discord로 계속</span>
          </a>
          <p style="text-align:center;font-size:var(--w-text-xs);color:var(--w-text-muted);margin-top:12px;">
            처음 오셨나요? 새 Discord 계정 생성 →
            <a href="https://discord.com/register" target="_blank" rel="noopener">discord.com/register</a>
          </p>
        </div>
      </div>
    </div>
  `;
}

function renderClosingCta() {
  return `
    <section class="w-landing__features" style="text-align:center;padding-bottom:var(--w-space-9);">
      <div class="w-card" style="background:linear-gradient(135deg,rgba(99,102,241,0.1),rgba(168,85,247,0.1));border-color:rgba(99,102,241,0.3);">
        <h2 class="w-landing__features-title" style="margin-bottom:12px;">지금 바로 시작하세요</h2>
        <p style="color:var(--w-text-secondary);max-width:520px;margin:0 auto var(--w-space-5);">
          Discord 계정과 이메일만 있으면 됩니다. 1분 안에 정착금을 받고 거래를 시작할 수 있습니다.
        </p>
        <a href="/auth/discord" onclick="openLoginModal(); return false;" class="w-landing__hero-cta" style="display:inline-flex;">
          <span style="font-size:20px;">🎮</span>
          <span>무료로 시작하기</span>
        </a>
      </div>
    </section>
  `;
}

function renderFooter() {
  return `
    <footer style="border-top:1px solid var(--w-border);padding:var(--w-space-6);text-align:center;color:var(--w-text-muted);font-size:var(--w-text-sm);">
      <div style="max-width:1280px;margin:0 auto;">
        <p>© 2026 월덕 (WTRD) · 디스코드 가상 경제 플랫폼</p>
        <p style="margin-top:var(--w-space-2);font-size:var(--w-text-xs);">
          <a href="/privacy" style="color:var(--w-text-muted);text-decoration:underline;margin:0 var(--w-space-2);">개인정보처리방침</a> ·
          <a href="/auth/guide" style="color:var(--w-text-muted);text-decoration:underline;margin:0 var(--w-space-2);">OAuth 안내</a> ·
          <a href="/api/version" style="color:var(--w-text-muted);text-decoration:underline;margin:0 var(--w-space-2);">상태 확인</a>
        </p>
      </div>
    </footer>
  `;
}

function renderInlineScript(stocks, regime) {
  return `
    <script>
      // 모달 열기/닫기 전역 함수
      window.openLoginModal = function() {
        const modal = document.getElementById('wtrd-login-modal');
        if (modal) {
          modal.classList.add('is-open');
          modal.style.display = 'grid';
        }
      };

      window.closeLoginModal = function() {
        const modal = document.getElementById('wtrd-login-modal');
        if (modal) {
          modal.classList.remove('is-open');
          modal.style.display = 'none';
        }
      };

      // ESC 키로 모달 닫기
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          closeLoginModal();
        }
      });

      // 모달 배경 클릭으로 닫기
      document.addEventListener('click', function(e) {
        const modal = document.getElementById('wtrd-login-modal');
        if (modal && e.target === modal) {
          closeLoginModal();
        }
      });

      // 다크 테마 기본 활성화
      (function() {
        const saved = localStorage.getItem('wtrd-theme');
        if (saved) document.documentElement.setAttribute('data-theme', saved);
      })();
    </script>
  `;
}

function renderLandingPage(options) {
  const {
    stocks = [],
    leaderboard = [],
    regime = {},
    news = null,
    treasuryBalance = '0',
    discordLoginUrl = '/auth/discord'
  } = options;

  const memberCount = (leaderboard && leaderboard.length > 0) ? Math.max(...leaderboard.map(u => Number(u.net_worth || u.cash || 0))) : 158;

  return `<!DOCTYPE html>
<html lang="ko" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>월덕 (WTRD) - 디스코드 가상 경제 플랫폼</title>
  <meta name="description" content="디스코드 최대 규모의 실시간 가상 경제. 18개 상장 종목 실시간 주식 거래, 자동 배당, 카지노/아케이드, 중앙은행 정책까지.">
  <meta property="og:title" content="월덕 (WTRD) - 가상 경제 플랫폼">
  <meta property="og:description" content="디스코드에서 무료로 시작하는 가상 경제 시스템">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🦆</text></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@600;700;800&family=Noto+Sans+KR:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
  ${cssTag('css/wtrd-design.css')}
  ${cssTag('css/dashboard-ux.css')}
  <style>
    body { font-family: var(--w-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif); margin: 0; padding: 0; background: #0b0f19; color: #f8fafc; }
    .w-landing__nav {
      position: relative;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 24px;
      max-width: 1280px;
      margin: 0 auto;
    }
    .w-landing__nav-brand {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 1.125rem;
      font-weight: 800;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .w-landing__nav-logo { font-size: 24px; }
    .w-landing__nav-title {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .w-landing__nav-ticker {
      flex: 1;
      max-width: 550px;
      overflow: hidden;
      min-width: 0;
      margin: 0 12px;
    }
    .w-landing__nav-links {
      display: flex;
      align-items: center;
      gap: 16px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .w-landing__nav-link {
      color: #94a3b8;
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      transition: color 0.15s ease;
    }
    .w-landing__nav-link:hover { color: #f8fafc; }
    .w-ticker {
      overflow: hidden;
      position: relative;
      white-space: nowrap;
      width: 100%;
      mask-image: linear-gradient(to right, transparent, black 8%, black 92%, transparent);
      -webkit-mask-image: linear-gradient(to right, transparent, black 8%, black 92%, transparent);
      display: flex;
      align-items: center;
    }
    .w-ticker__track {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      animation: wTickerScroll 25s linear infinite;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .w-ticker__track:hover {
      animation-play-state: paused;
    }
    .w-ticker__item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 9999px;
      padding: 3px 10px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .w-ticker__symbol {
      color: #94a3b8;
      font-family: monospace, var(--w-font-mono);
      font-weight: 700;
    }
    .w-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      font-family: monospace, var(--w-font-mono);
    }
    .w-badge--up {
      background: rgba(34, 197, 94, 0.15);
      color: #22c55e;
    }
    .w-badge--down {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
    }
    .w-badge--sm {
      font-size: 11px;
      padding: 1px 5px;
    }
    @keyframes wTickerScroll {
      0% { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }
    @media (max-width: 850px) {
      .w-landing__nav-ticker { display: none !important; }
    }
    .w-modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 9999;
      place-items: center;
      padding: 20px;
    }
    .w-modal-backdrop.is-open {
      display: grid !important;
    }
    .w-modal {
      background: #0f172a;
      border: 1px solid rgba(99, 102, 241, 0.35);
      border-radius: 16px;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 20px 40px rgba(0,0,0,0.8);
      overflow: hidden;
    }
    .w-modal__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .w-modal__title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 1.15rem;
      font-weight: 700;
      color: #f8fafc;
    }
    .w-modal__close {
      background: none;
      border: none;
      color: #94a3b8;
      font-size: 24px;
      cursor: pointer;
    }
    .w-modal__close:hover {
      color: #fff;
    }
    .w-modal__body {
      padding: 20px;
    }
  </style>
</head>
<body>
  <div class="w-landing">
    <div class="w-landing__bg"></div>
    ${renderNav(stocks, regime)}
    ${renderHero(treasuryBalance, (stocks || []).length, memberCount)}
    ${renderMarkets(stocks.map(s => ({ ...s, treasuryBalance })), leaderboard, regime, news)}
    ${renderFeatures()}
    ${renderClosingCta()}
    ${renderFooter()}
    ${renderLoginModal(discordLoginUrl)}
  </div>
  ${renderInlineScript(stocks, regime)}
</body>
</html>`;
}

module.exports = { renderLandingPage };
