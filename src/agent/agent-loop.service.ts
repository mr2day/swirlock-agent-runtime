import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { stepCountIs, streamText, type ToolSet } from 'ai';
import { BackendsService } from './backends';
import { ToolRegistry } from '../tools/tool-registry';
import type { AgentEvent, AgentTurnInput } from './agent.types';

type StopReason = 'completed' | 'step-budget' | 'tool-quota' | 'repeat-tool-call';

interface ToolQuotaConfig {
  default: number;
  perTool: Record<string, number>;
}

/**
 * Per-tool call quotas. A tool can be called at most N times per turn;
 * once exceeded, the agent loop stops with stopReason='tool-quota' so
 * a model stuck retrying the same tool can't drain the global step
 * budget. Configured by:
 *
 *   AGENT_TOOL_QUOTA_DEFAULT  default quota for any tool (default 5;
 *                             set to 0 or negative to disable quotas)
 *   AGENT_TOOL_QUOTAS_JSON    JSON object with per-tool overrides,
 *                             e.g. '{"search_web":5,"get_current_time":3}'
 */
function parseToolQuotas(): ToolQuotaConfig {
  const defaultQuota = Number(process.env.AGENT_TOOL_QUOTA_DEFAULT ?? '5');
  const json = process.env.AGENT_TOOL_QUOTAS_JSON;
  const perTool: Record<string, number> = {};
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v)) perTool[k] = v;
        }
      }
    } catch {
      // ignore malformed JSON — every tool falls back to default
    }
  }
  return { default: defaultQuota, perTool };
}

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

    // Per-turn stop-reason tracking. Initialised optimistically to
    // 'completed'; the stopWhen predicates below may overwrite it
    // eagerly when they fire. After the loop ends we may overwrite
    // again based on finishReason (e.g. a 'stop' finish means the
    // model emitted a final answer naturally even if a predicate
    // technically fired on the same step).
    let stopReason: StopReason = 'completed';
    let stopDetail: string | undefined;

    const quotas = parseToolQuotas();
    const toolCounts: Record<string, number> = {};
    let lastToolCallSig: string | null = null;

    // Per-tool quota: a single tool can be called at most N times per
    // turn (configurable, see parseToolQuotas). Catches "model
    // hammers search_web with slightly different queries forever"
    // failure mode earlier than the global step budget would.
    const quotaCondition = ({ steps }: { steps: ReadonlyArray<{
      toolCalls?: ReadonlyArray<{ toolName: string }>;
    }> }): boolean => {
      const last = steps[steps.length - 1];
      if (!last?.toolCalls) return false;
      for (const tc of last.toolCalls) {
        const name = tc.toolName;
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
        const quota = quotas.perTool[name] ?? quotas.default;
        if (quota > 0 && toolCounts[name] > quota) {
          stopReason = 'tool-quota';
          stopDetail = `tool ${name} called ${toolCounts[name]}× (quota ${quota})`;
          return true;
        }
      }
      return false;
    };

    // Repeat-tool-call detection: if the model emits the same tool
    // with byte-identical arguments twice in a row, stop. The
    // identical retry usually means the model misread the previous
    // result and is about to loop indefinitely.
    const repeatCondition = ({ steps }: { steps: ReadonlyArray<{
      toolCalls?: ReadonlyArray<{ toolName: string; input?: unknown }>;
    }> }): boolean => {
      const last = steps[steps.length - 1];
      if (!last?.toolCalls) return false;
      for (const tc of last.toolCalls) {
        const sig = `${tc.toolName}:${JSON.stringify(tc.input ?? {})}`;
        if (sig === lastToolCallSig) {
          stopReason = 'repeat-tool-call';
          stopDetail = `tool ${tc.toolName} called twice in a row with identical args`;
          return true;
        }
        lastToolCallSig = sig;
      }
      return false;
    };

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
        // Three stop conditions, evaluated after each step:
        //   1. stepCountIs(maxSteps)      — global step budget
        //   2. per-tool quota             — catches per-tool runaway
        //   3. repeat-call detection      — catches model loops
        // Whichever fires first sets stopReason via closure capture.
        stopWhen: [
          stepCountIs(maxSteps),
          quotaCondition,
          repeatCondition,
        ],
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

      // Reconcile finishReason against the closure-captured
      // stopReason. If the provider says 'stop' or 'length', the
      // model emitted a final answer (possibly truncated by the
      // output-token cap) — that's a natural completion regardless
      // of which stopWhen predicate happened to fire on the same
      // step. Only when finishReason is 'tool-calls' did the loop
      // end mid-synthesis; if no predicate already claimed
      // responsibility, blame the global step budget.
      if (finishReason === 'stop' || finishReason === 'length') {
        stopReason = 'completed';
        stopDetail = undefined;
      } else if (finishReason === 'tool-calls' && stopReason === 'completed') {
        stopReason = 'step-budget';
        stopDetail = `model still emitting tool calls after AGENT_MAX_STEPS=${maxSteps}`;
      }

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
        stopReason,
        ...(stopDetail ? { stopDetail } : {}),
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
