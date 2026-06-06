import { createAnthropic } from '@ai-sdk/anthropic';
import { createMistral } from '@ai-sdk/mistral';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateText, type LanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';
import { sql } from 'kysely';
import { providerOptionsForBackend, type BackendId } from '../agent/backends';
import { DatabaseService } from '../database/database.service';
import type { MessageContent } from '../database/schema';
import { ContextWindowService } from './context-window.service';
import { FRAGMENTER, type Fragmenter } from './fragmenter.interface';

interface UncompactedMessage {
  seq: number;
  role: string;
  text: string;
  // Tokens contributed by this message to the model's view. For
  // text-only messages = estimateTokens(text); for tool calls /
  // tool results = estimateTokens(JSON.stringify(content)) since
  // the AI SDK serialises them similarly when sent to the model.
  estimatedTokens: number;
  // For the summariser prompt: a single readable line that
  // represents this message in the conversation transcript.
  transcriptLine: string;
}

/**
 * Default size, in tokens, of the chunk the compactor takes off the
 * front of the uncompacted history on each pass. We don't want a
 * single compaction pass to summarise 100k tokens at once — that
 * loses too much detail and runs the summariser at its own context
 * ceiling. 10k tokens is roughly 25-50 conversational turns,
 * approximately one "session of work" worth of context.
 */
const DEFAULT_COMPACTION_CHUNK_TOKENS = 10_000;

/**
 * Per-backend, idle-driven conversation compactor. Walks the
 * messages that haven't been summarised yet, decides whether the
 * "what the model would see" token count has crossed the threshold
 * for the session's active backend, and if so rolls up the oldest
 * chunk into a single `session_summaries` row.
 *
 * Routing mirrors PageDeclutterService / SearchRerankerService:
 *   anthropic*       → Claude Haiku
 *   mistral-*        → Ministral 14B
 *   ollama-local     → the same Ollama model serving the session
 *
 * The Ollama branch keeps everything free and offline, which is
 * what the upcoming standalone talking-robot surface needs.
 */
@Injectable()
export class CompactorService {
  private readonly logger = new Logger(CompactorService.name);

  private readonly chunkTokens: number;

  // Per-family pre-built filter models. Null when the corresponding
  // API key isn't set, in which case that family's sessions are
  // simply not compacted.
  private readonly anthropicModel: LanguageModel | null;
  private readonly mistralModel: LanguageModel | null;

  private readonly ollamaFactory = createOllama({
    baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/api',
  });
  private readonly ollamaCache = new Map<string, LanguageModel>();

  // In-flight set so two scheduler ticks can't race the same
  // session through compaction simultaneously.
  private readonly compactingNow = new Set<string>();

  constructor(
    private readonly database: DatabaseService,
    private readonly contextWindow: ContextWindowService,
    @Inject(FRAGMENTER) private readonly fragmenter: Fragmenter,
  ) {
    this.chunkTokens = Number(
      process.env.COMPACTION_CHUNK_TOKENS ?? String(DEFAULT_COMPACTION_CHUNK_TOKENS),
    );

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      const factory = createAnthropic({ apiKey: anthropicKey });
      const modelId =
        process.env.COMPACTION_ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001';
      this.anthropicModel = factory(modelId);
    } else {
      this.anthropicModel = null;
    }

