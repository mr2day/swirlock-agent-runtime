#!/usr/bin/env node
/**
 * Smoke test: force tool use against Mistral La Plateforme
 * (Ministral 14B). Asks for arithmetic and a time-zoned timestamp;
 * a working integration calls add_numbers + get_current_time exactly
 * once each, then summarises.
 *
 * Distinguishes "Ministral can't tool-use" from "our wiring is
 * wrong" by reporting tool-call count + final text.
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
    console.error('[smoke] MISTRAL_API_KEY missing — aborting.');
    process.exit(2);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });
  const agentLoop = app.get(AgentLoopService);

  const turn = agentLoop.run({
    systemPrompt:
      'You are a precise assistant. When the user asks for arithmetic, ALWAYS use the add_numbers tool — never compute mentally. When the user asks about the current time, ALWAYS use get_current_time. Then summarise the results.',
    messages: [
      {
        role: 'user',
        content:
          'Two things: (1) add the numbers 18, 27, 5, 42 — give me the exact sum. (2) Tell me the current time in Europe/Bucharest.',
      },
    ],
    backend: { backend: 'mistral-online' },
    maxSteps: 6,
    maxOutputTokens: 512,
  });

  let textOut = '';
  let toolCalls = 0;
  let toolResults = 0;
  let success = false;
  let turnError = null;

  for await (const evt of turn) {
    if (evt.kind === 'turn-accepted') {
      console.log(`[smoke] turn-accepted: ${evt.backend} (${evt.model})`);
    } else if (evt.kind === 'text-delta') {
      textOut += evt.delta;
      process.stdout.write(evt.delta);
    } else if (evt.kind === 'tool-call-started') {
      toolCalls += 1;
      console.log(
        `\n[smoke] tool-call-started: ${evt.toolName} input=${JSON.stringify(evt.input)}`,
      );
    } else if (evt.kind === 'tool-call-completed') {
      toolResults += 1;
      console.log(
        `[smoke] tool-call-completed: ${evt.toolName} output=${JSON.stringify(evt.output).slice(0, 200)}`,
      );
    } else if (evt.kind === 'tool-call-failed') {
      console.error(
        `[smoke] tool-call-failed: ${evt.toolName} error=${evt.error}`,
      );
    } else if (evt.kind === 'turn-done') {
      success = true;
      console.log(`\n[smoke] turn-done finishReason=${evt.finishReason}`);
      console.log(
        `[smoke] usage in=${evt.usage.inputTokens ?? '?'} out=${evt.usage.outputTokens ?? '?'} total=${evt.usage.totalTokens ?? '?'}`,
      );
      console.log(
        `[smoke] response messages count=${evt.responseMessages.length}`,
      );
    } else if (evt.kind === 'turn-error') {
      turnError = evt.error;
      console.error(`[smoke] turn-error: ${evt.error}`);
    }
  }

  await app.close();

  console.log(`\n[smoke] SUMMARY:`);
  console.log(`[smoke]   toolCalls=${toolCalls}`);
  console.log(`[smoke]   toolResults=${toolResults}`);
  console.log(`[smoke]   textOut length=${textOut.length}`);
  console.log(`[smoke]   success=${success}`);
  console.log(`[smoke]   error=${turnError ?? 'none'}`);

  if (!success) process.exit(1);
  if (toolCalls < 2) {
    console.error(`[smoke] FAIL: expected >=2 tool calls, got ${toolCalls}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
