import type { ModelMessage } from 'ai';
import type { BackendChoice, BackendId, BackendInfo } from './backends';

export type { BackendChoice, BackendId, BackendInfo };

/**
 * Inputs to a single agent turn. `messages` is the conversation
 * history in Vercel AI SDK ModelMessage shape — user/assistant/tool
 * turns, system prompt is passed separately so we never bury it inside
 * the message array.
 */
export interface AgentTurnInput {
  systemPrompt?: string;
  messages: ModelMessage[];
  backend: BackendChoice;
  // Hard cap on agent loop steps for this turn. Falls back to
  // AGENT_MAX_STEPS env var, default 8.
  maxSteps?: number;
  // Hard cap on output tokens per model call. Falls back to
  // AGENT_MAX_OUTPUT_TOKENS, default 4096.
  maxOutputTokens?: number;
  // Optional turn id assigned by the caller for tracing. If omitted
  // the loop generates one.
  turnId?: string;
  // Plugged through to Vercel AI SDK's streamText — aborting the
  // signal tears down the in-flight provider call instead of
  // letting it run to completion and burn tokens.
  abortSignal?: AbortSignal;
  // IANA timezone of the user, supplied by the client at session
  // create time. Drives ${currentDate} / ${currentTime} formatting
  // and is itself substituted as ${userTimezone}. Falls back to
  // 'UTC' when missing.
  userTimezone?: string;
}

/**
 * Streamed events emitted while a turn is running. The WebSocket
 * gateway maps these onto the wire envelope; the loop service emits
 * them in-process so the gateway is a thin adapter.
 */
export type AgentEvent =
  | {
      kind: 'turn-accepted';
      turnId: string;
      backend: BackendId;
      model: string;
    }
  | {
      kind: 'text-delta';
      turnId: string;
      delta: string;
    }
  | {
      kind: 'reasoning-delta';
      turnId: string;
      delta: string;
    }
  | {
      kind: 'tool-call-started';
      turnId: string;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      kind: 'tool-call-completed';
      turnId: string;
      toolCallId: string;
      toolName: string;
      output: unknown;
    }
  | {
      kind: 'tool-call-failed';
      turnId: string;
      toolCallId: string;
      toolName: string;
      error: string;
    }
  | {
      kind: 'turn-done';
      turnId: string;
      // Full ModelMessage[] for what the assistant emitted across this
      // turn — text, tool_use, tool_result. Caller persists them.
      responseMessages: ModelMessage[];
      usage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      };
      finishReason: string;
      // Why the loop ended. 'completed' means the model emitted a final
      // answer naturally. Anything else means a safety rail fired
      // before synthesis — the UI should render a status indicator;
      // the response text may be empty or truncated.
      stopReason: 'completed' | 'step-budget' | 'tool-quota' | 'repeat-tool-call';
      // Free-form detail for non-completed stops (e.g. "search_web
      // called 5× (quota 5)"). Absent when stopReason === 'completed'.
      stopDetail?: string;
    }
  | {
      kind: 'turn-error';
      turnId: string;
      error: string;
    };
