const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { env } = require('../config/env');
const { createUser, findByEmail } = require('../models/userModel');
const { auth } = require('../middleware/auth');

const JWT_EXPIRES_IN = '7d';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function signToken(user) {
  return jwt.sign({ userId: user.id }, env.jwtSecret, { expiresIn: JWT_EXPIRES_IN });
}

const router = express.Router();

router.post('/register', async (req, res, next) => {
  try {
    const { username, email, password } = req.body || {};
    const user = await createUser(username, email, password);
    const token = signToken(user);
    res.status(201).json({ ok: true, token, user });
  } catch (err) {
    console.error('Error detail (register):', err);
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw httpError(400, 'Email dan password wajib diisi');

    const user = await findByEmail(email);
    if (!user) throw httpError(401, 'Email atau password salah');

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) throw httpError(401, 'Email atau password salah');

    const token = signToken(user);
    const safeUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      created_at: user.created_at
    };

    res.json({ ok: true, token, user: safeUser });
  } catch (err) {
    console.error('Error detail (login):', err);
    next(err);
  }
});

router.get('/me', auth, async (req, res) => {
  res.json({ ok: true, user: req.user });
});

module.exports = { authRouter: router };

