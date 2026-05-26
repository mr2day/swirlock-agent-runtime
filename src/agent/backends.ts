import { createAnthropic } from '@ai-sdk/anthropic';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Injectable, Logger } from '@nestjs/common';
import type { LanguageModel } from 'ai';

// Four backends we plan to operate against. The orchestrator picks
// one per turn (default at the session level, optionally overridden by
// the client on turn.submit).
//
//   anthropic       — Anthropic API, Haiku 4.5 by default
//   mistral-online  — Mistral La Plateforme, Ministral 3 14B by default
//   mistral-local   — local vLLM serving Ministral via OpenAI-compatible
//                     REST, plain bearer-less localhost endpoint
//   ollama-local    — local Ollama serving any pulled model via its
//                     OpenAI-compatible endpoint at :11434/v1; no auth
export type BackendId =
  | 'anthropic'
  | 'mistral-online'
  | 'mistral-local'
  | 'ollama-local';

export interface BackendChoice {
  backend: BackendId;
  // Optional model override; falls back to the backend's configured
  // default if unset.
  model?: string;
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

  private readonly ollamaFactory = createOpenAICompatible({
    name: 'ollama-local',
    baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
    // Ollama's OpenAI-compatible endpoint does not require a key but
    // the OpenAI SDK will refuse to send a request without an
    // Authorization header. Sentinel keeps the wire happy.
    apiKey: process.env.OLLAMA_API_KEY ?? 'sk-no-auth',
  });

  /**
   * Resolve a LanguageModel for the given backend + optional model
   * override. Throws if the backend is configured but lacks a model
   * default, or if a remote backend has no API key in the environment.
   */
  resolve(choice: BackendChoice): LanguageModel {
    const { backend } = choice;

    switch (backend) {
      case 'anthropic': {
        const model =
          choice.model ??
          process.env.ANTHROPIC_DEFAULT_MODEL ??
          'claude-haiku-4-5-20251001';
        return this.anthropicFactory(model);
      }

      case 'mistral-online': {
        if (!this.mistralOnlineFactory) {
          throw new Error(
            'mistral-online backend selected but MISTRAL_API_KEY is not set',
          );
        }
        const model =
          choice.model ??
          process.env.MISTRAL_DEFAULT_MODEL ??
          'ministral-14b-latest';
        return this.mistralOnlineFactory(model);
      }

      case 'mistral-local': {
        const model =
          choice.model ??
          process.env.VLLM_DEFAULT_MODEL ??
          'ministral-3:14b';
        return this.vllmFactory(model);
      }

      case 'ollama-local': {
        const model =
          choice.model ??
          process.env.OLLAMA_DEFAULT_MODEL ??
          'ministral-3:14b';
        return this.ollamaFactory(model);
      }

      default: {
        const _exhaustive: never = backend;
        void _exhaustive;
        throw new Error(`unknown backend: ${String(backend)}`);
      }
    }
  }

  /**
   * Lists which backends are currently usable (i.e. their required
   * credentials are present). Used by the gateway to publish a
   * backends.list reply.
   */
  available(): BackendId[] {
    const list: BackendId[] = ['anthropic']; // always required at startup
    if (this.mistralOnlineFactory) list.push('mistral-online');
    list.push('mistral-local');
    list.push('ollama-local');
    return list;
  }

  private requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
      throw new Error(`${name} is required for the anthropic backend`);
    }
    return v;
  }
}
