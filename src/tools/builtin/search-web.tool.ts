import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Exa from 'exa-js';
import { z } from 'zod';
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

  constructor(private readonly registry: ToolRegistry) {}

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
        'Searches the live web via Exa and returns titles, URLs, publish dates, and short snippets.',
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
        'PARAMETERS:',
        '- query: the search query in the user\'s language. Keep it focused, not verbose.',
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

        return { query: input.query, results };
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
