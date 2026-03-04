const { pool } = require('../config/database');

// In-memory rate limit: max 5 messages per 10s per user.
// userId -> [timestamps(ms)]
const rateLimitBuckets = new Map();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 1000;

async function getCurrentGameContextForUser(userId) {
  const { rows } = await pool.query(
    `select
       g.id as game_id,
       g.status,
       g.phase_number,
       r.code as room_code
     from games g
     join rooms r on r.id = g.room_id
     join room_players rp on rp.room_id = r.id
     where rp.user_id = $1
     order by g.id desc
     limit 1`,
    [userId]
  );
  return rows[0] || null;
}

async function isPlayerAlive(gameId, userId) {
  const { rows } = await pool.query(
    `select is_alive
     from game_players
     where game_id = $1 and user_id = $2
     limit 1`,
    [gameId, userId]
  );
  if (!rows[0]) return false;
  return rows[0].is_alive === true;
}

async function getPlayerRole(gameId, userId) {
  const { rows } = await pool.query(
    `select role
     from game_players
     where game_id = $1 and user_id = $2
     limit 1`,
    [gameId, userId]
  );
  if (!rows[0]) return null;
  return rows[0].role;
}

function checkRateLimit(userId) {
  const now = Date.now();
  const key = String(userId);
  const bucket = rateLimitBuckets.get(key) || [];
  const fresh = bucket.filter((ts) => now - ts <= RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT_MAX) {
    rateLimitBuckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  rateLimitBuckets.set(key, fresh);
  return true;
}

module.exports = function chatHandler(io, socket) {
  socket.on('chat:message', async (data) => {
    try {
      const rawMessage = (data && data.message) || '';
      const type = (data && data.type) || 'public';

      let message = String(rawMessage || '').trim();
      if (!message) {
        socket.emit('chat:error', { message: 'Pesan tidak boleh kosong' });
        return;
      }
      if (message.length > 200) {
        message = message.slice(0, 200);
      }

      if (!checkRateLimit(socket.user.id)) {
        socket.emit('chat:error', { message: 'Terlalu banyak pesan, coba lagi sebentar lagi' });
        return;
      }

      const ctx = await getCurrentGameContextForUser(socket.user.id);
      if (!ctx) {
        socket.emit('chat:error', { message: 'Konteks game tidak ditemukan' });
        return;
      }

      const { game_id: gameId, status: phase, room_code: roomCode } = ctx;

      const alive = await isPlayerAlive(gameId, socket.user.id);
      if (!alive) {
        socket.emit('chat:error', { message: 'Pemain yang sudah mati tidak bisa mengirim pesan' });
        return;
      }

      if (type === 'public') {
        if (phase !== 'discussion') {
          socket.emit('chat:error', { message: 'Chat publik hanya tersedia saat phase discussion' });
          return;
        }
      } else if (type === 'mafia') {
        if (phase !== 'night') {
          socket.emit('chat:error', { message: 'Chat mafia hanya tersedia saat phase night' });
          return;
        }

        const role = await getPlayerRole(gameId, socket.user.id);
        if (role !== 'mafia') {
          socket.emit('chat:error', { message: 'Hanya mafia yang bisa mengirim chat mafia' });
          return;
        }
      } else {
        socket.emit('chat:error', { message: 'Tipe chat tidak dikenal' });
        return;
      }

      const payload = {
        from: socket.user.username,
        message,
        timestamp: new Date().toISOString(),
        type
      };

      if (type === 'public') {
        io.to(`room:${roomCode}`).emit('chat:message', payload);
      } else if (type === 'mafia') {
        io.to(`mafia:${gameId}`).emit('chat:message', payload);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error in chat:message handler:', err);
      socket.emit('chat:error', { message: 'Gagal mengirim pesan' });
    }
  });
};

