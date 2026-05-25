-- Initial schema for swirlock-agent-runtime.
--
-- Two top-level concepts:
--
--   sessions: one conversation context. Owned by a user (from JWT sub).
--     Carries an optional system_prompt (client supplies it on session.create,
--     derived from whatever persona / instruction shape that product
--     surface uses), an optional default_backend, and a status flag.
--
--   messages: one entry in a session's conversation. Stores content
--     as JSONB in the Vercel AI SDK ModelMessage shape so it round-trips
--     cleanly through streamText regardless of which provider serves
--     the turn. Includes denormalized text for fast display + search.
--
-- All identifiers are UUID v4 generated client-side or by Postgres
-- gen_random_uuid(). All timestamps are timestamptz UTC.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             text NOT NULL,
  title               text,
  system_prompt       text,
  default_backend     text CHECK (default_backend IN ('anthropic', 'mistral-online', 'mistral-local')),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Cached running sum of message content tokens for prompt-budget
  -- decisions without re-counting the whole history. Updated on every
  -- appendTurn.
  total_token_count   bigint NOT NULL DEFAULT 0
);

CREATE INDEX sessions_user_id_updated_at_idx
  ON sessions (user_id, updated_at DESC)
  WHERE status = 'active';

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id             uuid NOT NULL,
  -- 'user' | 'assistant' | 'system' | 'tool'
  role                text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  -- The full Vercel-AI-SDK ModelMessage content. For text-only messages
  -- this is a JSON string; for messages with tool_use / tool_result /
  -- image blocks this is a JSON array of content parts.
  content             jsonb NOT NULL,
  -- Plain-text projection of `content`, for display and full-text search.
  -- Empty string when the message has no text part (e.g. pure tool_use).
  text                text NOT NULL DEFAULT '',
  -- Per-turn intra-session ordering. Monotonic per session_id; assigned
  -- by ChatSessionService.appendTurn under a transaction.
  seq                 bigint NOT NULL,
  -- Free-form metadata: token usage for this turn, model id used,
  -- citations from search tools, etc.
  metadata            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT messages_session_seq_unique UNIQUE (session_id, seq)
);

CREATE INDEX messages_session_id_seq_idx ON messages (session_id, seq);
CREATE INDEX messages_turn_id_idx ON messages (turn_id);

-- Future expansion lives in new numbered migrations
-- (0002-*.sql, 0003-*.sql, ...). Each migration runs once; the
-- migration runner records executed filenames in schema_migrations.
