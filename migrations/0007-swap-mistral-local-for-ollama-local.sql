-- Drop 'mistral-local' (vLLM-served, retired) and re-add 'ollama-local'
-- (native Ollama via ollama-ai-provider-v2) to the default_backend
-- CHECK constraints. Existing rows pinned to 'mistral-local' are
-- rewritten to NULL so they fall back to AGENT_DEFAULT_BACKEND on the
-- next turn.

UPDATE sessions
  SET default_backend = NULL
  WHERE default_backend = 'mistral-local';

UPDATE user_preferences
  SET default_backend = NULL
  WHERE default_backend = 'mistral-local';

ALTER TABLE sessions
  DROP CONSTRAINT sessions_default_backend_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_default_backend_check
  CHECK (default_backend IN (
    'anthropic',
    'mistral-online',
    'ollama-local'
  ));

ALTER TABLE user_preferences
  DROP CONSTRAINT user_preferences_default_backend_check;

ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_default_backend_check
  CHECK (default_backend IN (
    'anthropic',
    'mistral-online',
    'ollama-local'
  ));
