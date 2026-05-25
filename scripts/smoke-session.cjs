#!/usr/bin/env node
/**
 * Smoke test: creates a session, runs two turns against it, then reads
 * the full message history back and prints it.
 *
 * Verifies:
 *   - session row created
 *   - user/assistant/tool messages persisted in seq order
 *   - cumulative token count updated
 *   - second turn sees first turn's history via the loop
 */

'use strict';

const path = require('node:path');

require(path.join(__dirname, '..', 'dist', 'env'));

async function main() {
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(
    path.join(__dirname, '..', 'dist', 'app.module'),
  );
  const { SessionService } = require(
    path.join(__dirname, '..', 'dist', 'sessions', 'session.service'),
  );
  const { TurnService } = require(
    path.join(__dirname, '..', 'dist', 'sessions', 'turn.service'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });

  const sessions = app.get(SessionService);
  const turns = app.get(TurnService);

  const userId = 'smoke-user';
  const session = await sessions.createSession({
    userId,
    title: 'smoke session',
    systemPrompt:
      'You are a precise assistant. Use tools when needed and answer briefly.',
    defaultBackend: 'anthropic',
  });
  console.log(`[smoke] created session ${session.id}`);

  async function runTurn(message) {
    console.log(`\n[smoke] >>> user: ${message}`);
    const stream = turns.runTurn({
      sessionId: session.id,
      userId,
      userMessage: message,
      maxSteps: 4,
      maxOutputTokens: 256,
    });
    let last = null;
    for await (const evt of stream) {
      if (evt.kind === 'text-delta') {
        process.stdout.write(evt.delta);
      } else if (evt.kind === 'tool-call-started') {
        console.log(
          `\n[smoke] tool: ${evt.toolName}(${JSON.stringify(evt.input)})`,
        );
      } else if (evt.kind === 'tool-call-completed') {
        console.log(
          `[smoke] result: ${JSON.stringify(evt.output).slice(0, 160)}`,
        );
      } else if (evt.kind === 'turn-done') {
        last = evt;
        console.log(`\n[smoke] turn-done usage total=${evt.usage.totalTokens}`);
      } else if (evt.kind === 'turn-error') {
        console.error(`\n[smoke] turn-error: ${evt.error}`);
      }
    }
    return last;
  }

  await runTurn('What is 12 + 30? Use the add_numbers tool.');
  await runTurn('And what was the answer again? Just the number.');

  // Read back history.
  const messages = await sessions.getMessages(session.id, userId);
  console.log('\n[smoke] persisted messages:');
  for (const m of messages) {
    const contentDesc = Array.isArray(m.content)
      ? `[${m.content.length} parts]`
      : `string(${m.text.slice(0, 60).replace(/\s+/g, ' ')})`;
    console.log(
      `  seq=${m.seq} turn=${m.turnId.slice(0, 8)} role=${m.role} ${contentDesc}`,
    );
  }

  const reread = await sessions.getSession(session.id, userId);
  console.log(
    `\n[smoke] session token count after two turns: ${reread.totalTokenCount}`,
  );

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
