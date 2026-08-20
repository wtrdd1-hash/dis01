const express = require('express');

const APP_BOOT_AT = new Date();
const APP_VERSION = String(APP_BOOT_AT.getTime());
const APP_VERSION_LABEL = [
  APP_BOOT_AT.getFullYear(),
  String(APP_BOOT_AT.getMonth() + 1).padStart(2, '0'),
  String(APP_BOOT_AT.getDate()).padStart(2, '0')
].join('.') + ' ' + [
  String(APP_BOOT_AT.getHours()).padStart(2, '0'),
  String(APP_BOOT_AT.getMinutes()).padStart(2, '0')
].join(':');

function getAppVersion() {
  return APP_VERSION;
}

function getAppVersionLabel() {
  return APP_VERSION_LABEL;
}

const AUTO_REFRESH_CLIENT = String.raw`
<script id="soft-auto-refresh">
(function() {
  if (window.__softAutoRefreshInstalled) return;
  window.__softAutoRefreshInstalled = true;
  window.APP_VERSION = window.APP_VERSION || '${APP_VERSION}';
  window.APP_VERSION_LABEL = window.APP_VERSION_LABEL || '${APP_VERSION_LABEL}';

  const USER_REFRESH_MS = 5000;
  const STOCK_REFRESH_MS = 15000;
  const USER_HEARTBEAT_MS = 45000;
  const STOCK_HEARTBEAT_MS = 60000;
  let userTimer = null;
  let stockTimer = null;
  let userRequestRunning = false;
  let stockRequestRunning = false;
  let lastUserSyncAt = 0;
  let lastStockSyncAt = 0;

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el && value !== undefined && value !== null) el.textContent = value;
  }

  var MONEY_UNIT_TABLE = [
    { label: '극', exp: 48 }, { label: '재', exp: 44 }, { label: '정', exp: 40 },
    { label: '간', exp: 36 }, { label: '구', exp: 32 }, { label: '양', exp: 28 },
    { label: '자', exp: 24 }, { label: '해', exp: 20 }, { label: '경', exp: 16 },
    { label: '조', exp: 12 }, { label: '억', exp: 8 }, { label: '만', exp: 4 }
  ];
  var UNIT_EXP_MAP = {극:48,재:44,정:40,간:36,구:32,양:28,자:24,해:20,경:16,조:12,억:8,만:4,천:3};

  function commaDigits(digits) {
    var out = '';
    var group = 0;
    for (var j = digits.length - 1; j >= 0; j--) {
      out = digits.charAt(j) + out;
      group++;
      if (group === 3 && j > 0) {
        out = ',' + out;
        group = 0;
      }
    }
    return out || '0';
  }

  function fmtWon(value) {
    var cleaned = moneyRaw(value);
    var sign = cleaned.charAt(0) === '-' ? '-' : '';
    if (sign) cleaned = cleaned.slice(1);
    while (cleaned.length > 1 && cleaned.charAt(0) === '0') cleaned = cleaned.slice(1);
    if (cleaned === '0') return '0원';
    if (cleaned.length <= 4) return sign + commaDigits(cleaned) + '원';
    var rest = cleaned;
    var parts = [];
    for (var i = 0; i < MONEY_UNIT_TABLE.length; i++) {
      var exp = MONEY_UNIT_TABLE[i].exp;
      if (rest.length > exp) {
        var qty = rest.slice(0, rest.length - exp).replace(/^0+/, '') || '0';
        rest = rest.slice(rest.length - exp).replace(/^0+/, '') || '0';
        if (qty !== '0') parts.push(commaDigits(qty) + MONEY_UNIT_TABLE[i].label);
      }
    }
    if (rest !== '0' || !parts.length) parts.push(commaDigits(rest) + (parts.length ? '' : '원'));
    return sign + parts.join(' ');
  }

  function parseClientMoney(text) {
    var s = String(text == null ? '' : text)
      .replace(/,/g, '')
      .replace(/\u00a0/g, '')
      .replace(/원/g, '')
      .replace(/(\d)\s+(극|재|정|간|구|양|자|해|경|조|억|만|천)/g, '$1$2')
      .trim();
    if (!s) return '0';
    if (/^(all|max|전액|올인|전량|전체|최대)$/i.test(s)) return 'ALL';
    if (/^[+-]?\d+$/.test(s)) return s.replace(/^\+/, '');
    var re = /(\d+(?:\.\d+)?)(극|재|정|간|구|양|자|해|경|조|억|만|천)/g;
    var total = 0n;
    var matched = false;
    var m;
    while ((m = re.exec(s))) {
      matched = true;
      var exp = UNIT_EXP_MAP[m[2]] || 0;
      var bits = m[1].split('.');
      var digits = (bits[0] || '0') + (bits[1] || '');
      var val = BigInt(digits.replace(/^0+(?=\d)/, '') || '0');
      var shift = exp - (bits[1] ? bits[1].length : 0);
      if (shift >= 0) val *= 10n ** BigInt(shift);
      else val /= 10n ** BigInt(-shift);
      total += val;
    }
    var leftover = s.replace(/(\d+(?:\.\d+)?)(극|재|정|간|구|양|자|해|경|조|억|만|천)/g, '').replace(/[+\s]/g, '');
    if (leftover && /^\d+$/.test(leftover)) {
      matched = true;
      total += BigInt(leftover);
    }
    return matched && total > 0n ? total.toString() : '0';
  }

  function moneyRaw(value) {
    var s = String(value == null ? '0' : value).split('.')[0];
    var cleaned = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if ((ch >= '0' && ch <= '9') || (ch === '-' && cleaned.length === 0)) cleaned += ch;
    }
    return cleaned || '0';
  }

  function setMoney(id, value) {
    const el = document.getElementById(id);
    if (!el || value === undefined || value === null) return;
    const raw = moneyRaw(value);
    const prevRaw = el.getAttribute('data-raw');
    el.textContent = fmtWon(raw);
    el.setAttribute('data-raw', raw);
    if (prevRaw !== null && prevRaw !== '' && prevRaw !== raw) {
      var isUp = false;
      try { isUp = BigInt(raw) > BigInt(prevRaw); } catch (e) { isUp = raw.length > prevRaw.length; }
      el.style.transition = 'color 0.3s';
      el.style.color = isUp ? '#34d399' : '#f87171';
      setTimeout(function() { el.style.color = ''; }, 1200);
    }
  }

  function readRaw(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    const raw = el.getAttribute('data-raw');
    return (raw === null || raw === '') ? null : raw;
  }

  function maxMoneyStr(a, b) {
    try {
      var aa = BigInt(moneyRaw(a));
      var bb = BigInt(moneyRaw(b));
      return aa >= bb ? aa.toString() : bb.toString();
    } catch (e) {
      return moneyRaw(a != null && a !== '' ? a : b);
    }
  }

  function readMoneyEl(el) {
    if (!el) return '0';
    var fromRaw = '0';
    var raw = el.getAttribute('data-raw');
    if (raw !== null && raw !== '') fromRaw = moneyRaw(raw);
    var fromText = '0';
    try {
      var parsed = parseClientMoney(el.innerText || el.textContent || '');
      if (parsed && parsed !== 'ALL') fromText = moneyRaw(parsed);
    } catch (e) {}
    return maxMoneyStr(fromRaw, fromText);
  }

  function readWalletCash() {
    var ids = ['my-cash', 'modal-user-cash', 'modal-user-cash-info'];
    var best = window.__walletCash ? moneyRaw(window.__walletCash) : '0';
    for (var i = 0; i < ids.length; i++) {
      best = maxMoneyStr(best, readMoneyEl(document.getElementById(ids[i])));
    }
    return best;
  }
  window.readMoneyEl = readMoneyEl;
  window.readWalletCash = readWalletCash;

  function sumMoney(a, b, c) {
    function toBig(v) {
      try { return BigInt(moneyRaw(v)); } catch (e) { return 0n; }
    }
    return (toBig(a) + toBig(b) + toBig(c)).toString();
  }

  function paintAssetRatio(cash, bank, stock) {
    function toBig(v) {
      try { return BigInt(moneyRaw(v)); } catch (e) { return 0n; }
    }
    const c = toBig(cash);
    const b = toBig(bank);
    const s = toBig(stock);
    const t = c + b + s;
    var cashPct = 0;
    var bankPct = 0;
    var stockPct = 0;
    if (t > 0n) {
      cashPct = Number((c * 100n) / t);
      bankPct = Number((b * 100n) / t);
      stockPct = Math.max(0, 100 - cashPct - bankPct);
    }
    var label = document.getElementById('asset-ratio-label');
    if (label) label.textContent = '현금 ' + cashPct + '% · 예금 ' + bankPct + '% · 주식 ' + stockPct + '%';
    var rc = document.getElementById('ratio-cash');
    var rb = document.getElementById('ratio-bank');
    var rs = document.getElementById('ratio-stock');
    if (rc) { rc.style.width = cashPct + '%'; rc.title = '현금 ' + cashPct + '%'; }
    if (rb) { rb.style.width = bankPct + '%'; rb.title = '예금 ' + bankPct + '%'; }
    if (rs) { rs.style.width = stockPct + '%'; rs.title = '주식 ' + stockPct + '%'; }
  }

  window.formatMoneyCompact = fmtWon;
  window.moneyRaw = moneyRaw;
  window.parseClientMoney = parseClientMoney;
  window.sumMoneyStrings = sumMoney;

  function pick(user, snake, camel) {
    if (user[snake] !== undefined && user[snake] !== null) return user[snake];
    if (user[camel] !== undefined && user[camel] !== null) return user[camel];
    return undefined;
  }

  function applyUserLiveSnapshot(raw) {
    const user = raw && raw.user ? raw.user : raw;
    if (!user) return;

    const cash = pick(user, 'cash', 'cash');
    const bank = pick(user, 'bank', 'bank');
    const stockVal = pick(user, 'stockVal', 'stock_val');
    const netWorth = pick(user, 'netWorth', 'net_worth');
    const clickerLevel = pick(user, 'clicker_level', 'clickerLevel');
    const autoLevel = pick(user, 'auto_miner_level', 'autoLevel');
    const totalClicks = pick(user, 'total_clicks', 'totalClicks');
    const streak = pick(user, 'daily_streak', 'streak');

    if (cash !== undefined) {
      setMoney('my-cash', cash);
      setMoney('modal-user-cash', cash);
      setMoney('modal-user-cash-info', cash);
      window.__walletCash = moneyRaw(cash);
    }
    if (bank !== undefined) {
      setMoney('my-bank', bank);
      setMoney('modal-user-bank', bank);
    }
    if (stockVal !== undefined) {
      setMoney('my-stock-val', stockVal);
      setMoney('modal-user-stock', stockVal);
    }

    if (cash !== undefined || bank !== undefined || stockVal !== undefined || netWorth !== undefined) {
      const c = cash !== undefined ? moneyRaw(cash) : (readRaw('my-cash') || '0');
      const b = bank !== undefined ? moneyRaw(bank) : (readRaw('my-bank') || '0');
      const s = stockVal !== undefined ? moneyRaw(stockVal) : (readRaw('my-stock-val') || '0');
      const net = sumMoney(c, b, s);
      setMoney('my-net-worth', net);
      setMoney('modal-user-net', net);
      paintAssetRatio(c, b, s);
    }

    if (cash !== undefined || bank !== undefined || stockVal !== undefined) {
      if (typeof window.__onWalletCashUpdated === 'function') {
        try { window.__onWalletCashUpdated(); } catch (e) {}
      }
    }

    if (totalClicks !== undefined) {
      setText('clicker-clicks-val', Number(totalClicks).toLocaleString('ko-KR') + '회');
    }

    const cfg = window.CLICKER_CFG || {};
    const ppl = cfg.powerPerLevel || 10;
    const upc = cfg.upgradeCostPerLevel || 4500;
    const ail = cfg.autoIncomePerLevel || 15;
    const acn = cfg.autoCostPerNextLevel || 12000;

    if (clickerLevel !== undefined) {
      const lv = Number(clickerLevel) || 1;
      setText('clicker-power-val', '+' + (lv * ppl).toLocaleString('ko-KR') + '원');
      setText('shop-power-lv', String(lv));
      setText('shop-power-cost', (lv * upc).toLocaleString('ko-KR') + '원');
    }

    if (autoLevel !== undefined) {
      const lv = Number(autoLevel) || 0;
      setText('clicker-auto-val', '+' + (lv * ail).toLocaleString('ko-KR') + '원/s');
      setText('shop-auto-lv', String(lv));
      setText('shop-auto-cost', ((lv + 1) * acn).toLocaleString('ko-KR') + '원');
    }

    if (clickerLevel !== undefined || autoLevel !== undefined) {
      const powerEl = document.getElementById('shop-power-lv');
      const autoEl = document.getElementById('shop-auto-lv');
      const power = clickerLevel !== undefined ? Number(clickerLevel) || 1 : Number(powerEl && powerEl.textContent ? powerEl.textContent : 1);
      const auto = autoLevel !== undefined ? Number(autoLevel) || 0 : Number(autoEl && autoEl.textContent ? autoEl.textContent : 0);
      setText('modal-user-levels', 'Lv.' + power + ' / Lv.' + auto);
    }

    if (streak !== undefined) {
      setText('modal-user-streak', Number(streak) + '일 연속');
    }

    if (user.holdings && typeof window.__applyUserHoldings === 'function') {
      window.__applyUserHoldings(user.holdings);
    }

    if (user.tax && typeof user.tax === 'object') {
      window.__economyTax = user.tax;
      if (typeof window.applyEconomyTax === 'function') window.applyEconomyTax(user.tax);
    }
    if (user.loan && typeof user.loan === 'object') {
      window.__economyLoan = user.loan;
      if (typeof window.applyEconomyLoan === 'function') window.applyEconomyLoan(user.loan);
    }
  }

  window.applyUserLiveSnapshot = applyUserLiveSnapshot;

  function applyMarketFromSocket(data) {
    if (!data) return;
    if (typeof window.applyMarketUpdate === 'function') {
      window.applyMarketUpdate(data);
      return;
    }
    if (!Array.isArray(data.stocks)) return;
    data.stocks.forEach(function(stock) {
      const priceEl = document.getElementById('price-' + stock.stock_id);
      if (priceEl && stock.price !== undefined) {
        priceEl.textContent = Number(stock.price).toLocaleString('ko-KR') + '원';
      }
    });
    document.querySelectorAll('[data-last-updated]').forEach(function(el) {
      el.textContent = '업데이트: ' + new Date().toLocaleTimeString('ko-KR');
    });
  }

  function isLiveSocketConnected() {
    return !!(window.__liveSocket && window.__liveSocket.connected);
  }

  function bindLiveSocket() {
    const sock = window.__liveSocket;
    if (!sock || sock.__userBalanceBound) return;
    sock.__userBalanceBound = true;
    sock.on('user:balance', function(data) {
      window.__lastUserBalance = data;
      applyUserLiveSnapshot(data);
    });
    sock.on('market:snapshot', applyMarketFromSocket);
    sock.on('market:update', applyMarketFromSocket);
  }

  async function refreshUser() {
    if (document.hidden || userRequestRunning) return;
    if (isLiveSocketConnected()) {
      const now = Date.now();
      if (lastUserSyncAt && (now - lastUserSyncAt) < USER_HEARTBEAT_MS) return;
      lastUserSyncAt = now;
      window.__liveSocket.emit('user:sync', {});
      return;
    }
    lastUserSyncAt = 0;
    userRequestRunning = true;

    try {
      const res = await fetch('/api/user/me', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store'
      });

      if (res.status === 401) return;
      const data = await res.json();
      if (res.ok && data.success && data.user) applyUserLiveSnapshot(data.user);
    } catch (err) {
      console.warn('[auto-refresh] user refresh failed:', err && err.message ? err.message : err);
    } finally {
      userRequestRunning = false;
    }
  }

  async function refreshStocks() {
    if (document.hidden || stockRequestRunning) return;
    if (isLiveSocketConnected()) {
      const now = Date.now();
      if (lastStockSyncAt && (now - lastStockSyncAt) < STOCK_HEARTBEAT_MS) return;
      lastStockSyncAt = now;
      window.__liveSocket.emit('market:refresh', {});
      return;
    }
    lastStockSyncAt = 0;
    stockRequestRunning = true;

    try {
      const res = await fetch('/api/stocks', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store'
      });
      const data = await res.json();
      if (!res.ok || !data.success || !Array.isArray(data.stocks)) return;

      data.stocks.forEach(function(stock) {
        const priceEl = document.getElementById('price-' + stock.stock_id);
        if (priceEl && stock.price !== undefined) {
          priceEl.textContent = Number(stock.price).toLocaleString('ko-KR') + '원';
        }
      });

      document.querySelectorAll('[data-last-updated]').forEach(function(el) {
        el.textContent = '업데이트: ' + new Date().toLocaleTimeString('ko-KR');
      });
    } catch (err) {
      console.warn('[auto-refresh] stock refresh failed:', err && err.message ? err.message : err);
    } finally {
      stockRequestRunning = false;
    }
  }

  function start() {
    bindLiveSocket();
    if (!window.__walletCash) window.__walletCash = readWalletCash();
    if (window.__lastUserBalance) applyUserLiveSnapshot(window.__lastUserBalance);
    if (!userTimer) userTimer = setInterval(refreshUser, USER_REFRESH_MS);
    if (!stockTimer) stockTimer = setInterval(refreshStocks, STOCK_REFRESH_MS);
    refreshUser();
    refreshStocks();
  }

  function stop() {
    if (userTimer) {
      clearInterval(userTimer);
      userTimer = null;
    }
    if (stockTimer) {
      clearInterval(stockTimer);
      stockTimer = null;
    }
  }

  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  window.addEventListener('focus', function() {
    lastUserSyncAt = 0;
    lastStockSyncAt = 0;
    refreshUser();
    refreshStocks();
  });

  window.refreshPageData = function() {
    refreshUser();
    refreshStocks();
  };

  function showUpdatePopup(remoteLabel) {
    if (window.__updatePopupShown) return;
    window.__updatePopupShown = true;
    if (document.getElementById('app-update-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'app-update-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-live', 'polite');
    overlay.innerHTML =
      '<div class="app-update-card">' +
        '<div class="app-update-badge">NEW VERSION</div>' +
        '<h3>✨ 업데이트되었습니다</h3>' +
        '<p>월덕 웹이 새 버전으로 갱신되었습니다.<br>최신 화면을 보려면 새로고침해 주세요.</p>' +
        '<div class="app-update-ver">' + String(remoteLabel || window.APP_VERSION_LABEL || '') + '</div>' +
        '<button type="button" class="app-update-btn" id="app-update-reload">지금 새로고침</button>' +
        '<div class="app-update-hint" id="app-update-hint">12초 후 자동으로 새로고침됩니다</div>' +
      '</div>';

    if (!document.getElementById('app-update-style')) {
      const style = document.createElement('style');
      style.id = 'app-update-style';
      style.textContent =
        '#app-update-overlay{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);padding:20px}' +
        '.app-update-card{width:min(420px,100%);background:#1e1f22;border:1px solid rgba(88,101,242,.55);border-radius:14px;padding:22px 22px 18px;box-shadow:0 16px 48px rgba(0,0,0,.55);text-align:center;color:#fff;font-family:Pretendard,system-ui,sans-serif}' +
        '.app-update-badge{display:inline-block;background:linear-gradient(135deg,#5865f2,#8b5cf6);color:#fff;font-size:11px;font-weight:800;letter-spacing:.08em;padding:4px 9px;border-radius:999px;margin-bottom:12px}' +
        '.app-update-card h3{margin:0 0 8px;font-size:1.15rem;font-weight:800}' +
        '.app-update-card p{margin:0 0 12px;font-size:.9rem;line-height:1.5;color:#b5bac1}' +
        '.app-update-ver{font-size:.78rem;color:#818cf8;font-weight:700;margin-bottom:14px}' +
        '.app-update-btn{width:100%;border:0;border-radius:10px;padding:11px 14px;font-weight:800;font-size:.95rem;color:#fff;background:linear-gradient(135deg,#5865f2,#8b5cf6);cursor:pointer}' +
        '.app-update-btn:hover{filter:brightness(1.08)}' +
        '.app-update-hint{margin-top:10px;font-size:.75rem;color:#72767d}';
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);
    const btn = document.getElementById('app-update-reload');
    if (btn) btn.onclick = function() { location.reload(); };

    let left = 12;
    const hint = document.getElementById('app-update-hint');
    const timer = setInterval(function() {
      if (window.isGameInProgress) {
        if (hint) hint.textContent = '게임이 끝나면 자동으로 새로고침됩니다';
        return;
      }
      left -= 1;
      if (hint) hint.textContent = left + '초 후 자동으로 새로고침됩니다';
      if (left <= 0) {
        clearInterval(timer);
        location.reload();
      }
    }, 1000);
  }

  function applyRemoteVersion(data) {
    if (!data) return;
    const remote = data.version || data;
    const label = data.label || '';
    if (!remote || String(remote) === String(window.APP_VERSION)) return;
    showUpdatePopup(label);
  }

  async function checkAppVersion() {
    try {
      const res = await fetch('/api/version', { credentials: 'same-origin', cache: 'no-store' });
      const data = await res.json();
      if (res.ok && data && data.success) applyRemoteVersion(data);
    } catch (e) {}
  }

  function bindVersionSocket() {
    const sock = window.__liveSocket;
    if (!sock || sock.__versionBound) return;
    sock.__versionBound = true;
    sock.on('app:version', applyRemoteVersion);
  }

  const _origStart = start;
  start = function() {
    bindVersionSocket();
    _origStart();
    checkAppVersion();
    if (!window.__versionTimer) {
      window.__versionTimer = setInterval(checkAppVersion, 20000);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  console.info('[auto-refresh] soft refresh enabled');
})();
</script>
`;

function installAutoRefreshPatch() {
  if (express.response.__softAutoRefreshInstalled) return;
  express.response.__softAutoRefreshInstalled = true;

  const originalSend = express.response.send;

  express.response.send = function patchedAutoRefreshSend(body) {
    if (
      typeof body === 'string' &&
      body.includes('</body>') &&
      (body.includes('id="my-cash"') || body.includes('id="user-search-input"')) &&
      !body.includes('soft-auto-refresh')
    ) {
      body = body.replace(/<\/body>/i, `${AUTO_REFRESH_CLIENT}</body>`);
    }

    return originalSend.call(this, body);
  };
}

installAutoRefreshPatch();

function getAutoRefreshClient() {
  return AUTO_REFRESH_CLIENT;
}

module.exports = { installAutoRefreshPatch, getAutoRefreshClient, getAppVersion, getAppVersionLabel };
