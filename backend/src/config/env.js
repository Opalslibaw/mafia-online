const dotenv = require('dotenv');

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value || String(value).trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name, defaultValue = undefined) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  return value;
}

function requiredDbConfig() {
  const databaseUrl = optional('DATABASE_URL');
  if (databaseUrl) return { databaseUrl };

  // If DATABASE_URL is not provided, require individual PG vars.
  return {
    host: required('PGHOST'),
    port: Number(optional('PGPORT', '5432')),
    database: required('PGDATABASE'),
    user: required('PGUSER'),
    password: required('PGPASSWORD')
  };
}

const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '3000')),
  corsOrigin: optional('CORS_ORIGIN', '*'),

  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: optional('JWT_EXPIRES_IN', '7d'),

  pg: {
    ...requiredDbConfig(),
    // e.g. 'require' (useful on hosted PG); leave empty for local.
    sslMode: optional('PGSSLMODE', '')
  }
};

module.exports = { env };

