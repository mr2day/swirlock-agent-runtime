#!/usr/bin/env node
'use strict';

const path = require('node:path');
process.env.DEV_BYPASS_AUTH = 'true';
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

  const systemPrompt = [
    'Your name is "Gigi the Robot". You are based on the LLM model ${model}.',
    'Today is ${currentDate}, the current time is ${currentTime} in the user\'s timezone (${userTimezone}). Use these for time-sensitive reasoning. The user\'s timezone is also a rough signal of where they are physically.',
  ].join('\n');

  async function probe(label, prompt, tz) {
    console.log(`\n${label} (tz=${tz})`);
    console.log(`  > ${prompt}`);
    const turn = agentLoop.run({
      systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      backend: { backend: 'mistral-online' },
      maxSteps: 2,
      maxOutputTokens: 200,
      userTimezone: tz,
    });
    let text = '';
    for await (const evt of turn) {
      if (evt.kind === 'text-delta') text += evt.delta;
    }
    console.log(`  < ${text.trim().slice(0, 200)}`);
    return text;
  }

  const t1 = await probe(
    'time in Bucharest',
    'What time is it right now? Just hour:minute.',
    'Europe/Bucharest',
  );
  const t2 = await probe(
    'time in Los Angeles',
    'What time is it right now? Just hour:minute.',
    'America/Los_Angeles',
  );
  const t3 = await probe(
    'where am I',
    'Roughly, where am I? Two words.',
    'Europe/Bucharest',
  );

  await app.close();

  // Sanity: Bucharest is +03:00 in May (EEST); LA is -07:00 (PDT).
  // Their reported hours should differ by ~10. Don't string-match
  // too tightly; just confirm both produced an HH:MM.
  const hhmm1 = /\b(\d{1,2}):(\d{2})\b/.exec(t1);
  const hhmm2 = /\b(\d{1,2}):(\d{2})\b/.exec(t2);
  const probeAOk = hhmm1 && hhmm2 && hhmm1[0] !== hhmm2[0];
  const probeBOk = /bucharest|romania/i.test(t3);
  console.log(`\n=== SUMMARY ===`);
  console.log(`time differs by tz: ${probeAOk ? 'PASS' : 'FAIL'} (Bucharest=${hhmm1?.[0]} LA=${hhmm2?.[0]})`);
  console.log(`location-aware answer: ${probeBOk ? 'PASS' : 'FAIL'}`);
  process.exit(probeAOk && probeBOk ? 0 : 1);
}

main().catch((err) => {
  console.error('CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
