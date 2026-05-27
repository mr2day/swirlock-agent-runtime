#!/usr/bin/env node
/**
 * Side-by-side comparison of the three configured backends
 * (anthropic, mistral-online, mistral-local via vLLM) on two
 * grounding-sensitive prompts:
 *
 *   - Romanian: "ce parere ai despre concertul lui Max Korzh la Bucuresti?"
 *   - English: "what is broadcasting right now on Antena 1?"
 *
 * Both are time-bound, region-specific questions that a model without
 * the search_web tool would have to either refuse or hallucinate.
 * Each backend gets a fresh in-memory session so prior context can't
 * leak between models.
 */

'use strict';

const path = require('node:path');
require(path.join(__dirname, '..', 'dist', 'env'));

const BACKENDS = ['anthropic', 'mistral-online', 'mistral-local'];

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
  'Today is ${currentDate}, the current time is ${currentTime} in the user\'s timezone (${userTimezone}). Use these for time-sensitive reasoning. The user\'s timezone is also a rough signal of where they are physically.',
  'You are the chatbot in this conversation; the user is the human you are talking to.',
  '',
  'You are a small, friendly robot. You default to doing the work over explaining it; you give plain, direct answers and skip preamble.',
].join('\n');

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

  const results = {};

  for (const backend of BACKENDS) {
    results[backend] = [];
    console.log(`\n================================================================`);
    console.log(`BACKEND: ${backend}`);
    console.log(`================================================================`);

    for (const probe of PROMPTS) {
      console.log(`\n--- ${probe.label} ---`);
      console.log(`USER: ${probe.text}`);

      const t0 = Date.now();
      const messages = [{ role: 'user', content: probe.text }];
      let model = '';
      let answer = '';
      const toolCalls = [];
      let error = null;
      let stopReason = null;
      let stopDetail = null;

      try {
        const turn = agentLoop.run({
          systemPrompt: SYSTEM_PROMPT,
          // No maxSteps pin — uses AGENT_MAX_STEPS from env.
          messages,
          backend: { backend },
          maxOutputTokens: 600,
          userTimezone: 'Europe/Bucharest',
        });
        for await (const evt of turn) {
          switch (evt.kind) {
            case 'turn-accepted':
              model = evt.model;
              break;
            case 'text-delta':
              answer += evt.delta;
              break;
            case 'tool-call-started':
              toolCalls.push({ name: evt.toolName, input: evt.input, output: null });
              break;
            case 'tool-call-completed': {
              const last = [...toolCalls].reverse().find((t) => t.name === evt.toolName && t.output === null);
              if (last) last.output = evt.output;
              break;
            }
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

      // Summarise search_web outputs for readability.
      const toolSummary = toolCalls.map((c) => {
        if (c.name === 'search_web' && c.output && Array.isArray(c.output.results)) {
          const cites = c.output.results.slice(0, 5).map((r) => ({
            title: r.title,
            published: r.published_date,
            host: (() => {
              try {
                return new URL(r.url).host;
              } catch {
                return r.url;
              }
            })(),
          }));
          return {
            name: c.name,
            input: c.input,
            n_results: c.output.results.length,
            top: cites,
          };
        }
        return { name: c.name, input: c.input, output: c.output };
      });

      console.log(`MODEL: ${model}  (${elapsedMs} ms)`);
      if (toolSummary.length > 0) {
        console.log(`TOOL CALLS:`);
        for (const t of toolSummary) {
          console.log(`  - ${t.name}(${JSON.stringify(t.input)})`);
          if (t.top) {
            console.log(`    n_results: ${t.n_results}`);
            for (const c of t.top) {
              console.log(`    * [${c.published ?? '—'}] ${c.host} — ${c.title}`);
            }
          }
        }
      } else {
        console.log(`TOOL CALLS: (none)`);
      }
      if (error) console.log(`ERROR: ${error}`);
      if (stopReason && stopReason !== 'completed') {
        console.log(`STOP: ${stopReason}${stopDetail ? ` — ${stopDetail}` : ''}`);
      }
      console.log(`ANSWER:\n${answer.trim()}`);

      results[backend].push({
        prompt: probe.label,
        model,
        elapsedMs,
        tools: toolSummary,
        answer: answer.trim(),
        stopReason,
        stopDetail,
        error,
      });
    }
  }

  // Dump a JSON record at the end for the comparison report.
  console.log(`\n================================================================`);
  console.log(`RAW JSON (for comparison)`);
  console.log(`================================================================`);
  console.log(JSON.stringify(results, null, 2));

  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
