'use strict';

/**
 * Declarative assertion checker for eval scenarios.
 *
 * Each scenario's `expect` object is interpreted here. The keys are
 * the assertion names; the values are the parameters. Every assertion
 * returns `{ ok: boolean, message: string }`; the runner aggregates
 * all of them into the scenario result.
 *
 * Supported keys (add new ones at the bottom; keep the existing ones
 * stable since scenarios depend on them by name):
 *
 *   toolCallsInclude: string             — at least one tool call had this name
 *   toolCallsExclude: string[]           — none of these tools were called
 *   minToolCalls: number                 — total tool calls >= N
 *   maxToolCalls: number                 — total tool calls <= N
 *   stopReason: string                   — turn-done stopReason exactly matches
 *   stopReasonNot: string                — turn-done stopReason does NOT match
 *   answerNotEmpty: true                 — accumulated text-delta length > 0
 *   answerMinLength: number              — accumulated text-delta length >= N
 *   answerContains: string[]             — answer contains every substring (case-insensitive)
 *   answerMatches: RegExp                — answer matches the regex
 *   noMalformedToolCallText: true        — answer doesn't contain `<word>[ARGS]{`
 *   maxLatencyMs: number                 — wall-clock elapsed <= N
 *   noTurnError: true                    — no turn-error event was emitted
 */

const MALFORMED_PATTERN = /[a-zA-Z_][a-zA-Z_0-9]*\[ARGS\]\{/;

/**
 * @param {object} expectations - the scenario's `expect` block
 * @param {object} captured - { toolCalls: string[], answer: string, stopReason: string|null, finishReason: string|null, errors: string[], elapsedMs: number }
 * @returns {Array<{ok: boolean, message: string}>}
 */
function checkAll(expectations, captured) {
  const results = [];

  if (expectations.toolCallsInclude !== undefined) {
    const name = expectations.toolCallsInclude;
    const ok = captured.toolCalls.includes(name);
    results.push({
      ok,
      message: ok
        ? `tool calls include ${name} ✓`
        : `tool calls include ${name} — got [${captured.toolCalls.join(', ')}]`,
    });
  }

  if (Array.isArray(expectations.toolCallsExclude)) {
    for (const name of expectations.toolCallsExclude) {
      const ok = !captured.toolCalls.includes(name);
      results.push({
        ok,
        message: ok
          ? `tool calls exclude ${name} ✓`
          : `tool calls should NOT include ${name} — but they did`,
      });
    }
  }

  if (typeof expectations.minToolCalls === 'number') {
    const n = expectations.minToolCalls;
    const ok = captured.toolCalls.length >= n;
    results.push({
      ok,
      message: ok
        ? `tool calls >= ${n} ✓ (got ${captured.toolCalls.length})`
        : `tool calls >= ${n} — got ${captured.toolCalls.length}`,
    });
  }

  if (typeof expectations.maxToolCalls === 'number') {
    const n = expectations.maxToolCalls;
    const ok = captured.toolCalls.length <= n;
    results.push({
      ok,
      message: ok
        ? `tool calls <= ${n} ✓ (got ${captured.toolCalls.length})`
        : `tool calls <= ${n} — got ${captured.toolCalls.length}`,
    });
  }

  if (typeof expectations.stopReason === 'string') {
    const expected = expectations.stopReason;
    const got = captured.stopReason;
    const ok = got === expected;
    results.push({
      ok,
      message: ok
        ? `stopReason === ${expected} ✓`
        : `stopReason === ${expected} — got ${got}`,
    });
  }

  if (typeof expectations.stopReasonNot === 'string') {
    const expected = expectations.stopReasonNot;
    const got = captured.stopReason;
    const ok = got !== expected;
    results.push({
      ok,
      message: ok
        ? `stopReason !== ${expected} ✓`
        : `stopReason !== ${expected} — but it was`,
    });
  }

  if (expectations.answerNotEmpty === true) {
    const ok = captured.answer.trim().length > 0;
    results.push({
      ok,
      message: ok
        ? `answer is non-empty ✓ (${captured.answer.length} chars)`
        : `answer is non-empty — got empty string`,
    });
  }

  if (typeof expectations.answerMinLength === 'number') {
    const n = expectations.answerMinLength;
    const ok = captured.answer.length >= n;
    results.push({
      ok,
      message: ok
        ? `answer length >= ${n} ✓ (got ${captured.answer.length})`
        : `answer length >= ${n} — got ${captured.answer.length}`,
    });
  }

  if (Array.isArray(expectations.answerContains)) {
    const lowered = captured.answer.toLowerCase();
    for (const sub of expectations.answerContains) {
      const ok = lowered.includes(String(sub).toLowerCase());
      results.push({
        ok,
        message: ok
          ? `answer contains "${sub}" ✓`
          : `answer contains "${sub}" — not found`,
      });
    }
  }

  if (expectations.answerMatches instanceof RegExp) {
    const re = expectations.answerMatches;
    const ok = re.test(captured.answer);
    results.push({
      ok,
      message: ok
        ? `answer matches ${re} ✓`
        : `answer matches ${re} — not matched`,
    });
  }

  if (expectations.noMalformedToolCallText === true) {
    const ok = !MALFORMED_PATTERN.test(captured.answer);
    results.push({
      ok,
      message: ok
        ? `answer free of malformed tool-call text ✓`
        : `answer contains malformed tool-call pattern (\`<name>[ARGS]{...}\`) — the repair didn't fire`,
    });
  }

  if (typeof expectations.maxLatencyMs === 'number') {
    const n = expectations.maxLatencyMs;
    const ok = captured.elapsedMs <= n;
    results.push({
      ok,
      message: ok
        ? `elapsed <= ${n}ms ✓ (got ${captured.elapsedMs}ms)`
        : `elapsed <= ${n}ms — got ${captured.elapsedMs}ms`,
    });
  }

  if (expectations.noTurnError === true) {
    const ok = captured.errors.length === 0;
    results.push({
      ok,
      message: ok
        ? `no turn-error events ✓`
        : `expected no turn-error events; got: ${captured.errors.join(' | ')}`,
    });
  }

  return results;
}

module.exports = { checkAll };
