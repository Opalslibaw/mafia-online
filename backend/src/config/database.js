const { Pool } = require('pg');
const { env } = require('./env');

function buildPoolConfig() {
  const sslMode = (env.pg.sslMode || '').toLowerCase();
  const ssl =
    sslMode === 'require'
      ? {
          rejectUnauthorized: false
        }
      : undefined;

  if (env.pg.databaseUrl) {
    return {
      connectionString: env.pg.databaseUrl,
      ssl
    };
  }

  return {
    host: env.pg.host,
    port: env.pg.port,
    database: env.pg.database,
    user: env.pg.user,
    password: env.pg.password,
    ssl
  };
}

const pool = new Pool(buildPoolConfig());

async function testConnection() {
  const client = await pool.connect();
  try {
    const res = await client.query('select 1 as ok');
    return res.rows?.[0]?.ok === 1;
  } finally {
    client.release();
  }
}

async function closePool() {
  await pool.end();
}

module.exports = {
  pool,
  testConnection,
  closePool
};

