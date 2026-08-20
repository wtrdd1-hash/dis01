/**
 * 🧰 통합 클라이언트 헬퍼 (Browser-side SDK)
 *
 * 모든 페이지에서 일관된 동작을 제공합니다.
 * - 토스트 알림
 * - 모달
 * - 로딩 표시
 * - 확인 다이얼로그
 * - 에러 핸들링
 * - 키보드 네비게이션
 *
 * 로드 후 window.dx.* 로 접근
 */

(function() {
  if (window.dx) return;

  const dx = {};

  // ============== 토스트 알림 ==============
  function showToast(message, type = 'info', duration = 3500) {
    const existing = document.querySelectorAll('.dx-toast');
    existing.forEach(e => e.remove());
    const el = document.createElement('div');
    el.className = `dx-toast dx-toast--${type}`;
    const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '⚠' : 'ℹ';
    el.innerHTML = `<span style="font-size:18px;color:${type === 'success' ? '#34d399' : type === 'error' ? '#f87171' : type === 'warning' ? '#fbbf24' : '#38bdf8'};">${icon}</span><span style="flex:1;">${escapeHtml(message)}</span><button type="button" onclick="this.parentNode.remove()" style="background:none;border:none;color:#6b7280;cursor:pointer;font-size:18px;line-height:1;">×</button>`;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(40px)';
      setTimeout(() => el.remove(), 200);
    }, duration);
  }

  // ============== 모달 ==============
  function openModal(content, opts = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'dx-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const modal = document.createElement('div');
    modal.className = `dx-modal ${opts.wide ? 'dx-modal--wide' : ''} ${opts.size === 'auto' ? 'dx-modal--auto' : ''}`;
    modal.innerHTML = content;
    overlay.appendChild(modal);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
    const onEsc = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onEsc);

    function closeModal() {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener('keydown', onEsc);
      if (typeof opts.onClose === 'function') opts.onClose();
    }

    document.body.appendChild(overlay);
    modal.querySelectorAll('[data-dx-close]').forEach(b => b.addEventListener('click', closeModal));
    if (typeof opts.onOpen === 'function') opts.onOpen(modal, closeModal);
    return { modal, close: closeModal };
  }

  function closeModal() {
    document.querySelectorAll('.dx-modal-overlay').forEach(o => {
      o.style.opacity = '0';
      setTimeout(() => o.remove(), 200);
    });
  }

  // ============== 확인 다이얼로그 ==============
  function confirm(message, opts = {}) {
    return new Promise(resolve => {
      openModal(`
        <div class="dx-modal-header">
          <h3 class="dx-modal-title">${opts.title || '확인'}</h3>
        </div>
        <div class="dx-modal-body">
          <p style="margin:0;font-size:14px;line-height:1.6;color:#cbd5e1;">${escapeHtml(message)}</p>
        </div>
        <div class="dx-modal-footer">
          <button type="button" class="dx-btn dx-btn--ghost" data-dx-confirm-cancel>${opts.cancelText || '취소'}</button>
          <button type="button" class="dx-btn ${opts.danger ? 'dx-btn--danger' : 'dx-btn--primary'}" data-dx-confirm-ok>${opts.okText || '확인'}</button>
        </div>
      `, { size: 'auto', onClose: () => resolve(false) });
      document.querySelector('[data-dx-confirm-ok]').addEventListener('click', () => {
        document.querySelector('.dx-modal-overlay').remove();
        resolve(true);
      });
      document.querySelector('[data-dx-confirm-cancel]').addEventListener('click', () => {
        document.querySelector('.dx-modal-overlay').remove();
        resolve(false);
      });
    });
  }

  // ============== 로딩 표시 ==============
  function showLoading(target, message = '불러오는 중...') {
    if (typeof target === 'string') target = document.querySelector(target);
    if (!target) return null;
    if (target.__loadingEl) return target.__loadingEl;
    const el = document.createElement('div');
    el.className = 'dx-loading';
    el.innerHTML = `<span class="dx-spinner"></span> <span>${escapeHtml(message)}</span>`;
    el.style.minHeight = '120px';
    target.__loadingEl = el;
    target.appendChild(el);
    return el;
  }

  function hideLoading(target) {
    if (typeof target === 'string') target = document.querySelector(target);
    if (!target || !target.__loadingEl) return;
    target.__loadingEl.style.opacity = '0';
    setTimeout(() => {
      if (target.__loadingEl) {
        target.__loadingEl.remove();
        delete target.__loadingEl;
      }
    }, 200);
  }

  // ============== 빈 상태 ==============
  function showEmpty(target, options = {}) {
    if (typeof target === 'string') target = document.querySelector(target);
    if (!target) return;
    target.innerHTML = `
      <div class="dx-empty">
        <div class="dx-empty-icon">${options.icon || '📦'}</div>
        <div class="dx-empty-title">${escapeHtml(options.title || '데이터가 없습니다')}</div>
        <div class="dx-empty-subtitle">${escapeHtml(options.subtitle || '')}</div>
        ${options.action ? `<button type="button" class="dx-btn dx-btn--primary dx-mt-3" onclick="${escapeHtml(options.action.onclick || '')}">${escapeHtml(options.action.label || '새로 만들기')}</button>` : ''}
      </div>
    `;
  }

  // ============== 유틸 ==============
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatMoney(value) {
    if (value === null || value === undefined) return '0원';
    let s = String(value);
    if (s.includes('.')) s = s.split('.')[0];
    return Number(s).toLocaleString('ko-KR') + '원';
  }

  function formatNumber(value) {
    if (value === null || value === undefined) return '0';
    return Number(String(value).split('.')[0] || 0).toLocaleString('ko-KR');
  }

  async function fetchJSON(url, options = {}) {
    const opts = Object.assign({ credentials: 'same-origin', headers: {} }, options);
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, opts);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return { ok: res.ok, status: res.status, data: await res.json() };
    return { ok: res.ok, status: res.status, text: await res.text() };
  }

  // ============== 초기화 ==============
  function init() {
    // 부드러운 스크롤
    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener('click', e => {
        const t = document.querySelector(a.getAttribute('href'));
        if (t) {
          e.preventDefault();
          t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });

    // 모든 input/select 자동 label 연결
    document.querySelectorAll('[data-dx-label]').forEach(el => {
      const label = document.createElement('label');
      label.className = 'dx-label';
      label.textContent = el.getAttribute('data-dx-label');
      if (el.id) label.htmlFor = el.id;
      el.parentNode.insertBefore(label, el);
    });

    // document.body 에 dx-skeleton 자동 처리
    document.querySelectorAll('.dx-skeleton').forEach(el => el.classList.add('dx-skeleton-shimmer'));

    // 전역 키보드 단축키: ESC → 모달 닫기
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Export
  dx.showToast = showToast;
  dx.openModal = openModal;
  dx.closeModal = closeModal;
  dx.confirm = confirm;
  dx.showLoading = showLoading;
  dx.hideLoading = hideLoading;
  dx.showEmpty = showEmpty;
  dx.escapeHtml = escapeHtml;
  dx.formatMoney = formatMoney;
  dx.formatNumber = formatNumber;
  dx.fetchJSON = fetchJSON;

  window.dx = dx;
})();
