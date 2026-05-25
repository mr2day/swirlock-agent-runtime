# swirlock-agent-runtime

Swirlock Agent Runtime — a classic-pattern, tool-using LLM agent.

Built on NestJS + Vercel AI SDK 6. Tenant-agnostic. Consumed by `swirlock-chatbot-ui` today; will be consumed by the future Swirlock Commerce Engine, future IDE plugins, future voice / robot surfaces.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy the local config template and fill in secrets
cp service.config.local.cjs.example service.config.local.cjs
# edit service.config.local.cjs: Postgres password, ANTHROPIC_API_KEY, EXA_API_KEY

# 3. Set up the database (one-shot — uses postgres superuser)
SUPERUSER_PASSWORD=... npm run db:setup

# 4. Run migrations
npm run db:migrate

# 5. Build and start
npm run build
npm start
```

The agent listens on `ws://127.0.0.1:3216/v1/agent` (WebSocket) for clients.

## Architecture

- **NestJS** application
- **PostgreSQL 17** for session + message persistence (commercial-grade from day one)
- **Vercel AI SDK 6** for the agent loop (provider abstraction + streaming + tool dispatch)
- **Three backends** wired: Anthropic native, Mistral La Plateforme (online Ministral), vLLM (local Ministral via OpenAI-compat endpoint)
- **Direct provider calls** — no llm-host indirection (clean-departure architecture; see project notes)
- **IdP-issued JWT** auth on every WebSocket upgrade (same JWKS as the rest of the Swirlock ecosystem)
- **Tools** are first-class. Bundled: `get_current_time`, `add_numbers`, `search_web` (Exa direct). MCP client surface comes later.

## Scope and what this is NOT

This repo is the **agent runtime**. It is not:

- A chatbot product (that's `swirlock-chatbot-ui`)
- A commerce store (that's the future Swirlock Commerce Engine)
- An IDE plugin (that's a future VS Code extension)

It is the kernel those products call. It has no built-in persona — clients send a system prompt on session creation, which the agent prepends to every turn. The agent itself has only a tiny meta-instruction baked in: *"You are a tool-using agent. Use tools when you need information you don't have. Don't fabricate."*

## Smoke tests

After building (`npm run build`), the standalone scripts under `scripts/` exercise each layer:

- `smoke-anthropic.cjs` — first call to the model, no tools
- `smoke-tool-loop.cjs` — toy tools (`get_current_time`, `add_numbers`)
- `smoke-search.cjs` — `search_web` via Exa
- `smoke-session.cjs` — full session including multi-turn persistence
- `smoke-ws.cjs` — end-to-end WebSocket client

Each script bootstraps a minimal NestJS context, exercises its slice, and exits non-zero on failure.
