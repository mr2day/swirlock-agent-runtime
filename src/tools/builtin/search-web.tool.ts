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
      description:
        'Searches the live web via Exa for up-to-date information. Use when the user asks about recent events, real-world facts you may be unsure about, or anything that requires current sources. Returns titles, URLs, publish dates and short snippets.',
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
