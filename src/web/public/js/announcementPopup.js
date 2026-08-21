'use strict';

/**
 * 📢 월덕 웹사이트 공지사항 팝업 모달 매니저
 * - 활성 팝업 공지 자동 조회 & 렌더링
 * - '오늘 하루 보지 않기' 로컬 스토리지 기억
 * - 실시간 Socket.IO 팝업 수신
 */
(function() {
  if (window.__announcementPopupInitialized) return;
  window.__announcementPopupInitialized = true;

  const TYPE_CONFIG = {
    IMPORTANT: { label: '🔥 중요 공지', color: '#EF4444', bg: 'rgba(239, 68, 68, 0.15)', border: '#EF4444' },
    EVENT: { label: '🎉 이벤트 안내', color: '#F59E0B', bg: 'rgba(245, 158, 11, 0.15)', border: '#F59E0B' },
    MAINTENANCE: { label: '🛠️ 점검 안내', color: '#EAB308', bg: 'rgba(234, 179, 8, 0.15)', border: '#EAB308' },
    GENERAL: { label: '📢 공지사항', color: '#3B82F6', bg: 'rgba(59, 130, 246, 0.15)', border: '#3B82F6' }
  };

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function checkAndShowPopup() {
    fetch('/api/announcements/popup', { cache: 'no-store', credentials: 'same-origin' })
      .then(res => {
        if (!res.ok) throw new Error('announcement request failed');
        return res.json();
      })
      .then(data => {
        if (data.success && data.announcement) {
          showAnnouncementModal(data.announcement);
        }
      })
      .catch(() => {});
  }

  function showAnnouncementModal(ann) {
    if (!ann || !Number.isSafeInteger(Number(ann.id)) || Number(ann.id) <= 0) return;
    const storageKey = 'dismissed_announcement_' + Number(ann.id);
    let dismissedUntil = null;
    try {
      dismissedUntil = localStorage.getItem(storageKey);
    } catch (e) {}
    if (dismissedUntil && Date.now() < Number(dismissedUntil)) {
      return; // 오늘 하루 보지 않기 활성화 상태
    }

    if (document.getElementById('siteAnnouncementModal')) {
      document.getElementById('siteAnnouncementModal').remove();
    }

    const typeInfo = TYPE_CONFIG[ann.type] || TYPE_CONFIG.GENERAL;

    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'siteAnnouncementModal';
    modalOverlay.setAttribute('role', 'dialog');
    modalOverlay.setAttribute('aria-modal', 'true');
    modalOverlay.setAttribute('aria-labelledby', 'siteAnnouncementTitle');
    modalOverlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      min-height: 100dvh;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(10px);
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 16px;
      overflow-y: auto;
      z-index: 999999;
      animation: popupFadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    `;

    const modalBox = document.createElement('div');
    modalBox.style.cssText = `
      background: #111827;
      border: 1px solid ${typeInfo.border};
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6), 0 0 30px ${typeInfo.bg};
      border-radius: 20px;
      width: 100%;
      max-width: 520px;
      max-height: calc(100vh - 32px);
      max-height: calc(100dvh - 32px);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      color: #F3F4F6;
      font-family: -apple-system, BlinkMacSystemFont, 'Pretendard', sans-serif;
    `;

    const safeTitle = escapeHtml(ann.title);
    const formattedContent = escapeHtml(ann.content).replace(/\n/g, '<br>');

    modalBox.innerHTML = `
      <div style="background: linear-gradient(135deg, rgba(31, 41, 55, 0.8), rgba(17, 24, 39, 0.9)); padding: 20px 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: space-between; align-items: center;">
        <span style="background: ${typeInfo.bg}; color: ${typeInfo.color}; border: 1px solid ${typeInfo.border}; font-weight: 800; font-size: 12px; padding: 4px 10px; border-radius: 999px;">
          ${typeInfo.label}
        </span>
        <button id="closePopupIcon" type="button" aria-label="공지 닫기" style="background: none; border: none; color: #9CA3AF; font-size: 20px; cursor: pointer; padding: 4px; line-height: 1;">✕</button>
      </div>
      <div style="padding: 28px 24px; max-height: 55vh; overflow-y: auto;">
        <h2 id="siteAnnouncementTitle" style="font-size: 20px; font-weight: 800; margin: 0 0 16px; line-height: 1.4; color: #FFFFFF;">
          ${safeTitle}
        </h2>
        <div style="font-size: 14px; line-height: 1.7; color: #D1D5DB; word-break: break-word;">
          ${formattedContent}
        </div>
      </div>
      <div style="background: #0F172A; padding: 16px 24px; border-top: 1px solid rgba(255, 255, 255, 0.08); display: flex; justify-content: space-between; align-items: center;">
        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #9CA3AF; cursor: pointer; user-select: none;">
          <input type="checkbox" id="dontShowTodayCheck" style="accent-color: #6366F1; width: 16px; height: 16px; cursor: pointer;">
          오늘 하루 보지 않기
        </label>
        <button id="closePopupBtn" type="button" style="background: #6366F1; color: #FFFFFF; border: none; font-weight: 700; font-size: 14px; padding: 8px 20px; border-radius: 10px; cursor: pointer; transition: all 0.2s;">
          확인
        </button>
      </div>
    `;

    modalOverlay.appendChild(modalBox);
    document.body.appendChild(modalOverlay);

    const closeHandler = () => {
      const isChecked = document.getElementById('dontShowTodayCheck').checked;
      if (isChecked) {
        // 24시간 동안 기억
        const expireTime = Date.now() + 24 * 60 * 60 * 1000;
        try {
          localStorage.setItem(storageKey, String(expireTime));
        } catch (e) {}
      }
      document.removeEventListener('keydown', escapeHandler);
      modalOverlay.style.animation = 'popupFadeOut 0.2s forwards';
      setTimeout(() => modalOverlay.remove(), 200);
    };

    const escapeHandler = (event) => {
      if (event.key === 'Escape') closeHandler();
    };

    document.getElementById('closePopupIcon').onclick = closeHandler;
    document.getElementById('closePopupBtn').onclick = closeHandler;
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) closeHandler();
    };
    document.addEventListener('keydown', escapeHandler);
    document.getElementById('closePopupBtn').focus();
  }

  // 스타일 주입
  const style = document.createElement('style');
  style.textContent = `
    @keyframes popupFadeIn {
      from { opacity: 0; transform: scale(0.95); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes popupFadeOut {
      from { opacity: 1; transform: scale(1); }
      to { opacity: 0; transform: scale(0.95); }
    }
  `;
  document.head.appendChild(style);

  // 페이지 로드 시 팝업 체크
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkAndShowPopup);
  } else {
    checkAndShowPopup();
  }

  // 실시간 Socket.IO 팝업 리스너
  function connectRealtime() {
    if (window.__announcementPopupSocketConnected) return true;
    if (typeof window.io !== 'function') return false;
    try {
      const socket = window.io();
      socket.on('announcement:popup', (data) => {
        showAnnouncementModal(data);
      });
      window.__announcementPopupSocketConnected = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  if (!connectRealtime()) {
    window.addEventListener('load', connectRealtime, { once: true });
    setTimeout(connectRealtime, 1000);
  }
})();
