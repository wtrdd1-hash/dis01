/**
 * 🦆 월덕 메타버스 광장 (Duck Metaverse Plaza) 2D 인터랙티브 클라이언트
 */
(function() {
  'use strict';

  class MetaversePlazaEngine {
    constructor(canvasId, containerId) {
      this.canvas = document.getElementById(canvasId);
      this.container = document.getElementById(containerId);
      if (!this.canvas) return;

      this.ctx = this.canvas.getContext('2d');
      this.socket = null;
      
      const user = window.__currentUser || { id: 'guest_' + Math.random().toString(36).slice(2, 8), username: '월덕', avatar: '' };
      this.selfId = String(user.id || 'guest');
      
      this.players = new Map();
      this.myPlayer = {
        id: this.selfId,
        username: user.username || '월덕',
        avatar: user.avatar || '',
        loadout: {},
        x: 600,
        y: 450,
        targetX: 600,
        targetY: 450,
        dir: 'down',
        speech: null,
        emote: null
      };
      this.players.set(this.selfId, this.myPlayer);

      this.keys = {};
      this.speed = 5;
      this.bounds = { minX: 40, maxX: 1160, minY: 40, maxY: 680 };
      this.targetPos = null;
      this.avatarCache = new Map();

      // 로컬 유저 칭호/외형 프리패치
      try {
        fetch('/api/economy/cosmetics/loadout')
          .then(r => r.json())
          .then(data => {
            if (data && data.loadout && this.myPlayer) {
              this.myPlayer.loadout = data.loadout;
            }
          }).catch(() => {});
      } catch (e) {}

      this.zones = [
        { id: 'shop', name: '🛍️ 명품 부티크', x: 220, y: 180, w: 140, h: 100, color: '#fbbf24', url: '/shop' },
        { id: 'stock', name: '📈 주식 거래소', x: 920, y: 180, w: 140, h: 100, color: '#38bdf8', url: '/#tab-stocks' },
        { id: 'casino', name: '🎰 카지노 팰리스', x: 220, y: 520, w: 140, h: 100, color: '#f43f5e', url: '/#tab-casino' },
        { id: 'duckhouse', name: '🏰 덕하우스 갤러리', x: 920, y: 520, w: 140, h: 100, color: '#a855f7', url: '/shop#tab-duckhouse' }
      ];

      this.particles = [];
      this.initCanvasSize();
      this.initEvents();
      this.initSocket();
      this.startLoop();
    }

    initCanvasSize() {
      this.canvas.width = 1200;
      this.canvas.height = 720;
    }

    initEvents() {
      window.addEventListener('keydown', (e) => {
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
        this.keys[e.key.toLowerCase()] = true;
        this.keys[e.code] = true;
      });

      window.addEventListener('keyup', (e) => {
        this.keys[e.key.toLowerCase()] = false;
        this.keys[e.code] = false;
      });

      this.canvas.addEventListener('mousedown', (e) => {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const clickX = (e.clientX - rect.left) * scaleX;
        const clickY = (e.clientY - rect.top) * scaleY;

        // 구역 클릭 검사
        for (const z of this.zones) {
          if (clickX >= z.x - z.w/2 && clickX <= z.x + z.w/2 && clickY >= z.y - z.h/2 && clickY <= z.y + z.h/2) {
            window.location.href = z.url;
            return;
          }
        }

        this.targetPos = { x: clickX, y: clickY };
      });
    }

    initSocket() {
      try {
        if (typeof io === 'undefined') return;
        const socketUrl = window.location.origin;
        this.socket = io(socketUrl + '/metaverse', {
          transports: ['websocket', 'polling']
        });

        this.socket.on('connect', () => {
          const user = window.__currentUser || { id: this.selfId, username: this.myPlayer.username };
          this.socket.emit('metaverse:join', {
            id: user.id,
            username: user.username,
            avatar: user.avatarUrl || user.avatar,
            x: this.myPlayer.x,
            y: this.myPlayer.y
          });
        });

        this.socket.on('metaverse:init', (data) => {
          if (data && data.selfId) this.selfId = String(data.selfId);
          if (data && data.bounds) this.bounds = data.bounds;
          if (data && Array.isArray(data.players)) {
            data.players.forEach(p => {
              const pid = String(p.id);
              if (pid === this.selfId && this.myPlayer) {
                this.myPlayer.loadout = p.loadout || this.myPlayer.loadout;
              } else {
                this.players.set(pid, {
                  ...p,
                  id: pid,
                  targetX: p.x,
                  targetY: p.y,
                  speech: null,
                  emote: null
                });
              }
            });
          }
        });

        this.socket.on('metaverse:player_joined', (p) => {
          const pid = String(p.id);
          if (pid !== this.selfId) {
            this.players.set(pid, { ...p, id: pid, targetX: p.x, targetY: p.y, speech: null, emote: null });
          }
        });

        this.socket.on('metaverse:player_moved', (data) => {
          const pid = String(data.id);
          const p = this.players.get(pid);
          if (p) {
            p.targetX = data.x;
            p.targetY = data.y;
            p.dir = data.dir;
          }
        });

        this.socket.on('metaverse:player_chat', (data) => {
          const pid = String(data.id);
          const p = this.players.get(pid);
          if (p) {
            p.speech = { text: data.text, ts: Date.now() };
          }
        });

        this.socket.on('metaverse:player_emote', (data) => {
          const pid = String(data.id);
          const p = this.players.get(pid);
          if (p) {
            p.emote = { type: data.emote, ts: Date.now() };
          }
        });

        this.socket.on('metaverse:player_left', (data) => {
          const pid = String(data.id);
          this.players.delete(pid);
        });
      } catch (err) {
        console.error('[MetaversePlaza] initSocket error:', err);
      }
    }

    sendChat(text) {
      if (!text || !this.socket) return;
      this.socket.emit('metaverse:chat', { text });
    }

    sendEmote(type) {
      if (!this.socket) return;
      this.socket.emit('metaverse:emote', { emote: type });
    }

    update() {
      if (!this.myPlayer) return;

      let dx = 0;
      let dy = 0;

      if (this.keys['arrowleft'] || this.keys['keya']) dx -= 1;
      if (this.keys['arrowright'] || this.keys['keyd']) dx += 1;
      if (this.keys['arrowup'] || this.keys['keyw']) dy -= 1;
      if (this.keys['arrowdown'] || this.keys['keys']) dy += 1;

      if (dx !== 0 || dy !== 0) {
        this.targetPos = null;
        const len = Math.hypot(dx, dy) || 1;
        this.myPlayer.x += (dx / len) * this.speed;
        this.myPlayer.y += (dy / len) * this.speed;
        this.myPlayer.dir = dx < 0 ? 'left' : (dx > 0 ? 'right' : (dy < 0 ? 'up' : 'down'));
        this.clampPlayer(this.myPlayer);
        this.emitMove();
      } else if (this.targetPos) {
        const tdx = this.targetPos.x - this.myPlayer.x;
        const tdy = this.targetPos.y - this.myPlayer.y;
        const dist = Math.hypot(tdx, tdy);
        if (dist > 5) {
          this.myPlayer.x += (tdx / dist) * this.speed;
          this.myPlayer.y += (tdy / dist) * this.speed;
          this.myPlayer.dir = Math.abs(tdx) > Math.abs(tdy) ? (tdx < 0 ? 'left' : 'right') : (tdy < 0 ? 'up' : 'down');
          this.clampPlayer(this.myPlayer);
          this.emitMove();
        } else {
          this.targetPos = null;
        }
      }

      // 다른 플레이어 위치 부드러운 보간 (Lerp)
      this.players.forEach(p => {
        if (p.id !== this.selfId && p.targetX !== undefined) {
          p.x += (p.targetX - p.x) * 0.25;
          p.y += (p.targetY - p.y) * 0.25;
        }
      });
    }

    clampPlayer(p) {
      p.x = Math.max(this.bounds.minX, Math.min(this.bounds.maxX, p.x));
      p.y = Math.max(this.bounds.minY, Math.min(this.bounds.maxY, p.y));
    }

    emitMove() {
      const now = Date.now();
      if (!this._lastMoveEmit || now - this._lastMoveEmit > 40) {
        this._lastMoveEmit = now;
        this.socket.emit('metaverse:move', {
          x: Math.round(this.myPlayer.x),
          y: Math.round(this.myPlayer.y),
          dir: this.myPlayer.dir
        });
      }
    }

    draw() {
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;

      // 1. 바닥 배경 렌더링
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, w, h);

      // 격자 타일
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = 0; y < h; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // 2. 중앙 분수대 광장
      const time = Date.now() * 0.002;
      ctx.save();
      ctx.fillStyle = 'rgba(56, 189, 248, 0.12)';
      ctx.beginPath();
      ctx.arc(600, 360, 90 + Math.sin(time) * 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(600, 360, 65, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.font = '36px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('⛲', 600, 360);
      ctx.restore();

      // 3. 건물 구역 렌더링
      this.zones.forEach(z => {
        ctx.save();
        ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
        ctx.strokeStyle = z.color;
        ctx.lineWidth = 2;
        ctx.shadowColor = z.color;
        ctx.shadowBlur = 10;

        const rx = z.x - z.w / 2;
        const ry = z.y - z.h / 2;
        ctx.beginPath();
        ctx.roundRect(rx, ry, z.w, z.h, 16);
        ctx.fill();
        ctx.stroke();

        ctx.shadowBlur = 0;
        ctx.font = 'bold 14px Pretendard, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.fillText(z.name, z.x, z.y - 8);

        ctx.font = '11px sans-serif';
        ctx.fillStyle = z.color;
        ctx.fillText('클릭하여 입장 ➔', z.x, z.y + 16);
        ctx.restore();
      });

      // 4. 클릭 이동 타겟 핑
      if (this.targetPos) {
        ctx.save();
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(this.targetPos.x, this.targetPos.y, 8 + Math.sin(Date.now() * 0.01) * 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 5. 플레이어 렌더링 (Y좌표 정렬로 원근감 구현)
      const sortedPlayers = Array.from(this.players.values()).sort((a, b) => a.y - b.y);
      sortedPlayers.forEach(p => this.drawPlayer(p));
    }

    drawPlayer(p) {
      const ctx = this.ctx;
      const x = p.x;
      let y = p.y;
      const isSelf = p.id === this.selfId;
      const loadout = p.loadout || {};

      // 이모트 애니메이션 (점프)
      let jumpOffset = 0;
      if (p.emote && (Date.now() - p.emote.ts) < 1000) {
        const progress = (Date.now() - p.emote.ts) / 1000;
        if (p.emote.type === 'jump') {
          jumpOffset = Math.sin(progress * Math.PI) * 25;
        }
      }
      y -= jumpOffset;

      // 그림자
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.ellipse(x, p.y + 18, 18, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 내 캐릭터 식별 오라 링
      if (isSelf) {
        ctx.save();
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, p.y + 18, 22 + Math.sin(Date.now() * 0.006) * 3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 프로필 테두리 (PROFILE_FRAME)
      ctx.save();
      const frame = loadout.PROFILE_FRAME;
      let frameColor = isSelf ? '#38bdf8' : '#64748b';
      if (frame && frame.name) {
        if (frame.name.includes('성운') || frame.name.includes('오로라')) frameColor = '#ec4899';
        else if (frame.name.includes('황금') || frame.name.includes('월계관')) frameColor = '#f59e0b';
        else if (frame.name.includes('사이버') || frame.name.includes('서킷')) frameColor = '#06b6d4';
        else frameColor = '#818cf8';

        ctx.shadowColor = frameColor;
        ctx.shadowBlur = 12;
      }

      ctx.strokeStyle = frameColor;
      ctx.lineWidth = 3;
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.arc(x, y, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // 캐릭터 아바타 이미지 또는 기본 오리 🦆
      let renderedAvatar = false;
      if (p.avatar && p.avatar.startsWith('http')) {
        let img = this.avatarCache.get(p.avatar);
        if (!img) {
          img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = p.avatar;
          this.avatarCache.set(p.avatar, img);
        }
        if (img.complete && img.naturalWidth !== 0) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, 18, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, x - 18, y - 18, 36, 36);
          ctx.restore();
          renderedAvatar = true;
        }
      }

      if (!renderedAvatar) {
        ctx.save();
        ctx.font = '22px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🦆', x, y);
        ctx.restore();
      }

      // 배지 (BADGE) & 칭호 (TITLE)
      let badgeText = isSelf ? '👑 [나] ' : '';
      if (loadout.BADGE && loadout.BADGE.name) badgeText += (loadout.BADGE.icon || '⭐') + ' ';
      if (loadout.TITLE && loadout.TITLE.name) badgeText += `[${loadout.TITLE.name}] `;
      else if (!isSelf && !badgeText) badgeText = '[테스터] ';

      if (badgeText) {
        ctx.save();
        ctx.font = 'bold 10.5px Pretendard, sans-serif';
        ctx.fillStyle = isSelf ? '#38bdf8' : '#fbbf24';
        ctx.textAlign = 'center';
        ctx.fillText(badgeText, x, y - 36);
        ctx.restore();
      }

      // 닉네임 컬러 (NAME_COLOR)
      ctx.save();
      const nameColorItem = loadout.NAME_COLOR;
      let nameColor = isSelf ? '#38bdf8' : '#ffffff';
      if (nameColorItem && nameColorItem.name) {
        if (nameColorItem.name.includes('사이언') || nameColorItem.name.includes('네온')) nameColor = '#22d3ee';
        else if (nameColorItem.name.includes('퍼플') || nameColorItem.name.includes('일렉트릭')) nameColor = '#c084fc';
        else if (nameColorItem.name.includes('골드') || nameColorItem.name.includes('황금')) nameColor = '#fbbf24';
        else nameColor = '#f43f5e';

        ctx.shadowColor = nameColor;
        ctx.shadowBlur = 8;
      }

      ctx.font = 'bold 12.5px Pretendard, sans-serif';
      ctx.fillStyle = nameColor;
      ctx.textAlign = 'center';
      ctx.fillText(p.username, x, y - 23);
      ctx.restore();

      // 이모트 플로팅 아이콘 (하트, 돈뿌리기, 인사)
      if (p.emote && (Date.now() - p.emote.ts) < 1500) {
        const emoteProgress = (Date.now() - p.emote.ts) / 1500;
        let emoteChar = '✨';
        if (p.emote.type === 'heart') emoteChar = '❤️';
        else if (p.emote.type === 'money') emoteChar = '💸';
        else if (p.emote.type === 'wave') emoteChar = '👋';

        ctx.save();
        ctx.font = '24px sans-serif';
        ctx.textAlign = 'center';
        ctx.globalAlpha = 1 - emoteProgress;
        ctx.fillText(emoteChar, x, y - 48 - (emoteProgress * 25));
        ctx.restore();
      }

      // 말풍선 (Speech Bubble)
      if (p.speech && (Date.now() - p.speech.ts) < 5000) {
        this.drawSpeechBubble(x, y - 45, p.speech.text, Date.now() - p.speech.ts);
      }
    }

    drawSpeechBubble(x, y, text, age) {
      const ctx = this.ctx;
      ctx.save();

      const alpha = age > 4000 ? (5000 - age) / 1000 : 1;
      ctx.globalAlpha = alpha;

      ctx.font = '12px Pretendard, sans-serif';
      const textWidth = ctx.measureText(text).width;
      const bubbleW = Math.max(60, textWidth + 24);
      const bubbleH = 28;
      const bx = x - bubbleW / 2;
      const by = y - bubbleH;

      // 말풍선 배경
      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
      ctx.shadowBlur = 8;

      ctx.beginPath();
      ctx.roundRect(bx, by, bubbleW, bubbleH, 10);
      ctx.fill();
      ctx.stroke();

      // 말풍선 꼬리
      ctx.beginPath();
      ctx.moveTo(x - 5, by + bubbleH);
      ctx.lineTo(x, by + bubbleH + 6);
      ctx.lineTo(x + 5, by + bubbleH);
      ctx.fill();
      ctx.stroke();

      // 텍스트
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, by + bubbleH / 2);
      ctx.restore();
    }

    startLoop() {
      const loop = () => {
        this.update();
        this.draw();
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    }
  }

  window.MetaversePlazaEngine = MetaversePlazaEngine;
})();
