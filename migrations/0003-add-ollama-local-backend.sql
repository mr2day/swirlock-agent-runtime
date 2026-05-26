-- Widen sessions.default_backend to accept 'ollama-local'.
--
-- Ollama runs locally on the dev machine alongside (or instead of)
-- vLLM. The agent runtime treats it as just another backend resolved
-- through @ai-sdk/openai-compatible against Ollama's OpenAI-compatible
-- endpoint at http://localhost:11434/v1 — no llm-host indirection.

ALTER TABLE sessions
  DROP CONSTRAINT sessions_default_backend_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_default_backend_check
  CHECK (default_backend IN (
    'anthropic',
    'mistral-online',
    'mistral-local',
    'ollama-local'
  ));
