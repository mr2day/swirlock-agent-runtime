import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import { sql } from 'kysely';
import { AgentLoopService } from '../agent/agent-loop.service';
import type { AgentEvent, BackendChoice } from '../agent/agent.types';
import { DatabaseService } from '../database/database.service';
import type {
  Backend,
  MessageContent,
  Role,
} from '../database/schema';
import { SessionService } from './session.service';

export interface RunTurnInput {
  sessionId: string;
  clientId: string;
  userId: string;
  userMessage: string;
  // Optional override of the session's default backend for this single
  // turn. The session row is not modified.
  backendOverride?: BackendChoice;
  // Optional client-supplied turn id; otherwise we generate one.
  turnId?: string;
  // Optional caps. Fall back to AGENT_* env defaults inside the loop.
  maxSteps?: number;
  maxOutputTokens?: number;
  // Aborts the in-flight provider call when signaled. The gateway
  // creates a fresh AbortController per turn and aborts it when the
  // client sends `turn.cancel` (or the socket closes).
  abortSignal?: AbortSignal;
}

@Injectable()
export class TurnService {
  private readonly logger = new Logger(TurnService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionService,
    private readonly agentLoop: AgentLoopService,
  ) {}

  /**
   * Runs one user-->assistant turn against the session's stored
   * history. Persists the user message before the model call (so it's
   * durable even on crash mid-stream), then persists every
   * assistant/tool message returned by the loop on turn-done. Yields
   * the same AgentEvent stream the loop produces.
   */
  async *runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent> {
    const session = await this.sessions.getSession(
      input.sessionId,
      input.clientId,
      input.userId,
    );

    const backend = this.resolveBackend(input.backendOverride, session.defaultBackend);
    const turnId = input.turnId ?? randomUUID();

    // Daily turn cap. Counts user-role messages for this
    // (client_id, user_id) since UTC midnight and refuses the turn if
    // we're at or above the configured limit. Cap is per (client, user)
    // so a person using two of our apps gets full quota in each. Cheap
    // index-aided count (sessions(client_id, user_id) +
    // messages(session_id, seq), filtered by created_at).
    //
    // AGENT_TURN_CAP_EXEMPT_USERS is a comma-separated allowlist of
    // IdP sub values that bypass the cap entirely. Reserved for the
    // operator's own account; do not hand out exemptions casually.
    const exemptSubs = (process.env.AGENT_TURN_CAP_EXEMPT_USERS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const isExempt = exemptSubs.includes(input.userId);
    const cap = Number(process.env.AGENT_TURN_CAP_PER_USER_PER_DAY ?? '200');
    if (!isExempt && Number.isFinite(cap) && cap > 0) {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const row = await this.database.db
        .selectFrom('messages')
        .innerJoin('sessions', 'sessions.id', 'messages.session_id')
        .select((eb) => eb.fn.countAll().as('used'))
        .where('sessions.client_id', '=', input.clientId)
        .where('sessions.user_id', '=', input.userId)
        .where('messages.role', '=', 'user')
        .where('messages.created_at', '>=', startOfDay)
        .executeTakeFirstOrThrow();
      const used = Number(row.used);
      if (used >= cap) {
        yield {
          kind: 'turn-error',
          turnId,
          error: `daily turn cap reached (${used}/${cap}). Try again after UTC midnight.`,
        };
        return;
      }
    }

    const history = await this.sessions.getMessages(
      input.sessionId,
      input.clientId,
      input.userId,
    );

    // Layered summaries (if any) for this session. Each block
    // covers a contiguous range of message seqs that we will skip
    // from the verbatim history and replace with one synthetic
    // system message ("[Summary of earlier turns N..M]: ..."),
    // injected ahead of the still-verbatim tail. See
    // CompactorService for how blocks are produced.
    const summaries = await this.database.db
      .selectFrom('session_summaries')
      .select(['start_seq', 'end_seq', 'summary_text'])
      .where('session_id', '=', input.sessionId)
      .orderBy('start_seq', 'asc')
      .execute();
    const lastSummarisedSeq =
      summaries.length > 0
        ? Math.max(...summaries.map((s) => Number(s.end_seq)))
        : 0;

    // 1. Persist the user message under the next seq.
    const nextSeq = await this.appendMessage({
      sessionId: input.sessionId,
      turnId,
      role: 'user',
      content: input.userMessage,
      text: input.userMessage,
      metadata: null,
    });
    this.logger.debug(`turn ${turnId} user message persisted at seq=${nextSeq}`);

    // First user message in this session: auto-derive a title from it
    // and write it onto the session row IFF the title is still null.
    // Idempotent: a re-run (partial-retry, double-delivery) won't
    // clobber a title that already exists; this also leaves any
    // user-supplied title alone if one was ever passed.
    if (nextSeq === 1) {
      const derivedTitle = deriveSessionTitle(input.userMessage);
      await this.database.db
        .updateTable('sessions')
        .set({ title: derivedTitle, updated_at: new Date() })
        .where('id', '=', input.sessionId)
        .where('title', 'is', null)
        .execute();
    }

    // 2. Build the ModelMessage[] history for the loop. Three layers:
    //   (a) Summary blocks (oldest first) as synthetic system msgs.
    //   (b) The verbatim tail — every message with seq strictly above
    //       the highest summarised seq. The compactor's job is to keep
    //       this tail within budget; we trust it and send it as-is
    //       rather than re-pruning client-side.
    //   (c) The current user message.
    // The legacy AGENT_HISTORY_KEEP_LAST_MESSAGES sliding-window prune
    // stays as a belt-and-braces cap for sessions that haven't yet
    // had a compaction pass — e.g. brand-new long bursts before the
    // scheduler runs.
    const keepLast = Math.max(
      1,
      Number(process.env.AGENT_HISTORY_KEEP_LAST_MESSAGES ?? '20'),
    );
    const verbatimHistory = history.filter((m) => m.seq > lastSummarisedSeq);
    const prunedHistory =
      verbatimHistory.length <= keepLast + 1
        ? verbatimHistory
        : (() => {
            const first = verbatimHistory[0];
            const tail = verbatimHistory.slice(-keepLast);
            return tail[0]?.seq === first.seq ? tail : [first, ...tail];
          })();

    const modelMessages: ModelMessage[] = [];
    for (const s of summaries) {
      modelMessages.push({
        role: 'system',
        content: `[Summary of earlier turns ${s.start_seq}-${s.end_seq}]\n${s.summary_text}`,
      });
    }
    for (const m of prunedHistory) {
      modelMessages.push(toModelMessage(m.role, m.content));
    }
    modelMessages.push({ role: 'user', content: input.userMessage });

    // 3. Stream the loop, persisting outputs at turn-done.
    let baseSeq = nextSeq;
    let lastUsage: { totalTokens?: number } = {};
    // Captured from turn-accepted so the model that actually served
    // this turn is stamped on every assistant/tool message we persist.
    // Per-message attribution survives session.get.
    let attribution: { backend: string; modelId: string } | null = null;

    // The chatbot UI stamps Intl.DateTimeFormat().resolvedOptions().timeZone
    // into session.client_metadata.timezone at create time. AgentLoopService
    // uses it to substitute ${currentDate} / ${currentTime} / ${userTimezone}
    // in the persisted system prompt. Missing → UTC fallback.
    const tzRaw = (session.clientMetadata as Record<string, unknown> | null)?.[
      'timezone'
    ];
    const userTimezone = typeof tzRaw === 'string' ? tzRaw : undefined;

    for await (const event of this.agentLoop.run({
      systemPrompt: session.systemPrompt ?? undefined,
      messages: modelMessages,
      backend,
      turnId,
      maxSteps: input.maxSteps,
      maxOutputTokens: input.maxOutputTokens,
      abortSignal: input.abortSignal,
      userTimezone,
    })) {
      yield event;

      if (event.kind === 'turn-accepted') {
        attribution = { backend: event.backend, modelId: event.model };
      }

      if (event.kind === 'turn-done') {
        lastUsage = event.usage;

        // Persist every assistant/tool message emitted across the
        // multi-step loop in the order the SDK returned them. Each
        // gets its own monotonic seq. Assistant/tool messages carry
        // the {backend, modelId} attribution captured at turn-accepted.
        for (const msg of event.responseMessages) {
          baseSeq = await this.appendMessage({
            sessionId: input.sessionId,
            turnId,
            role: msg.role,
            content: extractStorableContent(msg.content),
            text: extractDisplayText(msg.content),
            metadata: attribution,
          });
        }

        // Bump session updated_at and accumulated token count.
        // bigint arithmetic via raw SQL — Kysely's typed +-builder
        // doesn't model the string<->bigint coercion cleanly.
        const tokenDelta = event.usage.totalTokens ?? 0;
        await this.database.db
          .updateTable('sessions')
          .set({
            updated_at: new Date(),
            total_token_count: sql`total_token_count + ${tokenDelta}`,
          })
          .where('id', '=', input.sessionId)
          .execute();
      }
    }

    void lastUsage;
  }

  private async appendMessage(args: {
    sessionId: string;
    turnId: string;
    role: Role;
    content: MessageContent;
    text: string;
    metadata: Record<string, unknown> | null;
  }): Promise<number> {
    // Compute next seq in the same transaction as the insert so two
    // concurrent appends cannot race. We do this with a SELECT
    // ... FOR UPDATE on the session row to serialize per-session
    // writes. Cheap (per-session lock), correct under concurrency.
    return await this.database.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('sessions')
        .select('id')
        .where('id', '=', args.sessionId)
        .forUpdate()
        .executeTakeFirstOrThrow(() => new NotFoundException('session vanished'));

      const lastSeqRow = await trx
        .selectFrom('messages')
        .select((eb) => eb.fn.max('seq').as('max_seq'))
        .where('session_id', '=', args.sessionId)
        .executeTakeFirst();

      const nextSeq =
        lastSeqRow && lastSeqRow.max_seq != null
          ? Number(lastSeqRow.max_seq) + 1
          : 1;

      // Sanitize every string reachable through the message: NUL
      // bytes, lone surrogates, Unicode noncharacters, BiDi override
      // controls, and stray C0 controls. The first two would crash a
      // Postgres JSONB insert outright (error 22025); the rest are
      // display / security risks we strip at the single persistence
      // boundary instead of trusting every tool.
      const safeContent = sanitizeForStorage(args.content) as MessageContent;
      const safeText = sanitizeString(args.text);

      await trx
        .insertInto('messages')
        .values({
          session_id: args.sessionId,
          turn_id: args.turnId,
          role: args.role,
          // node-pg sends raw strings for jsonb columns verbatim, so a
          // plain content string would arrive at Postgres unquoted and
          // fail JSON parsing. Stringify explicitly so both shapes
          // (string content / content-parts array) land as valid JSON.
          content: sql`${JSON.stringify(safeContent)}::jsonb`,
          text: safeText,
          seq: nextSeq,
          metadata: args.metadata
            ? sql`${JSON.stringify(args.metadata)}::jsonb`
            : null,
        })
        .execute();

      return nextSeq;
    });
  }

  private resolveBackend(
    override: BackendChoice | undefined,
    sessionDefault: Backend | null,
  ): BackendChoice {
    if (override) return override;
    if (sessionDefault) return { backend: sessionDefault };
    const envDefault =
      (process.env.AGENT_DEFAULT_BACKEND as Backend | undefined) ?? 'anthropic';
    return { backend: envDefault };
  }
}

