import { Injectable, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { ToolRegistry } from '../tool-registry';

const inputSchema = z.object({
  numbers: z
    .array(z.number())
    .min(2, 'pass at least two numbers')
    .describe('The list of numbers to add together.'),
});

type Input = z.infer<typeof inputSchema>;

interface Output {
  sum: number;
  count: number;
}

@Injectable()
export class AddNumbersTool implements OnModuleInit {
  constructor(private readonly registry: ToolRegistry) {}

  onModuleInit(): void {
    this.registry.register<Input, Output>({
      name: 'add_numbers',
      description: [
        'Adds an array of numbers and returns the exact sum.',
        '',
        'WHEN TO CALL THIS:',
        '- The user explicitly asks for a precise sum of many or large numbers where mistakes are costly.',
        '- The user asks for arithmetic in a context where exactness matters (invoices, totals, balances).',
        '',
        'WHEN NOT TO CALL THIS:',
        '- Trivial arithmetic you can do reliably yourself (single-digit, two two-digit additions, etc.). Calling the tool for "2 + 2" is wasteful.',
        '- Subtraction, multiplication, division, or any non-addition arithmetic — this tool only adds.',
      ].join('\n'),
      inputSchema,
      execute: async (input): Promise<Output> => {
        let sum = 0;
        for (const n of input.numbers) sum += n;
        return { sum, count: input.numbers.length };
      },
    });
  }
}
