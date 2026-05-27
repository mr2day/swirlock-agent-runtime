#!/usr/bin/env node
/**
 * A/B/C smoke across the three Ollama-local models the host has
 * pulled, on the same two grounding-sensitive prompts the 3-backend
 * comparison uses. The point is to see which (if any) of these
 * models emits structured tool calls reliably on Romanian input
 * via the native ollama-ai-provider-v2 wiring — without needing
 * the runtime-side tool-call-text repair shim.
 */

'use strict';

const path = require('node:path');
require(path.join(__dirname, '..', 'dist', 'env'));

const MODELS = ['ministral-3:14b', 'qwen3:14b', 'qwen3.5:9b'];

const PROMPTS = [
  {
    label: 'Max Korzh Bucuresti (Romanian, opinion on recent event)',
    text: 'ce parere ai despre concertul lui Max Korzh la Bucuresti?',
  },
  {
    label: 'Antena 1 broadcasting now (English, live state)',
    text: 'what is broadcasting right now on Antena 1?',
  },
];

const SYSTEM_PROMPT = [
  'Your name is "Gigi the Robot". If the user asks your name, answer plainly with "Gigi the Robot"; otherwise don\'t volunteer it. Your gender is male. You are based on the LLM model ${model} — when asked which model you are, give that string verbatim.',
  'Today is ${currentDate}, the current time is ${currentTime} in the user\'s timezone (${userTimezone}). Use these for time-sensitive reasoning.',
  'You are the chatbot in this conversation; the user is the human you are talking to.',
  '',
  'You are a small, friendly robot. You default to doing the work over explaining it; you give plain, direct answers and skip preamble.',
].join('\n');

async function main() {
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(__dirname, '..', 'dist', 'app.module'));
  const { AgentLoopService } = require(
    path.join(__dirname, '..', 'dist', 'agent', 'agent-loop.service'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  const agentLoop = app.get(AgentLoopService);

  for (const model of MODELS) {
    console.log(`\n================================================================`);
    console.log(`OLLAMA MODEL: ${model}`);
    console.log(`================================================================`);

    for (const probe of PROMPTS) {
      console.log(`\n--- ${probe.label} ---`);
      console.log(`USER: ${probe.text}`);

      const t0 = Date.now();
      const messages = [{ role: 'user', content: probe.text }];
      let answer = '';
      const toolCalls = [];
      let stopReason = null;
      let stopDetail = null;
      let error = null;

      try {
        const turn = agentLoop.run({
          systemPrompt: SYSTEM_PROMPT,
          messages,
          backend: { backend: 'ollama-local', model },
          maxOutputTokens: 600,
          userTimezone: 'Europe/Bucharest',
        });
        for await (const evt of turn) {
          switch (evt.kind) {
            case 'text-delta':
              answer += evt.delta;
              break;
            case 'tool-call-started':
              toolCalls.push({ name: evt.toolName, input: evt.input });
              break;
            case 'turn-done':
              stopReason = evt.stopReason;
              stopDetail = evt.stopDetail ?? null;
              break;
            case 'turn-error':
              error = evt.error;
              break;
          }
        }
      } catch (err) {
        error = err && err.message ? err.message : String(err);
      }
      const elapsedMs = Date.now() - t0;

      console.log(`  elapsed: ${elapsedMs} ms  stopReason: ${stopReason ?? 'n/a'}${stopDetail ? ' (' + stopDetail + ')' : ''}`);
      if (toolCalls.length > 0) {
        for (const c of toolCalls) {
          const q = c.input && typeof c.input === 'object' ? (c.input.query ?? JSON.stringify(c.input)) : JSON.stringify(c.input);
          console.log(`  TOOL: ${c.name}(${typeof q === 'string' ? q : JSON.stringify(q)})`);
        }
      } else {
        console.log(`  TOOL: (none)`);
      }
      if (error) console.log(`  ERROR: ${error}`);
      const trimmed = answer.trim();
      const malformedToolCallLooking = /^[a-z_][a-z_0-9]*\[ARGS\]\{/i.test(trimmed);
      if (malformedToolCallLooking) {
        console.log(`  !! MALFORMED TOOL CALL DETECTED IN TEXT:`);
      }
      console.log(`  ANSWER (${trimmed.length} chars):`);
      console.log(trimmed.split('\n').map((l) => '    ' + l).join('\n'));
    }
  }

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
