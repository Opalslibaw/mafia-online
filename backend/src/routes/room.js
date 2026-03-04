const express = require('express');
const crypto = require('crypto');

const { auth } = require('../middleware/auth');
const {
  createRoomWithHost,
  getRoomWithPlayersByCode,
  addPlayerToRoom,
  getPlayersForRoom,
  startGameForRoom
} = require('../models/roomModel');

const MAX_PLAYERS = 10;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const length = 6;
  let code = '';
  for (let i = 0; i < length; i += 1) {
    const idx = crypto.randomInt(0, chars.length);
    code += chars[idx];
  }
  return code;
}

function serializeRoom(room) {
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

const router = express.Router();

// All room endpoints require auth
router.use(auth);

router.post('/create', async (req, res, next) => {
  try {
    // Generate unique code; if conflict, retry a few times.
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateRoomCode();
      try {
        const { room } = await createRoomWithHost({
          code,
          hostUserId: req.user.id
        });
        res.status(201).json({
          ok: true,
          room: serializeRoom(room)
        });
        return;
      } catch (err) {
        console.error('Error detail (create room attempt):', err);
        lastError = err;
        if (!(err && err.code === '23505')) {
          throw err;
        }
      }
    }
    throw lastError || httpError(500, 'Gagal membuat room');
  } catch (err) {
    console.error('Error detail (create room):', err);
    next(err);
  }
});

router.post('/join', async (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (!code) throw httpError(400, 'Kode room wajib diisi');

    const { room, players } = await getRoomWithPlayersByCode(code);
    if (!room) throw httpError(404, 'Room tidak ditemukan');
    if (room.status !== 'waiting') throw httpError(400, 'Room tidak dalam status waiting');

    const alreadyInRoom = players.some((p) => p.user_id === req.user.id);
    if (alreadyInRoom) throw httpError(400, 'Sudah bergabung di room ini');

    if (players.length >= MAX_PLAYERS) throw httpError(400, 'Room sudah penuh');

    await addPlayerToRoom(room.id, req.user.id);
    const updatedPlayers = await getPlayersForRoom(room.id);

    res.json({
      ok: true,
      room: serializeRoom(room),
      players: serializePlayers(updatedPlayers)
    });
  } catch (err) {
    console.error('Error detail (join room):', err);
    next(err);
  }
});

router.get('/:code', async (req, res, next) => {
  try {
    const { code } = req.params;
    const { room, players } = await getRoomWithPlayersByCode(code);
    if (!room) throw httpError(404, 'Room tidak ditemukan');

    res.json({
      ok: true,
      room: serializeRoom(room),
      players: serializePlayers(players)
    });
  } catch (err) {
    console.error('Error detail (get room):', err);
    next(err);
  }
});

router.post('/:code/ready', async (req, res, next) => {
  try {
    const { code } = req.params;
    const { room } = await getRoomWithPlayersByCode(code);
    if (!room) throw httpError(404, 'Room tidak ditemukan');
    if (room.status !== 'waiting') throw httpError(400, 'Tidak bisa toggle ready saat game sudah dimulai');

    await addPlayerToRoom(room.id, req.user.id).catch((err) => {
      // ignore duplicate error (means already in room)
      if (!(err && err.code === '23505')) throw err;
    });

    const { togglePlayerReady, getRoomWithPlayersByCode: _unused } = require('../models/roomModel'); // lazy require to avoid cycle
    await togglePlayerReady(room.id, req.user.id);
    const { players } = await getRoomWithPlayersByCode(code);

    res.json({
      ok: true,
      room: serializeRoom(room),
      players: serializePlayers(players)
    });
  } catch (err) {
    console.error('Error detail (toggle ready):', err);
    next(err);
  }
});

router.post('/:code/start', async (req, res, next) => {
  try {
    const { code } = req.params;
    const { room, players } = await getRoomWithPlayersByCode(code);
    if (!room) throw httpError(404, 'Room tidak ditemukan');

    if (room.host_id !== req.user.id) {
      throw httpError(403, 'Hanya host yang bisa memulai game');
    }

    if (players.length < 4) {
      throw httpError(400, 'Minimal 4 pemain untuk memulai game');
    }

    const allReady = players.every((p) => p.is_ready);
    if (!allReady) {
      throw httpError(400, 'Semua pemain harus ready untuk memulai game');
    }

    const result = await startGameForRoom(code);

    res.json({
      ok: true,
      room: serializeRoom(result.room),
      players: serializePlayers(result.players)
    });
  } catch (err) {
    console.error('Error detail (start game):', err);
    next(err);
  }
});

module.exports = { roomRouter: router };

