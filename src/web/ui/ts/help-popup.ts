const STORAGE_KEY = 'duck_help_win';
const MIN_W = 300;
const MIN_H = 220;
const BAR_H = 44;
const OP_MIN = 40;
const OP_MAX = 100;
const OP_DEF = 85;

type HelpState = {
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed: boolean;
  opacity: number;
  open: boolean;
};

type DragKind = 'move' | 'resize';

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function centerBox(w: number, h: number): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(8, Math.round((vw - w) / 2)),
    y: Math.max(8, Math.round((vh - h) / 2))
  };
}

function defaultState(): HelpState {
  const w = clamp(Math.round(window.innerWidth * 0.52), MIN_W, Math.max(MIN_W, window.innerWidth - 16));
  const h = clamp(Math.round(window.innerHeight * 0.62), MIN_H, Math.max(MIN_H, window.innerHeight - 16));
  const c = centerBox(w, h);
  return { x: c.x, y: c.y, w, h, collapsed: false, opacity: OP_DEF, open: false };
}

function loadState(): HelpState {
  const base = defaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const p = JSON.parse(raw);
    return {
      x: Number(p.x) || base.x,
      y: Number(p.y) || base.y,
      w: Number(p.w) || base.w,
      h: Number(p.h) || base.h,
      collapsed: !!p.collapsed,
      opacity: clamp(Number(p.opacity) || OP_DEF, OP_MIN, OP_MAX),
      open: !!p.open
    };
  } catch (e) {
    return base;
  }
}

function saveState(s: HelpState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch (e) {}
}

function gsapTween(el: HTMLElement, vars: Record<string, unknown>): void {
  const g = (window as unknown as { gsap?: { fromTo: Function } }).gsap;
  if (g && typeof g.fromTo === 'function') {
    g.fromTo(el, vars.from || {}, Object.assign({ duration: 0.22, ease: 'power2.out' }, vars.to || vars));
    return;
  }
  el.style.transform = 'none';
}

