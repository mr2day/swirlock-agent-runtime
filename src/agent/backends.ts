import { createAnthropic } from '@ai-sdk/anthropic';
import { createMistral } from '@ai-sdk/mistral';
import { Injectable, Logger } from '@nestjs/common';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { repairMistralToolCallText } from './tool-call-text-repair';

// Three backends we operate against. The orchestrator picks one per
// turn (default at the session level, optionally overridden by the
// client on turn.submit).
//
//   anthropic       — Anthropic API, Haiku 4.5 by default
//   mistral-online  — Mistral La Plateforme, Ministral 14B by default
//   ollama-local    — local Ollama (ministral-3:14b by default) wired
//                     via ollama-ai-provider-v2 against Ollama's
//                     native /api/chat endpoint. NOT the OpenAI-
//                     compat shim — the native path preserves tool
//                     calls that the shim sometimes drops.
export type BackendId =
  | 'anthropic'
  | 'mistral-online'
  | 'ollama-local';

export interface BackendChoice {
  backend: BackendId;
  // Optional model override; falls back to the backend's configured
  // default if unset.
  model?: string;
}

/**
 * Public-facing description of a backend. Clients render the picker
 * directly from this — no hardcoded display names or model ids on
 * the UI side. `defaultModelId` is the model that turns will use if
 * the client doesn't override per-turn; it tracks the *_DEFAULT_MODEL
 * env vars so a config change here propagates everywhere.
 */
export interface BackendInfo {
  name: BackendId;
  displayName: string;
  defaultModelId: string;
  location: 'cloud' | 'local';
}

@Injectable()
export class BackendsService {
  private readonly logger = new Logger(BackendsService.name);

  private readonly anthropicFactory = createAnthropic({
    apiKey: this.requireEnv('ANTHROPIC_API_KEY'),
  });

  private readonly mistralOnlineFactory = process.env.MISTRAL_API_KEY
    ? createMistral({ apiKey: process.env.MISTRAL_API_KEY })
    : null;

  // Native Ollama provider. Talks /api/chat directly (no OpenAI-
  // compat translation), so tool-call payloads round-trip cleanly.
  // The baseURL is the /api root, NOT /v1.
  private readonly ollamaFactory = createOllama({
    baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/api',
  });


  /**
   * Resolve a LanguageModel for the given backend + optional model
   * override. Throws if the backend is configured but lacks a model
   * default, or if a remote backend has no API key in the environment.
   */
  resolve(choice: BackendChoice): LanguageModel {
    const { backend } = choice;

    const model = choice.model ?? this.defaultModelFor(backend);
    switch (backend) {
      case 'anthropic':
        return this.anthropicFactory(model);
      case 'mistral-online':
        if (!this.mistralOnlineFactory) {
          throw new Error(
            'mistral-online backend selected but MISTRAL_API_KEY is not set',
          );
        }
        return this.mistralOnlineFactory(model);
      case 'ollama-local': {
        const baseModel = this.ollamaFactory(model);
        const middleware = repairMistralToolCallText(model);
        return middleware
          ? wrapLanguageModel({ model: baseModel, middleware })
          : baseModel;
      }
      default: {
        const _exhaustive: never = backend;
        void _exhaustive;
        throw new Error(`unknown backend: ${String(backend)}`);
      }
    }
  }

  /**
   * Lists every backend the runtime can actually serve right now.
   * Cloud backends (anthropic, mistral-online) are gated by their
   * API key env var. The local backend (ollama-local) is probed
   * against Ollama's native /api/tags endpoint — if Ollama isn't
   * running, ollama-local disappears from the UI picker. No
   * hardcoded "this is always available" assumptions.
   */
  async available(): Promise<BackendInfo[]> {
    const list: BackendInfo[] = [];

    // displayName is the model id propagated from the backend's
    // configuration (env-driven via `defaultModelFor`). No hardcoded
    // friendly strings — the UI shows the actual model name, and a
    // model swap on the runtime side surfaces immediately without a
    // UI redeploy.
    if (process.env.ANTHROPIC_API_KEY) {
      const modelId = this.defaultModelFor('anthropic');
      list.push({
        name: 'anthropic',
        displayName: modelId,
        defaultModelId: modelId,
        location: 'cloud',
      });
    }
    if (this.mistralOnlineFactory) {
      const modelId = this.defaultModelFor('mistral-online');
      list.push({
        name: 'mistral-online',
        displayName: modelId,
        defaultModelId: modelId,
        location: 'cloud',
      });
    }

    const ollamaUp = await probeOllama(
      process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/api',
    );

    if (ollamaUp) {
      const modelId = this.defaultModelFor('ollama-local');
      list.push({
        name: 'ollama-local',
        displayName: modelId,
        defaultModelId: modelId,
        location: 'local',
      });
    }

    return list;
  }

  /**
   * The configured default backend (AGENT_DEFAULT_BACKEND). NOTE:
   * may not be currently available — callers wanting "what to
   * pre-select in the UI" should reconcile against available()
   * and fall back to the first available entry.
   */
  defaultBackend(): BackendId {
    const v = process.env.AGENT_DEFAULT_BACKEND as BackendId | undefined;
    if (
      v === 'anthropic' ||
      v === 'mistral-online' ||
      v === 'ollama-local'
    ) {
      return v;
    }
    return 'anthropic';
  }

  /**
   * Single source of truth for the default model id of each
   * backend. Used by `available()` (so the UI sees the same id the
   * runtime will resolve), by `resolve()` (when no per-turn model
   * override is set), and by AgentLoopService for turn-accepted
   * attribution. Env-overridable at every backend.
   */
  defaultModelFor(backend: BackendId): string {
    switch (backend) {
      case 'anthropic':
        return (
          process.env.ANTHROPIC_DEFAULT_MODEL ?? 'claude-haiku-4-5-20251001'
        );
      case 'mistral-online':
        return process.env.MISTRAL_DEFAULT_MODEL ?? 'ministral-14b-latest';
      case 'ollama-local':
        return process.env.OLLAMA_DEFAULT_MODEL ?? 'ministral-3:14b';
    }
  }

  private requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
      throw new Error(`${name} is required for the anthropic backend`);
    }
    return v;
  }
}

/**
 * Reachability probe for the local Ollama daemon. Hits
 * `${baseUrl}/tags`, which is the native endpoint that lists pulled
 * models. Truthy iff the call returns 2xx; failures are silent —
 * "not available right now" is the only piece of data the caller
 * needs. Note: this hits Ollama's native API root (`/api`), not the
 * OpenAI-compat shim (`/v1`), so it matches the path the
 * ollama-ai-provider-v2 factory uses for real requests.
 */
async function probeOllama(baseUrl: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 1200);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/tags`, {
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
