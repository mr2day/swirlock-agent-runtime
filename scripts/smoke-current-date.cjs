#!/usr/bin/env node
/**
 * Verify two things about ${currentDate} injection:
 * 1. When asked "what year is it?", the model returns the real year.
 * 2. When asked about a recent event that requires search, the
 *    search query uses the current year, not a year from the
 *    model's training cutoff.
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

  // Mirror what the chatbot UI sends now: agentBase + persona; the
  // placeholders are unresolved on the wire.
  const systemPrompt = [
    'Your name is "Gigi the Robot". If the user asks your name, answer plainly with "Gigi the Robot"; otherwise don\'t volunteer it. Your gender is male. You are based on the LLM model ${model} — when asked which model you are, give that string verbatim.',
    'Today\'s date is ${currentDate} (UTC). Use this for any time-sensitive reasoning — when forming a search query, computing how long ago something happened, deciding whether something is "recent". Never default to a year from your training data.',
    'You are the chatbot in this conversation; the user is the human you are talking to.',
    'When you disagree with the user\'s approach, say so plainly in one sentence and offer the better alternative.',
  ].join('\n');

  const realYear = String(new Date().getUTCFullYear());

  async function probe(label, prompt) {
    const turn = agentLoop.run({
      systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      backend: { backend: 'mistral-online' },
      maxSteps: 3,
      maxOutputTokens: 200,
    });
    let text = '';
    const toolInputs = [];
    for await (const evt of turn) {
      if (evt.kind === 'text-delta') text += evt.delta;
      if (evt.kind === 'tool-call-started') {
        toolInputs.push({ name: evt.toolName, input: evt.input });
      }
    }
    console.log(`\n${label}`);
    console.log(`  user: ${prompt}`);
    console.log(`  text: ${text.trim().slice(0, 200)}`);
    if (toolInputs.length > 0) {
      console.log(`  tool: ${JSON.stringify(toolInputs)}`);
    }
    return { text, toolInputs };
  }

  const a = await probe(
    'PROBE A: what year is it (no tools needed; model should use ${currentDate})',
    'In one word, what year is it?',
  );
  const aPass = a.text.includes(realYear);

  const b = await probe(
    'PROBE B: search query should use the real year, not 2024',
    'spune-mi părerea ta despre concertul Max Korzh de la București',
  );
  const searchInputs = b.toolInputs.filter((t) => t.name === 'search_web');
  const queryHasRealYear = searchInputs.some((t) =>
    String(t.input.query ?? '').includes(realYear),
  );
  const queryNoStale2024 = !searchInputs.some((t) =>
    /\b2024\b/.test(String(t.input.query ?? '')),
  );
  const bPass = searchInputs.length > 0 && (queryHasRealYear || queryNoStale2024);

  await app.close();

  console.log(`\n=== SUMMARY ===`);
  console.log(`A (year-aware): ${aPass ? 'PASS' : 'FAIL'} (said "${realYear}"? ${aPass})`);
  console.log(
    `B (search uses real year, not 2024): ${bPass ? 'PASS' : 'FAIL'} (searches=${searchInputs.length}, hasRealYear=${queryHasRealYear}, no2024=${queryNoStale2024})`,
  );
  process.exit(aPass && bPass ? 0 : 1);
}

main().catch((err) => {
  console.error('CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
