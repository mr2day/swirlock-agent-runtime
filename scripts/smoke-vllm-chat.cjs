#!/usr/bin/env node
/**
 * Conversational smoke against the local vLLM-served Ministral
 * (backend: mistral-local). Drives a multi-turn chat through
 * AgentLoopService so we exercise the same path the WebSocket
 * gateway uses — system-prompt substitution, tool registry, the
 * mistral tool-call parser inside vLLM, the multi-step loop.
 *
 * Prints what the model actually said per turn so you can see
 * whether the local engine talks fluently and whether tool routing
 * survives the engine swap (Ollama → vLLM).
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
    bufferLogs: true,
  });
  const agentLoop = app.get(AgentLoopService);

  const systemPrompt = [
    'Your name is "Gigi the Robot". If the user asks your name, answer plainly with "Gigi the Robot"; otherwise don\'t volunteer it. Your gender is male. You are based on the LLM model ${model} — when asked which model you are, give that string verbatim.',
    'Today is ${currentDate}, the current time is ${currentTime} in the user\'s timezone (${userTimezone}). Use these for time-sensitive reasoning. The user\'s timezone is also a rough signal of where they are physically.',
    'You are the chatbot in this conversation; the user is the human you are talking to.',
    '',
    'You are a small, friendly robot. You default to doing the work over explaining it; you give plain, direct answers and skip preamble.',
  ].join('\n');

  const messages = [];
  let turnCount = 0;

  async function userSays(text) {
    turnCount += 1;
    console.log(`\n--- turn ${turnCount} ---`);
    console.log(`USER: ${text}`);
    messages.push({ role: 'user', content: text });

    let assistantText = '';
    const toolCalls = [];
    let model = '';
    const turn = agentLoop.run({
      systemPrompt,
      messages,
      backend: { backend: 'mistral-local' },
      maxSteps: 4,
      maxOutputTokens: 400,
      userTimezone: 'Europe/Bucharest',
    });
    let responseMessages = null;
    for await (const evt of turn) {
      switch (evt.kind) {
        case 'turn-accepted':
          model = evt.model;
          break;
        case 'text-delta':
          assistantText += evt.delta;
          break;
        case 'tool-call-started':
          toolCalls.push(`${evt.toolName}(${JSON.stringify(evt.input)})`);
          break;
        case 'turn-done':
          responseMessages = evt.responseMessages;
          break;
        case 'turn-error':
          console.log(`AGENT ERROR: ${evt.error}`);
          break;
      }
    }
    if (toolCalls.length > 0) {
      console.log(`TOOL: ${toolCalls.join(' ; ')}`);
    }
    console.log(`AGENT (${model}): ${assistantText.trim()}`);
    if (responseMessages) {
      for (const m of responseMessages) {
        messages.push(m);
      }
    }
  }

  await userSays('Hi there. What is your name?');
  await userSays('Which LLM model are you running on right now?');
  await userSays('Please add these for me exactly: 18743, 92187, 41203, 7894, 318273.');
  await userSays('What time is it in Bucharest right now?');
  await userSays('What was the most-talked-about AI model release this week?');
  await userSays('Spune-mi pe scurt ce este "ontologie".');

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
