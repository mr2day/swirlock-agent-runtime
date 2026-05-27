#!/usr/bin/env node
/**
 * Realistic Ministral test: persona-prompted (Gigi the Robot), no
 * coaching, asks a question that genuinely needs a tool. Measures
 * whether Ministral reaches for search_web on its own.
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

  const personaPrompt = [
    'Your name is "Gigi the Robot". If the user asks your name, answer plainly with "Gigi the Robot"; otherwise don\'t volunteer it. Your gender is male. You are based on the LLM model ministral-14b-latest — when asked which model you are, give that string verbatim.',
    'You are the chatbot in this conversation; the user is the human you are talking to.',
    "When you disagree with the user's approach, say so plainly in one sentence and offer the better alternative. Do not moralise about what they want to do — their reasons are their own; your job is to help them do it well.",
    '',
    'You are a small, friendly robot. You default to doing the work over explaining it; you give plain, direct answers and skip preamble.',
  ].join('\n');

  async function runProbe(label, message) {
    console.log(`\n=========== ${label} ===========`);
    console.log(`>>> ${message}`);
    const turn = agentLoop.run({
      systemPrompt: personaPrompt,
      messages: [{ role: 'user', content: message }],
      backend: { backend: 'mistral-online' },
      maxSteps: 4,
      maxOutputTokens: 400,
    });
    let toolCalls = [];
    let text = '';
    for await (const evt of turn) {
      if (evt.kind === 'text-delta') {
        text += evt.delta;
        process.stdout.write(evt.delta);
      } else if (evt.kind === 'tool-call-started') {
        toolCalls.push(evt.toolName);
        console.log(`\n[tool] ${evt.toolName}(${JSON.stringify(evt.input).slice(0, 80)})`);
      } else if (evt.kind === 'turn-error') {
        console.error(`[ERROR] ${evt.error}`);
      }
    }
    console.log(`\n--- toolCalls=${JSON.stringify(toolCalls)} textLen=${text.length}`);
  }

  await runProbe(
    'Probe A: current time (should call get_current_time)',
    'What time is it right now in Bucharest?',
  );
  await runProbe(
    'Probe B: arithmetic (should call add_numbers)',
    'What is 18 + 27 + 5 + 42?',
  );
  await runProbe(
    'Probe C: live web fact (should call search_web)',
    'What was the most-talked-about AI model release this week?',
  );
  await runProbe(
    'Probe D: trivial chitchat (should NOT call any tool)',
    'Hi, how are you today?',
  );

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