/**
 * Recursively strip characters that cannot safely round-trip through
 * Postgres or that have no legitimate use in agent conversation text.
 * Walks plain objects + arrays cheaply (no JSON round-trip). Non-string,
 * non-container values pass through unchanged.
 *
 * Stripped at this boundary:
 *   - U+0000 NUL                       Postgres TEXT/JSONB hard reject.
 *   - U+D800..U+DFFF lone surrogates   Postgres JSONB also rejects these;
 *                                      invalid UTF-8 anyway.
 *   - U+FFFE, U+FFFF                   BMP noncharacters.
 *   - U+FDD0..U+FDEF                   Arabic-block noncharacters.
 *   - U+xFFFE, U+xFFFF (planes 1..16)  supplementary-plane noncharacters.
 *   - U+202A..U+202E, U+2066..U+2069   BiDi override / isolate controls
 *                                      (URL homograph attacks).
 *   - U+0001..U+001F except 0x09 0x0A 0x0D   C0 controls (binary leakage).
 *
 * Intentionally kept: U+0080..U+009F (C1 controls), U+FEFF (BOM),
 * U+200B..U+200F (ZWJ/ZWNJ/LRM/RLM) - legitimate in Arabic, Devanagari, etc.
 */
function sanitizeForStorage(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeForStorage);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeForStorage(v);
    }
    return out;
  }
  return value;
}

