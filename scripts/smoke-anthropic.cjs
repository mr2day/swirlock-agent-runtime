#!/usr/bin/env node
/**
 * Smoke test: boots a minimal NestJS context, resolves
 * AgentLoopService, and runs a single turn against Anthropic Haiku.
 *
 * Prints every event the loop emits. Exits 0 on turn-done, non-zero on
 * turn-error. Cheap to run (~$0.001 of Haiku tokens per shot).
 */

'use strict';

const path = require('node:path');

require(path.join(__dirname, '..', 'dist', 'env'));

async function main() {
  // Load compiled Nest application.
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(
    path.join(__dirname, '..', 'dist', 'app.module'),
  );
  const { AgentLoopService } = require(
    path.join(__dirname, '..', 'dist', 'agent', 'agent-loop.service'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });

  const agentLoop = app.get(AgentLoopService);

  const turn = agentLoop.run({
    systemPrompt:
      'You are a brief assistant. Answer in one short sentence.',
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly the four words: SWIRLOCK AGENT IS ALIVE.',
      },
    ],
    backend: { backend: 'anthropic' },
    maxSteps: 1,
    maxOutputTokens: 64,
  });

  let textOut = '';
  let success = false;
  let errorOut = null;
  let backendUsed = null;
  let usage = null;

  for await (const evt of turn) {
    if (evt.kind === 'turn-accepted') {
      backendUsed = `${evt.backend} (${evt.model})`;
      console.log(`[smoke] turn-accepted: ${backendUsed}`);
    } else if (evt.kind === 'text-delta') {
      textOut += evt.delta;
      process.stdout.write(evt.delta);
    } else if (evt.kind === 'turn-done') {
      usage = evt.usage;
      success = true;
      console.log('');
      console.log(`[smoke] turn-done finishReason=${evt.finishReason}`);
      console.log(
        `[smoke] usage in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'} total=${usage.totalTokens ?? '?'}`,
      );
    } else if (evt.kind === 'turn-error') {
      errorOut = evt.error;
      console.error(`[smoke] turn-error: ${evt.error}`);
    } else {
      console.log(`[smoke] event: ${evt.kind}`);
    }
  }

  await app.close();

  if (!success) {
    process.exit(1);
  }

  if (!textOut.trim()) {
    console.error('[smoke] turn-done but no text emitted');
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
