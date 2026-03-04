const { pool } = require('../config/database');
const {
  startGame,
  transitionPhase,
  checkWinCondition,
  eliminatePlayer
} = require('../services/gameService');
const {
  castVote,
  tallyVotes,
  submitNightAction,
  resolveNightActions
} = require('../services/voteService');
const { getMafiaMembers } = require('../services/roleService');

const NIGHT_DURATION = 30; // seconds
const DISCUSSION_DURATION = 60;
const VOTING_DURATION = 45;
const RESULT_DURATION = 10;

// gameId -> timeoutId
const gameTimers = new Map();

async function getGameWithRoom(gameId) {
  const { rows } = await pool.query(
    `select g.id, g.room_id, g.status, g.phase_number, g.winner_team, r.code as room_code
     from games g
     join rooms r on r.id = g.room_id
     where g.id = $1
     limit 1`,
    [gameId]
  );
  return rows[0] || null;
}

async function getRoomById(roomId) {
  const { rows } = await pool.query(
    `select id, code, host_id
     from rooms
     where id = $1
     limit 1`,
    [roomId]
  );
  return rows[0] || null;
}

async function getAliveCount(gameId) {
  const { rows } = await pool.query(
    `select count(*) as alive
     from game_players
     where game_id = $1 and is_alive = true`,
    [gameId]
  );
  return Number(rows[0]?.alive || 0);
}

async function getNightActorsCount(gameId) {
  const { rows } = await pool.query(
    `select count(*) as actors
     from game_players
     where game_id = $1
       and is_alive = true
       and role in ('mafia', 'doctor', 'detective')`,
    [gameId]
  );
  return Number(rows[0]?.actors || 0);
}

async function getNightActionsCount(gameId, phaseNumber) {
  const { rows } = await pool.query(
    `select count(distinct actor_id) as cnt
     from night_actions
     where game_id = $1 and phase_number = $2`,
    [gameId, phaseNumber]
  );
  return Number(rows[0]?.cnt || 0);
}

async function getVotesCount(gameId, phaseNumber) {
  const { rows } = await pool.query(
    `select count(distinct voter_id) as cnt
     from votes
     where game_id = $1 and phase_number = $2`,
    [gameId, phaseNumber]
  );
  return Number(rows[0]?.cnt || 0);
}

function getSocketsForUser(io, userId) {
  const sockets = [];
  for (const [id, socket] of io.sockets.sockets) {
    if (socket.user && String(socket.user.id) === String(userId)) {
      sockets.push(socket);
    }
  }
  return sockets;
}

function clearGameTimer(gameId) {
  const t = gameTimers.get(gameId);
  if (t) {
    clearTimeout(t);
    gameTimers.delete(gameId);
  }
}

