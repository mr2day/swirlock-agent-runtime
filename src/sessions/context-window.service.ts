import { Injectable } from '@nestjs/common';
import type { BackendId } from '../agent/backends';

/**
 * Per-backend context-window math, plus a cheap token estimator.
 * The compactor uses these two together: estimate the current
 * "what the model will see" token count, compare against the
 * configured fraction of the effective window, decide whether to
 * roll up an older chunk.
 *
 * Effective window = published window - reserveTokens, where
 * reserveTokens is the headroom kept for system prompt, tool
 * descriptions, and the assistant's own output. Default 8000;
 * env-overridable as CONTEXT_RESERVE_TOKENS for tighter
 * deployments. Threshold = effective * ratio, default ratio 0.70.
 *
 * Token estimation is char-count / 4. Not exact, but accurate to
 * ~10-15% on English / Romanian conversation text, which is all
 * we need for triggering a background job. The compactor never
 * uses these numbers for billing or context construction —
 * those flow from the AI SDK's actual usage reports.
 */
@Injectable()
export class ContextWindowService {
  private readonly reserveTokens: number;
  private readonly ratio: number;

  constructor() {
    this.reserveTokens = Number(process.env.CONTEXT_RESERVE_TOKENS ?? '8000');
    this.ratio = Number(process.env.CONTEXT_COMPACT_RATIO ?? '0.70');
  }

  /**
   * Published total context window for the backend's default model,
   * in tokens. Anthropic Claude 4.x = 200k, current Mistral
   * Medium/Large + Ministral 14B = 128k, Ollama is whatever the
   * caller set OLLAMA_NUM_CTX to.
   */
  publishedWindow(backend: BackendId): number {
    switch (backend) {
      case 'anthropic':
      case 'anthropic-sonnet':
      case 'anthropic-opus':
        return Number(process.env.CONTEXT_ANTHROPIC_WINDOW ?? '200000');
      case 'mistral-online':
      case 'mistral-medium':
      case 'mistral-large':
        return Number(process.env.CONTEXT_MISTRAL_WINDOW ?? '128000');
      case 'ollama-local':
        return Number(process.env.OLLAMA_NUM_CTX ?? '12288');
    }
  }

  /**
   * Window minus a reserve for system prompt, tool descriptions,
   * assistant output, and per-turn slack. This is the budget the
   * conversation history is allowed to consume.
   */
  effectiveWindow(backend: BackendId): number {
    return Math.max(1024, this.publishedWindow(backend) - this.reserveTokens);
  }

  /**
   * Compaction trigger threshold for this backend. When
   * (summaries + uncompacted verbatim) exceeds this, the compactor
   * rolls up the oldest verbatim chunk into a new summary.
   */
  threshold(backend: BackendId): number {
    return Math.floor(this.effectiveWindow(backend) * this.ratio);
  }

  /**
   * Rough token count for a string. Char-count / 4 is the standard
   * heuristic across English / Romance / many European languages;
   * fine for "have we crossed the threshold yet?" decisions.
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }
}
