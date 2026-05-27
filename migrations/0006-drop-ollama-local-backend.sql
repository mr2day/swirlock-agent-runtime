-- Drop 'ollama-local' from the default_backend CHECK constraints.
-- Ollama is retired in favour of vLLM (mistral-local). Any existing
-- session or user_preferences row pinned to 'ollama-local' is rewritten
-- to NULL so the per-session default falls back to AGENT_DEFAULT_BACKEND
-- and the per-user default falls back to the runtime default.

UPDATE sessions
  SET default_backend = NULL
  WHERE default_backend = 'ollama-local';

UPDATE user_preferences
  SET default_backend = NULL
  WHERE default_backend = 'ollama-local';

ALTER TABLE sessions
  DROP CONSTRAINT sessions_default_backend_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_default_backend_check
  CHECK (default_backend IN (
    'anthropic',
    'mistral-online',
    'mistral-local'
  ));

ALTER TABLE user_preferences
  DROP CONSTRAINT user_preferences_default_backend_check;

ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_default_backend_check
  CHECK (default_backend IN (
    'anthropic',
    'mistral-online',
    'mistral-local'
  ));
