-- Add client_id (the OAuth client that owns the session) to sessions.
--
-- In OIDC vocabulary "client" is the application that requested the
-- token; in multi-tenant SaaS vocabulary the same boundary is called
-- "tenant". We keep the OIDC name end-to-end so the column matches the
-- JWT claim it's populated from (`payload.client_id`).
--
-- Every read against sessions/messages must filter by (client_id,
-- user_id) so e.g. the chatbot UI and a future commerce UI can't see
-- each other's history even if they belong to the same human user.

ALTER TABLE sessions
  ADD COLUMN client_id text;

-- Backfill any existing rows (smoke-test leftovers from the bootstrap
-- session). DEV_BYPASS_AUTH=true tags everything as 'dev', so that's
-- the only value those rows could plausibly have had.
UPDATE sessions
  SET client_id = 'dev'
  WHERE client_id IS NULL;

ALTER TABLE sessions
  ALTER COLUMN client_id SET NOT NULL;

-- Replace the (user_id, updated_at) sidebar index with one that leads
-- on client_id so the most common access pattern — "this client app
-- asking for this user's active sessions, newest first" — stays a
-- single index seek.
DROP INDEX IF EXISTS sessions_user_id_updated_at_idx;

CREATE INDEX sessions_client_user_updated_at_idx
  ON sessions (client_id, user_id, updated_at DESC)
  WHERE status = 'active';
