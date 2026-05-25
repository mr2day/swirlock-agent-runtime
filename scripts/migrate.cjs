#!/usr/bin/env node
/**
 * Migration runner. Applies any .sql files in `migrations/` that
 * haven't been recorded in `schema_migrations` yet, in lexicographic
 * order. Each migration runs in a transaction; if it fails, nothing
 * from that file is committed.
 *
 * Safe to re-run any time.
 *
 *   npm run db:migrate
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

require(path.join(__dirname, '..', 'dist', 'env'));

const { Client } = require('pg');

const HOST = process.env.PG_HOST ?? '127.0.0.1';
const PORT = Number(process.env.PG_PORT ?? '5432');
const DATABASE = process.env.PG_DATABASE ?? 'swirlock_agent';
const USER = process.env.PG_USER ?? 'swirlock_agent';
const PASSWORD = process.env.PG_PASSWORD;

if (!PASSWORD) {
  console.error('ERROR: PG_PASSWORD is missing. Check service.config.local.cjs.');
  process.exit(1);
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const client = new Client({
    host: HOST,
    port: PORT,
    user: USER,
    password: PASSWORD,
    database: DATABASE,
  });
  await client.connect();
  console.log(`[migrate] connected to ${USER}@${HOST}:${PORT}/${DATABASE}`);

  // Ensure tracking table.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const appliedRows = await client.query(
    'SELECT filename FROM schema_migrations',
  );
  const applied = new Set(appliedRows.rows.map((r) => r.filename));

  const allMigrations = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const pending = allMigrations.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log('[migrate] up to date, nothing to apply.');
    await client.end();
    return;
  }

  console.log(
    `[migrate] applying ${pending.length} migration(s): ${pending.join(', ')}`,
  );

  for (const filename of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    console.log(`[migrate] applying ${filename}...`);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [filename],
      );
      await client.query('COMMIT');
      console.log(`[migrate] ${filename} OK`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAILED on ${filename}:`, err.message);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log('[migrate] done.');
}

main().catch((err) => {
  console.error('[migrate] CRASHED:', err && err.message ? err.message : err);
  process.exit(1);
});
