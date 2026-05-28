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
    // Audience pinned to the agent's public hostname. Must match the
    // `resource` field on every OIDC client registered to talk to the
    // agent. The chatbot UI's swirlock-chatbot-ui client is registered
    // with this exact value.
    IDP_AUDIENCE: 'https://agent.gigi-the-robot.com',

    // === Postgres ===
    PG_HOST: '127.0.0.1',
    PG_PORT: '5432',
    PG_DATABASE: 'swirlock_agent',
    PG_USER: 'swirlock_agent',
    // PG_PASSWORD has no default — must be set per-machine in
    // service.config.local.cjs (the service user's password, NOT the
    // Postgres superuser).

    // === Agent loop defaults ===
    // EU-first phase: Mistral La Plateforme (EU-hosted, GDPR-clean) is
    // the production default. Anthropic stays available as a per-turn
    // override (`backend: 'anthropic'` on turn.submit). See
    // [[project-eu-first-mistral-default]] in memory for the rationale.
    AGENT_DEFAULT_BACKEND: 'mistral-online',
    // Global cap on model→tool→model round-trips per turn. Multi-tool
    // tasks (search, then add, then time, then synthesize) fit
    // comfortably under 16. The per-tool quota (AGENT_TOOL_QUOTAS_JSON)
    // catches single-tool runaway loops earlier than this global cap.
    AGENT_MAX_STEPS: '16',
    AGENT_MAX_OUTPUT_TOKENS: '4096',
    // Per-tool call quota per turn. Catches "model hammers the same
    // tool with slightly different args forever" before it drains
    // AGENT_MAX_STEPS. AGENT_TOOL_QUOTA_DEFAULT applies to any tool
    // not named in AGENT_TOOL_QUOTAS_JSON. Set the default to 0 (or
    // negative) to disable quotas entirely.
    AGENT_TOOL_QUOTA_DEFAULT: '5',
    AGENT_TOOL_QUOTAS_JSON: '{"search_web":5,"get_current_time":3,"add_numbers":3}',
    // Per (client_id, user_id) daily turn cap. UTC-midnight rolling
    // window. Counted from messages.role='user' rows joined to
    // sessions. Set to 0 (or any non-positive) to disable. 200/day
    // covers normal use and caps a runaway script at ~$5-10/day of
    // Haiku tokens.
    AGENT_TURN_CAP_PER_USER_PER_DAY: '200',
    // Comma-separated IdP `sub` values exempt from the cap. Reserved
    // for the operator's own account. Populated per-machine in
    // service.config.local.cjs — the default here is empty so a
    // misconfigured deploy does not silently exempt anyone.
    AGENT_TURN_CAP_EXEMPT_USERS: '',

    // === Anthropic provider ===
    ANTHROPIC_DEFAULT_MODEL: 'claude-haiku-4-5-20251001',

    // === Mistral La Plateforme provider ===
    // ministral-14b-latest is the 14B Ministral on the hosted API
    // (€0.14 / €0.14 per 1M tokens — both directions, verified
    // 2026-05-27 on console.mistral.ai). Switch to mistral-medium-latest
    // for stronger reasoning or mistral-large-latest for premium opt-in.
    MISTRAL_DEFAULT_MODEL: 'ministral-14b-latest',

    // === Ollama local provider ===
    // Ollama runs as a native Windows daemon at :11434. We wire the
    // agent against Ollama's native /api/chat endpoint via the
    // ollama-ai-provider-v2 package — NOT the OpenAI-compat shim at
    // /v1 — because the shim has been known to drop tool-call
    // payloads. The base URL therefore points at the /api root.
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434/api',
    // ministral-3:14b is the local default; the
    // repairMistralToolCallText middleware (gated on the model id
    // internally) covers the malformed-tool-call cases this model
    // sometimes emits on non-English prompts.
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
