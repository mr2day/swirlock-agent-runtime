#!/usr/bin/env node
'use strict';

/**
 * Eval harness for swirlock-agent-runtime.
 *
 * Discovers scenario files in `eval/scenarios/*.cjs`, runs each one
 * against the actual AgentLoopService, and reports PASS / FAIL /
 * SKIP per scenario. Exits non-zero if any scenario fails so the
 * harness can gate `pm2 startOrReload` or a git pre-push hook.
 *
 * Add a scenario by dropping a new `.cjs` file in `eval/scenarios/`
 * that exports `{ name, preconditions, input, expect }`. See the
 * existing scenarios + `eval/lib/assertions.cjs` for the supported
 * shapes.
 */

const path = require('node:path');
const fs = require('node:fs');

require(path.join(__dirname, '..', 'dist', 'env'));

const { checkAll } = require(path.join(__dirname, 'lib', 'assertions.cjs'));
const preconditionHelpers = require(
  path.join(__dirname, 'lib', 'preconditions.cjs'),
);

const SCENARIOS_DIR = path.join(__dirname, 'scenarios');

function loadScenarios() {
  if (!fs.existsSync(SCENARIOS_DIR)) return [];
  const files = fs
    .readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith('.cjs'))
    .sort();
  return files.map((f) => ({
    file: f,
    scenario: require(path.join(SCENARIOS_DIR, f)),
  }));
}

async function checkPreconditions(scenario) {
  if (typeof scenario.preconditions !== 'function') return { ok: true, reasons: [] };
  const requested = scenario.preconditions({
    ollamaRunning: () => preconditionHelpers.ollamaRunning(),
    ollamaModel: (name) => preconditionHelpers.ollamaModelPulled(name),
    envSet: (name) => preconditionHelpers.envSet(name),
  });
  const resolved = await Promise.all(requested);
  const failures = resolved.filter((r) => !r.ok);
  if (failures.length === 0) return { ok: true, reasons: [] };
  return { ok: false, reasons: failures.map((f) => f.reason) };
}

async function runScenario(agentLoop, scenario) {
  const t0 = Date.now();
  const captured = {
    toolCalls: [],
    toolInputs: [],
    answer: '',
    stopReason: null,
    stopDetail: null,
    finishReason: null,
    errors: [],
    elapsedMs: 0,
  };

  try {
    const turn = agentLoop.run(scenario.input);
    for await (const evt of turn) {
      switch (evt.kind) {
        case 'text-delta':
          captured.answer += evt.delta;
          break;
        case 'tool-call-started':
          captured.toolCalls.push(evt.toolName);
          captured.toolInputs.push(evt.input);
          break;
        case 'turn-done':
          captured.stopReason = evt.stopReason ?? null;
          captured.stopDetail = evt.stopDetail ?? null;
          captured.finishReason = evt.finishReason ?? null;
          break;
        case 'turn-error':
          captured.errors.push(evt.error);
          break;
      }
    }
  } catch (err) {
    captured.errors.push(err && err.message ? err.message : String(err));
  }
  captured.elapsedMs = Date.now() - t0;
  return captured;
}

async function main() {
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(path.join(__dirname, '..', 'dist', 'app.module'));
  const { AgentLoopService } = require(
    path.join(__dirname, '..', 'dist', 'agent', 'agent-loop.service'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  const agentLoop = app.get(AgentLoopService);

  const entries = loadScenarios();
  if (entries.length === 0) {
    console.log('no scenarios found in eval/scenarios/');
    await app.close();
    process.exit(0);
  }

  console.log(`\n=== swirlock-agent-runtime eval ===`);
  console.log(`scenarios: ${entries.length}\n`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failingDetails = [];

  for (const { file, scenario } of entries) {
    const label = scenario.name ?? file;
    process.stdout.write(`  · ${label}\n`);

    const pre = await checkPreconditions(scenario);
    if (!pre.ok) {
      console.log(`    SKIP — ${pre.reasons.join('; ')}\n`);
      skipped += 1;
      continue;
    }

    const captured = await runScenario(agentLoop, scenario);
    const checks = checkAll(scenario.expect ?? {}, captured);
    const failures = checks.filter((c) => !c.ok);
    if (failures.length === 0) {
      console.log(`    PASS (${captured.elapsedMs}ms, ${captured.toolCalls.length} tool calls)\n`);
      passed += 1;
    } else {
      console.log(`    FAIL (${captured.elapsedMs}ms)`);
      for (const f of failures) console.log(`      ✗ ${f.message}`);
      console.log('');
      failed += 1;
      failingDetails.push({ file, label, failures, captured });
    }
  }

  console.log(`=== summary ===`);
  console.log(`  PASS:    ${passed}`);
  console.log(`  FAIL:    ${failed}`);
  console.log(`  SKIP:    ${skipped}`);
  console.log(`  TOTAL:   ${entries.length}`);

  await app.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('eval runner crashed:', err && err.stack ? err.stack : err);
  process.exit(2);
});