    const mistralKey = process.env.MISTRAL_API_KEY;
    if (mistralKey) {
      const factory = createMistral({ apiKey: mistralKey });
      const modelId =
        process.env.COMPACTION_MISTRAL_MODEL ?? 'ministral-14b-latest';
      this.mistralModel = factory(modelId);
    } else {
      this.mistralModel = null;
    }
  }

  /**
   * Run one compaction pass on the given session if it's needed.
   * Idempotent: no-op when already within budget. The caller (the
   * scheduler) must have verified the session is idle before
   * calling — we do NOT check for in-flight turns ourselves.
   */
  async compactIfNeeded(sessionId: string): Promise<void> {
    if (this.compactingNow.has(sessionId)) return;
    this.compactingNow.add(sessionId);
    try {
      await this.compactOnePass(sessionId);
    } finally {
      this.compactingNow.delete(sessionId);
    }
  }

  private async compactOnePass(sessionId: string): Promise<void> {
    const session = await this.database.db
      .selectFrom('sessions')
      .select(['id', 'default_backend'])
      .where('id', '=', sessionId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!session) return;

    const backend: BackendId = (session.default_backend ??
      'anthropic') as BackendId;

    // 1. Existing summaries, sorted by chronology.
    const summaries = await this.database.db
      .selectFrom('session_summaries')
      .select(['id', 'start_seq', 'end_seq', 'token_count'])
      .where('session_id', '=', sessionId)
      .orderBy('start_seq', 'asc')
      .execute();

    const lastSummarisedSeq =
      summaries.length > 0
        ? Math.max(...summaries.map((s) => Number(s.end_seq)))
        : 0;
    const summaryTokens = summaries.reduce(
      (acc, s) => acc + (s.token_count ?? 0),
      0,
    );

    // 2. Uncompacted messages after the last summary.
    const messageRows = await this.database.db
      .selectFrom('messages')
      .select(['seq', 'role', 'text', 'content'])
      .where('session_id', '=', sessionId)
      .where('seq', '>', sql<string>`${lastSummarisedSeq}::bigint`)
      .orderBy('seq', 'asc')
      .execute();

    const uncompacted: UncompactedMessage[] = messageRows.map((m) => {
      const text = m.text ?? '';
      const serialisedContent =
        typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content);
      const tokens =
        text.length > 0
          ? this.contextWindow.estimateTokens(text)
          : this.contextWindow.estimateTokens(serialisedContent);
      return {
        seq: Number(m.seq),
        role: m.role,
        text,
        estimatedTokens: tokens,
        transcriptLine: buildTranscriptLine(m.role, text, m.content),
      };
    });

    const verbatimTokens = uncompacted.reduce(
      (acc, m) => acc + m.estimatedTokens,
      0,
    );
    const total = summaryTokens + verbatimTokens;
    const threshold = this.contextWindow.threshold(backend);
    if (total < threshold) {
      // Under budget — nothing to do this pass.
      return;
    }

    // 3. Take the oldest contiguous slice of uncompacted messages
    // whose total estimated token count reaches chunkTokens.
    let acc = 0;
    let cutoffIdx = 0;
    for (let i = 0; i < uncompacted.length; i++) {
      acc += uncompacted[i].estimatedTokens;
      if (acc >= this.chunkTokens) {
        cutoffIdx = i + 1;
        break;
      }
    }
    if (cutoffIdx === 0) {
      // Even the entire uncompacted list is smaller than chunkTokens
      // but we still exceed the budget — must be summaries growing
      // through their own count. Take everything we have rather
      // than skipping the pass.
      cutoffIdx = uncompacted.length;
    }
    const slice = uncompacted.slice(0, cutoffIdx);
    if (slice.length === 0) return;

    // 4. Resolve the per-backend summariser model.
    const resolved = this.resolveModel(backend);
    if (!resolved) {
      this.logger.warn(
        `compactor: no model available for backend=${backend}, skipping session=${sessionId}`,
      );
      return;
    }

    // 5. Summarise.
    const startSeq = slice[0].seq;
    const endSeq = slice[slice.length - 1].seq;
    const transcript = slice.map((m) => m.transcriptLine).join('\n\n');
    const summaryText = await this.summarise(resolved.model, transcript, backend);
    if (!summaryText) {
      this.logger.warn(
        `compactor: empty summary for session=${sessionId} seqs=${startSeq}-${endSeq}, skipping`,
      );
      return;
    }
    const tokenCount = this.contextWindow.estimateTokens(summaryText);

    // 6. Persist the summary block. Wrapped in a transaction so a
    // crash mid-save leaves the session untouched.
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('session_summaries')
        .values({
          session_id: sessionId,
          start_seq: startSeq,
          end_seq: endSeq,
          summary_text: summaryText,
          token_count: tokenCount,
          summary_model: resolved.modelLabel,
        })
        .execute();
    });

    this.logger.log(
      `compacted session=${sessionId} seqs=${startSeq}-${endSeq} ` +
        `(${slice.length} msgs, ~${slice.reduce((a, m) => a + m.estimatedTokens, 0)} tok) ` +
        `→ ${tokenCount} tok via ${resolved.modelLabel}`,
    );

    // 7. Notify the Fragmenter (stub today). Errors here don't
    // roll back the summary — the summary is the load-bearing
    // artefact, the Fragmenter's processing is additive.
    try {
      await this.fragmenter.onSummaryCreated({
        sessionId,
        startSeq,
        endSeq,
        summaryText,
        summaryModel: resolved.modelLabel,
      });
    } catch (err) {
      this.logger.warn(
        `Fragmenter.onSummaryCreated threw for session=${sessionId} (ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async summarise(
    model: LanguageModel,
    transcript: string,
    backend: BackendId,
  ): Promise<string | null> {
    try {
      const result = await generateText({
        model,
        system: SUMMARY_SYSTEM_PROMPT,
        prompt: `Conversation transcript:\n\n${transcript}\n\nWrite the summary in the original language of the conversation. No preamble.`,
        maxOutputTokens: Number(process.env.COMPACTION_MAX_SUMMARY_TOKENS ?? '1500'),
        providerOptions: providerOptionsForBackend(backend),
      });
      const text = result.text.trim();
      return text.length > 0 ? text : null;
    } catch (err) {
      this.logger.warn(
        `summarise call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private resolveModel(
    backend: BackendId,
  ): { model: LanguageModel; modelLabel: string } | null {
    switch (backend) {
      case 'anthropic':
      case 'anthropic-sonnet':
      case 'anthropic-opus':
        if (!this.anthropicModel) return null;
        return {
          model: this.anthropicModel,
          modelLabel:
            process.env.COMPACTION_ANTHROPIC_MODEL ??
            'claude-haiku-4-5-20251001',
        };
      case 'mistral-online':
      case 'mistral-medium':
      case 'mistral-large':
        if (!this.mistralModel) return null;
        return {
          model: this.mistralModel,
          modelLabel:
            process.env.COMPACTION_MISTRAL_MODEL ?? 'ministral-14b-latest',
        };
      case 'ollama-local': {
        const modelId =
          process.env.OLLAMA_DEFAULT_MODEL ?? 'ministral-3:14b';
        return {
          model: this.resolveOllamaModel(modelId),
          modelLabel: modelId,
        };
      }
      default: {
        const _exhaustive: never = backend;
        void _exhaustive;
        return null;
      }
    }
  }

  private resolveOllamaModel(modelId: string): LanguageModel {
    const cached = this.ollamaCache.get(modelId);
    if (cached) return cached;
    const numCtx = Number(process.env.OLLAMA_NUM_CTX ?? '12288');
    const model = this.ollamaFactory.chat(modelId, {
      options: { num_ctx: numCtx },
    });
    this.ollamaCache.set(modelId, model);
    return model;
  }
}

/**
 * Render a single message as one readable line for the summariser
 * prompt. Tool calls collapse to `[tool: name(query="...")]`, tool
 * results to `[tool result: name → N results]`, regular text to the
 * text itself. Long content is truncated — the summary doesn't need
 * verbatim tool dumps, only the gist.
 */
function buildTranscriptLine(
  role: string,
  text: string,
  content: MessageContent,
): string {
  const prefix = role === 'user' ? 'USER' : role === 'assistant' ? 'ASSISTANT' : role.toUpperCase();
  if (text && text.length > 0) {
    const trimmed = text.length > 1200 ? text.slice(0, 1200) + '…' : text;
    return `${prefix}: ${trimmed}`;
  }
  // Multi-part: pull a one-line description per part.
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      const part = p as Record<string, unknown>;
      const type = part['type'];
      if (type === 'tool-call') {
        const name = part['toolName'] ?? 'tool';
        const input = JSON.stringify(part['input']).slice(0, 160);
        parts.push(`[tool call: ${name}(${input})]`);
      } else if (type === 'tool-result') {
        const name = part['toolName'] ?? 'tool';
        parts.push(`[tool result: ${name}]`);
      } else if (type === 'text') {
        const t = String(part['text'] ?? '');
        parts.push(t.length > 600 ? t.slice(0, 600) + '…' : t);
      }
    }
    return `${prefix}: ${parts.join(' ')}`;
  }
  return `${prefix}:`;
}

const SUMMARY_SYSTEM_PROMPT = [
  'You are a conversation summariser. You receive a section of an ongoing',
  'conversation between a user and an AI assistant. Your output is a single,',
  'compact summary that captures everything a later assistant turn would',
  'need to remember from this section in order to continue the conversation',
  'coherently.',
  '',
  'KEEP:',
  '- Concrete facts the user shared (names, dates, places, decisions, preferences).',
  '- Tasks asked, work in progress, conclusions reached, unresolved threads.',
  '- Tool calls that produced answers: what was looked up, what was found.',
  '- Anything the user explicitly told the assistant to remember or do.',
  '',
  'DROP:',
  '- Turn-by-turn formatting, greetings, acknowledgements, small talk.',
  '- Verbatim tool result dumps (mention the conclusion, not the raw output).',
  '- Repeated information already established earlier in the section.',
  '- The summariser\'s own narration ("the user then asked...", "next the assistant said...").',
  '',
  'OUTPUT:',
  '- A coherent paragraph or short bullet list, NOT a transcript.',
  '- In the original language of the conversation.',
  '- No preamble, no "Here is the summary:", no commentary.',
  '- Aim for under 1500 tokens; shorter is better as long as nothing important is lost.',
].join('\n');
