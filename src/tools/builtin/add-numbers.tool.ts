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
      description:
        'Adds an array of numbers and returns the exact sum. Use this when precise arithmetic is required.',
      inputSchema,
      execute: async (input): Promise<Output> => {
        let sum = 0;
        for (const n of input.numbers) sum += n;
        return { sum, count: input.numbers.length };
      },
    });
  }
}
