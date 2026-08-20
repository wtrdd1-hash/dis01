(function (global) {
  var SLOT_SYMS = ['🍒', '🍋', '🍇', '🍉', '🔔', '💎', '7️⃣'];
  var LOTTO_SYMS = ['💰', '🦆', '💎', '7️⃣', '💣', '⭐'];
  var timers = {};

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setCall(id, text, color) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || '';
    if (color) el.style.color = color;
  }

  function resultHtml(isWin, title, body, flavor, isTie) {
    var kind = isTie ? 'tie' : (isWin ? 'win' : 'lose');
    var html = '<div class="game-fx-result ' + kind + '">';
    html += '<div class="game-fx-title">' + escapeHtml(title) + '</div>';
    if (body) html += '<div class="game-fx-body">' + escapeHtml(body) + '</div>';
    if (flavor) html += '<div class="game-fx-flavor">' + escapeHtml(flavor) + '</div>';
    html += '</div>';
    return html;
  }

  function paintResult(id, isWin, title, body, flavor, isTie) {
    var el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = resultHtml(isWin, title, body, flavor, isTie);
    el.style.color = isTie ? '#fbbf24' : (isWin ? '#34d399' : '#f87171');
  }

  function clearTimer(key) {
    if (timers[key]) {
      clearInterval(timers[key]);
      timers[key] = null;
    }
  }

  function cycleText(el, symbols, key, ms) {
    if (!el) return;
    clearTimer(key);
    timers[key] = setInterval(function () {
      el.textContent = symbols[Math.floor(Math.random() * symbols.length)];
    }, ms || 70);
  }

  function stopCycle(el, symbol, key) {
    clearTimer(key);
    if (!el) return;
    el.classList.remove('spinning');
    el.classList.add('reel-stop');
    el.textContent = symbol;
    setTimeout(function () { el.classList.remove('reel-stop'); }, 320);
  }

  async function stopReelsInOrder(els, symbols, baseKey) {
    for (var i = 0; i < els.length; i++) {
      await sleep(i === 0 ? 420 : 380);
      stopCycle(els[i], symbols[i] || '❓', baseKey + i);
    }
  }

  async function countUp(el, target, duration) {
    if (!el) return;
    var end = Number(target) || 0;
    var startAt = Date.now();
    var ms = duration || 900;
    return new Promise(function (resolve) {
      function tick() {
        var t = Math.min(1, (Date.now() - startAt) / ms);
        var eased = 1 - Math.pow(1 - t, 3);
        var n = Math.round(end * eased);
        el.textContent = String(n);
        if (t < 1) requestAnimationFrame(tick);
        else {
          el.textContent = String(end);
          resolve();
        }
      }
      tick();
    });
  }

  global.GameFx = {
    sleep: sleep,
    escapeHtml: escapeHtml,
    setCall: setCall,
    resultHtml: resultHtml,
    paintResult: paintResult,
    cycleText: cycleText,
    stopCycle: stopCycle,
    stopReelsInOrder: stopReelsInOrder,
    countUp: countUp,
    clearTimer: clearTimer,
    SLOT_SYMS: SLOT_SYMS,
    LOTTO_SYMS: LOTTO_SYMS
  };
})(window);
