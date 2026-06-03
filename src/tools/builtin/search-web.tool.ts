import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Exa from 'exa-js';
import { z } from 'zod';
import { SearchRerankerService } from '../search-reranker.service';
import { ToolRegistry } from '../tool-registry';

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('The natural-language web search query.'),
  freshness: z
    .enum(['day', 'week', 'month', 'year', 'any'])
    .describe(
      "How recent results must be. 'any' is the broadest, 'day' is the most restrictive.",
    )
    .optional(),
  num_results: z
    .number()
    .int()
    .min(1)
    .max(20)
    .describe('Number of results to return (1-20).')
    .optional(),
});

type Input = z.infer<typeof inputSchema>;

interface Citation {
  title: string;
  url: string;
  published_date: string | null;
  snippet: string;
}

interface Output {
  query: string;
  results: Citation[];
}

@Injectable()
export class SearchWebTool implements OnModuleInit {
  private readonly logger = new Logger(SearchWebTool.name);
  private exa: Exa | null = null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly reranker: SearchRerankerService,
  ) {}

  onModuleInit(): void {
    const key = process.env.EXA_API_KEY;
    if (!key) {
      this.logger.warn(
        'EXA_API_KEY not set — search_web tool will not be registered',
      );
      return;
    }
    this.exa = new Exa(key);

    const defaultFreshness =
      (process.env.SEARCH_DEFAULT_FRESHNESS as Input['freshness']) ?? 'month';
    const defaultMaxResults = Number(process.env.SEARCH_MAX_RESULTS ?? '8');

    this.registry.register<Input, Output>({
      name: 'search_web',
      description: [
        'Searches the live web via Exa and returns titles, URLs, publish dates, and ~600-char snippets.',
        '',
        'WHEN TO CALL THIS:',
        '- The user asks about a recent event, news, release, or announcement.',
        '- The user asks a current-state question: prices, scores, weather, who currently holds a position, what is the latest version, what are recent reviews of X.',
        '- The user asks your opinion or impression of a specific real-world thing (a concert, restaurant, product, book, person, place) that you may not have reliable knowledge of.',
        "- You don't know the answer with confidence and a web search would resolve it.",
        '- The user explicitly asks you to look something up, search, find, check.',
        '',
        'WHEN NOT TO CALL THIS:',
        '- Stable, well-known facts (capitals, historical dates, definitions, language, math identities, code syntax). Your training data already has these.',
        '- Casual conversation, jokes, opinions on abstract topics, creative writing, code generation from the user\'s description.',
        '- When the user has already provided the information you need.',
        '',
        'HOW EXA ACTUALLY BEHAVES (empirically observed — write queries with these quirks in mind):',
        '- Exa is a semantic search engine. It rewards short, natural-language queries (3-6 words is the sweet spot). It punishes verbose queries with many constraints by drifting semantically.',
        "- Exa does NOT honour boolean operators or `site:` filters. A query like `Pro Cinema program site:procinema.ro` returns zero results, not the procinema.ro page. Drop the operator and just say what you want.",
        '- Exa does NOT honour quoted phrases as exact-match. Drop the quotes; let semantic matching work.',
        "- Exa rewards distinctive proper nouns. A brand like \"Pro Cinema\" works best when the query is short enough that the brand carries the semantic weight (e.g. `Program Pro Cinema 31 mai`, not `what is on Pro Cinema TV channel right now at this hour`).",
        '- Exa\'s index lag: results dated TODAY appear after Exa\'s daily crawl, not in real time. `freshness: "day"` returns content indexed within the last 24h, which may already be stale for live data (TV programmes, sports scores). When you get only stale entries, try `freshness: "week"` or `"any"` and rely on `fetch_page` to drill into the most authoritative-looking URL.',
        '- If the first query returns mostly junk (irrelevant languages, wrong countries, off-topic articles), the fix is almost always to SHORTEN the query, not lengthen it.',
        '',
        'THE SEARCH → FETCH PATTERN:',
        'A `search_web` result\'s snippet is at most ~600 characters. For program listings, tables, long articles, or any page with many entries, the specific row/entry the user asked about is almost never inside the snippet — only the beginning of the page is.',
        'Whenever a search result\'s title/URL looks like the authoritative source (e.g. an official programme page, a news article on the right event, a product page) but the snippet was cut off before reaching the answer, IMMEDIATELY call `fetch_page` on that URL to read the actual content.',
        'Do not confidently answer from absence of evidence in a snippet — that is the failure mode that produces wrong, gaslighting answers. If the snippet was cut off, fetch the page.',
        '',
        'PARAMETERS:',
        '- query: the search query in the user\'s language. Short, natural, no operators. 3-6 words ideal.',
        '- num_results: how many results to pull. Default is 8 if you omit it — use that for most questions. Pass 10-15 for broad reviews, surveys, or "what are people saying about X". Pass 3-5 only when you need a single specific fact (a number, a date, a name). Never less than 3.',
        '- freshness: how recent results must be. "day" is very restrictive (last 24h) — only for breaking news. "week" suits most recent-event questions. "month" or "year" for slower topics. "any" when recency does not matter. Default is the configured "month".',
        '',
        "Do not ask permission before calling. Just call and respond. Do not say \"I don't have that information\" — search and find out.",
      ].join('\n'),
      inputSchema,
      execute: async (input): Promise<Output> => {
        if (!this.exa) {
          throw new Error('search_web invoked but Exa client is not configured');
        }
        const freshness = input.freshness ?? defaultFreshness;
        const numResults = input.num_results ?? defaultMaxResults;

        const startDate = this.freshnessToStartDate(freshness);

        const response = await this.exa.searchAndContents(input.query, {
          numResults,
          type: 'auto',
          text: { maxCharacters: 600 },
          ...(startDate ? { startPublishedDate: startDate } : {}),
        });

        const results: Citation[] = response.results.map((r) => {
          const text = (r as { text?: string }).text;
          return {
            title: r.title ?? '',
            url: r.url,
            published_date: r.publishedDate ?? null,
            snippet: typeof text === 'string' ? text.slice(0, 600) : '',
          };
        });

        // Per-backend reranking runs only when SEARCH_RERANK_ENABLED=true;
        // when disabled (the default) the helper no-ops and returns the
        // candidates unchanged in zero time, so this branch is effectively
        // free in the off configuration.
        const rerank = await this.reranker.rerank(input.query, results);
        return { query: input.query, results: rerank.results };
      },
    });
  }

  private freshnessToStartDate(
    freshness: NonNullable<Input['freshness']>,
  ): string | null {
    if (freshness === 'any') return null;
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const offsets: Record<string, number> = {
      day: 1 * day,
      week: 7 * day,
      month: 31 * day,
      year: 366 * day,
    };
    const start = new Date(now - offsets[freshness]);
    return start.toISOString();
  }
}