function schedulePhaseTimer(io, gameId, phase, roomCode, durationSeconds) {
  clearGameTimer(gameId);
  if (!durationSeconds || durationSeconds <= 0) return;

  const timeoutId = setTimeout(async () => {
    try {
      if (phase === 'night') {
        await handleEndOfNight(io, gameId, roomCode);
      } else if (phase === 'discussion') {
        await handleSimplePhaseAdvance(io, gameId, roomCode);
      } else if (phase === 'voting') {
        await handleEndOfVoting(io, gameId, roomCode);
      } else if (phase === 'result') {
        await handleSimplePhaseAdvance(io, gameId, roomCode);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error in phase timer:', err);
    }
  }, durationSeconds * 1000);

  gameTimers.set(gameId, timeoutId);
}

async function broadcastPhase(io, gameId, phase, phaseNumber, roomCode, durationSeconds) {
  const payload = { gameId, phase, phaseNumber, duration: durationSeconds };
  io.to(`room:${roomCode}`).emit('game:phase_changed', payload);
}

async function handleEndOfNight(io, gameId, roomCode) {
  clearGameTimer(gameId);

  const game = await getGameWithRoom(gameId);
  if (!game || game.status !== 'night') return;

  const result = await resolveNightActions(gameId, game.phase_number);

  io.to(`room:${roomCode}`).emit('game:night_resolved', {
    gameId,
    killed: result.killed,
    healed: result.healed
  });

  const win = await checkWinCondition(gameId);
  if (win && win.isOver) {
    io.to(`room:${roomCode}`).emit('game:ended', { gameId, winner: win.winner });
    return;
  }

  const { newStatus, phaseNumber } = await transitionPhase(gameId);

  let duration = 0;
  if (newStatus === 'discussion') duration = DISCUSSION_DURATION;
  else if (newStatus === 'voting') duration = VOTING_DURATION;
  else if (newStatus === 'result') duration = RESULT_DURATION;

  await broadcastPhase(io, gameId, newStatus, phaseNumber, roomCode, duration);
  schedulePhaseTimer(io, gameId, newStatus, roomCode, duration);
}

async function handleSimplePhaseAdvance(io, gameId, roomCode) {
  clearGameTimer(gameId);

  const game = await getGameWithRoom(gameId);
  if (!game || (game.status !== 'discussion' && game.status !== 'result')) return;

  const { newStatus, phaseNumber } = await transitionPhase(gameId);

  let duration = 0;
  if (newStatus === 'voting') duration = VOTING_DURATION;
  else if (newStatus === 'result') duration = RESULT_DURATION;
  else if (newStatus === 'night') duration = NIGHT_DURATION;

  await broadcastPhase(io, gameId, newStatus, phaseNumber, roomCode, duration);
  schedulePhaseTimer(io, gameId, newStatus, roomCode, duration);
}

async function handleEndOfVoting(io, gameId, roomCode) {
  clearGameTimer(gameId);

  const game = await getGameWithRoom(gameId);
  if (!game || game.status !== 'voting') return;

  const { eliminatedUserId, voteCount, totalVotes } = await tallyVotes(gameId, game.phase_number);

  if (eliminatedUserId) {
    await eliminatePlayer(gameId, eliminatedUserId, game.phase_number);
  }

  io.to(`room:${roomCode}`).emit('game:voting_resolved', {
    gameId,
    eliminatedUserId,
    voteCount,
    totalVotes
  });

  const win = await checkWinCondition(gameId);
  if (win && win.isOver) {
    io.to(`room:${roomCode}`).emit('game:ended', { gameId, winner: win.winner });
    return;
  }

  const { newStatus, phaseNumber } = await transitionPhase(gameId);

  let duration = 0;
  if (newStatus === 'result') duration = RESULT_DURATION;
  else if (newStatus === 'night') duration = NIGHT_DURATION;

  await broadcastPhase(io, gameId, newStatus, phaseNumber, roomCode, duration);
  schedulePhaseTimer(io, gameId, newStatus, roomCode, duration);
}

function registerGameHandler(io, socket) {
  // game:start (host only)
  socket.on('game:start', async (data) => {
    try {
      const { roomId } = data || {};
      if (!roomId) {
        socket.emit('game:error', { message: 'roomId wajib diisi' });
        return;
      }

      const room = await getRoomById(roomId);
      if (!room) {
        socket.emit('game:error', { message: 'Room tidak ditemukan' });
        return;
      }

      if (String(room.host_id) !== String(socket.user.id)) {
        socket.emit('game:error', { message: 'Hanya host yang bisa memulai game' });
        return;
      }

      const gameId = await startGame(roomId);

      // Kirim role ke masing-masing player secara private.
      const roleRes = await pool.query(
        `select user_id, role
         from game_players
         where game_id = $1`,
        [gameId]
      );

      const assignments = {};
      roleRes.rows.forEach((r) => {
        assignments[r.user_id] = r.role;
      });

      Object.entries(assignments).forEach(([userId, role]) => {
        const sockets = getSocketsForUser(io, userId);
        sockets.forEach((s) => {
          s.emit('game:role', { gameId, role });
        });
      });

      // Mafia join ke room khusus mafia:gameId
      const mafiaUserIds = await getMafiaMembers(gameId);
      mafiaUserIds.forEach((userId) => {
        const sockets = getSocketsForUser(io, userId);
        sockets.forEach((s) => {
          s.join(`mafia:${gameId}`);
        });
      });

      io.to(`mafia:${gameId}`).emit('mafia:reveal', {
        gameId,
        mafiaUserIds
      });

      // Semua player (di socket room:roomCode) akan menerima phase pertama.
      const game = await getGameWithRoom(gameId);
      const roomCode = game.room_code;

      await broadcastPhase(io, gameId, 'night', game.phase_number, roomCode, NIGHT_DURATION);
      schedulePhaseTimer(io, gameId, 'night', roomCode, NIGHT_DURATION);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error in game:start handler:', err);
      socket.emit('game:error', { message: 'Gagal memulai game' });
    }
  });

  // game:night_action
  socket.on('game:night_action', async (data) => {
    try {
      const { gameId, targetId, actionType } = data || {};
      if (!gameId || !targetId || !actionType) {
        socket.emit('game:error', { message: 'gameId, targetId, dan actionType wajib diisi' });
        return;
      }

      const game = await getGameWithRoom(gameId);
      if (!game || game.status !== 'night') {
        socket.emit('game:error', { message: 'Night action hanya bisa dilakukan saat phase night' });
        return;
      }

      const result = await submitNightAction(
        gameId,
        socket.user.id,
        targetId,
        actionType,
        game.phase_number
      );

      if (!result.success) {
        socket.emit('game:night_action_result', { success: false, message: result.message });
        return;
      }

      socket.emit('game:night_action_result', { success: true });

      // Cek apakah semua yang bisa beraksi sudah submit.
      const actorsCount = await getNightActorsCount(gameId);
      const actionsCount = await getNightActionsCount(gameId, game.phase_number);

      if (actionsCount >= actorsCount && actorsCount > 0) {
        await handleEndOfNight(io, gameId, game.room_code);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error in game:night_action handler:', err);
      socket.emit('game:error', { message: 'Gagal memproses night action' });
    }
  });

  // game:vote
  socket.on('game:vote', async (data) => {
    try {
      const { gameId, targetId } = data || {};
      if (!gameId || !targetId) {
        socket.emit('game:error', { message: 'gameId dan targetId wajib diisi' });
        return;
      }

      const game = await getGameWithRoom(gameId);
      if (!game || game.status !== 'voting') {
        socket.emit('game:error', { message: 'Voting hanya bisa dilakukan saat phase voting' });
        return;
      }

      const result = await castVote(gameId, socket.user.id, targetId, game.phase_number);
      if (!result.success) {
        socket.emit('game:vote_result', { success: false, message: result.message });
        return;
      }

      socket.emit('game:vote_result', { success: true });

      // Broadcast vote count per target.
      const { rows } = await pool.query(
        `select target_id, count(*) as vote_count
         from votes
         where game_id = $1 and phase_number = $2
         group by target_id`,
        [gameId, game.phase_number]
      );
      const voteCount = {};
      rows.forEach((r) => {
        voteCount[r.target_id] = Number(r.vote_count || 0);
      });

      io.to(`room:${game.room_code}`).emit('game:vote_update', {
        gameId,
        voteCount
      });

      const aliveCount = await getAliveCount(gameId);
      const votesCount = await getVotesCount(gameId, game.phase_number);

      if (votesCount >= aliveCount && aliveCount > 0) {
        await handleEndOfVoting(io, gameId, game.room_code);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Error in game:vote handler:', err);
      socket.emit('game:error', { message: 'Gagal memproses vote' });
    }
  });
}

module.exports = function gameHandler(io, socket) {
  registerGameHandler(io, socket);
};

