import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { ToolRegistry } from '../tool-registry';

const inputSchema = z.object({
  timezone: z
    .string()
    .describe(
      "IANA timezone name (e.g. 'Europe/Bucharest', 'America/Los_Angeles'). Defaults to UTC when omitted.",
    )
    .optional(),
});

type Input = z.infer<typeof inputSchema>;

interface Output {
  iso: string;
  timezone: string;
  unix_seconds: number;
}

@Injectable()
export class GetCurrentTimeTool implements OnModuleInit {
  constructor(private readonly registry: ToolRegistry) {}

  onModuleInit(): void {
    this.registry.register<Input, Output>({
      name: 'get_current_time',
      description: [
        'Returns the current wall-clock time as ISO 8601, plus unix epoch seconds, in the requested IANA timezone (default UTC).',
        '',
        'WHEN TO CALL THIS:',
        '- The user asks the current time, date, or day of week.',
        '- The user asks "how long ago" / "how long until" something against the present.',
        '- Time-aware reasoning where the answer depends on now (e.g. "is this concert tonight?").',
        '',
        'WHEN NOT TO CALL THIS:',
        '- The user provides a specific date/time and you just need to compute against it.',
        '- Historical dates or relative reasoning that does not need the present moment.',
      ].join('\n'),
      inputSchema,
      execute: async (input): Promise<Output> => {
        const tz = input.timezone ?? 'UTC';
        const now = new Date();
        // Validate the tz by constructing a formatter; bubble up the
        // RangeError as a tool error rather than crashing the loop.
        const fmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
        const parts = fmt.formatToParts(now);
        const lookup: Record<string, string> = {};
        for (const p of parts) lookup[p.type] = p.value;
        // ISO-like rendering in the requested tz; the trailing Z is
        // intentionally omitted because we are not necessarily UTC.
        const iso = `${lookup.year}-${lookup.month}-${lookup.day}T${lookup.hour}:${lookup.minute}:${lookup.second}`;
        return {
          iso,
          timezone: tz,
          unix_seconds: Math.floor(now.getTime() / 1000),
        };
      },
    });
  }
}
