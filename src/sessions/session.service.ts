import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type {
  Backend,
  MessageContent,
  Role,
  SessionStatus,
} from '../database/schema';

export interface SessionRecord {
  id: string;
  clientId: string;
  userId: string;
  title: string | null;
  systemPrompt: string | null;
  defaultBackend: Backend | null;
  status: SessionStatus;
  createdAt: Date;
  updatedAt: Date;
  totalTokenCount: number;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  turnId: string;
  role: Role;
  content: MessageContent;
  text: string;
  seq: number;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface CreateSessionInput {
  clientId: string;
  userId: string;
  title?: string;
  systemPrompt?: string;
  defaultBackend?: Backend;
}

@Injectable()
export class SessionService {
  constructor(private readonly database: DatabaseService) {}

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    // Seed the new session's default_backend from the user's last
    // explicit choice (if any). The client may still override
    // explicitly. Falls back to NULL (TurnService resolves NULL to
    // AGENT_DEFAULT_BACKEND at turn time).
    const effectiveBackend =
      input.defaultBackend ??
      (await this.getUserPreferredBackend(input.clientId, input.userId));

    const inserted = await this.database.db
      .insertInto('sessions')
      .values({
        client_id: input.clientId,
        user_id: input.userId,
        title: input.title ?? null,
        system_prompt: input.systemPrompt ?? null,
        default_backend: effectiveBackend ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.toSessionRecord(inserted);
  }

  /**
   * Returns the user's last-explicitly-chosen backend (via the
   * sidebar's model picker), or null if they have never switched.
   * New sessions inherit this so a model pick "sticks" for future
   * conversations, not just the current one.
   */
  async getUserPreferredBackend(
    clientId: string,
    userId: string,
  ): Promise<Backend | null> {
    const row = await this.database.db
      .selectFrom('user_preferences')
      .select('default_backend')
      .where('client_id', '=', clientId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.default_backend ?? null;
  }

  async getSession(
    sessionId: string,
    clientId: string,
    userId: string,
  ): Promise<SessionRecord> {
    const row = await this.database.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('client_id', '=', clientId)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException(`session not found: ${sessionId}`);
    }
    return this.toSessionRecord(row);
  }

  async listSessions(
    clientId: string,
    userId: string,
    limit = 50,
  ): Promise<SessionRecord[]> {
    const rows = await this.database.db
      .selectFrom('sessions')
      .selectAll()
      .where('client_id', '=', clientId)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => this.toSessionRecord(r));
  }

  async getMessages(
    sessionId: string,
    clientId: string,
    userId: string,
  ): Promise<MessageRecord[]> {
    // Verify ownership before reading messages.
    await this.getSession(sessionId, clientId, userId);

    const rows = await this.database.db
      .selectFrom('messages')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('seq', 'asc')
      .execute();

    return rows.map((r) => this.toMessageRecord(r));
  }

  async archiveSession(
    sessionId: string,
    clientId: string,
    userId: string,
  ): Promise<void> {
    await this.getSession(sessionId, clientId, userId);
    await this.database.db
      .updateTable('sessions')
      .set({ status: 'archived', updated_at: new Date() })
      .where('id', '=', sessionId)
      .execute();
  }

  /**
   * Update the session's default backend. Subsequent turns that don't
   * specify a per-turn override will use the new backend; past turns
   * are not retroactively reattributed. Returns the updated session.
   */
  async setSessionBackend(
    sessionId: string,
    clientId: string,
    userId: string,
    backend: Backend,
  ): Promise<SessionRecord> {
    await this.getSession(sessionId, clientId, userId);
    // Update the session row (this turn / this conversation) AND
    // upsert the user's preference (so the NEXT new session inherits
    // the choice instead of falling back to AGENT_DEFAULT_BACKEND).
    await this.database.db
      .updateTable('sessions')
      .set({ default_backend: backend, updated_at: new Date() })
      .where('id', '=', sessionId)
      .execute();
    await this.database.db
      .insertInto('user_preferences')
      .values({
        client_id: clientId,
        user_id: userId,
        default_backend: backend,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(['client_id', 'user_id']).doUpdateSet({
          default_backend: backend,
          updated_at: new Date(),
        }),
      )
      .execute();
    return this.getSession(sessionId, clientId, userId);
  }

  private toSessionRecord(row: {
    id: string;
    client_id: string;
    user_id: string;
    title: string | null;
    system_prompt: string | null;
    default_backend: Backend | null;
    status: SessionStatus;
    created_at: Date;
    updated_at: Date;
    total_token_count: string;
  }): SessionRecord {
    return {
      id: row.id,
      clientId: row.client_id,
      userId: row.user_id,
      title: row.title,
      systemPrompt: row.system_prompt,
      defaultBackend: row.default_backend,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      totalTokenCount: Number(row.total_token_count),
    };
  }

  private toMessageRecord(row: {
    id: string;
    session_id: string;
    turn_id: string;
    role: Role;
    content: MessageContent;
    text: string;
    seq: string;
    metadata: Record<string, unknown> | null;
    created_at: Date;
  }): MessageRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      role: row.role,
      content: row.content,
      text: row.text,
      seq: Number(row.seq),
      metadata: row.metadata,
      createdAt: row.created_at,
    };
  }
}
