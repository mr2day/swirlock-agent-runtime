-- Widen the default_backend CHECK constraints to accept the two new
-- Anthropic entries — Sonnet 4.6 and Opus 4.7 — added alongside the
-- existing 'anthropic' (Haiku 4.5) for testing the quality-cost
-- spread across the Claude family.

ALTER TABLE sessions
  DROP CONSTRAINT sessions_default_backend_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_default_backend_check
  CHECK (default_backend IN (
    'anthropic',
    'anthropic-sonnet',
    'anthropic-opus',
    'mistral-online',
    'ollama-local'
  ));

ALTER TABLE user_preferences
  DROP CONSTRAINT user_preferences_default_backend_check;

ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_default_backend_check
  CHECK (default_backend IN (
    'anthropic',
    'anthropic-sonnet',
    'anthropic-opus',
    'mistral-online',
    'ollama-local'
  ));
