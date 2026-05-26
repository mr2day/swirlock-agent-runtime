#!/usr/bin/env node
/**
 * Smoke test: one Anthropic-shape turn against Mistral La Plateforme
 * via the agent loop. Verifies the @ai-sdk/mistral factory + the
 * configured MISTRAL_API_KEY actually authorizes against the chat
 * completions endpoint.
 *
 * Failure modes worth distinguishing from the output:
 *   - 401 / "invalid api key" → key string is wrong
 *   - 403 / "forbidden" → key is the wrong *kind* (e.g. studio key
 *     not authorized for La Plateforme's chat completions)
 *   - timeout / connection error → network or Mistral outage
 *   - text returned → key works; mistral-online is live
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
  const { AgentLoopService } = require(
    path.join(__dirname, '..', 'dist', 'agent', 'agent-loop.service'),
  );

  if (!process.env.MISTRAL_API_KEY) {
    console.error(
      '[smoke] MISTRAL_API_KEY is not set. Add it to service.config.local.cjs and rebuild.',
    );
    process.exit(2);
  }

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
        content:
          'Reply with exactly the four words: MISTRAL IS ALIVE ONLINE.',
      },
    ],
    backend: { backend: 'mistral-online' },
    maxSteps: 1,
    maxOutputTokens: 64,
  });

  let textOut = '';
  let success = false;

  for await (const evt of turn) {
    if (evt.kind === 'turn-accepted') {
      console.log(`[smoke] turn-accepted: ${evt.backend} (${evt.model})`);
    } else if (evt.kind === 'text-delta') {
      textOut += evt.delta;
      process.stdout.write(evt.delta);
    } else if (evt.kind === 'turn-done') {
      success = true;
      console.log('');
      console.log(`[smoke] turn-done finishReason=${evt.finishReason}`);
      console.log(
        `[smoke] usage in=${evt.usage.inputTokens ?? '?'} out=${evt.usage.outputTokens ?? '?'} total=${evt.usage.totalTokens ?? '?'}`,
      );
    } else if (evt.kind === 'turn-error') {
      console.error(`[smoke] turn-error: ${evt.error}`);
    }
  }

  await app.close();

  if (!success) process.exit(1);
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
