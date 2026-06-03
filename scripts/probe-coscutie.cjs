#!/usr/bin/env node
/**
 * Drive a fresh agent turn that asks: "analyse the website coscutie.ro
 * and tell me what they sell, how the site is structured, and what
 * categories of products are most prominent." Capture every tool call
 * the model makes, then dump the answer. We use Anthropic Haiku for
 * this — it's the cleanest reasoner on tool routing and gives us a
 * baseline of "what does an agent loop with the tools we have today
 * actually produce for this kind of site-analysis task."
 */

'use strict';

const path = require('node:path');
require(path.join(__dirname, '..', 'dist', 'env'));

async function main() {
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(__dirname, '..', 'dist', 'app.module'));
  const { AgentLoopService } = require(
    path.join(__dirname, '..', 'dist', 'agent', 'agent-loop.service'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  const agentLoop = app.get(AgentLoopService);

  const systemPrompt = [
    'You are a small, friendly robot. Use tools when you need fresh',
    'information from the web.',
    'Today is ${currentDate}, the current time is ${currentTime} in',
    'the user timezone (${userTimezone}).',
  ].join('\n');

  const probes = [
    {
      label: 'analyse coscutie.ro',
      prompt:
        'Analizează site-ul coscutie.ro. Ce vând? Cum e structurat? Ce categorii de produse sunt cele mai vizibile?',
    },
  ];

  for (const probe of probes) {
    console.log('================================================================');
    console.log(`PROMPT: ${probe.prompt}`);
    console.log('');

    const t0 = Date.now();
    let answer = '';
    const toolCalls = [];

    const turn = agentLoop.run({
      systemPrompt,
      messages: [{ role: 'user', content: probe.prompt }],
      backend: { backend: 'anthropic' },
      maxOutputTokens: 1500,
      userTimezone: 'Europe/Bucharest',
    });

    for await (const evt of turn) {
      switch (evt.kind) {
        case 'text-delta':
          answer += evt.delta;
          break;
        case 'tool-call-started':
          toolCalls.push({
            name: evt.toolName,
            input: evt.input,
            output: null,
          });
          break;
        case 'tool-call-completed': {
          const last = [...toolCalls].reverse().find(
            (t) => t.name === evt.toolName && t.output === null,
          );
          if (last) last.output = evt.output;
          break;
        }
      }
    }
    const elapsed = Date.now() - t0;

    console.log(`elapsed: ${elapsed} ms, ${toolCalls.length} tool calls`);
    for (let i = 0; i < toolCalls.length; i++) {
      const c = toolCalls[i];
      const input =
        c.name === 'search_web'
          ? `q="${c.input.query}" freshness=${c.input.freshness ?? '?'} n=${c.input.num_results ?? '?'}`
          : c.name === 'fetch_page'
            ? c.input.url
            : JSON.stringify(c.input);
      const outSummary =
        c.name === 'fetch_page' && c.output
          ? `${c.output.content_length ?? '?'} chars (truncated=${c.output.truncated ?? '?'})`
          : c.name === 'search_web' && c.output
            ? `${c.output.results?.length ?? 0} results`
            : '';
      console.log(`  [${i + 1}] ${c.name}(${input}) → ${outSummary}`);
    }
    console.log('');
    console.log('ANSWER:');
    console.log(answer.trim());
    console.log('');
  }

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
