const { pool } = require('../config/database');

// Assumed schema (PostgreSQL):
// rooms (
//   id serial primary key,
//   code varchar(6) not null unique,
//   host_id integer not null references users(id),
//   status varchar(20) not null default 'waiting', -- 'waiting' | 'started' | 'finished'
//   max_players integer not null,
//   created_at timestamptz not null default now(),
//   started_at timestamptz
// );
//
// room_players (
//   room_id integer not null references rooms(id) on delete cascade,
//   user_id integer not null references users(id) on delete cascade,
//   is_ready boolean not null default false,
//   joined_at timestamptz not null default now(),
//   is_host boolean not null default false,
//   unique (room_id, user_id)
// );

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase();
}

async function createRoomWithHost({ code, hostUserId }) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const roomInsert = await client.query(
      `insert into rooms (code, host_id, status, max_players)
       values ($1, $2, 'waiting', 10)
       returning id, code, host_id, status, created_at, started_at`,
      [code, hostUserId]
    );
    const room = roomInsert.rows[0];

    await client.query(
      `insert into room_players (room_id, user_id, is_host, is_ready)
       values ($1, $2, true, false)`,
      [room.id, hostUserId]
    );

    await client.query('commit');

    return { room };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function getRoomByCode(code) {
  const c = normalizeCode(code);
  const { rows } = await pool.query(
    `select id, code, host_id, status, created_at, started_at
     from rooms
     where code = $1
     limit 1`,
    [c]
  );
  return rows[0] || null;
}

async function getRoomWithPlayersByCode(code) {
  const room = await getRoomByCode(code);
  if (!room) return { room: null, players: [] };
  const players = await getPlayersForRoom(room.id);
  return { room, players };
}

async function getPlayersForRoom(roomId) {
  const { rows } = await pool.query(
    `select
       rp.room_id,
       rp.user_id,
       rp.is_ready,
       rp.joined_at,
       rp.is_host,
       u.username
     from room_players rp
     join users u on u.id = rp.user_id
     where rp.room_id = $1
     order by rp.joined_at asc`,
    [roomId]
  );
  return rows;
}

async function addPlayerToRoom(roomId, userId) {
  try {
    const { rows } = await pool.query(
      `insert into room_players (room_id, user_id, is_host, is_ready)
       values ($1, $2, false, false)
       returning room_id, user_id, is_ready, joined_at, is_host`,
      [roomId, userId]
    );
    return rows[0];
  } catch (err) {
    if (err && err.code === '23505') {
      const e = new Error('Sudah bergabung di room ini');
      e.status = 400;
      throw e;
    }
    throw err;
  }
}

async function togglePlayerReady(roomId, userId) {
  const { rows } = await pool.query(
    `update room_players
     set is_ready = not is_ready
     where room_id = $1 and user_id = $2
     returning room_id, user_id, is_ready, joined_at, is_host`,
    [roomId, userId]
  );
  if (!rows[0]) {
    const err = new Error('Player tidak ada di room ini');
    err.status = 404;
    throw err;
  }
  return rows[0];
}

function buildRoles(players) {
  // Very simple role distribution:
  // - >= 4 players guaranteed by route validation.
  // - ~25% (at least 1) mafia, exactly 1 detective, rest villager.
  const total = players.length;
  const mafiaCount = Math.max(1, Math.floor(total / 4));

  const shuffled = [...players];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = tmp;
  }

  const roleMap = new Map();
  for (let i = 0; i < mafiaCount; i += 1) {
    roleMap.set(shuffled[i].user_id, 'mafia');
  }

  const detectiveIndex = mafiaCount;
  roleMap.set(shuffled[detectiveIndex].user_id, 'detective');

  for (let i = detectiveIndex + 1; i < shuffled.length; i += 1) {
    roleMap.set(shuffled[i].user_id, 'villager');
  }

  return roleMap;
}

async function startGameForRoom(code) {
  const client = await pool.connect();
  try {
    await client.query('begin');

    const c = normalizeCode(code);

    const roomRes = await client.query(
      `select id, code, host_id, status, created_at, started_at
       from rooms
       where code = $1
       limit 1
       for update`,
      [c]
    );
    const room = roomRes.rows[0];
    if (!room) {
      const err = new Error('Room tidak ditemukan');
      err.status = 404;
      throw err;
    }
    if (room.status !== 'waiting') {
      const err = new Error('Game sudah dimulai / tidak dalam status waiting');
      err.status = 400;
      throw err;
    }

    const playersRes = await client.query(
      `select
         rp.room_id,
         rp.user_id,
         rp.is_ready,
         rp.joined_at,
         rp.is_host,
         u.username
       from room_players rp
       join users u on u.id = rp.user_id
       where rp.room_id = $1
       order by rp.joined_at asc
       for update`,
      [room.id]
    );
    const players = playersRes.rows;

    if (players.length < 4) {
      const err = new Error('Minimal 4 pemain untuk memulai game');
      err.status = 400;
      throw err;
    }

    const allReady = players.every((p) => p.is_ready);
    if (!allReady) {
      const err = new Error('Semua pemain harus ready untuk memulai game');
      err.status = 400;
      throw err;
    }

    // Roles can be assigned in-memory or in another table.
    // We only ensure game status changes here to match schema constraints.

    const updatedRoomRes = await client.query(
      `update rooms
       set status = 'started',
           started_at = now()
       where id = $1
       returning id, code, host_id, status, created_at, started_at`,
      [room.id]
    );
    const updatedRoom = updatedRoomRes.rows[0];

    await client.query('commit');

    return {
      room: updatedRoom,
      players
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createRoomWithHost,
  getRoomByCode,
  getRoomWithPlayersByCode,
  getPlayersForRoom,
  addPlayerToRoom,
  togglePlayerReady,
  startGameForRoom
};

