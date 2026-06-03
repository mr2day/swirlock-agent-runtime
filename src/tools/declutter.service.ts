import { createAnthropic } from '@ai-sdk/anthropic';
import { createMistral } from '@ai-sdk/mistral';
import { Injectable, Logger } from '@nestjs/common';
import { generateText, type LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import type { BackendId } from '../agent/backends';
import { TurnContextService } from '../runtime/turn-context.service';

/**
 * Strips boilerplate from a fetched / browsed web page using a cheap
 * model as a content extractor before the raw text reaches the
 * agent's main model. Navigation menus, related-article teasers, ad
 * widgets, footers, and cookie banners are pure junk-token cost to
 * an expensive main model; pre-filtering through something cheaper
 * pays for itself the first time the cleaned text is re-sent to the
 * main model on a subsequent agent step.
 *
 * Filter model is chosen per-turn from the active backend family:
 *   anthropic / anthropic-sonnet / anthropic-opus → Anthropic Haiku
 *   mistral-online / mistral-medium / mistral-large → Ministral 14B
 *   ollama-local → the same Ollama model serving the turn (no swap)
 *
 * The Ollama branch is intentionally "no swap" — when the user picks
 * the local backend they want everything free and offline, which
 * means filter and main reasoning run on the same local model. This
 * is also the path that will drive the standalone talking-robot
 * surface, so it has to work without any cloud round-trip.
 *
 * Failure mode: any error from the filter call (rate limit,
 * transient network failure, refusal) returns the original text
 * unchanged so the fetch_page / browse tool always produces a
 * usable result and the agent loop is never blocked by the filter.
 */
@Injectable()
export class PageDeclutterService {
  private readonly logger = new Logger(PageDeclutterService.name);

  private readonly enabled: boolean;
  private readonly minInputChars: number;
  private readonly maxInputChars: number;
  private readonly maxOutputTokens: number;

  // Pre-built filter models for the cloud families. Null if the
  // corresponding API key isn't set, in which case those backend
  // families fall back to returning the raw text.
  private readonly anthropicFilter: LanguageModel | null;
  private readonly mistralFilter: LanguageModel | null;

  // Ollama factory + per-model cache. Local backend turns share the
  // same model id with the active turn, so we resolve lazily per
  // (model id) seen at runtime.
  private readonly ollamaFactory = createOllama({
    baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/api',
  });
  private readonly ollamaCache = new Map<string, LanguageModel>();

  constructor(private readonly turnContext: TurnContextService) {
    this.enabled = (process.env.PAGE_DECLUTTER_ENABLED ?? 'true') !== 'false';
    this.minInputChars = Number(
      process.env.PAGE_DECLUTTER_MIN_INPUT_CHARS ?? '1500',
    );
    this.maxInputChars = Number(
      process.env.PAGE_DECLUTTER_MAX_INPUT_CHARS ?? '80000',
    );
    this.maxOutputTokens = Number(
      process.env.PAGE_DECLUTTER_MAX_OUTPUT_TOKENS ?? '8000',
    );

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && this.enabled) {
      const factory = createAnthropic({ apiKey: anthropicKey });
      const modelId =
        process.env.PAGE_DECLUTTER_ANTHROPIC_MODEL ??
        'claude-haiku-4-5-20251001';
      this.anthropicFilter = factory(modelId);
    } else {
      this.anthropicFilter = null;
    }

    const mistralKey = process.env.MISTRAL_API_KEY;
    if (mistralKey && this.enabled) {
      const factory = createMistral({ apiKey: mistralKey });
      const modelId =
        process.env.PAGE_DECLUTTER_MISTRAL_MODEL ?? 'ministral-14b-latest';
      this.mistralFilter = factory(modelId);
    } else {
      this.mistralFilter = null;
    }
  }

  /**
   * Returns the substantive body of the page with boilerplate
   * removed, or the original input on any failure / skip condition.
   * Caller does not need to handle errors — a string always comes
   * back.
   */
  async declutter(
    rawText: string,
    sourceUrl: string | undefined,
  ): Promise<{
    text: string;
    filtered: boolean;
    elapsedMs: number;
    filterModel?: string;
  }> {
    const t0 = Date.now();
    if (!this.enabled) {
      return { text: rawText, filtered: false, elapsedMs: 0 };
    }
    if (rawText.length < this.minInputChars) {
      return { text: rawText, filtered: false, elapsedMs: 0 };
    }

    const resolved = this.resolveFilter();
    if (!resolved) {
      // No filter available for this backend family (e.g. mistral
      // backend selected but MISTRAL_API_KEY not set). Pass through.
      return { text: rawText, filtered: false, elapsedMs: 0 };
    }
    const { model, modelLabel } = resolved;

    // Cap to a sane size so a pathologically large page doesn't
    // blow up the filter's bill (or local VRAM). Pages that hit the
    // cap are rare; when they do, the front of the page (usually
    // the substantive content) is what survives.
    const input =
      rawText.length > this.maxInputChars
        ? rawText.slice(0, this.maxInputChars)
        : rawText;

    try {
      const result = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: this.buildUserPrompt(input, sourceUrl),
        maxOutputTokens: this.maxOutputTokens,
      });
      const cleaned = result.text.trim();
      if (cleaned.length === 0) {
        return {
          text: rawText,
          filtered: false,
          elapsedMs: Date.now() - t0,
          filterModel: modelLabel,
        };
      }
      const usage = result.usage;
      this.logger.log(
        `declutter[${modelLabel}] ${sourceUrl ?? '?'}: ${rawText.length}→${cleaned.length} chars ` +
          `(${Math.round((cleaned.length / rawText.length) * 100)}%), ` +
          `in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'} tok, ` +
          `${Date.now() - t0}ms`,
      );
      return {
        text: cleaned,
        filtered: true,
        elapsedMs: Date.now() - t0,
        filterModel: modelLabel,
      };
    } catch (err) {
      this.logger.warn(
        `declutter[${modelLabel}] ${sourceUrl ?? '?'} failed, returning raw text: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        text: rawText,
        filtered: false,
        elapsedMs: Date.now() - t0,
        filterModel: modelLabel,
      };
    }
  }

  /**
   * Pick the filter model based on the active backend family. Cloud
   * families collapse to a fixed cheap model regardless of which
   * specific tier was selected for the turn; the local family
   * mirrors the active turn's exact model so everything stays
   * offline and free.
   */
  private resolveFilter():
    | { model: LanguageModel; modelLabel: string }
    | null {
    const ctx = this.turnContext.current();
    const backend: BackendId = ctx?.backend ?? 'anthropic';

    switch (backend) {
      case 'anthropic':
      case 'anthropic-sonnet':
      case 'anthropic-opus':
        if (!this.anthropicFilter) return null;
        return {
          model: this.anthropicFilter,
          modelLabel:
            process.env.PAGE_DECLUTTER_ANTHROPIC_MODEL ??
            'claude-haiku-4-5-20251001',
        };
      case 'mistral-online':
      case 'mistral-medium':
      case 'mistral-large':
        if (!this.mistralFilter) return null;
        return {
          model: this.mistralFilter,
          modelLabel:
            process.env.PAGE_DECLUTTER_MISTRAL_MODEL ?? 'ministral-14b-latest',
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

  /**
   * Cached lookup so repeated turns on the same Ollama model don't
   * re-instantiate the provider per fetch. The same num_ctx setting
   * the agent loop uses is applied here too — without it Ollama
   * silently truncates large pages back down to its 4096 default.
   */
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

  private buildUserPrompt(rawText: string, sourceUrl: string | undefined): string {
    const header = sourceUrl ? `Source URL: ${sourceUrl}\n\n` : '';
    return `${header}Raw page text follows. Output the substantive content with boilerplate stripped, verbatim, as clean markdown. No preamble.\n\n---\n${rawText}\n---`;
  }
}

const SYSTEM_PROMPT = [
  'You are a web-page content extractor. Your input is the raw text of a web page',
  '(extracted by an HTTP fetcher or a headless browser). Your output is ONLY the',
  'substantive content of that page, with boilerplate removed — never a summary,',
  'never a paraphrase.',
  '',
  'KEEP, verbatim:',
  '- The main article, document, or page body text.',
  '- Headings, subheadings, lists, tables, captions.',
  '- Inline citations, quoted material, code blocks.',
  '- Structured data: programme schedules, product specs, prices, addresses,',
  '  publication dates, author bylines on articles.',
  '- Anything that is the actual reason a reader visited the page.',
  '',
  'REMOVE:',
  '- Navigation menus and breadcrumbs.',
  '- Advertisements and promoted content.',
  '- Related-article teasers, "you might also like", "most read",',
  '  "trending now", "from our partners".',
  '- Sidebars unrelated to the main content.',
  '- Cookie banners, newsletter signup prompts, paywall blurbs.',
  '- Social-share widgets, comment counts, reaction buttons.',
  '- Site-wide footers (copyright, about, contact links).',
  '- Author bio sidebars (keep the article byline, drop the sidebar).',
  '- Repeated decorative captions like "Image:", "Photo:" when they add no info.',
  '',
  'OUTPUT FORMAT:',
  '- Clean markdown.',
  '- No preamble, no "Here is the extracted content:", no commentary about',
  '  what you removed.',
  '- Preserve the original language of the page (do not translate).',
  '- If the page is genuinely all boilerplate (an empty stub, a 404, a',
  '  cookie-wall), output exactly: [no substantive content]',
].join('\n');
