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
        this.backends.defaultModelFor(input.backend.backend);
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

    // Substitute placeholders in the persisted system prompt right
    // before sending. Four placeholders today:
    //
    //   ${model}        the model id about to serve this turn.
    //   ${currentDate}  today's date in the user's timezone (YYYY-MM-DD).
    //   ${currentTime}  current wall-clock time in the user's timezone
    //                   (HH:MM:SS).
    //   ${userTimezone} the user's IANA timezone (e.g. Europe/Bucharest),
    //                   also a rough location signal.
    //
    // The system prompt is stored verbatim with the placeholders; the
    // substitution happens at each turn so a moved laptop / midnight
    // crossing / backend swap all reflect immediately.
    const tz = input.userTimezone || 'UTC';
    const now = new Date();
    const { date: currentDate, time: currentTime } = formatNowIn(now, tz);
    const resolvedSystem = input.systemPrompt
      ? input.systemPrompt
          .replace(/\$\{model\}/g, modelId)
          .replace(/\$\{currentDate\}/g, currentDate)
          .replace(/\$\{currentTime\}/g, currentTime)
          .replace(/\$\{userTimezone\}/g, tz)
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

}

/**
 * Format the current moment as date + time strings in a given IANA
 * timezone. Falls back to UTC if the timezone string is rejected by
 * the runtime (Intl raises RangeError for unknown ids — we swallow
 * it so a misconfigured client doesn't crash the loop).
 */
function formatNowIn(
  now: Date,
  timezone: string,
): { date: string; time: string } {
  try {
    const dateFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const timeFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    return { date: dateFmt.format(now), time: timeFmt.format(now) };
  } catch {
    return {
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 19),
    };
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
