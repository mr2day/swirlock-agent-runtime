import { Injectable } from '@nestjs/common';
import type { BackendId } from '../agent/backends';

/**
 * Per-backend context-window math, plus a cheap token estimator.
 * The compactor uses these two together: estimate the current
 * "what the model will see" token count, compare against the
 * configured fraction of the effective window, decide whether to
 * roll up an older chunk.
 *
 * Effective window = published window - reserve, where the reserve
 * is the headroom kept for system prompt, tool descriptions, and
 * the assistant's own output. Reserve is PER BACKEND so the value
 * makes sense at different window scales:
 *
 *   Anthropic at 200k tokens: 8000 reserve = 4% overhead, fine.
 *   Mistral at 128k tokens:   6000 reserve = 5% overhead, fine.
 *   Ollama at 12288 tokens:   3000 reserve = 24% overhead, the
 *     right number for a local model. Tool descriptions for our
 *     current 5 tools sum to ~2400 tokens; system prompt ~400; the
 *     per-turn output budget is bounded by maxOutputTokens. 3000
 *     leaves a comfortable cushion without quartering the usable
 *     window the way 8000 did.
 *
 * Threshold = effective * ratio, default ratio 0.70.
 *
 * Token estimation is char-count / 4. Not exact, but accurate to
 * ~10-15% on English / Romanian conversation text, which is all
 * we need for triggering a background job. The compactor never
 * uses these numbers for billing or context construction —
 * those flow from the AI SDK's actual usage reports.
 */
@Injectable()
export class ContextWindowService {
  private readonly ratio: number;

  constructor() {
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
   * Per-backend reserve. The single CONTEXT_RESERVE_TOKENS env var
   * still acts as a global override if set; otherwise the per-family
   * env vars (or their built-in defaults) apply. Tuning order:
   *   1. Set CONTEXT_RESERVE_TOKENS to force one value everywhere.
   *   2. Set the family-specific var (CONTEXT_ANTHROPIC_RESERVE,
   *      CONTEXT_MISTRAL_RESERVE, CONTEXT_OLLAMA_RESERVE) for finer
   *      control.
   *   3. Fall back to the family default.
   */
  reserveFor(backend: BackendId): number {
    const global = process.env.CONTEXT_RESERVE_TOKENS;
    if (global !== undefined) return Number(global);
    switch (backend) {
      case 'anthropic':
      case 'anthropic-sonnet':
      case 'anthropic-opus':
        return Number(process.env.CONTEXT_ANTHROPIC_RESERVE ?? '8000');
      case 'mistral-online':
      case 'mistral-medium':
      case 'mistral-large':
        return Number(process.env.CONTEXT_MISTRAL_RESERVE ?? '6000');
      case 'ollama-local':
        return Number(process.env.CONTEXT_OLLAMA_RESERVE ?? '3000');
    }
  }

  /**
   * Window minus the per-backend reserve. This is the budget the
   * conversation history is allowed to consume.
   */
  effectiveWindow(backend: BackendId): number {
    return Math.max(1024, this.publishedWindow(backend) - this.reserveFor(backend));
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
