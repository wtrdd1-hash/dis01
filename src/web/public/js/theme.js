(function () {
  var KEYS = {
    theme: 'wtrdd-theme',
    density: 'wtrdd-density',
    layout: 'wtrdd-layout',
    ticker: 'wtrdd-ticker',
    floatChat: 'wtrdd-float-chat'
  };
  var THEME_COLORS = {
    dark: '#1e1f22',
    light: '#ffffff',
    midnight: '#000000',
    gold: '#16120a',
    market: '#ffffff'
  };

  function read(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {}
  }

  function resolveTheme(pref) {
    if (pref === 'system') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    }
    return pref;
  }

  function current() {
    return {
      theme: read(KEYS.theme, 'system'),
      density: read(KEYS.density, 'cozy'),
      layout: read(KEYS.layout, 'default'),
      ticker: read(KEYS.ticker, 'on'),
      floatChat: read(KEYS.floatChat, 'on')
    };
  }

  function applyAll(next) {
    var pref = next.theme;
    var resolved = resolveTheme(pref);
    var root = document.documentElement;
    root.setAttribute('data-theme-pref', pref);
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-density', next.density);
    root.setAttribute('data-layout', next.layout);
    root.setAttribute('data-ticker', next.ticker);
    root.setAttribute('data-float-chat', next.floatChat);
    root.style.colorScheme = (resolved === 'light' || resolved === 'market') ? 'light' : 'dark';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[resolved] || THEME_COLORS.dark);
    syncUi();
  }

  function apply(pref, density, layout) {
    var cur = current();
    applyAll({
      theme: pref,
      density: density,
      layout: layout,
      ticker: cur.ticker,
      floatChat: cur.floatChat
    });
  }

  function setTheme(pref) {
    write(KEYS.theme, pref);
    var cur = current();
    applyAll(cur);
  }

  function setDensity(density) {
    write(KEYS.density, density);
    applyAll(current());
  }

  function setLayout(layout) {
    write(KEYS.layout, layout);
    applyAll(current());
  }

  function setTicker(on) {
    write(KEYS.ticker, on ? 'on' : 'off');
    applyAll(current());
  }

  function setFloatChat(on) {
    write(KEYS.floatChat, on ? 'on' : 'off');
    applyAll(current());
  }

  function syncUi() {
    var root = document.getElementById('settings-root');
    if (!root) return;
    var cur = current();
    root.querySelectorAll('[data-theme-opt]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-theme-opt') === cur.theme);
    });
    root.querySelectorAll('[data-density-opt]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-density-opt') === cur.density);
    });
    root.querySelectorAll('[data-layout-opt]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-layout-opt') === cur.layout);
    });
    var ticker = root.querySelector('[data-ticker-opt]');
    if (ticker) ticker.setAttribute('aria-checked', cur.ticker === 'on' ? 'true' : 'false');
    var floatChat = root.querySelector('[data-float-chat-opt]');
    if (floatChat) floatChat.setAttribute('aria-checked', cur.floatChat === 'on' ? 'true' : 'false');
  }

  function showSection(section) {
    var root = document.getElementById('settings-root');
    if (!root) return;
    var id = section === 'appearance' ? 'appearance' : 'interface';
    root.querySelectorAll('[data-settings-nav]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-settings-nav') === id);
    });
    root.querySelectorAll('[data-settings-pane]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-settings-pane') === id);
    });
  }

  function isOpen() {
    var root = document.getElementById('settings-root');
    return !!(root && root.classList.contains('open'));
  }

  function openSettings(section) {
    var profile = document.getElementById('profile-modal');
    if (profile) profile.style.display = 'none';
    var root = document.getElementById('settings-root');
    var btn = document.getElementById('btn-appearance');
    if (!root) return;
    root.classList.add('open');
    if (btn) btn.setAttribute('aria-expanded', 'true');
    showSection(section || 'interface');
    syncUi();
  }

  function closeSettings() {
    var root = document.getElementById('settings-root');
    var btn = document.getElementById('btn-appearance');
    if (!root) return;
    root.classList.remove('open');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function settingsHtml() {
    return ''
      + '<div class="settings-shell" role="dialog" aria-modal="true" aria-label="사용자 설정">'
      + '  <aside class="settings-nav">'
      + '    <div class="settings-nav-k">사용자 설정</div>'
      + '    <button type="button" class="settings-nav-item" data-settings-nav="appearance">모양</button>'
      + '    <button type="button" class="settings-nav-item" data-settings-nav="interface">인터페이스</button>'
      + '    <div class="settings-nav-k">앱</div>'
      + '    <button type="button" class="settings-nav-exit" data-settings-close>나가기</button>'
      + '  </aside>'
      + '  <div class="settings-main">'
      + '    <button type="button" class="settings-esc" data-settings-close title="닫기">ESC</button>'
      + '    <section class="settings-pane" data-settings-pane="appearance">'
      + '      <h2>모양</h2>'
      + '      <p class="settings-lead">화면 색만 바꿉니다. 시세의 상승 빨강·하락 파랑은 그대로입니다.</p>'
      + '      <div class="appearance-sec">'
      + '        <div class="appearance-sec-title">테마</div>'
      + '        <div class="theme-grid">'
      + '          <button type="button" class="theme-opt" data-theme-opt="system"><span class="theme-swatch"><i></i><i></i><i></i></span><b>시스템</b><span>기기 설정</span></button>'
      + '          <button type="button" class="theme-opt" data-theme-opt="dark"><span class="theme-swatch"><i></i><i></i><i></i></span><b>다크</b><span>디스코드</span></button>'
      + '          <button type="button" class="theme-opt" data-theme-opt="light"><span class="theme-swatch"><i></i><i></i><i></i></span><b>화이트</b><span>밝은 화면</span></button>'
      + '          <button type="button" class="theme-opt" data-theme-opt="midnight"><span class="theme-swatch"><i></i><i></i><i></i></span><b>미드나잇</b><span>OLED</span></button>'
      + '          <button type="button" class="theme-opt" data-theme-opt="gold"><span class="theme-swatch"><i></i><i></i><i></i></span><b>월덕 골드</b><span>카지노</span></button>'
      + '          <button type="button" class="theme-opt" data-theme-opt="market"><span class="theme-swatch"><i></i><i></i><i></i></span><b>시세</b><span>업비트형</span></button>'
      + '        </div>'
      + '      </div>'
      + '    </section>'
      + '    <section class="settings-pane" data-settings-pane="interface">'
      + '      <h2>인터페이스</h2>'
      + '      <p class="settings-lead">GUI 모드와 밀도, 화면에 둘 요소를 고릅니다. 선택은 이 브라우저에 저장됩니다.</p>'
      + '      <div class="appearance-sec">'
      + '        <div class="appearance-sec-title">GUI 모드</div>'
      + '        <div class="iface-grid">'
      + '          <button type="button" class="iface-opt" data-layout-opt="default"><span class="iface-preview default"><span></span><span></span><span></span><span></span></span><span><b>Discord형</b><span>채널 + 본문 + 자산 레일</span></span></button>'
      + '          <button type="button" class="iface-opt" data-layout-opt="focus"><span class="iface-preview focus"><span></span><span></span><span></span></span><span><b>시세 집중</b><span>자산 레일을 접고 시세·주문을 넓힘. 자산은 상단 ₩</span></span></button>'
      + '          <button type="button" class="iface-opt" data-layout-opt="wide"><span class="iface-preview wide"><span></span><span></span><span></span><span></span></span><span><b>와이드 트레이딩</b><span>주문창을 넓힌 거래 화면</span></span></button>'
      + '        </div>'
      + '      </div>'
      + '      <div class="appearance-sec">'
      + '        <div class="appearance-sec-title">밀도</div>'
      + '        <div class="density-row">'
      + '          <button type="button" class="iface-opt" data-density-opt="cozy"><span><b>편안</b><span>지금과 같은 간격</span></span></button>'
      + '          <button type="button" class="iface-opt" data-density-opt="compact"><span><b>밀도</b><span>시세표처럼 촘촘하게</span></span></button>'
      + '        </div>'
      + '      </div>'
      + '      <div class="appearance-sec">'
      + '        <div class="appearance-sec-title">화면 요소</div>'
      + '        <div class="settings-row"><div><b>LIVE 당첨 티커</b><span>본문 위 카지노 당첨 소식</span></div><button type="button" class="settings-switch" data-ticker-opt role="switch" aria-label="LIVE 당첨 티커"></button></div>'
      + '        <div class="settings-row"><div><b>플로팅 광장 버튼</b><span>오른쪽 아래 빠른 채팅 버튼</span></div><button type="button" class="settings-switch" data-float-chat-opt role="switch" aria-label="플로팅 광장 버튼"></button></div>'
      + '        <p class="appearance-hint">상승은 빨강, 하락은 파랑입니다.</p>'
      + '      </div>'
      + '    </section>'
      + '  </div>'
      + '</div>';
  }

  function mount() {
    if (document.getElementById('settings-root')) return;
    var wrap = document.createElement('div');
    wrap.id = 'settings-root';
    wrap.className = 'settings-root';
    wrap.innerHTML = settingsHtml();
    document.body.appendChild(wrap);

    wrap.addEventListener('click', function (e) {
      var t = e.target.closest('[data-settings-close], [data-settings-nav], [data-theme-opt], [data-layout-opt], [data-density-opt], [data-ticker-opt], [data-float-chat-opt]');
      if (!t) return;
      if (t.hasAttribute('data-settings-close')) {
        closeSettings();
        return;
      }
      if (t.hasAttribute('data-settings-nav')) {
        showSection(t.getAttribute('data-settings-nav'));
        return;
      }
      if (t.hasAttribute('data-theme-opt')) setTheme(t.getAttribute('data-theme-opt'));
      if (t.hasAttribute('data-layout-opt')) setLayout(t.getAttribute('data-layout-opt'));
      if (t.hasAttribute('data-density-opt')) setDensity(t.getAttribute('data-density-opt'));
      if (t.hasAttribute('data-ticker-opt')) setTicker(t.getAttribute('aria-checked') !== 'true');
      if (t.hasAttribute('data-float-chat-opt')) setFloatChat(t.getAttribute('aria-checked') !== 'true');
    });

    var btn = document.getElementById('btn-appearance');
    if (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (isOpen()) closeSettings();
        else openSettings('appearance');
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen()) {
        e.preventDefault();
        closeSettings();
      }
    });

    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var onChange = function () {
        var cur = current();
        if (cur.theme === 'system') applyAll(cur);
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    syncUi();
  }

  var boot = current();
  applyAll(boot);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.openUserSettings = function (section) {
    openSettings(section || 'interface');
  };

  window.WtrddTheme = {
    apply: apply,
    applyAll: applyAll,
    setTheme: setTheme,
    setDensity: setDensity,
    setLayout: setLayout,
    setTicker: setTicker,
    setFloatChat: setFloatChat,
    current: current,
    openSettings: openSettings,
    closeSettings: closeSettings
  };
})();