class HelpWindow {
  root: HTMLElement;
  win: HTMLElement;
  body: HTMLElement;
  opacityInput: HTMLInputElement;
  opacityVal: HTMLElement;
  minBtn: HTMLButtonElement;
  state: HelpState;
  loaded = false;
  drag: { kind: DragKind; edge: string; sx: number; sy: number; x: number; y: number; w: number; h: number } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.win = root.querySelector('.wui-help__win') as HTMLElement;
    this.body = root.querySelector('#wui-help-body') as HTMLElement;
    this.opacityInput = root.querySelector('#wui-help-opacity') as HTMLInputElement;
    this.opacityVal = root.querySelector('#wui-help-opacity-val') as HTMLElement;
    this.minBtn = root.querySelector('#wui-help-min') as HTMLButtonElement;
    this.state = loadState();
    this.bind();
    this.apply(false);
    if (this.state.open) this.open();
  }

  bind(): void {
    this.root.querySelector('#wui-help-close')?.addEventListener('click', () => this.close());
    this.minBtn?.addEventListener('click', () => this.toggleCollapse());
    this.opacityInput?.addEventListener('input', () => {
      this.state.opacity = clamp(Number(this.opacityInput.value) || OP_DEF, OP_MIN, OP_MAX);
      this.applyOpacity();
      saveState(this.state);
    });
    this.opacityInput?.addEventListener('pointerdown', (e) => e.stopPropagation());

    const bar = this.root.querySelector('[data-drag="1"]') as HTMLElement;
    bar?.addEventListener('pointerdown', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, button, label')) return;
      this.beginDrag('move', '', e);
    });

    this.root.querySelectorAll('[data-resize]').forEach((el) => {
      el.addEventListener('pointerdown', (e) => {
        this.beginDrag('resize', el.getAttribute('data-resize') || '', e as PointerEvent);
      });
    });

    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', () => this.endDrag());
    window.addEventListener('resize', () => {
      this.keepInView();
      this.apply(false);
    });

    document.addEventListener('keydown', (e) => {
      const tag = ((e.target as HTMLElement)?.tagName || '').toUpperCase();
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      if (!typing && e.key === '?') {
        e.preventDefault();
        this.toggle();
        return;
      }
      if (this.state.open && !this.state.collapsed && !typing && e.key === '/') {
        const q = document.getElementById('help-search') as HTMLInputElement | null;
        if (q) {
          e.preventDefault();
          q.focus();
        }
      }
      if (this.state.open && e.key === 'Escape') this.close();
    });

    document.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('.help-go') as HTMLElement | null;
      if (!btn) return;
      const tab = btn.getAttribute('data-help-tab');
      const action = btn.getAttribute('data-help-action');
      if (tab && typeof (window as any).switchTab === 'function') (window as any).switchTab(tab);
      if (action && typeof (window as any)[action] === 'function') (window as any)[action]();
    });

    const onHelpSwap = (ev: Event) => {
      const t = (ev as any).detail?.target;
      if (t && t.id === 'wui-help-body') this.afterContent();
    };
    this.body.addEventListener('htmx:afterSwap', onHelpSwap);
    document.body.addEventListener('htmx:afterSwap', onHelpSwap);
  }

  beginDrag(kind: DragKind, edge: string, e: PointerEvent): void {
    e.preventDefault();
    this.drag = {
      kind,
      edge,
      sx: e.clientX,
      sy: e.clientY,
      x: this.state.x,
      y: this.state.y,
      w: this.state.w,
      h: this.state.h
    };
  }

  onMove(e: PointerEvent): void {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.sx;
    const dy = e.clientY - this.drag.sy;
    if (this.drag.kind === 'move') {
      this.state.x = this.drag.x + dx;
      this.state.y = this.drag.y + dy;
    } else {
      this.resizeBy(this.drag.edge, dx, dy);
    }
    this.keepInView();
    this.apply(false);
  }

  resizeBy(edge: string, dx: number, dy: number): void {
    const start = this.drag;
    if (!start) return;
    let { x, y, w, h } = start;
    const collapsed = this.state.collapsed;
    if (edge.indexOf('e') !== -1) w = start.w + dx;
    if (edge.indexOf('w') !== -1) {
      w = start.w - dx;
      x = start.x + dx;
    }
    if (!collapsed) {
      if (edge.indexOf('s') !== -1) h = start.h + dy;
      if (edge.indexOf('n') !== -1) {
        h = start.h - dy;
        y = start.y + dy;
      }
    }
    const maxW = window.innerWidth - 8;
    const maxH = window.innerHeight - 8;
    w = clamp(w, MIN_W, maxW);
    if (!collapsed) h = clamp(h, MIN_H, maxH);
    if (edge.indexOf('w') !== -1) x = start.x + (start.w - w);
    if (!collapsed && edge.indexOf('n') !== -1) y = start.y + (start.h - h);
    this.state.x = x;
    this.state.y = y;
    this.state.w = w;
    if (!collapsed) this.state.h = h;
  }

  endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    saveState(this.state);
  }

  keepInView(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.state.w = clamp(this.state.w, MIN_W, Math.max(MIN_W, vw - 8));
    this.state.h = clamp(this.state.h, MIN_H, Math.max(MIN_H, vh - 8));
    const visH = this.state.collapsed ? BAR_H : this.state.h;
    this.state.x = clamp(this.state.x, 4, Math.max(4, vw - this.state.w - 4));
    this.state.y = clamp(this.state.y, 4, Math.max(4, vh - visH - 4));
  }

  applyOpacity(): void {
    const pct = clamp(this.state.opacity, OP_MIN, OP_MAX);
    this.win.style.opacity = String(pct / 100);
    if (this.opacityInput) this.opacityInput.value = String(pct);
    if (this.opacityVal) this.opacityVal.textContent = pct + '%';
  }

  apply(animate: boolean): void {
    this.keepInView();
    const visH = this.state.collapsed ? BAR_H : this.state.h;
    this.win.style.left = this.state.x + 'px';
    this.win.style.top = this.state.y + 'px';
    this.win.style.width = this.state.w + 'px';
    this.win.style.height = visH + 'px';
    this.win.classList.toggle('is-collapsed', this.state.collapsed);
    if (this.minBtn) {
      this.minBtn.textContent = this.state.collapsed ? '+' : '−';
      this.minBtn.title = this.state.collapsed ? '펼치기' : '접기';
    }
    this.applyOpacity();
    if (animate) {
      gsapTween(this.win, { from: { scale: 0.94, y: 12 }, to: { scale: 1, y: 0 } });
    }
  }

  loadContent(): void {
    if (this.loaded && this.body && this.body.innerHTML.trim()) return;
    document.body.dispatchEvent(new CustomEvent('wui-help-open'));
    const htmx = (window as any).htmx;
    if (htmx && typeof htmx.trigger === 'function') {
      htmx.trigger(document.body, 'wui-help-open');
      this.loaded = true;
      return;
    }
    if (!this.body.innerHTML.trim()) {
      fetch('/partials/help', { headers: { 'HX-Request': 'true' } })
        .then((r) => r.text())
        .then((html) => {
          this.body.innerHTML = html;
          this.afterContent();
        })
        .catch(() => {
          this.body.innerHTML = '<p class="help-note">도움말을 불러오지 못했습니다. 잠시 후 다시 열어 주세요.</p>';
        });
    }
    this.loaded = true;
  }

  afterContent(): void {
    const alpine = (window as any).Alpine;
    if (alpine && this.body && typeof alpine.initTree === 'function') {
      alpine.initTree(this.body);
    }
    const q = document.getElementById('help-search') as HTMLInputElement | null;
    if (q) setTimeout(() => q.focus(), 80);
  }

  open(): void {
    this.state.open = true;
    this.root.hidden = false;
    this.apply(true);
    this.loadContent();
    saveState(this.state);
  }

  close(): void {
    this.state.open = false;
    this.root.hidden = true;
    saveState(this.state);
  }

  toggle(): void {
    if (this.state.open) this.close();
    else this.open();
  }

  toggleCollapse(): void {
    this.state.collapsed = !this.state.collapsed;
    this.apply(false);
    saveState(this.state);
  }
}

