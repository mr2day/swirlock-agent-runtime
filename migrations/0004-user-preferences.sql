-- Per-(client_id, user_id) preferences. Today: just the user's
-- preferred default backend. When the user picks a model in the
-- sidebar of any session, the choice is also written here so the
-- NEXT session they create starts on the same model — not on the
-- runtime's AGENT_DEFAULT_BACKEND.
--
-- The session table's `default_backend` column is still authoritative
-- per-session (so switching mid-conversation doesn't ripple
-- backwards to old sessions). This table only seeds new sessions.

CREATE TABLE user_preferences (
  client_id        text NOT NULL,
  user_id          text NOT NULL,
  default_backend  text CHECK (default_backend IN (
    'anthropic',
    'mistral-online',
    'mistral-local',
    'ollama-local'
  )),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, user_id)
);
