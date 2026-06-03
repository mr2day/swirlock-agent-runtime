-- Widen the default_backend CHECK constraints to accept the two new
-- Mistral La Plateforme tiers — Mistral Medium and Mistral Large —
-- added alongside the existing 'mistral-online' (Ministral 14B) for
-- the same quality-cost spread we have on the Anthropic side.

ALTER TABLE sessions
  DROP CONSTRAINT sessions_default_backend_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_default_backend_check
  CHECK (default_backend IN (
    'anthropic',
    'anthropic-sonnet',
    'anthropic-opus',
    'mistral-online',
    'mistral-medium',
    'mistral-large',
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
    'mistral-medium',
    'mistral-large',
    'ollama-local'
  ));
