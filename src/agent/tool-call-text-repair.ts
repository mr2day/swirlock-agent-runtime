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
 * message body.
 *
 * Incremental detection: the middleware only holds back text-delta
 * events while the accumulated buffer COULD still grow into the
 * malformed pattern. As soon as the buffer contains a character
 * that breaks the structural prefix (e.g. a space, a comma, anything
 * not allowed at that position in `<identifier>[ARGS]{<json>}`), the
 * middleware flushes everything and switches to passthrough for the
 * rest of that text block. For a normal answer that starts with
 * "Ah, " the buffer breaks at the comma and streaming resumes
 * immediately — total perceived delay is ~one token.
 *
 * Only when the buffer completes the full malformed pattern (or runs
 * to text-end with a structural prefix the model never broke) does
 * the middleware suppress all the buffered text and synthesise a
 * proper tool-call sequence in its place, then rewrite the finish
 * reason from 'stop' to 'tool-calls' so the streamText loop continues
 * with the dispatched call.
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

// A buffer is "still possibly a malformed tool-call prefix" iff it
// matches one of the partial-pattern stages below:
//   <ident>                            — identifier only
//   <ident>[                           — opened bracket
//   <ident>[A | [AR | [ARG | [ARGS     — typing the ARGS sentinel
//   <ident>[ARGS]                      — sentinel closed
//   <ident>[ARGS]{ | [ARGS]{...        — into the JSON body
// Anything else means the model has emitted text that can't be the
// malformed pattern; flush and stream.
const COULD_STILL_MATCH =
  /^[a-zA-Z_][a-zA-Z_0-9]*(?:\[(?:A(?:R(?:G(?:S(?:\](?:\{[\s\S]*)?)?)?)?)?)?)?$/;

function couldStillBeMalformedPrefix(buffer: string): boolean {
  const stripped = buffer.replace(/^\s+/, '');
  if (stripped.length === 0) return true;
  return COULD_STILL_MATCH.test(stripped);
}

interface PendingTextBlock {
  mode: 'inspecting' | 'passthrough';
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
      // gets its own buffer + state.
      const pending = new Map<string, PendingTextBlock>();
      let synthesizedToolCall = false;

      const flushBlock = (
        block: PendingTextBlock,
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
      ): void => {
        controller.enqueue(block.startEvent);
        for (const d of block.deltas) controller.enqueue(d);
        block.mode = 'passthrough';
        block.deltas = [];
        block.buffer = '';
      };

      const transform = new TransformStream<
        LanguageModelV3StreamPart,
        LanguageModelV3StreamPart
      >({
        transform(chunk, controller) {
          if (chunk.type === 'text-start') {
            pending.set(chunk.id, {
              mode: 'inspecting',
              startEvent: chunk,
              deltas: [],
              buffer: '',
            });
            return; // hold the text-start while inspecting
          }

          if (chunk.type === 'text-delta') {
            const block = pending.get(chunk.id);
            if (!block || block.mode === 'passthrough') {
              controller.enqueue(chunk);
              return;
            }

            // Inspecting: append, then decide.
            block.buffer += chunk.delta;
            block.deltas.push(chunk);

            if (couldStillBeMalformedPrefix(block.buffer)) {
              return; // still possibly a malformed call — keep buffering
            }

            // Predicate failed — this text block is regular prose.
            // Flush everything and resume streaming.
            flushBlock(block, controller);
            return;
          }

          if (chunk.type === 'text-end') {
            const block = pending.get(chunk.id);
            pending.delete(chunk.id);
            if (!block || block.mode === 'passthrough') {
              controller.enqueue(chunk);
              return;
            }

            // Still inspecting at text-end — see if the full pattern
            // matched.
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
                return; // suppress the buffered text events
              } catch {
                // JSON malformed — fall through to flush as text.
              }
            }

            // No pattern match — emit as ordinary text.
            controller.enqueue(block.startEvent);
            for (const d of block.deltas) controller.enqueue(d);
            controller.enqueue(chunk);
            return;
          }

          if (chunk.type === 'finish') {
            // Flush any still-pending inspecting blocks (defensive).
            for (const block of pending.values()) {
              if (block.mode === 'inspecting') {
                controller.enqueue(block.startEvent);
                for (const d of block.deltas) controller.enqueue(d);
              }
            }
            pending.clear();

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
          for (const block of pending.values()) {
            if (block.mode === 'inspecting') flushBlock(block, controller);
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
