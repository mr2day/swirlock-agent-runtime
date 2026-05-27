import { createAnthropic } from '@ai-sdk/anthropic';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Injectable, Logger } from '@nestjs/common';
import type { LanguageModel } from 'ai';

// Three backends we operate against. The orchestrator picks one per
// turn (default at the session level, optionally overridden by the
// client on turn.submit).
//
//   anthropic       — Anthropic API, Haiku 4.5 by default
//   mistral-online  — Mistral La Plateforme, Ministral 14B by default
//   mistral-local   — local vLLM serving Ministral via OpenAI-compatible
//                     REST, plain bearer-less localhost endpoint
export type BackendId =
  | 'anthropic'
  | 'mistral-online'
  | 'mistral-local';

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

  private readonly vllmFactory = createOpenAICompatible({
    name: 'vllm-local',
    baseURL: process.env.VLLM_BASE_URL ?? 'http://127.0.0.1:8000/v1',
    // vLLM by default does not require a key. We pass a sentinel so the
    // OpenAI SDK does not reject the request for missing Authorization.
    apiKey: process.env.VLLM_API_KEY ?? 'sk-no-auth',
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
      case 'mistral-local':
        return this.vllmFactory(model);
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
   * API key env var. The local backend (mistral-local via vLLM) is
   * probed at the configured URL on every call — if vLLM isn't
   * running, mistral-local disappears from the UI picker. No
   * hardcoded "this is always available" assumptions.
   */
  async available(): Promise<BackendInfo[]> {
    const list: BackendInfo[] = [];

    if (process.env.ANTHROPIC_API_KEY) {
      list.push({
        name: 'anthropic',
        displayName: 'Claude Haiku 4.5',
        defaultModelId: this.defaultModelFor('anthropic'),
        location: 'cloud',
      });
    }
    if (this.mistralOnlineFactory) {
      list.push({
        name: 'mistral-online',
        displayName: 'Ministral 14B',
        defaultModelId: this.defaultModelFor('mistral-online'),
        location: 'cloud',
      });
    }

    const vllmUp = await probeOpenAICompatible(
      process.env.VLLM_BASE_URL ?? 'http://127.0.0.1:8000/v1',
    );

    if (vllmUp) {
      list.push({
        name: 'mistral-local',
        displayName: 'vLLM (local)',
        defaultModelId: this.defaultModelFor('mistral-local'),
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
      v === 'mistral-local'
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
      case 'mistral-local':
        return process.env.VLLM_DEFAULT_MODEL ?? 'ministral-14b-local';
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
 * Reachability probe for an OpenAI-compatible local provider. Hits
 * `${baseUrl}/models` with a short timeout; truthy iff the call
 * returns 2xx. vLLM exposes this endpoint when running. Failures
 * are silent — a "not available right now" is the only piece of
 * data the caller needs.
 */
async function probeOpenAICompatible(baseUrl: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 1200);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: ctrl.signal,
      headers: { Authorization: 'Bearer sk-no-auth' },
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
