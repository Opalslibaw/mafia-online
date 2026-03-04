const { pool } = require('../config/database');
const { assignRoles } = require('./roleService');

const GAME_STATES = ['waiting', 'night', 'discussion', 'voting', 'result', 'end'];

function getNextPhaseStatus(currentStatus) {
  switch (currentStatus) {
    case 'waiting':
      return 'night';
    case 'night':
      return 'discussion';
    case 'discussion':
      return 'voting';
    case 'voting':
      return 'result';
    case 'result':
      return 'night';
    case 'end':
    default:
      return 'end';
  }
}

async function getGameById(gameId) {
  const { rows } = await pool.query(
    `select id, room_id, status, phase_number, winner_team
     from games
     where id = $1
     limit 1`,
    [gameId]
  );
  return rows[0] || null;
}

async function getAliveCounts(gameId) {
  const { rows } = await pool.query(
    `select
       sum(case when role = 'mafia' and is_alive = true then 1 else 0 end) as mafia_alive,
       sum(case when role <> 'mafia' and is_alive = true then 1 else 0 end) as non_mafia_alive
     from game_players
     where game_id = $1`,
    [gameId]
  );
  const row = rows[0] || {};
  const mafiaAlive = Number(row.mafia_alive || 0);
  const nonMafiaAlive = Number(row.non_mafia_alive || 0);
  return { mafiaAlive, nonMafiaAlive };
}

async function startGame(roomId) {
  // Buat game baru dengan status 'night' dan phase_number = 1.
  const gameInsert = await pool.query(
    `insert into games (room_id, status, phase_number)
     values ($1, 'night', 1)
     returning id`,
    [roomId]
  );
  const gameId = gameInsert.rows[0].id;

  // Ambil semua player dari room yang terkait.
  const playersRes = await pool.query(
    `select user_id
     from room_players
     where room_id = $1`,
    [roomId]
  );
  const playerIds = playersRes.rows.map((r) => r.user_id);

  if (playerIds.length < 4) {
    const err = new Error('Minimal 4 pemain untuk memulai game');
    err.status = 400;
    throw err;
  }

  await assignRoles(gameId, playerIds);

  return gameId;
}

async function transitionPhase(gameId) {
  const game = await getGameById(gameId);
  if (!game) {
    const err = new Error('Game tidak ditemukan');
    err.status = 404;
    throw err;
  }

  if (game.status === 'end') {
    return { newStatus: 'end', phaseNumber: game.phase_number };
  }

  const nextStatus = getNextPhaseStatus(game.status);
  const nextPhaseNumber = nextStatus === 'night' && game.status !== 'waiting'
    ? game.phase_number + 1
    : game.phase_number;

  const updateRes = await pool.query(
    `update games
     set status = $2,
         phase_number = $3
     where id = $1
     returning status, phase_number`,
    [gameId, nextStatus, nextPhaseNumber]
  );

  const updated = updateRes.rows[0];
  return {
    newStatus: updated.status,
    phaseNumber: updated.phase_number
  };
}

async function checkWinCondition(gameId) {
  const game = await getGameById(gameId);
  if (!game) {
    const err = new Error('Game tidak ditemukan');
    err.status = 404;
    throw err;
  }

  if (game.status === 'end' && game.winner_team) {
    return {
      isOver: true,
      winner: game.winner_team
    };
  }

  const { mafiaAlive, nonMafiaAlive } = await getAliveCounts(gameId);

  let winner = null;
  if (mafiaAlive === 0) {
    winner = 'villager';
  } else if (mafiaAlive >= nonMafiaAlive && nonMafiaAlive > 0) {
    winner = 'mafia';
  }

  if (!winner) {
    return null;
  }

  await pool.query(
    `update games
     set winner_team = $2,
         status = 'end'
     where id = $1`,
    [gameId, winner]
  );

  return {
    isOver: true,
    winner
  };
}

async function eliminatePlayer(gameId, userId, phaseNumber) {
  await pool.query(
    `update game_players
     set is_alive = false,
         death_phase = $3
     where game_id = $1 and user_id = $2`,
    [gameId, userId, phaseNumber]
  );
}

module.exports = {
  GAME_STATES,
  startGame,
  transitionPhase,
  checkWinCondition,
  eliminatePlayer
};

