const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const { env } = require('./config/env');
const { testConnection, closePool } = require('./config/database');
const { authRouter } = require('./routes/auth');
const { roomRouter } = require('./routes/room');
const { setupSocket } = require('./socket');

function createApp() {
  const app = express();

  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/rooms', roomRouter);

  // Express error handler (must be last).
  app.use((err, req, res, next) => {
    const status = Number(err.status || 500);
    res.status(status).json({
      ok: false,
      error: status === 500 ? 'Internal Server Error' : err.message
    });
  });

  return app;
}

async function main() {
  try {
    await testConnection();
  } catch (err) {
    // Fail fast if DB is not reachable.
    console.error('Failed to connect to PostgreSQL. Check your env vars and DB status.');
    console.error(err);
    process.exit(1);
  }

  const app = createApp();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: {
      origin: env.corsOrigin,
      credentials: true
    }
  });

  setupSocket(io);

  server.listen(env.port, () => {
    console.log(`Backend listening on :${env.port} (${env.nodeEnv})`);
  });

  const shutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down...`);

    io.close();
    server.close(async () => {
      try {
        await closePool();
      } catch (e) {
        console.error('Error closing DB pool', e);
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();

