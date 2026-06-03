import { createAnthropic } from '@ai-sdk/anthropic';
import { Injectable, Logger } from '@nestjs/common';
import { generateText, type LanguageModel } from 'ai';

/**
 * Strips boilerplate from a fetched / browsed web page using a cheap
 * model (Haiku 4.5 by default) as a content extractor before the raw
 * text reaches the agent's main model. The agent's main model is
 * often Opus or Sonnet at $15–$75 per million tokens; navigation
 * menus, related-article teasers, ad widgets, footers, and cookie
 * banners are pure junk-token cost to it. Running the page through
 * Haiku ($1 / $5 per million) to keep only the substantive content
 * pays for itself the first time the cleaned text is re-sent to an
 * expensive model.
 *
 * Verbatim, not summary: the cleaned output must contain the same
 * sentences and structure as the source, only with the junk removed.
 * The prompt enforces this; we test it as part of the declutter
 * eval scenario.
 *
 * Failure mode: any error from the Haiku call (rate limit, transient
 * network failure, refusal) returns the original text unchanged, so
 * the fetch_page / browse tool always produces a usable result and
 * the agent loop is never blocked by the filter.
 */
@Injectable()
export class PageDeclutterService {
  private readonly logger = new Logger(PageDeclutterService.name);

  private readonly model: LanguageModel | null;
  private readonly enabled: boolean;
  private readonly minInputChars: number;
  private readonly maxInputChars: number;
  private readonly maxOutputTokens: number;

  constructor() {
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

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || !this.enabled) {
      this.model = null;
      return;
    }
    const factory = createAnthropic({ apiKey: key });
    const modelId =
      process.env.PAGE_DECLUTTER_MODEL ?? 'claude-haiku-4-5-20251001';
    this.model = factory(modelId);
  }

  /**
   * Returns the substantive body of the page with boilerplate removed,
   * or the original input on any failure / skip condition. Caller
   * does not need to handle errors — a string always comes back.
   */
  async declutter(
    rawText: string,
    sourceUrl: string | undefined,
  ): Promise<{ text: string; filtered: boolean; elapsedMs: number }> {
    const t0 = Date.now();
    if (!this.model) {
      return { text: rawText, filtered: false, elapsedMs: 0 };
    }
    if (rawText.length < this.minInputChars) {
      return { text: rawText, filtered: false, elapsedMs: 0 };
    }
    // Cap to a sane size so a pathologically large page doesn't blow
    // up Haiku's input bill. Pages that hit the cap are rare; when
    // they do, the front of the page (usually the substantive content)
    // is what survives.
    const input =
      rawText.length > this.maxInputChars
        ? rawText.slice(0, this.maxInputChars)
        : rawText;

    try {
      const result = await generateText({
        model: this.model,
        system: SYSTEM_PROMPT,
        prompt: this.buildUserPrompt(input, sourceUrl),
        maxOutputTokens: this.maxOutputTokens,
      });
      const cleaned = result.text.trim();
      if (cleaned.length === 0) {
        // Haiku returned an empty result — treat as failure, return
        // the original so the agent still has something to work with.
        return {
          text: rawText,
          filtered: false,
          elapsedMs: Date.now() - t0,
        };
      }
      const usage = result.usage;
      this.logger.log(
        `declutter ${sourceUrl ?? '?'}: ${rawText.length}→${cleaned.length} chars ` +
          `(${Math.round((cleaned.length / rawText.length) * 100)}%), ` +
          `in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'} tok, ` +
          `${Date.now() - t0}ms`,
      );
      return {
        text: cleaned,
        filtered: true,
        elapsedMs: Date.now() - t0,
      };
    } catch (err) {
      this.logger.warn(
        `declutter ${sourceUrl ?? '?'} failed, returning raw text: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { text: rawText, filtered: false, elapsedMs: Date.now() - t0 };
    }
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
