const jwt = require('jsonwebtoken');

const { env } = require('../config/env');
const { findById } = require('../models/userModel');

async function authenticateSocket(socket, next) {
  try {
    const token = socket.handshake?.auth?.token;
    if (!token) {
      return next(new Error('TOKEN_MISSING'));
    }

    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch (err) {
      return next(new Error('TOKEN_INVALID'));
    }

    const userId = payload.userId || payload.sub;
    if (!userId) {
      return next(new Error('TOKEN_INVALID'));
    }

    const user = await findById(userId);
    if (!user) {
      return next(new Error('USER_NOT_FOUND'));
    }

    // Attach user ke socket
    socket.user = user;
    return next();
  } catch (err) {
    return next(new Error('AUTH_ERROR'));
  }
}

function setupSocket(io) {
  // Middleware autentikasi untuk semua koneksi Socket.io
  io.use((socket, next) => {
    authenticateSocket(socket, next);
  });

  const roomHandler = require('./roomHandler');
  const gameHandler = require('./gameHandler');
  const chatHandler = require('./chatHandler');

  io.on('connection', (socket) => {
    if (!socket.user) {
      socket.disconnect(true);
      return;
    }

    // Contoh event naming convention:
    // Client -> Server: 'room:join', 'room:ready', 'game:vote', ...
    // Server -> Client: 'room:updated', 'game:phase_changed', ...

    if (typeof roomHandler === 'function') {
      roomHandler(io, socket);
    }
    if (typeof gameHandler === 'function') {
      gameHandler(io, socket);
    }
    if (typeof chatHandler === 'function') {
      chatHandler(io, socket);
    }
  });
}

module.exports = {
  setupSocket
};

