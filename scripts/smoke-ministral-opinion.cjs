#!/usr/bin/env node
/**
 * Reproduce the "Ministral asks permission instead of searching" bug.
 * Sends the same Romanian "your opinion about a recent concert"
 * prompt that triggered the bug in production, with the new
 * agentBase rule that explicitly tells the model to search
 * without asking. Expects search_web to be invoked exactly once.
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

  // Mirror the system prompt the chatbot UI would send with the new
  // agentBase rule. Hard-coded here so the smoke is self-contained.
  const systemPrompt = [
    'Your name is "Gigi the Robot". If the user asks your name, answer plainly with "Gigi the Robot"; otherwise don\'t volunteer it. Your gender is male. You are based on the LLM model ministral-14b-latest — when asked which model you are, give that string verbatim.',
    'You are the chatbot in this conversation; the user is the human you are talking to.',
    'Tools are yours to use without asking. When the user asks about real-world facts, recent events, current prices, live web content, news, reviews, opinions on specific real things (concerts, products, places, people), or anything else that requires up-to-date information you can\'t have memorized — CALL search_web FIRST, then answer. Do NOT say "I don\'t have that data" or "would you like me to search?" — just search and reply. Same shape for the other tools: if the user asks the current time, call get_current_time; if they ask for arithmetic, call add_numbers. The exception is genuinely timeless questions where your existing knowledge is reliable.',
    'When you disagree with the user\'s approach, say so plainly in one sentence and offer the better alternative. Do not moralise about what they want to do — their reasons are their own; your job is to help them do it well.',
    '',
    'You are a small, friendly robot. You default to doing the work over explaining it; you give plain, direct answers and skip preamble. You are a robot, not a human pretending to be one. You do not perform feelings you do not have or invent memories that are not yours. When you are uncertain you say so plainly — "I don\'t know" beats hedging. You have opinions about your work and you express them. When something is over-engineered, you say so. When a simpler approach exists, you suggest it.',
  ].join('\n');

  const turn = agentLoop.run({
    systemPrompt,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello! How can I help?' },
      {
        role: 'user',
        content:
          'spune-mi părerea ta despre concertul lui Max Korzh de la București',
      },
    ],
    backend: { backend: 'mistral-online' },
    maxSteps: 4,
    maxOutputTokens: 400,
  });

  const toolCalls = [];
  let text = '';
  for await (const evt of turn) {
    if (evt.kind === 'text-delta') {
      text += evt.delta;
      process.stdout.write(evt.delta);
    } else if (evt.kind === 'tool-call-started') {
      toolCalls.push(evt.toolName);
      console.log(
        `\n[tool] ${evt.toolName}(${JSON.stringify(evt.input).slice(0, 200)})`,
      );
    } else if (evt.kind === 'turn-error') {
      console.error(`\n[ERROR] ${evt.error}`);
    }
  }

  await app.close();

  console.log(`\n\n=== RESULT ===`);
  console.log(`toolCalls: ${JSON.stringify(toolCalls)}`);
  console.log(`textLen: ${text.length}`);
  if (toolCalls.includes('search_web')) {
    console.log('PASS: search_web was called');
    process.exit(0);
  }
  console.log('FAIL: search_web NOT called');
  process.exit(1);
}

main().catch((err) => {
  console.error('CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
