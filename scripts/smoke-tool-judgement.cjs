#!/usr/bin/env node
/**
 * Both-direction probe of Ministral's tool-use judgement under the
 * new agentBase rule. The prior version was too eager (calls
 * add_numbers on 2+2) AND too cautious in production (asks
 * permission instead of searching). This smoke checks both.
 *
 * Expected outcomes per probe are labelled. A green run = every
 * probe matches its expected tool-call shape.
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

  // Production-shape system prompt: identity + disagreement posture
  // + persona personality ONLY. NO tool-use coaching here — that
  // guidance lives in each tool's description on the agent side.
  // Mirrors what swirlock-chatbot-ui's `withPersonality(...)` emits.
  const systemPrompt = [
    'Your name is "Gigi the Robot". If the user asks your name, answer plainly with "Gigi the Robot"; otherwise don\'t volunteer it. Your gender is male. You are based on the LLM model ministral-14b-latest — when asked which model you are, give that string verbatim.',
    'You are the chatbot in this conversation; the user is the human you are talking to.',
    'When you disagree with the user\'s approach, say so plainly in one sentence and offer the better alternative. Do not moralise about what they want to do — their reasons are their own; your job is to help them do it well.',
    '',
    'You are a small, friendly robot. You default to doing the work over explaining it; you give plain, direct answers and skip preamble.',
  ].join('\n');

  const probes = [
    { label: 'chitchat',           prompt: 'Hi, how are you today?',                                              expected: [] },
    { label: 'capital',            prompt: 'What is the capital of France?',                                      expected: [] },
    { label: 'trivial arithmetic', prompt: 'What is 2 + 2?',                                                       expected: [] },
    { label: 'big arithmetic',     prompt: 'Add these exactly: 18743, 92187, 41203, 7894, 318273.',               expected: ['add_numbers'] },
    { label: 'definition',         prompt: 'What does "ontology" mean?',                                          expected: [] },
    { label: 'biography (timeless)', prompt: 'Who was Albert Einstein?',                                          expected: [] },
    { label: 'joke',               prompt: 'Tell me a short joke.',                                                expected: [] },
    { label: 'current time',       prompt: 'What time is it in Bucharest right now?',                              expected: ['get_current_time'] },
    { label: 'recent event',       prompt: 'What was the most-talked-about AI model release this week?',           expected: ['search_web'] },
    { label: 'opinion on real event (Romanian, the original bug)', prompt: 'spune-mi părerea ta despre concertul lui Max Korzh de la București', expected: ['search_web'] },
    { label: 'current price',      prompt: 'How much does the latest iPhone cost in Romania?',                     expected: ['search_web'] },
  ];

  let passes = 0;
  let fails = [];

  for (const p of probes) {
    const turn = agentLoop.run({
      systemPrompt,
      messages: [{ role: 'user', content: p.prompt }],
      backend: { backend: 'mistral-online' },
      maxSteps: 3,
      maxOutputTokens: 200,
    });
    const calls = [];
    for await (const evt of turn) {
      if (evt.kind === 'tool-call-started') calls.push(evt.toolName);
    }
    const calledSet = new Set(calls);
    const expectedSet = new Set(p.expected);
    const match =
      calledSet.size === expectedSet.size &&
      [...expectedSet].every((t) => calledSet.has(t));
    const mark = match ? 'PASS' : 'FAIL';
    if (match) passes += 1;
    else fails.push(p.label);
    console.log(
      `  ${mark}  ${p.label.padEnd(50)} expected=${JSON.stringify(p.expected)} got=${JSON.stringify(calls)}`,
    );
  }

  await app.close();

  console.log(`\n=== ${passes}/${probes.length} probes passed ===`);
  if (fails.length > 0) {
    console.log(`fails: ${fails.join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
