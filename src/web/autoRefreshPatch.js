const express = require('express');

const AUTO_REFRESH_CLIENT = `
<script id="soft-auto-refresh">
(function() {
  if (window.__softAutoRefreshInstalled) return;
  window.__softAutoRefreshInstalled = true;

  const USER_REFRESH_MS = 5000;
  const STOCK_REFRESH_MS = 15000;
  let userTimer = null;
  let stockTimer = null;
  let userRequestRunning = false;
  let stockRequestRunning = false;

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el && value !== undefined && value !== null) el.textContent = value;
  }

  function updateUserUi(user) {
    if (!user) return;

    if (user.cash !== undefined) {
      setText('my-cash', Number(user.cash).toLocaleString('ko-KR') + '원');
      setText('modal-user-cash-info', Number(user.cash).toLocaleString('ko-KR') + '원');
    }

    if (user.bank !== undefined) {
      setText('my-bank', Number(user.bank).toLocaleString('ko-KR') + '원');
    }

    if (user.total_clicks !== undefined) {
      setText('clicker-clicks-val', Number(user.total_clicks).toLocaleString('ko-KR') + '회');
    }

    if (user.clicker_level !== undefined) {
      setText('clicker-power-val', '+' + (Number(user.clicker_level) * 10).toLocaleString('ko-KR') + '원');
    }

    if (user.auto_miner_level !== undefined) {
      setText('clicker-auto-val', '+' + (Number(user.auto_miner_level) * 15).toLocaleString('ko-KR') + '원/s');
    }
  }

  async function refreshUser() {
    if (document.hidden || userRequestRunning) return;
    userRequestRunning = true;

    try {
      const res = await fetch('/api/user/me', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store'
      });

      if (res.status === 401) return;
      const data = await res.json();
      if (res.ok && data.success && data.user) updateUserUi(data.user);
    } catch (err) {
      console.warn('[auto-refresh] user refresh failed:', err && err.message ? err.message : err);
    } finally {
      userRequestRunning = false;
    }
  }

  async function refreshStocks() {
    if (document.hidden || stockRequestRunning) return;
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
    refreshUser();
    refreshStocks();
  });

  window.refreshPageData = function() {
    refreshUser();
    refreshStocks();
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
      body.includes('id="my-cash"') &&
      !body.includes('soft-auto-refresh')
    ) {
      body = body.replace(/<\/body>/i, `${AUTO_REFRESH_CLIENT}</body>`);
    }

    return originalSend.call(this, body);
  };
}

installAutoRefreshPatch();

module.exports = { installAutoRefreshPatch };
