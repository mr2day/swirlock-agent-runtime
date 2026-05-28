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
      eb(ref('client_metadata'), '@>', '{"personaId":"violetta-sterling"}'),
    )
    .orderBy('updated_at', 'desc')
    .limit(2)
    .execute();

  if (sessions.length === 0) {
    console.log('no Violetta sessions found');
    await app.close();
    process.exit(0);
  }

  for (const session of sessions) {
    console.log('================================================================');
    console.log(`session ${session.id}`);
    console.log(`  title:           ${session.title}`);
    console.log(`  default_backend: ${session.default_backend}`);
    console.log(`  updated_at:      ${session.updated_at}`);
    console.log(`  client_metadata: ${JSON.stringify(session.client_metadata)}`);
    console.log(`  system_prompt:`);
    console.log('    ' + String(session.system_prompt ?? '').replace(/\n/g, '\n    '));
    console.log('  ---');

    const messages = await db.db
      .selectFrom('messages')
      .selectAll()
      .where('session_id', '=', session.id)
      .orderBy('seq', 'asc')
      .execute();

    for (const m of messages) {
      console.log(`  [seq=${m.seq}] role=${m.role}  turn=${m.turn_id}  metadata=${JSON.stringify(m.metadata)}`);
      const contentStr =
        typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content, null, 2);
      const display = (m.text && m.text.length > 0 ? m.text : contentStr).slice(0, 2000);
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
