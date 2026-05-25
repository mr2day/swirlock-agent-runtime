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
  userId: string;
  title?: string;
  systemPrompt?: string;
  defaultBackend?: Backend;
}

@Injectable()
export class SessionService {
  constructor(private readonly database: DatabaseService) {}

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const inserted = await this.database.db
      .insertInto('sessions')
      .values({
        user_id: input.userId,
        title: input.title ?? null,
        system_prompt: input.systemPrompt ?? null,
        default_backend: input.defaultBackend ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.toSessionRecord(inserted);
  }

  async getSession(sessionId: string, userId: string): Promise<SessionRecord> {
    const row = await this.database.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .executeTakeFirst();

    if (!row) {
      throw new NotFoundException(`session not found: ${sessionId}`);
    }
    return this.toSessionRecord(row);
  }

  async listSessions(userId: string, limit = 50): Promise<SessionRecord[]> {
    const rows = await this.database.db
      .selectFrom('sessions')
      .selectAll()
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map((r) => this.toSessionRecord(r));
  }

  async getMessages(
    sessionId: string,
    userId: string,
  ): Promise<MessageRecord[]> {
    // Verify ownership before reading messages.
    await this.getSession(sessionId, userId);

    const rows = await this.database.db
      .selectFrom('messages')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('seq', 'asc')
      .execute();

    return rows.map((r) => this.toMessageRecord(r));
  }

  async archiveSession(sessionId: string, userId: string): Promise<void> {
    await this.getSession(sessionId, userId);
    await this.database.db
      .updateTable('sessions')
      .set({ status: 'archived', updated_at: new Date() })
      .where('id', '=', sessionId)
      .execute();
  }

  private toSessionRecord(row: {
    id: string;
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
