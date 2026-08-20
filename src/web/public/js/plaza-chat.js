(function () {
  if (window.__plazaChatInstalled) return;
  window.__plazaChatInstalled = true;

  var DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';
  var MAX_OPEN = 8;
  var STORAGE_OPEN = 'plazaOpenRooms';
  var STORAGE_ACTIVE = 'plazaActiveRoom';

  var chatSocket = null;
  var chatFallback = null;
  var floatingOpen = false;
  var roomsById = {};
  var openRoomIds = [];
  var activeRoomId = 1;
  var peopleCache = [];

  function toast(type, title, message) {
    if (typeof window.showToast === 'function') window.showToast(type, title, message);
  }

  function getCurrentUserId() {
    return window.currentChatUserId ? String(window.currentChatUserId) : '';
  }

  function isCurrentAdmin() {
    return window.currentIsAdmin === true;
  }

  function isLoggedIn() {
    return Boolean(getCurrentUserId());
  }

  function loadOpenState() {
    try {
      var raw = JSON.parse(localStorage.getItem(STORAGE_OPEN) || '[]');
      openRoomIds = Array.isArray(raw) ? raw.map(Number).filter(function (n) { return n > 0; }).slice(0, MAX_OPEN) : [];
    } catch (e) {
      openRoomIds = [];
    }
    var saved = Number(localStorage.getItem(STORAGE_ACTIVE) || 1);
    activeRoomId = saved > 0 ? saved : 1;
    if (openRoomIds.indexOf(activeRoomId) === -1) openRoomIds.unshift(activeRoomId);
    if (!openRoomIds.length) openRoomIds = [1];
  }

  function saveOpenState() {
    try {
      localStorage.setItem(STORAGE_OPEN, JSON.stringify(openRoomIds.slice(0, MAX_OPEN)));
      localStorage.setItem(STORAGE_ACTIVE, String(activeRoomId));
    } catch (e) {}
  }

  function roomIcon(type) {
    if (type === 'thread') return '↳';
    if (type === 'dm') return '@';
    return '#';
  }

  function getAvatarUrl(msg) {
    var avatar = msg && msg.avatar ? String(msg.avatar) : '';
    if (!avatar) return DEFAULT_AVATAR;
    try {
      var parsed = new URL(avatar);
      var host = parsed.hostname.toLowerCase();
      if (parsed.protocol === 'https:' && (host === 'cdn.discordapp.com' || host === 'media.discordapp.net')) {
        return parsed.href;
      }
    } catch (e) {}
    var id = msg && msg.user_id ? String(msg.user_id) : '';
    if (/^\d{5,32}$/.test(id) && /^[a-zA-Z0-9_-]+$/.test(avatar)) {
      return 'https://cdn.discordapp.com/avatars/' + id + '/' + avatar + '.png';
    }
    return DEFAULT_AVATAR;
  }

  function decodeEntities(text) {
    return String(text || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function buildBubble(msg) {
    var wrapper = document.createElement('div');
    var currentUserId = getCurrentUserId();
    var isMine = currentUserId && String(msg.user_id) === currentUserId;
    var isAdmin = msg.is_admin === 1 || msg.is_admin === true;
    wrapper.className = 'chat-bubble ' + (isMine ? 'mine' : '') + ' ' + (isAdmin ? 'admin' : '');

    var avatarWrap = document.createElement('div');
    avatarWrap.className = 'chat-avatar-wrap';
    var avatar = document.createElement('img');
    avatar.className = 'chat-avatar';
    avatar.src = getAvatarUrl(msg);
    avatar.alt = 'Avatar';
    avatar.onerror = function () {
      avatar.onerror = null;
      avatar.src = DEFAULT_AVATAR;
    };
    var onlineDot = document.createElement('span');
    onlineDot.className = 'chat-online-dot';
    onlineDot.title = '온라인';
    avatarWrap.appendChild(avatar);
    avatarWrap.appendChild(onlineDot);

    var content = document.createElement('div');
    content.className = 'chat-content';
    var meta = document.createElement('div');
    meta.className = 'chat-meta';

    var username = document.createElement('button');
    username.type = 'button';
    username.className = 'chat-user-btn';
    username.innerHTML = '<span class="user-at">@</span>' + (msg.username || '익명');
    username.addEventListener('click', function () {
      if (!isMine) openDmWith(msg.user_id);
    });
    meta.appendChild(username);

    if (isAdmin) {
      var badge = document.createElement('span');
      badge.className = 'badge-admin-chat';
      badge.innerHTML = '👑 <span>관리자</span>';
      meta.appendChild(badge);
    } else {
      var memBadge = document.createElement('span');
      memBadge.className = 'badge-member-chat';
      memBadge.innerHTML = '💬 <span>시민</span>';
      meta.appendChild(memBadge);
    }

    var time = document.createElement('span');
    time.className = 'chat-time-tag';
    var timeStr = msg.created_at
      ? new Date(msg.created_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      : '';
    time.innerHTML = '⏱️ ' + timeStr;
    meta.appendChild(time);

    var room = roomsById[activeRoomId];
    if (isLoggedIn() && room && room.type === 'channel') {
      var threadBtn = document.createElement('button');
      threadBtn.className = 'btn-thread-msg';
      threadBtn.type = 'button';
      threadBtn.title = '스레드/답글 열기';
      threadBtn.innerHTML = '💬 <span>답글</span>';
      threadBtn.addEventListener('click', function () {
        openThreadFrom(msg);
      });
      meta.appendChild(threadBtn);
    }

    if (isCurrentAdmin() || isMine) {
      var del = document.createElement('button');
      del.className = 'btn-del-msg';
      del.type = 'button';
      del.title = '메시지 삭제';
      del.innerHTML = '🗑️';
      del.addEventListener('click', function () {
        window.deleteChatMessage(msg.id);
      });
      meta.appendChild(del);
    }

    var text = document.createElement('div');
    text.className = 'chat-text-body';
    text.textContent = decodeEntities(msg.message);
    content.appendChild(meta);
    content.appendChild(text);
    wrapper.appendChild(avatarWrap);
    wrapper.appendChild(content);
    return wrapper;
  }

  function appendLiveChatMessage(msg, shouldScroll) {
    if (!msg || msg.id === undefined || msg.id === null) return;
    if (shouldScroll === undefined) shouldScroll = true;
    var roomId = Number(msg.room_id || 1);
    if (roomId !== Number(activeRoomId)) {
      bumpUnread(roomId);
      renderRoomLists();
      renderTabs();
      if (!floatingOpen) {
        var unread = document.getElementById('floating-chat-badge');
        if (unread) unread.style.display = 'inline-block';
      }
      return;
    }

    var main = document.getElementById('chat-messages-container');
    var floating = document.getElementById('floating-chat-messages-container');
    var currentUserId = getCurrentUserId();
    var isMine = currentUserId && String(msg.user_id) === currentUserId;

    if (main && !document.getElementById('chat-msg-' + msg.id)) {
      var bubble = buildBubble(msg);
      bubble.id = 'chat-msg-' + msg.id;
      main.appendChild(bubble);
      if (shouldScroll) main.scrollTop = main.scrollHeight;
    }
    if (floating && !document.getElementById('fchat-msg-' + msg.id)) {
      var fbubble = buildBubble(msg);
      fbubble.id = 'fchat-msg-' + msg.id;
      floating.appendChild(fbubble);
      if (shouldScroll && floatingOpen) floating.scrollTop = floating.scrollHeight;
    }
    if (!floatingOpen && !isMine && shouldScroll) {
      var badge = document.getElementById('floating-chat-badge');
      if (badge) badge.style.display = 'inline-block';
    }
  }

  function bumpUnread(roomId) {
    var room = roomsById[roomId];
    if (!room) {
      roomsById[roomId] = { id: roomId, unread: 1, title: '대화', type: 'channel' };
      return;
    }
    room.unread = 1;
  }

  function handleDeletedChat(data) {
    if (!data || data.id === undefined || data.id === null) return;
    var main = document.getElementById('chat-msg-' + data.id);
    var floating = document.getElementById('fchat-msg-' + data.id);
    if (main) main.remove();
    if (floating) floating.remove();
  }

  async function fetchJson(url, opts) {
    var res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
    var data = await res.json().catch(function () {
      return { success: false, error: '응답 파싱 실패' };
    });
    if (!res.ok && data.success !== false) data.success = false;
    return data;
  }

  function groupRooms() {
    var channels = [];
    var threads = [];
    var dms = [];
    Object.keys(roomsById).forEach(function (key) {
      var room = roomsById[key];
      if (!room) return;
      if (room.type === 'thread') threads.push(room);
      else if (room.type === 'dm') dms.push(room);
      else channels.push(room);
    });
    channels.sort(function (a, b) { return a.id - b.id; });
    return { channels: channels, threads: threads, dms: dms };
  }

  function navButton(room) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-nav-item' + (Number(room.id) === Number(activeRoomId) ? ' active' : '');
    btn.innerHTML = '';
    var icon = document.createElement('span');
    icon.className = 'chat-nav-hash';
    icon.textContent = roomIcon(room.type);
    var name = document.createElement('span');
    name.className = 'chat-nav-name';
    name.textContent = room.title || ('방 ' + room.id);
    btn.appendChild(icon);
    btn.appendChild(name);
    if (room.unread) {
      var dot = document.createElement('span');
      dot.className = 'chat-nav-unread';
      btn.appendChild(dot);
    }
    btn.addEventListener('click', function () {
      var nav = document.getElementById('chat-nav');
      if (nav) nav.classList.remove('open');
      openRoom(room.id, true);
    });
    return btn;
  }

  function renderRoomLists() {
    var grouped = groupRooms();
    var ch = document.getElementById('chat-channel-list');
    var th = document.getElementById('chat-thread-list');
    var dm = document.getElementById('chat-dm-list');
    if (ch) {
      ch.textContent = '';
      grouped.channels.forEach(function (room) { ch.appendChild(navButton(room)); });
    }
    if (th) {
      th.textContent = '';
      if (!grouped.threads.length) {
        var emptyT = document.createElement('div');
        emptyT.className = 'chat-nav-empty';
        emptyT.textContent = '메시지에서 스레드를 열 수 있습니다';
        th.appendChild(emptyT);
      } else {
        grouped.threads.forEach(function (room) { th.appendChild(navButton(room)); });
      }
    }
    if (dm) {
      dm.textContent = '';
      if (!grouped.dms.length) {
        var emptyD = document.createElement('div');
        emptyD.className = 'chat-nav-empty';
        emptyD.textContent = '새 대화로 1대1을 시작하세요';
        dm.appendChild(emptyD);
      } else {
        grouped.dms.forEach(function (room) { dm.appendChild(navButton(room)); });
      }
    }
  }

  function renderTabs() {
    var bar = document.getElementById('chat-open-tabs');
    if (!bar) return;
    bar.textContent = '';
    openRoomIds.forEach(function (id) {
      var room = roomsById[id] || { id: id, title: '대화', type: 'channel' };
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'chat-tab' + (Number(id) === Number(activeRoomId) ? ' active' : '');
      var label = document.createElement('span');
      label.textContent = roomIcon(room.type) + ' ' + (room.title || id);
      tab.appendChild(label);
      if (room.unread && Number(id) !== Number(activeRoomId)) {
        var dot = document.createElement('span');
        dot.className = 'chat-tab-unread';
        tab.appendChild(dot);
      }
      tab.addEventListener('click', function () { openRoom(id, false); });
      if (openRoomIds.length > 1) {
        var close = document.createElement('span');
        close.className = 'chat-tab-close';
        close.textContent = '×';
        close.addEventListener('click', function (e) {
          e.stopPropagation();
          closeRoomTab(id);
        });
        tab.appendChild(close);
      }
      bar.appendChild(tab);
    });
  }

  function updateHeaders() {
    var room = roomsById[activeRoomId] || { title: '광장', type: 'channel' };
    var title = (room.title || '광장');
    var prefix = roomIcon(room.type);
    var top = document.getElementById('channel-header-title');
    if (document.body.getAttribute('data-tab') === 'tab-chat' && top) top.textContent = title;
    var live = document.getElementById('chat-active-title');
    if (live) live.textContent = prefix + ' ' + title;
    var floatTitle = document.getElementById('floating-chat-title');
    if (floatTitle) floatTitle.textContent = prefix + ' ' + title;
    var input = document.getElementById('chat-input');
    if (input) input.placeholder = prefix + title + '에 메시지 보내기';
    var finput = document.getElementById('floating-chat-input');
    if (finput) finput.placeholder = prefix + title + '에 메시지 보내기';
  }

  async function loadRooms() {
    var data = await fetchJson('/api/chat/rooms');
    if (!data.success || !Array.isArray(data.rooms)) return;
    roomsById = {};
    data.rooms.forEach(function (room) {
      roomsById[room.id] = room;
    });
    if (!roomsById[activeRoomId] && data.rooms[0]) activeRoomId = data.rooms[0].id;
    renderRoomLists();
    renderTabs();
    updateHeaders();
  }

  async function loadChatMessages() {
    var main = document.getElementById('chat-messages-container');
    var floating = document.getElementById('floating-chat-messages-container');
    try {
      var data = await fetchJson('/api/chat/messages?roomId=' + encodeURIComponent(activeRoomId));
      if (!data.success || !Array.isArray(data.messages)) throw new Error(data.error || 'fail');
      if (data.room) roomsById[data.room.id] = Object.assign(roomsById[data.room.id] || {}, data.room, { unread: 0 });
      if (main) main.innerHTML = '';
      if (floating) floating.innerHTML = '';
      if (data.messages.length === 0) {
        var empty = '<div class="chat-empty">아직 메시지가 없습니다. 첫 글을 남겨 보세요.</div>';
        if (main) main.innerHTML = empty;
        if (floating) floating.innerHTML = empty;
      } else {
        data.messages.forEach(function (msg) { appendLiveChatMessage(msg, false); });
        if (main) main.scrollTop = main.scrollHeight;
        if (floating) floating.scrollTop = floating.scrollHeight;
        var last = data.messages[data.messages.length - 1];
        if (isLoggedIn() && last) {
          fetchJson('/api/chat/rooms/' + activeRoomId + '/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lastId: last.id })
          }).catch(function () {});
        }
      }
      if (roomsById[activeRoomId]) roomsById[activeRoomId].unread = 0;
      renderRoomLists();
      renderTabs();
      updateHeaders();
    } catch (err) {
      var failed = '<div class="chat-empty chat-empty-error">채팅을 불러오지 못했습니다.</div>';
      if (main) main.innerHTML = failed;
      if (floating) floating.innerHTML = failed;
    }
  }

  async function openRoom(roomId, addTab) {
    roomId = Number(roomId);
    if (!roomId) return;
    activeRoomId = roomId;
    if (addTab !== false && openRoomIds.indexOf(roomId) === -1) {
      openRoomIds.push(roomId);
      if (openRoomIds.length > MAX_OPEN) openRoomIds.shift();
    }
    saveOpenState();
    if (chatSocket && chatSocket.connected) chatSocket.emit('chat:join', { roomId: roomId });
    renderTabs();
    renderRoomLists();
    updateHeaders();
    await loadChatMessages();
  }

  function closeRoomTab(roomId) {
    openRoomIds = openRoomIds.filter(function (id) { return Number(id) !== Number(roomId); });
    if (!openRoomIds.length) openRoomIds = [1];
    if (Number(activeRoomId) === Number(roomId)) activeRoomId = openRoomIds[openRoomIds.length - 1];
    saveOpenState();
    openRoom(activeRoomId, false);
  }

  async function openDmWith(userId) {
    if (!isLoggedIn()) {
      toast('warn', '로그인 필요', '1대1 대화는 로그인 후 이용할 수 있습니다.');
      return;
    }
    if (!userId || String(userId) === getCurrentUserId()) return;
    var data = await fetchJson('/api/chat/rooms/dm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: String(userId) })
    });
    if (!data.success || !data.room) {
      toast('error', '1대1 실패', data.error || '대화를 열지 못했습니다.');
      return;
    }
    roomsById[data.room.id] = Object.assign(roomsById[data.room.id] || {}, data.room);
    hideDmPicker();
    await openRoom(data.room.id, true);
  }

  async function openThreadFrom(msg) {
    if (!isLoggedIn()) {
      toast('warn', '로그인 필요', '스레드는 로그인 후 이용할 수 있습니다.');
      return;
    }
    var data = await fetchJson('/api/chat/rooms/thread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentRoomId: activeRoomId,
        parentMessageId: msg.id
      })
    });
    if (!data.success || !data.room) {
      toast('error', '스레드 실패', data.error || '스레드를 열지 못했습니다.');
      return;
    }
    roomsById[data.room.id] = Object.assign(roomsById[data.room.id] || {}, data.room);
    await openRoom(data.room.id, true);
  }

  function hideDmPicker() {
    var modal = document.getElementById('chat-dm-modal');
    if (modal) modal.style.display = 'none';
  }

  function showDmPicker() {
    var modal = document.getElementById('chat-dm-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    renderPeople();
  }

  async function renderPeople() {
    var box = document.getElementById('chat-dm-people');
    if (!box) return;
    box.textContent = '불러오는 중...';
    var data = await fetchJson('/api/chat/people');
    if (!data.success) {
      box.textContent = data.error || '목록을 불러오지 못했습니다.';
      return;
    }
    peopleCache = data.people || [];
    box.textContent = '';
    if (!peopleCache.length) {
      box.textContent = '대화를 시작할 유저가 없습니다.';
      return;
    }
    peopleCache.forEach(function (person) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-people-item';
      btn.textContent = '@' + person.username;
      btn.addEventListener('click', function () { openDmWith(person.id); });
      box.appendChild(btn);
    });
  }

  function toggleFloatingChat() {
    var drawer = document.getElementById('floating-chat-drawer');
    var badge = document.getElementById('floating-chat-badge');
    if (!drawer) return;
    floatingOpen = !floatingOpen;
    drawer.style.display = floatingOpen ? 'flex' : 'none';
    if (floatingOpen) {
      if (badge) badge.style.display = 'none';
      loadChatMessages();
      var input = document.getElementById('floating-chat-input');
      if (input) setTimeout(function () { input.focus(); }, 50);
    }
  }

  function startChatFallback() {
    if (chatFallback || typeof window.EventSource === 'undefined') return;
    chatFallback = new EventSource('/api/stream');
    chatFallback.onmessage = function (event) {
      try {
        var data = JSON.parse(event.data);
        if (data.type === 'CHAT_MESSAGE' && data.message) appendLiveChatMessage(data.message, true);
      } catch (e) {}
    };
    chatFallback.onerror = function () {
      if (chatFallback) {
        chatFallback.close();
        chatFallback = null;
      }
    };
  }

  function stopChatFallback() {
    if (!chatFallback) return;
    chatFallback.close();
    chatFallback = null;
  }

  function getChatSocket() {
    if (chatSocket) return chatSocket;
    if (typeof window.io !== 'function') {
      startChatFallback();
      return null;
    }
    chatSocket = window.io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 8000
    });
    chatSocket.on('connect', function () {
      stopChatFallback();
      chatSocket.emit('chat:join', { roomId: activeRoomId });
    });
    chatSocket.on('connect_error', function () { startChatFallback(); });
    chatSocket.on('disconnect', function () { startChatFallback(); });
    chatSocket.on('chat:message', function (msg) { appendLiveChatMessage(msg, true); });
    chatSocket.on('chat:deleted', handleDeletedChat);
    chatSocket.on('chat:room', function (room) {
      if (!room || !room.id) return;
      roomsById[room.id] = Object.assign(roomsById[room.id] || {}, room);
      renderRoomLists();
    });
    return chatSocket;
  }

  async function sendChatViaHttp(text) {
    return fetchJson('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, roomId: activeRoomId })
    });
  }

  function sendChatMessage(text) {
    var socket = getChatSocket();
    if (!socket || !socket.connected) return sendChatViaHttp(text);
    return new Promise(function (resolve) {
      socket.timeout(8000).emit('chat:send', { message: text, roomId: activeRoomId }, function (err, data) {
        if (err) {
          resolve({ success: false, error: '실시간 채팅 응답 시간이 초과되었습니다. 다시 시도해주세요.' });
          return;
        }
        resolve(data || { success: false, error: '채팅 서버 응답이 올바르지 않습니다.' });
      });
    });
  }

  async function submitChat(inputId, buttonId) {
    var input = document.getElementById(inputId);
    var btn = document.getElementById(buttonId);
    if (!input) return;
    var text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    if (btn) btn.disabled = true;
    try {
      var data = await sendChatMessage(text);
      if (!data.success) {
        toast('error', '채팅 실패', data.error || '채팅 전송에 실패했습니다.');
        return;
      }
      input.value = '';
      if (data.message) appendLiveChatMessage(data.message, true);
    } catch (err) {
      toast('error', '통신 오류', '채팅 서버와 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      if (btn) btn.disabled = false;
      input.focus();
    }
  }

  async function deleteChatMessage(id) {
    if (!id) return;
    if (!window.confirm('이 메시지를 삭제하시겠습니까?')) return;
    try {
      var data = await fetchJson('/api/chat/message/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!data.success) {
        toast('error', '삭제 실패', data.error || '삭제 권한이 없습니다.');
        return;
      }
      handleDeletedChat({ id: id });
    } catch (err) {
      toast('error', '삭제 실패', '채팅 삭제 요청에 실패했습니다.');
    }
  }

  function insertEmoji(emoji, inputId) {
    var input = document.getElementById(inputId);
    if (!input) return;
    input.value += emoji;
    input.focus();
  }

  window.appendLiveChatMessage = appendLiveChatMessage;
  window.loadChatMessages = loadChatMessages;
  window.toggleFloatingChat = toggleFloatingChat;
  window.deleteChatMessage = deleteChatMessage;
  window.handleSendChat = function (e) {
    if (e) e.preventDefault();
    return submitChat('chat-input', 'chat-submit-btn');
  };
  window.handleSendFloatingChat = function (e) {
    if (e) e.preventDefault();
    return submitChat('floating-chat-input', 'floating-chat-submit-btn');
  };
  window.insertEmoji = function (emoji) { insertEmoji(emoji, 'chat-input'); };
  window.insertFloatingEmoji = function (emoji) { insertEmoji(emoji, 'floating-chat-input'); };
  window.openPlazaDmPicker = showDmPicker;
  window.closePlazaDmPicker = hideDmPicker;

  loadOpenState();
  getChatSocket();

  async function boot() {
    await loadRooms();
    await openRoom(activeRoomId, true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
