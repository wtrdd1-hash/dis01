(function () {
  if (window.__helpGuideInstalled) return;
  window.__helpGuideInstalled = true;

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }
  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function applyFilter() {
    const list = qs('#help-list');
    const empty = qs('#help-empty');
    if (!list) return;
    const q = String((qs('#help-search') || {}).value || '').trim().toLowerCase();
    const catBtn = qs('.help-chip.active');
    const cat = catBtn ? catBtn.getAttribute('data-help-cat') : 'all';
    let shown = 0;
    qsa('.help-card', list).forEach(function (card) {
      const cardCat = card.getAttribute('data-help-cat') || '';
      const hay = (card.getAttribute('data-help-search') || '').toLowerCase();
      const catOk = cat === 'all' || cardCat === cat;
      const qOk = !q || hay.indexOf(q) !== -1;
      const on = catOk && qOk;
      card.hidden = !on;
      if (on) shown += 1;
    });
    if (empty) empty.hidden = shown > 0;
  }

  function openCard(card, on) {
    if (!card) return;
    card.classList.toggle('open', on);
    const head = qs('.help-card-head', card);
    if (head) head.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  function bind() {
    const search = qs('#help-search');
    if (search) search.addEventListener('input', applyFilter);

    qsa('.help-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        qsa('.help-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        applyFilter();
      });
    });

    qsa('.help-card-head').forEach(function (head) {
      head.addEventListener('click', function () {
        const card = head.closest('.help-card');
        if (!card) return;
        const willOpen = !card.classList.contains('open');
        qsa('.help-card.open').forEach(function (other) {
          if (other !== card) openCard(other, false);
        });
        openCard(card, willOpen);
      });
    });

    qsa('.help-go').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        const tab = btn.getAttribute('data-help-tab');
        const action = btn.getAttribute('data-help-action');
        if (tab && typeof window.switchTab === 'function') window.switchTab(tab);
        if (action && typeof window[action] === 'function') window[action]();
      });
    });
  }

  function focusSearch() {
    const q = qs('#help-search');
    if (q) setTimeout(function () { q.focus(); }, 80);
  }

  const prevSwitch = window.switchTab;
  if (typeof prevSwitch === 'function') {
    window.switchTab = function (tabId) {
      prevSwitch(tabId);
      if (tabId === 'tab-help') focusSearch();
    };
  }

  document.addEventListener('keydown', function (e) {
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
    if (!typing && e.key === '?') {
      e.preventDefault();
      if (typeof window.switchTab === 'function') window.switchTab('tab-help');
      return;
    }
    if (document.body && document.body.dataset.tab === 'tab-help' && !typing && e.key === '/') {
      e.preventDefault();
      focusSearch();
    }
  });

  function boot() {
    bind();
    try {
      const params = new URLSearchParams(window.location.search);
      const hash = (window.location.hash || '').replace(/^#/, '');
      if (params.get('open') === 'help' || hash === 'help' || hash === 'tab-help') {
        if (typeof window.switchTab === 'function') window.switchTab('tab-help');
      } else if (document.body && document.body.dataset.tab === 'tab-help') {
        focusSearch();
      }
    } catch (err) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
