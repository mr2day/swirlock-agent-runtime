#!/usr/bin/env node
/**
 * Smoke test: forces a search_web call by asking about a recent topic.
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
    systemPrompt:
      'You are a research assistant. When the user asks about anything recent, ALWAYS call search_web before answering. Cite the sources you used.',
    messages: [
      {
        role: 'user',
        content:
          'What were the most-discussed AI model releases in May 2026? Give a brief summary with sources.',
      },
    ],
    backend: { backend: 'anthropic' },
    maxSteps: 4,
    maxOutputTokens: 800,
  });

  let success = false;
  let sawSearch = false;
  let textOut = '';

  for await (const evt of turn) {
    if (evt.kind === 'turn-accepted') {
      console.log(`[smoke] turn-accepted: ${evt.backend} (${evt.model})`);
    } else if (evt.kind === 'text-delta') {
      textOut += evt.delta;
      process.stdout.write(evt.delta);
    } else if (evt.kind === 'tool-call-started') {
      if (evt.toolName === 'search_web') sawSearch = true;
      console.log(
        `\n[smoke] tool-call-started: ${evt.toolName} input=${JSON.stringify(evt.input)}`,
      );
    } else if (evt.kind === 'tool-call-completed') {
      const out = evt.output;
      if (evt.toolName === 'search_web' && out && Array.isArray(out.results)) {
        console.log(
          `[smoke] tool-call-completed: search_web got ${out.results.length} results`,
        );
        for (const r of out.results.slice(0, 3)) {
          console.log(`  - ${r.title} (${r.url})`);
        }
      } else {
        console.log(
          `[smoke] tool-call-completed: ${evt.toolName} ${JSON.stringify(out).slice(0, 120)}`,
        );
      }
    } else if (evt.kind === 'tool-call-failed') {
      console.error(`[smoke] tool-call-failed: ${evt.toolName} ${evt.error}`);
    } else if (evt.kind === 'turn-done') {
      success = true;
      console.log(`\n[smoke] turn-done finishReason=${evt.finishReason}`);
      console.log(
        `[smoke] usage in=${evt.usage.inputTokens ?? '?'} out=${evt.usage.outputTokens ?? '?'} total=${evt.usage.totalTokens ?? '?'}`,
      );
    } else if (evt.kind === 'turn-error') {
      console.error(`[smoke] turn-error: ${evt.error}`);
    }
  }

  await app.close();

  if (!success) process.exit(1);
  if (!sawSearch) {
    console.error('[smoke] expected at least one search_web call');
    process.exit(1);
  }
  if (!textOut.trim()) {
    console.error('[smoke] no final text emitted');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
