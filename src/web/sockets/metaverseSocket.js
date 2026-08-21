'use strict';

const CosmeticLoadoutService = require('../../core/economy/CosmeticLoadoutService');

const activePlayers = new Map(); // socketId -> playerState
const MAP_BOUNDS = { minX: 40, maxX: 1160, minY: 40, maxY: 680 };

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function attachMetaverseSocket(io) {
  const plazaNsp = io.of('/metaverse');

  plazaNsp.on('connection', (socket) => {
    socket.on('metaverse:join', async (data) => {
      try {
        const userId = String(data?.id || socket.id);
        const username = String(data?.username || '여행자').slice(0, 20);
        const avatar = String(data?.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png');

        // 최신 외형 로드아웃 조회
        let loadout = {};
        try {
          const res = await CosmeticLoadoutService.getUserLoadout(userId);
          if (res && res.loadout) loadout = res.loadout;
        } catch (e) {}

        const startX = clamp(Number(data?.x) || (500 + Math.floor(Math.random() * 200)), MAP_BOUNDS.minX, MAP_BOUNDS.maxX);
        const startY = clamp(Number(data?.y) || (300 + Math.floor(Math.random() * 150)), MAP_BOUNDS.minY, MAP_BOUNDS.maxY);

        const playerState = {
          socketId: socket.id,
          id: userId,
          username,
          avatar,
          loadout,
          x: startX,
          y: startY,
          dir: 'down',
          lastActionAt: Date.now()
        };

        activePlayers.set(socket.id, playerState);

        // 현재 맵의 모든 유저 목록 전송
        const playerList = Array.from(activePlayers.values());
        socket.emit('metaverse:init', {
          selfId: userId,
          players: playerList,
          bounds: MAP_BOUNDS
        });

        // 다른 유저들에게 입장 브로드캐스트
        socket.broadcast.emit('metaverse:player_joined', playerState);
      } catch (err) {
        console.error('[Metaverse] join error:', err);
      }
    });

    socket.on('metaverse:move', (data) => {
      const player = activePlayers.get(socket.id);
      if (!player) return;

      const targetX = clamp(Number(data?.x) || player.x, MAP_BOUNDS.minX, MAP_BOUNDS.maxX);
      const targetY = clamp(Number(data?.y) || player.y, MAP_BOUNDS.minY, MAP_BOUNDS.maxY);
      const dir = String(data?.dir || player.dir);

      player.x = targetX;
      player.y = targetY;
      player.dir = dir;
      player.lastActionAt = Date.now();

      socket.broadcast.emit('metaverse:player_moved', {
        id: player.id,
        x: targetX,
        y: targetY,
        dir
      });
    });

    socket.on('metaverse:chat', (data) => {
      const player = activePlayers.get(socket.id);
      if (!player) return;

      const rawText = String(data?.text || '').trim().slice(0, 100);
      if (!rawText) return;

      const chatPayload = {
        id: player.id,
        username: player.username,
        text: rawText,
        loadout: player.loadout,
        timestamp: Date.now()
      };

      plazaNsp.emit('metaverse:player_chat', chatPayload);
    });

    socket.on('metaverse:emote', (data) => {
      const player = activePlayers.get(socket.id);
      if (!player) return;

      const emote = String(data?.emote || 'jump').slice(0, 10);
      plazaNsp.emit('metaverse:player_emote', {
        id: player.id,
        emote,
        timestamp: Date.now()
      });
    });

    socket.on('disconnect', () => {
      const player = activePlayers.get(socket.id);
      if (player) {
        activePlayers.delete(socket.id);
        plazaNsp.emit('metaverse:player_left', { id: player.id });
      }
    });
  });
}

module.exports = { attachMetaverseSocket };
