(function () {
  function moneyText(v) {
    if (typeof window.fmtMoneyUi === 'function') return window.fmtMoneyUi(v);
    try {
      return BigInt(String(v || '0').split('.')[0]).toLocaleString('ko-KR') + '원';
    } catch (e) {
      return String(v || '0') + '원';
    }
  }

  function dueLabel(loan) {
    if (!loan || !loan.hasLoan) return '';
    if (loan.overdue) return '연체 — 카지노·주식 매수가 막혀 있습니다.';
    var dueAt = Number(loan.dueAt || 0);
    var sec = dueAt ? Math.max(0, Math.floor((dueAt - Date.now()) / 1000)) : Math.max(0, Number(loan.dueInSec) || 0);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return '만기까지 ' + h + '시간 ' + String(m).padStart(2, '0') + '분 ' + String(s).padStart(2, '0') + '초';
  }

  function applyEconomyLoan(loan) {
    if (!loan || typeof loan !== 'object') return;
    window.__economyLoan = loan;
    var wallet = document.getElementById('wallet-loan-note');
    if (wallet) {
      if (loan.exempt) {
        wallet.textContent = '';
      } else if (loan.hasLoan) {
        wallet.textContent = (loan.overdue ? '대출 연체 ' : '대출 ') + moneyText(loan.debt) +
          ' · 담보 ' + moneyText(loan.collateral) + ' · ' + dueLabel(loan);
        wallet.style.color = loan.overdue ? '#f87171' : '#a5b4fc';
      } else {
        var maxB = String(loan.maxBorrow || '0');
        wallet.textContent = maxB !== '0'
          ? '대출 한도 ' + moneyText(maxB) + ' · 이자 ' + (loan.rateText || '시간당 0.15%') + ' · 만기 ' + (loan.termHours || 24) + '시간'
          : '';
        wallet.style.color = '#9ca3af';
      }
    }
    var status = document.getElementById('bank-loan-status');
    if (status) {
      if (loan.exempt) {
        status.textContent = '관리자 계정은 대출할 수 없습니다.';
      } else if (loan.hasLoan) {
        status.textContent = '채무 ' + moneyText(loan.debt) +
          ' (원금 ' + moneyText(loan.principal) + ' + 이자 ' + moneyText(loan.interest) + ') · 담보 ' +
          moneyText(loan.collateral) + ' · ' + dueLabel(loan);
      } else {
        status.textContent = '한도 ' + moneyText(loan.maxBorrow || 0) +
          ' (예금의 50%) · 이자 ' + (loan.rateText || '시간당 0.15%') +
          ' · 만기 ' + (loan.termHours || 24) + '시간. 국고를 먼저 쓰고, 부족분은 최대 20%만 새로 발행합니다.';
      }
    }
    var borrowBtn = document.getElementById('btn-loan-borrow');
    var repayBtn = document.getElementById('btn-loan-repay');
    if (borrowBtn) borrowBtn.disabled = !!(loan.exempt || loan.hasLoan || String(loan.maxBorrow || '0') === '0');
    if (repayBtn) repayBtn.disabled = !loan.hasLoan;
  }
  window.applyEconomyLoan = applyEconomyLoan;

  async function refreshBankLoan() {
    try {
      var res = await fetch('/api/economy/loan', { credentials: 'same-origin', cache: 'no-store' });
      var data = await res.json();
      if (!data || data.success === false) return;
      var loan = data.loan || data.active || {
        hasLoan: false,
        eligible: data.eligible,
        maxBorrow: data.maxBorrow,
        exempt: data.exempt,
        rateText: data.rateText,
        termHours: data.termHours,
        creditFactor: data.creditFactor,
        locked: data.locked
      };
      if (data.maxBorrow != null && loan.maxBorrow == null) loan.maxBorrow = data.maxBorrow;
      if (data.exempt) loan.exempt = true;
      if (data.locked != null) loan.locked = data.locked;
      applyEconomyLoan(loan);
    } catch (e) {}
  }
  window.refreshBankLoan = refreshBankLoan;

  function loanAmountPayload() {
    var input = document.getElementById('loan-amount-input');
    if (typeof window.getBetPayload === 'function') return window.getBetPayload(input);
    return input ? String(input.value || '').trim() : '';
  }

  async function submitLoanBorrow() {
    try {
      var res = await fetch('/api/economy/loan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ amount: loanAmountPayload() })
      });
      var data = await res.json();
      if (!data.success) {
        if (typeof window.showToast === 'function') window.showToast('error', '대출 실패', data.error);
        return;
      }
      if (typeof window.showToast === 'function') window.showToast('success', '대출 완료', data.message);
      if (data.loan) applyEconomyLoan(data.loan);
      if (typeof window.applyUserLiveSnapshot === 'function' && (data.cash != null || data.bank != null)) {
        window.applyUserLiveSnapshot({ cash: data.cash, bank: data.bank, loan: data.loan });
      }
      refreshBankLoan();
    } catch (e) {
      if (typeof window.showToast === 'function') window.showToast('error', '통신 오류', '대출 서버 연결 실패');
    }
  }
  window.submitLoanBorrow = submitLoanBorrow;

  async function submitLoanRepay() {
    try {
      var amount = loanAmountPayload();
      var res = await fetch('/api/economy/loan/repay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ amount: amount || '전액' })
      });
      var data = await res.json();
      if (!data.success) {
        if (typeof window.showToast === 'function') window.showToast('error', '상환 실패', data.error);
        return;
      }
      if (typeof window.showToast === 'function') window.showToast('success', '상환 완료', data.message);
      if (data.loan) applyEconomyLoan(data.loan);
      if (typeof window.applyUserLiveSnapshot === 'function' && (data.cash != null || data.bank != null)) {
        window.applyUserLiveSnapshot({ cash: data.cash, bank: data.bank, loan: data.loan });
      }
      refreshBankLoan();
    } catch (e) {
      if (typeof window.showToast === 'function') window.showToast('error', '통신 오류', '상환 서버 연결 실패');
    }
  }
  window.submitLoanRepay = submitLoanRepay;

  var prevOpen = window.openBankModal;
  window.openBankModal = function () {
    if (typeof prevOpen === 'function') prevOpen();
    else {
      var modal = document.getElementById('bank-modal');
      if (modal) modal.style.display = 'flex';
    }
    refreshBankLoan();
  };

  var prevAll = window.setBankAllAmount;
  window.setBankAllAmount = function () {
    var input = document.getElementById('bank-amount-input');
    if (!input) return;
    var withdrawBtn = document.getElementById('bank-act-withdraw');
    var isWithdraw = !!(withdrawBtn && withdrawBtn.classList.contains('selected'));
    if (isWithdraw && typeof window.getCurrentUserBankNum === 'function') {
      var bank = window.getCurrentUserBankNum();
      var locked = 0n;
      try { locked = BigInt(String((window.__economyLoan && window.__economyLoan.locked) || '0').split('.')[0] || '0'); } catch (e) {}
      var free = bank > locked ? bank - locked : 0n;
      input.value = free > 0n ? String(free) : '0';
      if (typeof window.markAllIn === 'function') window.markAllIn(input, true);
      return;
    }
    if (typeof prevAll === 'function') return prevAll();
  };

  setInterval(function () {
    if (window.__economyLoan) applyEconomyLoan(window.__economyLoan);
  }, 1000);

  if (window.__economyLoan) applyEconomyLoan(window.__economyLoan);
})();
