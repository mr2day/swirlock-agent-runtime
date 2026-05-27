'use strict';

/**
 * Precondition helpers for eval scenarios. Each helper returns
 * `{ ok: boolean, reason: string }` so the runner can SKIP a
 * scenario instead of failing it when an external dependency
 * isn't reachable.
 *
 * Scenarios declare their preconditions as a function that returns
 * an array of these results; the runner OR-merges any failures into
 * a SKIP reason on the report.
 */

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/api';

async function ollamaRunning() {
  const base = process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/tags`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `ollama /tags returned ${res.status}` };
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: `ollama unreachable at ${base}: ${err && err.message ? err.message : err}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function ollamaModelPulled(modelName) {
  const base = process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 1500);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/tags`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `ollama /tags returned ${res.status}` };
    const body = await res.json();
    const models = Array.isArray(body.models) ? body.models : [];
    const hit = models.find((m) => m && (m.name === modelName || m.model === modelName));
    if (!hit) return { ok: false, reason: `ollama model not pulled: ${modelName}` };
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: `ollama unreachable while checking ${modelName}: ${err && err.message ? err.message : err}` };
  } finally {
    clearTimeout(timeout);
  }
}

function envSet(name) {
  const v = process.env[name];
  if (!v || v.length === 0) return { ok: false, reason: `${name} not set` };
  return { ok: true, reason: '' };
}

module.exports = {
  ollamaRunning,
  ollamaModelPulled,
  envSet,
};
