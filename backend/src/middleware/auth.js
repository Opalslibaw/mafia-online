const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { findById } = require('../models/userModel');

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) return null;
  return token;
}

async function auth(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      const err = new Error('Token tidak ada. Gunakan Authorization: Bearer <token>');
      err.status = 401;
      throw err;
    }

    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch (e) {
      console.error('Error detail (verify token):', e);
      const err = new Error('Token tidak valid atau sudah expired');
      err.status = 401;
      throw err;
    }

    const userId = payload.userId || payload.sub;
    if (!userId) {
      const err = new Error('Token tidak valid');
      err.status = 401;
      throw err;
    }

    const user = await findById(userId);
    if (!user) {
      const err = new Error('User tidak ditemukan');
      err.status = 401;
      throw err;
    }

    req.user = user;
    next();
  } catch (err) {
    console.error('Error detail (auth middleware):', err);
    next(err);
  }
}

module.exports = { auth };

