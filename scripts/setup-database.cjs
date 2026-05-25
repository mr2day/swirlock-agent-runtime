#!/usr/bin/env node
/**
 * One-shot Postgres setup. Uses the postgres superuser ONCE to create:
 *   1. A database `swirlock_agent` (or whatever PG_DATABASE is set to)
 *   2. A service user `swirlock_agent` (or whatever PG_USER is set to)
 *      with the password from service.config.local.cjs:PG_PASSWORD
 *   3. Grants on the database to the service user
 *
 * After this runs, the postgres superuser password is no longer needed
 * by the agent. Migrations run as the service user.
 *
 * Run:
 *   SUPERUSER_PASSWORD='...' node scripts/setup-database.cjs
 *
 * Idempotent: if the database / user already exist, skips creation and
 * just ensures grants. Safe to re-run.
 */

'use strict';

const path = require('node:path');

// Load service.config.local.cjs to get PG_HOST/PORT/DATABASE/USER/PASSWORD.
require(path.join(__dirname, '..', 'dist', 'env'));

const { Client } = require('pg');

const HOST = process.env.PG_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PG_PORT ?? '5432');
const DATABASE = process.env.PG_DATABASE ?? 'swirlock_agent';
const USER = process.env.PG_USER ?? 'swirlock_agent';
const PASSWORD = process.env.PG_PASSWORD;
const SUPERUSER_PASSWORD = process.env.SUPERUSER_PASSWORD;

if (!PASSWORD) {
  console.error(
    'ERROR: PG_PASSWORD is missing. Add it to service.config.local.cjs.',
  );
  process.exit(1);
}
if (!SUPERUSER_PASSWORD) {
  console.error(
    'ERROR: SUPERUSER_PASSWORD env var is required. Pass it inline:\n' +
      '  SUPERUSER_PASSWORD=... node scripts/setup-database.cjs',
  );
  process.exit(1);
}

async function main() {
  // Connect to the maintenance `postgres` database as superuser.
  const admin = new Client({
    host: HOST,
    port: PORT,
    user: 'postgres',
    password: SUPERUSER_PASSWORD,
    database: 'postgres',
  });
  await admin.connect();
  console.log(`[setup] connected to postgres@${HOST}:${PORT}/postgres as superuser`);

  // 1. Ensure service user
  const userRows = await admin.query(
    'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1',
    [USER],
  );
  if (userRows.rowCount === 0) {
    // CREATE USER is not parameterizable for identifiers/passwords. We
    // identifier-quote USER and string-escape PASSWORD ourselves.
    const safeUser = '"' + USER.replace(/"/g, '""') + '"';
    const safePassword = "'" + PASSWORD.replace(/'/g, "''") + "'";
    await admin.query(`CREATE USER ${safeUser} WITH PASSWORD ${safePassword}`);
    console.log(`[setup] created user "${USER}"`);
  } else {
    // Reset the password in case the local cjs was regenerated.
    const safeUser = '"' + USER.replace(/"/g, '""') + '"';
    const safePassword = "'" + PASSWORD.replace(/'/g, "''") + "'";
    await admin.query(`ALTER USER ${safeUser} WITH PASSWORD ${safePassword}`);
    console.log(
      `[setup] user "${USER}" already existed — refreshed its password`,
    );
  }

  // 2. Ensure database, owned by the service user.
  const dbRows = await admin.query(
    'SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1',
    [DATABASE],
  );
  if (dbRows.rowCount === 0) {
    const safeDb = '"' + DATABASE.replace(/"/g, '""') + '"';
    const safeOwner = '"' + USER.replace(/"/g, '""') + '"';
    await admin.query(`CREATE DATABASE ${safeDb} OWNER ${safeOwner}`);
    console.log(`[setup] created database "${DATABASE}" owned by "${USER}"`);
  } else {
    console.log(`[setup] database "${DATABASE}" already existed`);
  }

  // 3. Grant connect + creation privileges on the database.
  const safeDb = '"' + DATABASE.replace(/"/g, '""') + '"';
  const safeUser = '"' + USER.replace(/"/g, '""') + '"';
  await admin.query(`GRANT CONNECT ON DATABASE ${safeDb} TO ${safeUser}`);
  await admin.query(`GRANT CREATE ON DATABASE ${safeDb} TO ${safeUser}`);
  console.log(`[setup] granted CONNECT, CREATE on "${DATABASE}" to "${USER}"`);

  await admin.end();

  // 4. Reconnect as the service user to verify and grant schema-level
  //    privileges on the public schema (needed for CREATE TABLE).
  const svc = new Client({
    host: HOST,
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: DATABASE,
  });
  await svc.connect();
  console.log(
    `[setup] verified service-user login to ${DATABASE} as ${USER}`,
  );
  await svc.end();

  console.log('[setup] done.');
}

main().catch((err) => {
  console.error('[setup] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
