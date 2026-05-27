-- Per-session client-side metadata bag. Today: stores the OAuth
-- client's notion of which "persona" / "skin" / "scope" the session
-- belongs to. The agent doesn't interpret the contents — it stores
-- them and lets session.list filter by exact-match.
--
-- Replaces the client-side localStorage intersection hack that
-- silently hid all sessions on a fresh device (a real user-visible
-- regression). Filtering is now server-side and survives device
-- swaps + localStorage clears.

ALTER TABLE sessions
  ADD COLUMN client_metadata jsonb;

-- GIN index for containment queries (`client_metadata @> '{"personaId":"..."}'`).
-- jsonb_path_ops keeps the index small and is fast for @> exactly.
CREATE INDEX sessions_client_metadata_gin_idx
  ON sessions USING GIN (client_metadata jsonb_path_ops)
  WHERE client_metadata IS NOT NULL;