// Build the forbidden-character regex from numeric code points so the
// source file itself stays free of bare control / surrogate / noncharacter
// bytes - which are exactly the bytes that break editors, diff tools, and
// Postgres in the first place.
function codePointToEscape(cp: number): string {
  return '\\u' + cp.toString(16).padStart(4, '0');
}

const FORBIDDEN_BMP = (() => {
  const e = codePointToEscape;
  const cls = [
    e(0x0000) + '-' + e(0x0008), // C0 incl. NUL, up to backspace
    e(0x000B),                    // C0: vertical tab (skip 0x09/0x0A: tab+LF)
    e(0x000C),                    // C0: form feed (skip 0x0D: CR)
    e(0x000E) + '-' + e(0x001F), // rest of C0 below SP
    e(0xD800) + '-' + e(0xDFFF), // lone surrogates
    e(0xFDD0) + '-' + e(0xFDEF), // Arabic-block noncharacters
    e(0xFFFE) + e(0xFFFF),       // BMP noncharacters
    e(0x202A) + '-' + e(0x202E), // BiDi override
    e(0x2066) + '-' + e(0x2069), // BiDi isolate
  ].join('');
  return new RegExp('[' + cls + ']', 'g');
})();

// Supplementary-plane noncharacters U+1FFFE / U+1FFFF / U+2FFFE / ...
// U+10FFFE / U+10FFFF appear in UTF-16 as any high surrogate followed by
// low surrogate U+DFFE or U+DFFF.
const FORBIDDEN_SUPPLEMENTARY = (() => {
  const e = codePointToEscape;
  return new RegExp(
    '[' + e(0xD800) + '-' + e(0xDBFF) + ']' +
    '[' + e(0xDFFE) + e(0xDFFF) + ']',
    'g',
  );
})();

