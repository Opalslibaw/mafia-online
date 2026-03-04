const {
  getRoomWithPlayersByCode,
  getPlayersForRoom,
  togglePlayerReady
} = require('../models/roomModel');

function serializeRoom(room) {
  if (!room) return null;
  return {
    code: room.code,
    hostId: room.host_id,
    status: room.status,
    createdAt: room.created_at,
    startedAt: room.started_at
  };
}

function serializePlayers(players) {
  return players.map((p) => ({
    id: p.user_id,
    username: p.username,
    isHost: p.is_host,
    isReady: p.is_ready
  }));
}

module.exports = function roomHandler(io, socket) {
  // Join room (Socket.io room) berdasarkan roomCode
  socket.on('room:join', async (data) => {
    try {
      const { roomCode } = data || {};
      if (!roomCode) {
        socket.emit('room:error', { message: 'roomCode wajib diisi' });
        return;
      }

      const { room, players } = await getRoomWithPlayersByCode(roomCode);
      if (!room) {
        socket.emit('room:error', { message: 'Room tidak ditemukan' });
        return;
      }

      if (room.status !== 'waiting') {
        socket.emit('room:error', { message: 'Room tidak dalam status waiting' });
        return;
      }

      const roomName = `room:${room.code}`;
      socket.join(roomName);

      io.to(roomName).emit('room:updated', {
        room: serializeRoom(room),
        players: serializePlayers(players)
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error in room:join handler:', err);
      socket.emit('room:error', { message: 'Gagal join room' });
    }
  });

  // Leave room (Socket.io room)
  socket.on('room:leave', async (data) => {
    try {
      const { roomCode } = data || {};
      if (!roomCode) {
        socket.emit('room:error', { message: 'roomCode wajib diisi' });
        return;
      }

      const { room } = await getRoomWithPlayersByCode(roomCode);
      if (!room) {
        socket.emit('room:error', { message: 'Room tidak ditemukan' });
        return;
      }

      const roomName = `room:${room.code}`;
      socket.leave(roomName);

      const players = await getPlayersForRoom(room.id);

      io.to(roomName).emit('room:updated', {
        room: serializeRoom(room),
        players: serializePlayers(players)
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error in room:leave handler:', err);
      socket.emit('room:error', { message: 'Gagal keluar dari room' });
    }
  });

  // Toggle ready status player
  socket.on('room:ready', async (data) => {
    try {
      const { roomCode } = data || {};
      if (!roomCode) {
        socket.emit('room:error', { message: 'roomCode wajib diisi' });
        return;
      }

      const { room } = await getRoomWithPlayersByCode(roomCode);
      if (!room) {
        socket.emit('room:error', { message: 'Room tidak ditemukan' });
        return;
      }

      if (room.status !== 'waiting') {
        socket.emit('room:error', { message: 'Tidak bisa toggle ready saat game sudah dimulai' });
        return;
      }

      await togglePlayerReady(room.id, socket.user.id);
      const players = await getPlayersForRoom(room.id);

      const roomName = `room:${room.code}`;

      io.to(roomName).emit('room:updated', {
        room: serializeRoom(room),
        players: serializePlayers(players)
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error in room:ready handler:', err);
      socket.emit('room:error', { message: 'Gagal toggle ready' });
    }
  });
};

