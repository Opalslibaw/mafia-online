require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR UNIQUE NOT NULL, email VARCHAR UNIQUE NOT NULL, password_hash VARCHAR NOT NULL, created_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS rooms (id SERIAL PRIMARY KEY, code VARCHAR(6) UNIQUE NOT NULL, host_id INT REFERENCES users(id), status VARCHAR DEFAULT 'waiting', max_players INT DEFAULT 10, created_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS room_players (room_id INT REFERENCES rooms(id), user_id INT REFERENCES users(id), is_ready BOOLEAN DEFAULT FALSE, joined_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY(room_id, user_id))`);
    await client.query(`CREATE TABLE IF NOT EXISTS games (id SERIAL PRIMARY KEY, room_id INT REFERENCES rooms(id), status VARCHAR, phase_number INT DEFAULT 0, started_at TIMESTAMP, ended_at TIMESTAMP, winner_team VARCHAR)`);
    await client.query(`CREATE TABLE IF NOT EXISTS game_players (game_id INT REFERENCES games(id), user_id INT REFERENCES users(id), role VARCHAR, is_alive BOOLEAN DEFAULT TRUE, death_phase INT, PRIMARY KEY(game_id, user_id))`);
    await client.query(`CREATE TABLE IF NOT EXISTS votes (id SERIAL PRIMARY KEY, game_id INT REFERENCES games(id), phase_number INT, voter_id INT REFERENCES users(id), target_id INT REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS night_actions (id SERIAL PRIMARY KEY, game_id INT REFERENCES games(id), phase_number INT, actor_id INT REFERENCES users(id), target_id INT REFERENCES users(id), action_type VARCHAR, created_at TIMESTAMP DEFAULT NOW())`);
    await client.query('COMMIT');
    console.log('Migration berhasil!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration gagal:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
