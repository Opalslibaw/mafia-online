const { pool } = require('../config/database');
const { eliminatePlayer } = require('./gameService');

// Assumed schema:
// votes (
//   game_id integer not null,
//   voter_id integer not null,
//   target_id integer not null,
//   phase_number integer not null,
//   created_at timestamptz not null default now(),
//   unique (game_id, voter_id, phase_number)
// );
//
// night_actions (
//   game_id integer not null,
//   actor_id integer not null,
//   target_id integer not null,
//   action_type varchar(20) not null, -- 'kill' | 'heal' | 'investigate'
//   phase_number integer not null,
//   created_at timestamptz not null default now(),
//   unique (game_id, actor_id, phase_number)
// );

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

async function castVote(gameId, voterId, targetId, phaseNumber) {
  // Cek voter masih hidup
  const voterAlive = await isPlayerAlive(gameId, voterId);
  if (!voterAlive) {
    return { success: false, message: 'Voter sudah mati dan tidak bisa vote' };
  }

  // Cek target masih hidup
  const targetAlive = await isPlayerAlive(gameId, targetId);
  if (!targetAlive) {
    return { success: false, message: 'Target sudah mati dan tidak bisa di-vote' };
  }

  // Cek double vote
  const existing = await pool.query(
    `select 1
     from votes
     where game_id = $1 and voter_id = $2 and phase_number = $3
     limit 1`,
    [gameId, voterId, phaseNumber]
  );
  if (existing.rows[0]) {
    return { success: false, message: 'Sudah melakukan vote di phase ini' };
  }

  await pool.query(
    `insert into votes (game_id, voter_id, target_id, phase_number)
     values ($1, $2, $3, $4)`,
    [gameId, voterId, targetId, phaseNumber]
  );

  return { success: true, message: 'Vote diterima' };
}

async function tallyVotes(gameId, phaseNumber) {
  const { rows } = await pool.query(
    `select target_id, count(*) as vote_count
     from votes
     where game_id = $1 and phase_number = $2
     group by target_id`,
    [gameId, phaseNumber]
  );

  if (rows.length === 0) {
    return {
      eliminatedUserId: null,
      voteCount: 0,
      totalVotes: 0
    };
  }

  let totalVotes = 0;
  let maxVotes = 0;
  rows.forEach((r) => {
    const c = Number(r.vote_count || 0);
    totalVotes += c;
    if (c > maxVotes) maxVotes = c;
  });

  const topTargets = rows.filter((r) => Number(r.vote_count || 0) === maxVotes);
  const chosen =
    topTargets.length === 1
      ? topTargets[0]
      : topTargets[Math.floor(Math.random() * topTargets.length)];

  return {
    eliminatedUserId: chosen.target_id,
    voteCount: maxVotes,
    totalVotes
  };
}

async function submitNightAction(gameId, actorId, targetId, actionType, phaseNumber) {
  const allowedActions = ['kill', 'heal', 'investigate'];
  if (!allowedActions.includes(actionType)) {
    return { success: false, message: 'Tipe aksi tidak dikenal' };
  }

  const alive = await isPlayerAlive(gameId, actorId);
  if (!alive) {
    return { success: false, message: 'Pemain sudah mati dan tidak bisa melakukan aksi' };
  }

  const role = await getPlayerRole(gameId, actorId);
  if (!role) {
    return { success: false, message: 'Role pemain tidak ditemukan' };
  }

  if (actionType === 'kill' && role !== 'mafia') {
    return { success: false, message: 'Hanya mafia yang bisa melakukan kill' };
  }
  if (actionType === 'heal' && role !== 'doctor') {
    return { success: false, message: 'Hanya doctor yang bisa melakukan heal' };
  }
  if (actionType === 'investigate' && role !== 'detective') {
    return { success: false, message: 'Hanya detective yang bisa melakukan investigate' };
  }

  // Cek double submit (per actor per phase).
  const existing = await pool.query(
    `select 1
     from night_actions
     where game_id = $1 and actor_id = $2 and phase_number = $3
     limit 1`,
    [gameId, actorId, phaseNumber]
  );
  if (existing.rows[0]) {
    return { success: false, message: 'Sudah mengirim action di phase ini' };
  }

  await pool.query(
    `insert into night_actions (game_id, actor_id, target_id, action_type, phase_number)
     values ($1, $2, $3, $4, $5)`,
    [gameId, actorId, targetId, actionType, phaseNumber]
  );

  return { success: true };
}

async function resolveNightActions(gameId, phaseNumber) {
  const { rows: actions } = await pool.query(
    `select actor_id, target_id, action_type
     from night_actions
     where game_id = $1 and phase_number = $2`,
    [gameId, phaseNumber]
  );

  if (actions.length === 0) {
    return { killed: null, healed: false };
  }

  // Ambil satu target kill (kalau banyak, ambil yang pertama saja).
  const killActions = actions.filter((a) => a.action_type === 'kill');
  if (killActions.length === 0) {
    return { killed: null, healed: false };
  }

  const killTargetId = killActions[0].target_id;

  const healActions = actions.filter(
    (a) => a.action_type === 'heal' && a.target_id === killTargetId
  );
  const healed = healActions.length > 0;

  if (!healed) {
    await eliminatePlayer(gameId, killTargetId, phaseNumber);
    return { killed: killTargetId, healed: false };
  }

  return { killed: null, healed: true };
}

module.exports = {
  castVote,
  tallyVotes,
  submitNightAction,
  resolveNightActions
};

