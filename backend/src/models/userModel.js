const bcrypt = require('bcrypt');
const { pool } = require('../config/database');

const SALT_ROUNDS = 10;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateUsername(username) {
  const u = String(username || '').trim();
  if (u.length < 3) {
    const err = new Error('Username minimal 3 karakter');
    err.status = 400;
    throw err;
  }
  return u;
}

function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 6) {
    const err = new Error('Password minimal 6 karakter');
    err.status = 400;
    throw err;
  }
  return p;
}

function validateEmail(email) {
  const e = normalizeEmail(email);
  if (!e) {
    const err = new Error('Email wajib diisi');
    err.status = 400;
    throw err;
  }
  return e;
}

async function findByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;

  const { rows } = await pool.query(
    `select id, username, email, password_hash, created_at
     from users
     where email = $1
     limit 1`,
    [e]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query(
    `select id, username, email, created_at
     from users
     where id = $1
     limit 1`,
    [id]
  );
  return rows[0] || null;
}

async function createUser(username, email, password) {
  const u = validateUsername(username);
  const e = validateEmail(email);
  const p = validatePassword(password);

  // Clear, deterministic errors for duplicates.
  const dup = await pool.query(
    `select id, username, email
     from users
     where email = $1 or username = $2
     limit 1`,
    [e, u]
  );
  if (dup.rows[0]) {
    const existing = dup.rows[0];
    if (existing.email === e) {
      const err = new Error('Email sudah dipakai');
      err.status = 409;
      throw err;
    }
    if (existing.username === u) {
      const err = new Error('Username sudah dipakai');
      err.status = 409;
      throw err;
    }
    const err = new Error('Username/email sudah dipakai');
    err.status = 409;
    throw err;
  }

  const passwordHash = await bcrypt.hash(p, SALT_ROUNDS);

  try {
    const { rows } = await pool.query(
      `insert into users (username, email, password_hash)
       values ($1, $2, $3)
       returning id, username, email, created_at`,
      [u, e, passwordHash]
    );
    return rows[0];
  } catch (err) {
    console.error('Error detail (createUser):', err);
    // Fallback if race condition hits unique constraint.
    if (err && err.code === '23505') {
      const msg = String(err.detail || '');
      if (msg.toLowerCase().includes('email')) {
        const e2 = new Error('Email sudah dipakai');
        e2.status = 409;
        throw e2;
      }
      if (msg.toLowerCase().includes('username')) {
        const e2 = new Error('Username sudah dipakai');
        e2.status = 409;
        throw e2;
      }
      const e2 = new Error('Username/email sudah dipakai');
      e2.status = 409;
      throw e2;
    }
    throw err;
  }
}

module.exports = {
  createUser,
  findByEmail,
  findById
};

