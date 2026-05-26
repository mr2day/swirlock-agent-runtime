#!/usr/bin/env node
/**
 * Smoke test: runs one Anthropic-shape turn against the local Ollama
 * via the agent loop. Verifies the openai-compatible factory wires up
 * correctly and that ministral-3:14b returns text. No tools — the
 * Ollama tool-use path will be exercised separately once we trust
 * the basic transport.
 *
 * Requires Ollama running at OLLAMA_BASE_URL (default
 * http://127.0.0.1:11434/v1) with the OLLAMA_DEFAULT_MODEL pulled.
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

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });

  const agentLoop = app.get(AgentLoopService);

  const turn = agentLoop.run({
    systemPrompt: 'You are a brief assistant. Answer in one short sentence.',
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly the four words: OLLAMA IS ALIVE LOCALLY.',
      },
    ],
    backend: { backend: 'ollama-local' },
    maxSteps: 1,
    maxOutputTokens: 64,
  });

  let textOut = '';
  let success = false;
  let backendUsed = null;

  for await (const evt of turn) {
    if (evt.kind === 'turn-accepted') {
      backendUsed = `${evt.backend} (${evt.model})`;
      console.log(`[smoke] turn-accepted: ${backendUsed}`);
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
