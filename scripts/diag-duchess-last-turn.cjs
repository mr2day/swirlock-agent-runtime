#!/usr/bin/env node
'use strict';

const path = require('node:path');
require(path.join(__dirname, '..', 'dist', 'env'));

async function main() {
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(__dirname, '..', 'dist', 'app.module'));
  const { DatabaseService } = require(
    path.join(__dirname, '..', 'dist', 'database', 'database.service'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  const db = app.get(DatabaseService);

  const sessions = await db.db
    .selectFrom('sessions')
    .selectAll()
    .where(({ eb, ref }) =>
      eb(ref('client_metadata'), '@>', '{"personaId":"duchess-noctilock"}'),
    )
    .orderBy('updated_at', 'desc')
    .limit(2)
    .execute();

  if (sessions.length === 0) {
    console.log('no Duchess sessions found');
    await app.close();
    process.exit(0);
  }

  for (const session of sessions) {
    console.log('================================================================');
    console.log(`session ${session.id}`);
    console.log(`  title:           ${session.title}`);
    console.log(`  default_backend: ${session.default_backend}`);
    console.log(`  created_at:      ${session.created_at}`);
    console.log(`  updated_at:      ${session.updated_at}`);
    console.log(`  client_metadata: ${JSON.stringify(session.client_metadata)}`);

    const messages = await db.db
      .selectFrom('messages')
      .selectAll()
      .where('session_id', '=', session.id)
      .orderBy('seq', 'asc')
      .execute();

    let lastTurn = null;
    for (const m of messages) {
      if (m.turn_id !== lastTurn) {
        console.log('  ---');
        lastTurn = m.turn_id;
      }
      const meta = m.metadata ? '  ' + JSON.stringify(m.metadata) : '';
      console.log(`  [seq=${m.seq}] role=${m.role}${meta}`);
      let display;
      if (typeof m.content === 'string') display = m.content;
      else display = JSON.stringify(m.content);
      display = (m.text && m.text.length > 0 ? m.text : display).slice(0, 2500);
      console.log('    ' + display.split('\n').join('\n    '));
      console.log('');
    }
  }

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