function registerAlpine(): void {
  const Alpine = (window as any).Alpine;
  if (!Alpine || Alpine.__helpGuide) return;
  Alpine.__helpGuide = true;
  Alpine.data('helpGuide', () => ({
    q: '',
    cat: 'all',
    noneVisible: false,
    setCat(cat: string) {
      this.cat = cat;
      const root = (this as any).$root as HTMLElement;
      root.querySelectorAll('.help-chip').forEach((chip: Element) => {
        chip.classList.toggle('active', chip.getAttribute('data-help-cat') === cat);
      });
      this.filter();
    },
    toggleCard(btn: HTMLElement) {
      const card = btn.closest('.help-card');
      if (!card) return;
      const open = !card.classList.contains('open');
      card.closest('.help-list')?.querySelectorAll('.help-card.open').forEach((other) => {
        if (other !== card) {
          other.classList.remove('open');
          other.querySelector('.help-card-head')?.setAttribute('aria-expanded', 'false');
        }
      });
      card.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    },
    filter() {
      const root = (this as any).$root as HTMLElement;
      const q = String(this.q || '').trim().toLowerCase();
      let shown = 0;
      root.querySelectorAll('.help-card').forEach((card: Element) => {
        const cat = card.getAttribute('data-help-cat') || '';
        const hay = (card.getAttribute('data-help-search') || '').toLowerCase();
        const ok = (this.cat === 'all' || cat === this.cat) && (!q || hay.indexOf(q) !== -1);
        (card as HTMLElement).hidden = !ok;
        if (ok) shown += 1;
      });
      this.noneVisible = shown === 0;
    }
  }));
}

function boot(): void {
  registerAlpine();
  const root = document.getElementById('wui-help');
  if (!root) return;
  const inst = new HelpWindow(root);
  (window as any).WuiHelp = {
    open: () => inst.open(),
    close: () => inst.close(),
    toggle: () => inst.toggle()
  };
  try {
    const params = new URLSearchParams(window.location.search);
    const hash = (window.location.hash || '').replace(/^#/, '');
    let savedTab = '';
    try { savedTab = localStorage.getItem('duck_active_tab') || ''; } catch (e2) {}
    if (params.get('open') === 'help' || hash === 'help' || hash === 'tab-help' || savedTab === 'tab-help') {
      inst.open();
      if (savedTab === 'tab-help') {
        try { localStorage.setItem('duck_active_tab', 'tab-stocks'); } catch (e3) {}
      }
    }
  } catch (e) {}
}

document.addEventListener('alpine:init', registerAlpine);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
