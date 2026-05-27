import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { stepCountIs, streamText, type ToolSet } from 'ai';
import { BackendsService } from './backends';
import { ToolRegistry } from '../tools/tool-registry';
import type { AgentEvent, AgentTurnInput } from './agent.types';

/**
 * Single-turn agent loop. Resolves the requested backend, streams the
 * model response (looping over tool calls as needed up to the step
 * budget), and yields a uniform AgentEvent stream that the gateway
 * (or smoke scripts) consume.
 *
 * The loop itself is provided by `streamText` + `stopWhen: stepCountIs`:
 * the Vercel AI SDK handles the model -> tool -> model handshake. We
 * inject our tools from the registry and map the SDK's typed stream
 * parts onto our own event shape.
 */
@Injectable()
export class AgentLoopService {
  private readonly logger = new Logger(AgentLoopService.name);

  constructor(
    private readonly backends: BackendsService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async *run(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
    const turnId = input.turnId ?? randomUUID();
    const maxSteps =
      input.maxSteps ?? Number(process.env.AGENT_MAX_STEPS ?? '8');
    const maxOutputTokens =
      input.maxOutputTokens ??
      Number(process.env.AGENT_MAX_OUTPUT_TOKENS ?? '4096');

    let model;
    let modelId: string;
    try {
      model = this.backends.resolve(input.backend);
      modelId =
        input.backend.model ??
        this.defaultModelForBackend(input.backend.backend);
    } catch (err) {
      yield {
        kind: 'turn-error',
        turnId,
        error: errorMessage(err),
      };
      return;
    }

    yield {
      kind: 'turn-accepted',
      turnId,
      backend: input.backend.backend,
      model: modelId,
    };

    const tools = this.toolRegistry.toToolSet() as ToolSet;
    const hasTools = Object.keys(tools).length > 0;

    // Substitute ${model} in the system prompt with the model that
    // will actually serve this turn. The placeholder is stored
    // verbatim on session.system_prompt, so a backend switch is
    // immediately reflected in the next turn's persona introspection
    // ("what model are you based on?" answers truthfully).
    const resolvedSystem = input.systemPrompt
      ? input.systemPrompt.replace(/\$\{model\}/g, modelId)
      : undefined;

    let result;
    try {
      result = streamText({
        model,
        system: resolvedSystem,
        messages: input.messages,
        tools: hasTools ? tools : undefined,
        stopWhen: stepCountIs(maxSteps),
        maxOutputTokens,
        abortSignal: input.abortSignal,
      });
    } catch (err) {
      yield {
        kind: 'turn-error',
        turnId,
        error: errorMessage(err),
      };
      return;
    }

    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            if (part.text) {
              yield { kind: 'text-delta', turnId, delta: part.text };
            }
            break;
          case 'reasoning-delta':
            if (part.text) {
              yield { kind: 'reasoning-delta', turnId, delta: part.text };
            }
            break;
          case 'tool-call':
            yield {
              kind: 'tool-call-started',
              turnId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            };
            break;
          case 'tool-result':
            yield {
              kind: 'tool-call-completed',
              turnId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
            };
            break;
          case 'tool-error':
            yield {
              kind: 'tool-call-failed',
              turnId,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              error: errorMessage(part.error),
            };
            break;
          case 'error':
            yield {
              kind: 'turn-error',
              turnId,
              error: errorMessage(part.error),
            };
            return;
          default:
            // step-start, step-finish, finish, raw, etc. — ignored at
            // this layer; we surface the aggregate via turn-done.
            break;
        }
      }

      const [response, usage, finishReason] = await Promise.all([
        result.response,
        result.usage,
        result.finishReason,
      ]);

      yield {
        kind: 'turn-done',
        turnId,
        responseMessages: response.messages,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        },
        finishReason,
      };
    } catch (err) {
      yield {
        kind: 'turn-error',
        turnId,
        error: errorMessage(err),
      };
    }
  }

  private defaultModelForBackend(backend: AgentTurnInput['backend']['backend']): string {
    switch (backend) {
      case 'anthropic':
        return (
          process.env.ANTHROPIC_DEFAULT_MODEL ?? 'claude-haiku-4-5-20251001'
        );
      case 'mistral-online':
        return process.env.MISTRAL_DEFAULT_MODEL ?? 'ministral-14b-latest';
      case 'mistral-local':
        return process.env.VLLM_DEFAULT_MODEL ?? 'ministral-3:14b';
      case 'ollama-local':
        return process.env.OLLAMA_DEFAULT_MODEL ?? 'ministral-3:14b';
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