function sanitizeString(s: string): string {
  // Fast path: most strings are clean. A single test beats two replace
  // passes on every persisted value.
  if (!FORBIDDEN_BMP.test(s) && !FORBIDDEN_SUPPLEMENTARY.test(s)) {
    return s;
  }
  FORBIDDEN_BMP.lastIndex = 0;
  FORBIDDEN_SUPPLEMENTARY.lastIndex = 0;
  return s.replace(FORBIDDEN_BMP, '').replace(FORBIDDEN_SUPPLEMENTARY, '');
}

/**
 * Pick a session title from the first user message: trim whitespace,
 * collapse internal runs, clip to 60 chars + ellipsis. Same shape as
 * the UI used to derive client-side, lifted to the server so it
 * survives across devices.
 */
function deriveSessionTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'New chat';
  return cleaned.length <= 60 ? cleaned : cleaned.slice(0, 60).trimEnd() + '…';
}

function toModelMessage(role: Role, content: MessageContent): ModelMessage {
  // We store ModelMessage.content verbatim, so we can reverse the
  // serialization losslessly. Role discrimination follows the SDK's
  // union shape.
  switch (role) {
    case 'system':
      return {
        role: 'system',
        content: typeof content === 'string' ? content : '',
      };
    case 'user':
      return {
        role: 'user',
        content: content as ModelMessage extends infer M
          ? M extends { role: 'user'; content: infer C }
            ? C
            : never
          : never,
      };
    case 'assistant':
      return {
        role: 'assistant',
        content: content as ModelMessage extends infer M
          ? M extends { role: 'assistant'; content: infer C }
            ? C
            : never
          : never,
      };
    case 'tool':
      return {
        role: 'tool',
        content: content as ModelMessage extends infer M
          ? M extends { role: 'tool'; content: infer C }
            ? C
            : never
          : never,
      };
  }
}

/**
 * Project a ModelMessage's `content` to the JSONB shape we store. For
 * plain strings we keep the string; for content-part arrays we keep
 * the array as-is. The SDK's content parts are already plain JSON,
 * so they round-trip through JSONB without further transformation.
 */
function extractStorableContent(content: unknown): MessageContent {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content as Array<Record<string, unknown>>;
  }
  return '';
}

/**
 * Extract a plain-text projection of message content for the `text`
 * column. For text-only messages this is the same as the content;
 * for content-parts arrays it concatenates the `text` of every TextPart.
 */
function extractDisplayText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === 'object' &&
      (item as Record<string, unknown>).type === 'text' &&
      typeof (item as Record<string, unknown>).text === 'string'
    ) {
      parts.push((item as { text: string }).text);
    }
  }
  return parts.join('');
}
