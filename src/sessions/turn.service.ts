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
    // and write it onto the session row. The client doesn't pass a
    // title at create time anymore; the session's title is the first
    // thing the user actually typed. Sidebar / session.list pick it
    // up on the next refresh.
    if (nextSeq === 1) {
      const derivedTitle = deriveSessionTitle(input.userMessage);
      await this.database.db
        .updateTable('sessions')
        .set({ title: derivedTitle, updated_at: new Date() })
        .where('id', '=', input.sessionId)
        .execute();
    }

    // 2. Build the ModelMessage[] history for the loop.
    const modelMessages: ModelMessage[] = [];
    for (const m of history) {
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

    for await (const event of this.agentLoop.run({
      systemPrompt: session.systemPrompt ?? undefined,
      messages: modelMessages,
      backend,
      turnId,
      maxSteps: input.maxSteps,
      maxOutputTokens: input.maxOutputTokens,
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
          content: sql`${JSON.stringify(args.content)}::jsonb`,
          text: args.text,
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
