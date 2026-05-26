import type { ColumnType, Generated } from 'kysely';

// Vercel AI SDK ModelMessage `content` is either a string (for plain
// assistant/user text) or an array of content parts (tool_use,
// tool_result, image, text). We store it verbatim as JSONB so the
// round-trip back into streamText is lossless.
export type MessageContent =
  | string
  | Array<Record<string, unknown>>;

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export type SessionStatus = 'active' | 'archived' | 'deleted';

export type Backend =
  | 'anthropic'
  | 'mistral-online'
  | 'mistral-local'
  | 'ollama-local';

export interface SessionsTable {
  id: Generated<string>;
  // OAuth client_id from the JWT — the app that owns this session.
  // Different client apps (chatbot UI vs commerce UI vs IDE plugin)
  // never see each other's sessions, even if they share a user.
  client_id: string;
  user_id: string;
  title: string | null;
  system_prompt: string | null;
  default_backend: Backend | null;
  status: ColumnType<SessionStatus, SessionStatus | undefined, SessionStatus>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
  total_token_count: ColumnType<string, number | bigint | undefined, number | bigint>;
}

export interface MessagesTable {
  id: Generated<string>;
  session_id: string;
  turn_id: string;
  role: Role;
  content: ColumnType<MessageContent, MessageContent, MessageContent>;
  text: ColumnType<string, string | undefined, string>;
  seq: ColumnType<string, number | bigint, number | bigint>;
  metadata: ColumnType<Record<string, unknown> | null, Record<string, unknown> | null, Record<string, unknown> | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface SchemaMigrationsTable {
  filename: string;
  applied_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface Database {
  sessions: SessionsTable;
  messages: MessagesTable;
  schema_migrations: SchemaMigrationsTable;
}
