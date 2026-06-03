import { createAnthropic } from '@ai-sdk/anthropic';
import { createMistral } from '@ai-sdk/mistral';
import { Injectable, Logger } from '@nestjs/common';
import { generateObject, type LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { z } from 'zod';
import type { BackendId } from '../agent/backends';
import { TurnContextService } from '../runtime/turn-context.service';

/**
 * Single search result, shaped to match what `search_web` returns to
 * the agent loop. Kept structurally compatible so the reranker can
 * be wired between the tool's Exa call and its return value with no
 * adaptation layer.
 */
export interface RerankCandidate {
  title: string;
  url: string;
  published_date: string | null;
  snippet: string;
}

/**
 * Re-orders + filters a list of search results by judging each
 * candidate's likelihood of containing the answer to the search
 * query. Runs the same per-backend routing as PageDeclutterService:
 * Anthropic family → Haiku, Mistral family → Ministral 14B, Ollama
 * → the same local model serving the turn. Switchable per-deployment
 * via PAGE_RERANK_ENABLED so we can A/B with raw Exa rankings.
 *
 * Why this exists: Exa returns ~8 semantically-similar results per
 * query. A relevant fraction is typically 2-4; the rest dilute the
 * model's context and push expensive backends toward picking the
 * wrong URL to fetch. A small model that has read all 8 snippets
 * and scored each against the query catches dilution far cheaper
 * than the main model spending tokens on it.
 *
 * Failure mode: any error or unparseable output returns the
 * original list unchanged. The agent loop never blocks on the
 * reranker — at worst the search behaves exactly as if reranking
 * were disabled.
 */
@Injectable()
export class SearchRerankerService {
  private readonly logger = new Logger(SearchRerankerService.name);

  private readonly enabled: boolean;
  private readonly topN: number;

  private readonly anthropicModel: LanguageModel | null;
  private readonly mistralModel: LanguageModel | null;

  private readonly ollamaFactory = createOllama({
    baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/api',
  });
  private readonly ollamaCache = new Map<string, LanguageModel>();

  constructor(private readonly turnContext: TurnContextService) {
    // Default OFF — the user opts in to test, since reranking can
    // drop the one weird result that actually had the answer.
    this.enabled = (process.env.SEARCH_RERANK_ENABLED ?? 'false') === 'true';
    this.topN = Number(process.env.SEARCH_RERANK_TOP_N ?? '3');

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && this.enabled) {
      const factory = createAnthropic({ apiKey: anthropicKey });
      const modelId =
        process.env.SEARCH_RERANK_ANTHROPIC_MODEL ??
        'claude-haiku-4-5-20251001';
      this.anthropicModel = factory(modelId);
    } else {
      this.anthropicModel = null;
    }

    const mistralKey = process.env.MISTRAL_API_KEY;
    if (mistralKey && this.enabled) {
      const factory = createMistral({ apiKey: mistralKey });
      const modelId =
        process.env.SEARCH_RERANK_MISTRAL_MODEL ?? 'ministral-14b-latest';
      this.mistralModel = factory(modelId);
    } else {
      this.mistralModel = null;
    }
  }

  /**
   * Returns the top-N most-relevant candidates ordered by descending
   * relevance, or the original list unchanged on any failure. Caller
   * never needs an error handler.
   */
  async rerank(
    query: string,
    candidates: RerankCandidate[],
  ): Promise<{
    results: RerankCandidate[];
    reranked: boolean;
    elapsedMs: number;
    rerankerModel?: string;
  }> {
    const t0 = Date.now();
    if (!this.enabled || candidates.length <= this.topN) {
      return { results: candidates, reranked: false, elapsedMs: 0 };
    }

    const resolved = this.resolveModel();
    if (!resolved) {
      return { results: candidates, reranked: false, elapsedMs: 0 };
    }
    const { model, modelLabel } = resolved;

    try {
      const result = await generateObject({
        model,
        schema: z.object({
          // Ordered list of candidate indices (0-based) to KEEP, most
          // relevant first. Anything not listed is dropped.
          kept_indices: z
            .array(z.number().int().min(0).max(candidates.length - 1))
            .min(1)
            .max(this.topN),
        }),
        system: SYSTEM_PROMPT,
        prompt: this.buildPrompt(query, candidates),
        maxOutputTokens: 200,
      });

      const seen = new Set<number>();
      const ordered: RerankCandidate[] = [];
      for (const i of result.object.kept_indices) {
        if (i < 0 || i >= candidates.length) continue;
        if (seen.has(i)) continue;
        seen.add(i);
        ordered.push(candidates[i]);
      }

      if (ordered.length === 0) {
        // Model returned only invalid indices — keep originals.
        return {
          results: candidates,
          reranked: false,
          elapsedMs: Date.now() - t0,
          rerankerModel: modelLabel,
        };
      }

      const usage = result.usage;
      this.logger.log(
        `rerank[${modelLabel}] q="${query.slice(0, 40)}${query.length > 40 ? '…' : ''}": ` +
          `${candidates.length}→${ordered.length}, ` +
          `in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'} tok, ` +
          `${Date.now() - t0}ms`,
      );

      return {
        results: ordered,
        reranked: true,
        elapsedMs: Date.now() - t0,
        rerankerModel: modelLabel,
      };
    } catch (err) {
      this.logger.warn(
        `rerank[${modelLabel}] q="${query}" failed, returning original list: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        results: candidates,
        reranked: false,
        elapsedMs: Date.now() - t0,
        rerankerModel: modelLabel,
      };
    }
  }

  /**
   * Pick the reranker model from the active backend family. Same
   * routing rules as PageDeclutterService — cloud families collapse
   * to a fixed cheap model, the local family mirrors the active
   * turn's exact model so everything stays offline and free.
   */
  private resolveModel():
    | { model: LanguageModel; modelLabel: string }
    | null {
    const ctx = this.turnContext.current();
    const backend: BackendId = ctx?.backend ?? 'anthropic';

    switch (backend) {
      case 'anthropic':
      case 'anthropic-sonnet':
      case 'anthropic-opus':
        if (!this.anthropicModel) return null;
        return {
          model: this.anthropicModel,
          modelLabel:
            process.env.SEARCH_RERANK_ANTHROPIC_MODEL ??
            'claude-haiku-4-5-20251001',
        };
      case 'mistral-online':
      case 'mistral-medium':
      case 'mistral-large':
        if (!this.mistralModel) return null;
        return {
          model: this.mistralModel,
          modelLabel:
            process.env.SEARCH_RERANK_MISTRAL_MODEL ?? 'ministral-14b-latest',
        };
      case 'ollama-local': {
        const modelId =
          ctx?.model ?? process.env.OLLAMA_DEFAULT_MODEL ?? 'ministral-3:14b';
        return {
          model: this.resolveOllamaModel(modelId),
          modelLabel: modelId,
        };
      }
      default: {
        const _exhaustive: never = backend;
        void _exhaustive;
        return null;
      }
    }
  }

  private resolveOllamaModel(modelId: string): LanguageModel {
    const cached = this.ollamaCache.get(modelId);
    if (cached) return cached;
    const numCtx = Number(process.env.OLLAMA_NUM_CTX ?? '12288');
    const model = this.ollamaFactory.chat(modelId, {
      options: { num_ctx: numCtx },
    });
    this.ollamaCache.set(modelId, model);
    return model;
  }

  private buildPrompt(query: string, candidates: RerankCandidate[]): string {
    const lines: string[] = [];
    lines.push(`Search query: ${query}`);
    lines.push('');
    lines.push('Candidate results:');
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      lines.push(`[${i}] ${c.title}`);
      lines.push(`    url: ${c.url}`);
      const snippet = c.snippet.replace(/\s+/g, ' ').slice(0, 400);
      lines.push(`    snippet: ${snippet}`);
    }
    lines.push('');
    lines.push(
      `Return the top ${this.topN} indices most likely to contain information that answers the query, ordered most-relevant first. Drop the rest. If fewer than ${this.topN} are clearly relevant, return fewer.`,
    );
    return lines.join('\n');
  }
}

const SYSTEM_PROMPT = [
  'You are a search-result reranker. You receive a search query and a',
  'numbered list of candidate results (title + URL + snippet) and you',
  'pick the small subset most likely to actually answer the query.',
  '',
  'How to judge a candidate:',
  '- Does the snippet contain a direct answer, or strong evidence the',
  '  page will?',
  '- Is the source authoritative for this kind of question (official',
  '  pages, primary sources, established outlets, academic / encyclopedic)?',
  '- Is the entry on-topic for the QUERY, not just topically adjacent?',
  '',
  'Be deliberate, not greedy: it is fine to return fewer indices than',
  'asked for if only one or two candidates are clearly relevant. A small',
  'set of strong matches beats a long list padded with noise.',
  '',
  'Output: a JSON object {"kept_indices": [...]} with 0-based indices',
  'in descending order of relevance. Indices must be integers within',
  'the input range. No other output.',
].join('\n');
