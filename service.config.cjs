'use strict';

/**
 * Single source of truth for the Swirlock Agent Runtime runtime config.
 *
 * Exports `env`: a flat object of key/value pairs that `src/env.ts`
 * lifts into `process.env` at startup. Vercel AI SDK provider packages
 * (@ai-sdk/anthropic, @ai-sdk/mistral) and our own services read these
 * values via `process.env.KEY`.
 *
 * Local overrides + secrets go in `service.config.local.cjs`
 * (gitignored). Anything that needs to differ per machine — Postgres
 * password, API keys, the default backend — lives there.
 *
 * Edit values here for ecosystem-wide defaults that should hold on
 * every machine.
 */

module.exports = {
  env: {
    NODE_ENV: 'production',

    // === Service network ===
    HOST: '127.0.0.1',
    PORT: '3216',

    // === IdP — same as the rest of the Swirlock ecosystem ===
    IDP_ISSUER: 'https://idpbase.swirlock.com/oidc',
    // Per-machine audience must match the URL the chatbot UI / commerce
    // engine / etc. requested tokens with. Default below is the dev
    // localhost; override in service.config.local.cjs for any other
    // deployment.
    IDP_AUDIENCE: 'http://127.0.0.1:3216',

    // === Postgres ===
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'swirlock_agent',
    PG_USER: 'swirlock_agent',
    // PG_PASSWORD has no default — must be set per-machine in
    // service.config.local.cjs (the service user's password, NOT the
    // Postgres superuser).

    // === Agent loop defaults ===
    AGENT_DEFAULT_BACKEND: 'anthropic',
    AGENT_MAX_STEPS: '8',
    AGENT_MAX_OUTPUT_TOKENS: '4096',

    // === Anthropic provider ===
    ANTHROPIC_DEFAULT_MODEL: 'claude-haiku-4-5-20251001',

    // === Mistral La Plateforme provider ===
    MISTRAL_DEFAULT_MODEL: 'ministral-3-14b-25-12',

    // === vLLM local provider (configured when WSL2 is set up) ===
    VLLM_BASE_URL: 'http://127.0.0.1:8000/v1',
    VLLM_DEFAULT_MODEL: 'ministral-3:14b',

    // === Ollama local provider ===
    // Ollama exposes an OpenAI-compatible REST endpoint at :11434/v1
    // out of the box. No auth; the agent uses createOpenAICompatible
    // and passes a sentinel "Authorization: Bearer sk-no-auth" so the
    // OpenAI SDK doesn't refuse to send the request.
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
    OLLAMA_DEFAULT_MODEL: 'ministral-3:14b',

    // === Search ===
    // EXA_API_KEY has no default — must be set per-machine.
    SEARCH_DEFAULT_FRESHNESS: 'month',
    SEARCH_MAX_RESULTS: '8',

    // === Auth bypass (development only — set to 'true' in local cjs
    //     to skip IdP JWT verification on the WebSocket. The service
    //     will log a loud warning at startup if this is on.) ===
    DEV_BYPASS_AUTH: 'false',
  },
};
