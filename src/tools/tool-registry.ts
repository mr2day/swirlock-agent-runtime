import { Injectable, Logger } from '@nestjs/common';
import { tool, type Tool } from 'ai';
import type { z } from 'zod';

/**
 * One tool the agent can call. We define our tools with zod input
 * schemas (the Vercel AI SDK accepts zod natively and serializes the
 * resulting JSON Schema to whichever provider needs it).
 *
 * `execute` runs in-process; its return value is forwarded to the
 * model as the `tool_result` content for the next loop step.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput): Promise<TOutput>;
}

/**
 * Global agent tool registry. Tools register themselves via NestJS
 * lifecycle (their @Injectable provider calls `register` in
 * onModuleInit), and AgentLoopService consumes the registry once per
 * turn.
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, ToolDefinition>();

  register<TIn, TOut>(def: ToolDefinition<TIn, TOut>): void {
    if (this.tools.has(def.name)) {
      throw new Error(`tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def as ToolDefinition);
    this.logger.log(`registered tool: ${def.name}`);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Build a Vercel-AI-SDK ToolSet from the registry. Called once per
   * turn by AgentLoopService.
   */
  toToolSet(): Record<string, Tool> {
    const set: Record<string, Tool> = {};
    for (const def of this.tools.values()) {
      set[def.name] = tool({
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async (input: unknown) => def.execute(input),
      }) as Tool;
    }
    return set;
  }
}
