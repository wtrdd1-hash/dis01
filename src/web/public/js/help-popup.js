/* compiled from src/web/ui/ts/help-popup.ts */
(function () {
  'use strict';
  var STORAGE_KEY = 'duck_help_win';
  var MIN_W = 300;
  var MIN_H = 220;
  var BAR_H = 44;
  var OP_MIN = 40;
  var OP_MAX = 100;
  var OP_DEF = 85;

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function centerBox(w, h) {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    return {
      x: Math.max(8, Math.round((vw - w) / 2)),
      y: Math.max(8, Math.round((vh - h) / 2))
    };
  }

  function defaultState() {
    var w = clamp(Math.round(window.innerWidth * 0.52), MIN_W, Math.max(MIN_W, window.innerWidth - 16));
    var h = clamp(Math.round(window.innerHeight * 0.62), MIN_H, Math.max(MIN_H, window.innerHeight - 16));
    var c = centerBox(w, h);
    return { x: c.x, y: c.y, w: w, h: h, collapsed: false, opacity: OP_DEF, open: false };
  }

  function loadState() {
    var base = defaultState();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      var p = JSON.parse(raw);
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

  function saveState(s) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch (e) {}
  }

  function gsapTween(el, vars) {
    var g = window.gsap;
    if (g && typeof g.fromTo === 'function') {
      g.fromTo(el, vars.from || {}, Object.assign({ duration: 0.22, ease: 'power2.out' }, vars.to || vars));
      return;
    }
    el.style.transform = 'none';
  }

  function HelpWindow(root) {
    this.root = root;
    this.win = root.querySelector('.wui-help__win');
    this.body = root.querySelector('#wui-help-body');
    this.opacityInput = root.querySelector('#wui-help-opacity');
    this.opacityVal = root.querySelector('#wui-help-opacity-val');
    this.minBtn = root.querySelector('#wui-help-min');
    this.state = loadState();
    this.loaded = false;
    this.drag = null;
    this.bind();
    this.apply(false);
    if (this.state.open) this.open();
  }

  HelpWindow.prototype.bind = function () {
    var self = this;
    var closeBtn = this.root.querySelector('#wui-help-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { self.close(); });
    if (this.minBtn) this.minBtn.addEventListener('click', function () { self.toggleCollapse(); });
    if (this.opacityInput) {
      this.opacityInput.addEventListener('input', function () {
        self.state.opacity = clamp(Number(self.opacityInput.value) || OP_DEF, OP_MIN, OP_MAX);
        self.applyOpacity();
        saveState(self.state);
      });
      this.opacityInput.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    }

    var bar = this.root.querySelector('[data-drag="1"]');
    if (bar) {
      bar.addEventListener('pointerdown', function (e) {
        var t = e.target;
        if (t.closest && t.closest('input, button, label')) return;
        self.beginDrag('move', '', e);
      });
    }

    this.root.querySelectorAll('[data-resize]').forEach(function (el) {
      el.addEventListener('pointerdown', function (e) {
        self.beginDrag('resize', el.getAttribute('data-resize') || '', e);
      });
    });

    window.addEventListener('pointermove', function (e) { self.onMove(e); });
    window.addEventListener('pointerup', function () { self.endDrag(); });
    window.addEventListener('resize', function () {
      self.keepInView();
      self.apply(false);
    });

    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName ? e.target.tagName : '').toUpperCase();
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
      if (!typing && e.key === '?') {
        e.preventDefault();
        self.toggle();
        return;
      }
      if (self.state.open && !self.state.collapsed && !typing && e.key === '/') {
        var q = document.getElementById('help-search');
        if (q) {
          e.preventDefault();
          q.focus();
        }
      }
      if (self.state.open && e.key === 'Escape') self.close();
    });

    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.help-go') : null;
      if (!btn) return;
      var tab = btn.getAttribute('data-help-tab');
      var action = btn.getAttribute('data-help-action');
      if (tab && typeof window.switchTab === 'function') window.switchTab(tab);
      if (action && typeof window[action] === 'function') window[action]();
    });

    function onHelpSwap(ev) {
      var t = ev.detail && ev.detail.target;
      if (t && t.id === 'wui-help-body') self.afterContent();
    }
    this.body.addEventListener('htmx:afterSwap', onHelpSwap);
    document.body.addEventListener('htmx:afterSwap', onHelpSwap);
  };

  HelpWindow.prototype.beginDrag = function (kind, edge, e) {
    e.preventDefault();
    this.drag = {
      kind: kind,
      edge: edge,
      sx: e.clientX,
      sy: e.clientY,
      x: this.state.x,
      y: this.state.y,
      w: this.state.w,
      h: this.state.h
    };
  };

  HelpWindow.prototype.onMove = function (e) {
    if (!this.drag) return;
    var dx = e.clientX - this.drag.sx;
    var dy = e.clientY - this.drag.sy;
    if (this.drag.kind === 'move') {
      this.state.x = this.drag.x + dx;
      this.state.y = this.drag.y + dy;
    } else {
      this.resizeBy(this.drag.edge, dx, dy);
    }
    this.keepInView();
    this.apply(false);
  };

  HelpWindow.prototype.resizeBy = function (edge, dx, dy) {
    var start = this.drag;
    if (!start) return;
    var x = start.x;
    var y = start.y;
    var w = start.w;
    var h = start.h;
    var collapsed = this.state.collapsed;
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
    var maxW = window.innerWidth - 8;
    var maxH = window.innerHeight - 8;
    w = clamp(w, MIN_W, maxW);
    if (!collapsed) h = clamp(h, MIN_H, maxH);
    if (edge.indexOf('w') !== -1) x = start.x + (start.w - w);
    if (!collapsed && edge.indexOf('n') !== -1) y = start.y + (start.h - h);
    this.state.x = x;
    this.state.y = y;
    this.state.w = w;
    if (!collapsed) this.state.h = h;
  };

  HelpWindow.prototype.endDrag = function () {
    if (!this.drag) return;
    this.drag = null;
    saveState(this.state);
  };

  HelpWindow.prototype.keepInView = function () {
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    this.state.w = clamp(this.state.w, MIN_W, Math.max(MIN_W, vw - 8));
    this.state.h = clamp(this.state.h, MIN_H, Math.max(MIN_H, vh - 8));
    var visH = this.state.collapsed ? BAR_H : this.state.h;
    this.state.x = clamp(this.state.x, 4, Math.max(4, vw - this.state.w - 4));
    this.state.y = clamp(this.state.y, 4, Math.max(4, vh - visH - 4));
  };

  HelpWindow.prototype.applyOpacity = function () {
    var pct = clamp(this.state.opacity, OP_MIN, OP_MAX);
    this.win.style.opacity = String(pct / 100);
    if (this.opacityInput) this.opacityInput.value = String(pct);
    if (this.opacityVal) this.opacityVal.textContent = pct + '%';
  };

  HelpWindow.prototype.apply = function (animate) {
    this.keepInView();
    var visH = this.state.collapsed ? BAR_H : this.state.h;
    this.win.style.left = this.state.x + 'px';
    this.win.style.top = this.state.y + 'px';
    this.win.style.width = this.state.w + 'px';
    this.win.style.height = visH + 'px';
    this.win.classList.toggle('is-collapsed', this.state.collapsed);
    if (this.minBtn) {
      this.minBtn.textContent = this.state.collapsed ? '+' : '\u2212';
      this.minBtn.title = this.state.collapsed ? '\uD3BC\uCE58\uAE30' : '\uC811\uAE30';
    }
    this.applyOpacity();
    if (animate) {
      gsapTween(this.win, { from: { scale: 0.94, y: 12 }, to: { scale: 1, y: 0 } });
    }
  };

  HelpWindow.prototype.loadContent = function () {
    var self = this;
    if (this.loaded && this.body && this.body.innerHTML.trim()) return;
    document.body.dispatchEvent(new CustomEvent('wui-help-open'));
    if (window.htmx && typeof window.htmx.trigger === 'function') {
      window.htmx.trigger(document.body, 'wui-help-open');
      this.loaded = true;
      return;
    }
    if (!this.body.innerHTML.trim()) {
      fetch('/partials/help', { headers: { 'HX-Request': 'true' } })
        .then(function (r) { return r.text(); })
        .then(function (html) {
          self.body.innerHTML = html;
          self.afterContent();
        })
        .catch(function () {
          self.body.innerHTML = '<p class="help-note">\uB3C4\uC6C0\uB9D0\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC5F4\uC5B4 \uC8FC\uC138\uC694.</p>';
        });
    }
    this.loaded = true;
  };

  HelpWindow.prototype.afterContent = function () {
    var alpine = window.Alpine;
    if (alpine && this.body && typeof alpine.initTree === 'function') {
      alpine.initTree(this.body);
    }
    var q = document.getElementById('help-search');
    if (q) setTimeout(function () { q.focus(); }, 80);
  };

  HelpWindow.prototype.open = function () {
    this.state.open = true;
    this.root.hidden = false;
    this.apply(true);
    this.loadContent();
    saveState(this.state);
  };

  HelpWindow.prototype.close = function () {
    this.state.open = false;
    this.root.hidden = true;
    saveState(this.state);
  };

  HelpWindow.prototype.toggle = function () {
    if (this.state.open) this.close();
    else this.open();
  };

  HelpWindow.prototype.toggleCollapse = function () {
    this.state.collapsed = !this.state.collapsed;
    this.apply(false);
    saveState(this.state);
  };

  function registerAlpine() {
    var Alpine = window.Alpine;
    if (!Alpine || Alpine.__helpGuide) return;
    Alpine.__helpGuide = true;
    Alpine.data('helpGuide', function () {
      return {
        q: '',
        cat: 'all',
        noneVisible: false,
        setCat: function (cat) {
          this.cat = cat;
          var root = this.$root;
          root.querySelectorAll('.help-chip').forEach(function (chip) {
            chip.classList.toggle('active', chip.getAttribute('data-help-cat') === cat);
          });
          this.filter();
        },
        toggleCard: function (btn) {
          var card = btn.closest('.help-card');
          if (!card) return;
          var open = !card.classList.contains('open');
          var list = card.closest('.help-list');
          if (list) {
            list.querySelectorAll('.help-card.open').forEach(function (other) {
              if (other !== card) {
                other.classList.remove('open');
                var head = other.querySelector('.help-card-head');
                if (head) head.setAttribute('aria-expanded', 'false');
              }
            });
          }
          card.classList.toggle('open', open);
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        },
        filter: function () {
          var root = this.$root;
          var q = String(this.q || '').trim().toLowerCase();
          var shown = 0;
          var self = this;
          root.querySelectorAll('.help-card').forEach(function (card) {
            var cat = card.getAttribute('data-help-cat') || '';
            var hay = (card.getAttribute('data-help-search') || '').toLowerCase();
            var ok = (self.cat === 'all' || cat === self.cat) && (!q || hay.indexOf(q) !== -1);
            card.hidden = !ok;
            if (ok) shown += 1;
          });
          this.noneVisible = shown === 0;
        }
      };
    });
  }

  function boot() {
    registerAlpine();
    var root = document.getElementById('wui-help');
    if (!root) return;
    var inst = new HelpWindow(root);
    window.WuiHelp = {
      open: function () { inst.open(); },
      close: function () { inst.close(); },
      toggle: function () { inst.toggle(); }
    };
    try {
      var params = new URLSearchParams(window.location.search);
      var hash = (window.location.hash || '').replace(/^#/, '');
      var savedTab = '';
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
})();
