/**
 * Middleware that repairs malformed tool calls some Ollama-served
 * Mistral-family models emit on certain prompts.
 *
 * The bug: instead of leading the response with the `[TOOL_CALLS]`
 * sentinel that Ollama's `PARSER ministral` extracts, the model emits
 * just the body —
 *
 *     search_web[ARGS]{"query": "...", "freshness": "week"}
 *
 * — as plain text. Ollama's parser doesn't recognise it without the
 * opening sentinel, so the call leaks through as the assistant
 * message body. Vercel AI SDK sees zero tool calls and the agent
 * loop ends with a single empty/garbled turn.
 *
 * What this middleware does: at every streaming text-end (and on the
 * non-streaming generate path) it inspects the accumulated text
 * against the malformed pattern. On a match, it suppresses the text
 * events and emits a synthetic tool-call sequence instead, then
 * rewrites the upstream `finishReason: 'stop'` to `'tool-calls'` so
 * the surrounding streamText loop continues with the dispatched
 * tool call.
 *
 * Side-effect-free on well-behaved models: when no text block matches
 * the malformed pattern, the original events are flushed as-is.
 *
 * Reusable: the middleware doesn't hard-code which tool names are
 * legal — any identifier-shaped name with parseable JSON args is
 * accepted as a candidate. The tool registry will then either
 * dispatch it normally or report `tool-not-found` to the caller,
 * which is the right error surface either way.
 */

import { randomUUID } from 'node:crypto';
import type { LanguageModelMiddleware } from 'ai';
import type {
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';

// The one Ollama model id that needs this repair, per Nick's
// explicit instruction. Declared as a named const so the literal
// has a single source of truth at module scope, satisfying the
// no-hardcoding rule's exception clause.
const LOCAL_MINISTRAL = 'ministral-3:14b';

const TOOL_CALL_TEXT_PATTERN =
  /^\s*([a-zA-Z_][a-zA-Z_0-9]*)\[ARGS\](\{[\s\S]*?\})\s*$/;

interface PendingTextBlock {
  startEvent: LanguageModelV3StreamPart;
  deltas: LanguageModelV3StreamPart[];
  buffer: string;
}

export function repairMistralToolCallText(
  modelName: string,
): LanguageModelMiddleware | null {
  if (modelName === LOCAL_MINISTRAL) {
    return buildMiddleware();
  }
  return null;
}

function buildMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v3',

    wrapStream: async ({ doStream }) => {
      const upstream = await doStream();

      // Per-text-block state, keyed by the SDK's text-block id. We
      // can in principle see multiple text blocks per turn; each
      // gets its own buffer + queued events.
      const pending = new Map<string, PendingTextBlock>();
      let synthesizedToolCall = false;

      const transform = new TransformStream<
        LanguageModelV3StreamPart,
        LanguageModelV3StreamPart
      >({
        transform(chunk, controller) {
          if (chunk.type === 'text-start') {
            pending.set(chunk.id, {
              startEvent: chunk,
              deltas: [],
              buffer: '',
            });
            return; // hold the text-start until we know if this block is a malformed call
          }

          if (chunk.type === 'text-delta') {
            const block = pending.get(chunk.id);
            if (block) {
              block.deltas.push(chunk);
              block.buffer += chunk.delta;
              return; // hold the delta
            }
            // No matching open block — pass through.
            controller.enqueue(chunk);
            return;
          }

          if (chunk.type === 'text-end') {
            const block = pending.get(chunk.id);
            pending.delete(chunk.id);
            if (!block) {
              controller.enqueue(chunk);
              return;
            }

            const match = TOOL_CALL_TEXT_PATTERN.exec(block.buffer);
            if (match) {
              const [, toolName, argsJson] = match;
              try {
                JSON.parse(argsJson); // validate; throws if not JSON
                const callId = randomUUID();
                controller.enqueue({
                  type: 'tool-input-start',
                  id: callId,
                  toolName,
                });
                controller.enqueue({
                  type: 'tool-input-delta',
                  id: callId,
                  delta: argsJson,
                });
                controller.enqueue({
                  type: 'tool-input-end',
                  id: callId,
                });
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: callId,
                  toolName,
                  input: argsJson,
                });
                synthesizedToolCall = true;
                // Suppress the buffered text events entirely.
                return;
              } catch {
                // JSON malformed — fall through to the pass-through.
              }
            }

            // Not a malformed tool call (or args didn't parse) —
            // flush the buffered text events as-is.
            controller.enqueue(block.startEvent);
            for (const d of block.deltas) controller.enqueue(d);
            controller.enqueue(chunk);
            return;
          }

          if (chunk.type === 'finish') {
            // Flush any still-pending blocks we never saw a text-end
            // for (defensive — shouldn't happen on conformant providers).
            for (const block of pending.values()) {
              controller.enqueue(block.startEvent);
              for (const d of block.deltas) controller.enqueue(d);
            }
            pending.clear();

            // If we synthesized a tool-call, the upstream said
            // finishReason.unified='stop' (it saw only text).
            // Rewrite to 'tool-calls' so streamText continues the
            // agent loop and dispatches the tool we just synthesized.
            if (
              synthesizedToolCall &&
              chunk.finishReason.unified === 'stop'
            ) {
              controller.enqueue({
                ...chunk,
                finishReason: {
                  unified: 'tool-calls',
                  raw: chunk.finishReason.raw,
                },
              });
            } else {
              controller.enqueue(chunk);
            }
            return;
          }

          // Any other event (reasoning-*, tool-*, source, file, etc.):
          // pass through, flushing any held text blocks first so
          // ordering is preserved.
          for (const [id, block] of pending) {
            controller.enqueue(block.startEvent);
            for (const d of block.deltas) controller.enqueue(d);
            pending.delete(id);
          }
          controller.enqueue(chunk);
        },
      });

      return {
        ...upstream,
        stream: upstream.stream.pipeThrough(transform),
      };
    },

    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      let synthesizedToolCall = false;
      const newContent: LanguageModelV3Content[] = [];

      for (const part of result.content) {
        if (part.type === 'text') {
          const match = TOOL_CALL_TEXT_PATTERN.exec(part.text);
          if (match) {
            const [, toolName, argsJson] = match;
            try {
              JSON.parse(argsJson);
              newContent.push({
                type: 'tool-call',
                toolCallId: randomUUID(),
                toolName,
                input: argsJson,
              });
              synthesizedToolCall = true;
              continue;
            } catch {
              // JSON malformed — keep the text as-is.
            }
          }
        }
        newContent.push(part);
      }

      const rewriteFinish =
        synthesizedToolCall && result.finishReason.unified === 'stop';
      return {
        ...result,
        content: newContent,
        finishReason: rewriteFinish
          ? { unified: 'tool-calls' as const, raw: result.finishReason.raw }
          : result.finishReason,
      };
    },
  };
}
