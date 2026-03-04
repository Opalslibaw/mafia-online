const { pool } = require('../config/database');

function fisherYatesShuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function buildRoleComposition(count) {
  if (count < 4 || count > 10) {
    const err = new Error('Jumlah pemain harus antara 4 sampai 10');
    err.status = 400;
    throw err;
  }

  let mafia = 0;
  let doctor = 1;
  let detective = 0;

  if (count <= 5) {
    mafia = 1;
    doctor = 1;
    detective = 0;
  } else if (count <= 7) {
    mafia = 2;
    doctor = 1;
    detective = 1;
  } else {
    mafia = 3;
    doctor = 1;
    detective = 1;
  }

  const villager = count - (mafia + doctor + detective);

  const roles = [];
  for (let i = 0; i < mafia; i += 1) roles.push('mafia');
  for (let i = 0; i < doctor; i += 1) roles.push('doctor');
  for (let i = 0; i < detective; i += 1) roles.push('detective');
  for (let i = 0; i < villager; i += 1) roles.push('villager');

  return roles;
}

async function assignRoles(gameId, playerIds) {
  const ids = Array.isArray(playerIds) ? playerIds.slice() : [];
  const count = ids.length;
  if (count === 0) {
    const err = new Error('Tidak ada pemain untuk di-assign role');
    err.status = 400;
    throw err;
  }

  const roles = buildRoleComposition(count);
  const shuffledIds = fisherYatesShuffle(ids);

  const client = await pool.connect();
  try {
    await client.query('begin');

    const assignments = {};

    for (let i = 0; i < shuffledIds.length; i += 1) {
      const userId = shuffledIds[i];
      const role = roles[i];
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `insert into game_players (game_id, user_id, role)
         values ($1, $2, $3)`,
        [gameId, userId, role]
      );
      assignments[userId] = role;
    }

    await client.query('commit');

    // JANGAN expose role ke player lain – caller harus memastikan
    // role hanya dikirim ke player masing-masing (misalnya via Socket.io).
    return assignments;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
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

async function getMafiaMembers(gameId) {
  const { rows } = await pool.query(
    `select user_id
     from game_players
     where game_id = $1 and role = 'mafia'`,
    [gameId]
  );
  return rows.map((r) => r.user_id);
}

module.exports = {
  assignRoles,
  getPlayerRole,
  getMafiaMembers
};

