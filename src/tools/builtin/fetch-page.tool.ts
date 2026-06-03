import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Exa from 'exa-js';
import { z } from 'zod';
import { PageDeclutterService } from '../declutter.service';
import { ToolRegistry } from '../tool-registry';

const inputSchema = z.object({
  url: z
    .string()
    .url()
    .describe('The URL to fetch and read in full.'),
});

type Input = z.infer<typeof inputSchema>;

interface Output {
  url: string;
  title: string | null;
  published_date: string | null;
  content: string;
  content_length: number;
  truncated: boolean;
}

/**
 * Fetches the full text content of a single URL via Exa's getContents
 * endpoint with `livecrawl: 'always'` so dynamic pages (TV listings,
 * sports scores, live programmes) return current data instead of
 * Exa's cached snapshot. Pairs with `search_web`: once a relevant
 * URL is found in the search results, the model uses this tool to
 * drill into the page and read past the ~600-char snippet that
 * `search_web` returns.
 */
@Injectable()
export class FetchPageTool implements OnModuleInit {
  private readonly logger = new Logger(FetchPageTool.name);
  private exa: Exa | null = null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly declutter: PageDeclutterService,
  ) {}

  onModuleInit(): void {
    const key = process.env.EXA_API_KEY;
    if (!key) {
      this.logger.warn(
        'EXA_API_KEY not set — fetch_page tool will not be registered',
      );
      return;
    }
    this.exa = new Exa(key);

    // Cap on the returned `content` field length, in characters.
    // Tunable via env so a deployment with a tight context budget can
    // shrink it and a deployment with a generous one can raise it.
    // Default 12000 ≈ ~3000 tokens, big enough to hold a daily TV
    // program table or a full article.
    const maxContentLength = Number(
      process.env.FETCH_PAGE_MAX_CONTENT_LENGTH ?? '12000',
    );

    this.registry.register<Input, Output>({
      name: 'fetch_page',
      description: [
        'Fetches the full text of a single URL via Exa with live crawl.',
        'Returns the page title, published date if available, and the',
        'extracted text content (up to a configured cap). Use after',
        '`search_web` when the snippet in a search result was too short',
        'to contain the answer — the model can then drill into the most',
        'promising URL and read the actual page.',
        '',
        'WHEN TO CALL THIS:',
        "- A `search_web` result's title/URL looks like the right answer but the",
        '  snippet got cut off before showing the specific entry / row / value.',
        '- The user asks for content from a known URL.',
        '- The information needed lives in a table, listing, or long article that',
        '  a 600-char snippet cannot reasonably contain (TV programmes, sports',
        '  schedules, product specs, long articles, FAQ entries).',
        '- After `search_web` returns 0 or only irrelevant results, but you have',
        '  a known canonical URL where the answer should live.',
        '',
        'WHEN NOT TO CALL THIS:',
        '- The `search_web` snippet already contains the answer.',
        '- You do not have a specific URL to fetch.',
        '- The URL is obviously not going to contain the answer (e.g. a random',
        '  search result unrelated to the question).',
        '',
        'PARAMETERS:',
        '- url: the exact URL to fetch. Must come from a `search_web` result',
        '  or be a known canonical address the user pointed to.',
        '',
        'OUTPUT:',
        '- content: extracted text content from the page (up to a configured',
        '  cap; if truncated, `truncated: true` is set and `content_length`',
        '  carries the original size).',
        '- title, published_date: metadata if Exa surfaces them.',
        '',
        'Do not ask permission before calling. Just call and read.',
      ].join('\n'),
      inputSchema,
      execute: async (input): Promise<Output> => {
        if (!this.exa) {
          throw new Error('fetch_page invoked but Exa client is not configured');
        }
        const response = await this.exa.getContents([input.url], {
          text: true,
          livecrawl: 'always',
        });

        const first = response.results?.[0];
        if (!first) {
          return {
            url: input.url,
            title: null,
            published_date: null,
            content: '',
            content_length: 0,
            truncated: false,
          };
        }

        const rawText = (first as { text?: string }).text ?? '';
        // Strip navigation / ads / related-article teasers via a
        // Haiku pre-filter before the cleaned text ever reaches the
        // agent's main model. Falls back to raw on any failure.
        const declutterResult = await this.declutter.declutter(
          rawText,
          first.url ?? input.url,
        );
        const cleanText = declutterResult.text;
        const truncated = cleanText.length > maxContentLength;
        const content = truncated
          ? cleanText.slice(0, maxContentLength)
          : cleanText;

        return {
          url: first.url ?? input.url,
          title: first.title ?? null,
          published_date: (first as { publishedDate?: string | null }).publishedDate ?? null,
          content,
          content_length: rawText.length,
          truncated,
        };
      },
    });
  }
}
