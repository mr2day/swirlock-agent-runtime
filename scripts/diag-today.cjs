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

  // "Today" in the user's timezone (Bucharest) - we'll filter by
  // server-side created_at >= start-of-today-UTC-minus-a-bit to be safe.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - 0); // last 24h

  const sessions = await db.db
    .selectFrom('sessions')
    .selectAll()
    .where('updated_at', '>=', since)
    .orderBy('updated_at', 'asc')
    .execute();

  console.log(`${sessions.length} sessions with activity since ${since.toISOString()}`);
  console.log('');

  for (const session of sessions) {
    const meta = session.client_metadata || {};
    console.log('================================================================');
    console.log(`session ${session.id}`);
    console.log(`  persona:         ${meta.personaId || '(none)'}`);
    console.log(`  title:           ${session.title}`);
    console.log(`  default_backend: ${session.default_backend}`);
    console.log(`  created_at:      ${session.created_at}`);
    console.log(`  updated_at:      ${session.updated_at}`);

    const messages = await db.db
      .selectFrom('messages')
      .selectAll()
      .where('session_id', '=', session.id)
      .orderBy('seq', 'asc')
      .execute();

    let lastTurnId = null;
    for (const m of messages) {
      if (m.turn_id !== lastTurnId) {
        console.log('  ---');
        lastTurnId = m.turn_id;
      }
      const meta = m.metadata ? JSON.stringify(m.metadata) : '';
      console.log(`  [seq=${m.seq}] ${m.role}${meta ? '  ' + meta : ''}`);
      let display;
      if (typeof m.content === 'string') {
        display = m.content;
      } else if (Array.isArray(m.content)) {
        display = m.content
          .map((p) => {
            if (!p || typeof p !== 'object') return JSON.stringify(p);
            if (p.type === 'text') return p.text;
            if (p.type === 'tool-call') {
              const args = p.input ? JSON.stringify(p.input) : '';
              return `→ ${p.toolName}(${args})`;
            }
            if (p.type === 'tool-result') {
              const out = p.output && p.output.value;
              const results = out && Array.isArray(out.results) ? out.results : null;
              if (results) {
                return `← ${results.length} search results:\n  ` +
                  results.slice(0, 5).map((r) =>
                    `* ${r.title || ''} <${r.url || ''}> [${r.published_date || '—'}]`
                  ).join('\n  ');
              }
              return `← ${JSON.stringify(out).slice(0, 600)}`;
            }
            return JSON.stringify(p);
          })
          .join('\n    ');
      } else {
        display = JSON.stringify(m.content);
      }
      display = (m.text && m.text.length > 0 ? m.text : display);
      console.log('    ' + String(display).slice(0, 1800).split('\n').join('\n    '));
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
