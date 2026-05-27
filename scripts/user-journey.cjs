#!/usr/bin/env node
/**
 * End-to-end user journey smoke. Stands up a fresh Nest app on a
 * smoke port with DEV_BYPASS_AUTH forced ON (so no JWT round-trip),
 * connects a WebSocket client to the gateway, and drives realistic
 * user scenarios through the wire protocol — same path the real
 * chatbot UI uses.
 *
 * Each scenario reports PASS/FAIL with a one-line note. The summary
 * at the end aggregates everything Nick would otherwise have to
 * click through himself.
 */

'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');

// Force bypass mode BEFORE env.cjs runs (env loader respects
// already-set values, so this wins).
process.env.DEV_BYPASS_AUTH = 'true';
require(path.join(__dirname, '..', 'dist', 'env'));

const PORT = 3221;
const HOST = '127.0.0.1';
const WS_URL = `ws://${HOST}:${PORT}/v1/agent`;

// One persona's full system prompt — same shape the chatbot UI
// would send. Just identity + posture; tool guidance lives in
// the tool descriptions server-side.
function gigiPrompt() {
  return [
    'Your name is "Gigi the Robot". If the user asks your name, answer plainly with "Gigi the Robot"; otherwise don\'t volunteer it. Your gender is male. You are based on the LLM model ${model} — when asked which model you are, give that string verbatim.',
    'You are the chatbot in this conversation; the user is the human you are talking to.',
    'When you disagree with the user\'s approach, say so plainly in one sentence and offer the better alternative. Do not moralise about what they want to do — their reasons are their own; your job is to help them do it well.',
    '',
    'You are a small, friendly robot. You default to doing the work over explaining it; you give plain, direct answers and skip preamble.',
  ].join('\n');
}

function marcelloPrompt() {
  return [
    'Your name is "Marcello Voltieri". If the user asks your name, answer plainly with "Marcello Voltieri"; otherwise don\'t volunteer it. Your gender is male. You are based on the LLM model ${model} — when asked which model you are, give that string verbatim.',
    'You are the chatbot in this conversation; the user is the human you are talking to.',
    'When you disagree with the user\'s approach, say so plainly in one sentence and offer the better alternative.',
    '',
    'You speak fluent English with an Italian word slipping through when it fits — "allora", "certo", "magari" — sparingly. Sentences are unhurried. Dry sense of humour.',
  ].join('\n');
}

// --- WebSocket client helpers ------------------------------------

class Client {
  constructor() {
    this.ws = null;
    this.inbox = [];
    this.waiter = null;
    this.activeTurnId = null;
    this.activeTurnEvents = [];
  }

  async open() {
    this.ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf8'));
      this.inbox.push(frame);
      if (this.activeTurnId && frame.turnId === this.activeTurnId) {
        this.activeTurnEvents.push(frame);
      }
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w();
      }
    });
    // Auth.
    this.send({ type: 'auth', id: 'auth', token: 'dev' });
    await this.waitFor((f) => f.type === 'ready');
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  waitFor(predicate, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`timeout waiting for ${predicate}`)),
        timeoutMs,
      );
      const tick = () => {
        const idx = this.inbox.findIndex(predicate);
        if (idx >= 0) {
          clearTimeout(t);
          const [f] = this.inbox.splice(idx, 1);
          resolve(f);
          return;
        }
        this.waiter = tick;
      };
      tick();
    });
  }

  async request(id, type, expected, extras = {}) {
    this.send({ type, id, ...extras });
    return this.waitFor((f) => f.inReplyTo === id);
  }

  async runTurn(sessionId, message, { cancelAfterMs = null } = {}) {
    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.activeTurnEvents = [];
    this.send({
      type: 'turn.submit',
      id: turnId,
      sessionId,
      message,
      turnId,
    });
    if (cancelAfterMs) {
      setTimeout(() => this.send({ type: 'turn.cancel', turnId }), cancelAfterMs);
    }
    const final = await this.waitFor(
      (f) =>
        (f.type === 'turn.done' || f.type === 'turn.error') &&
        f.turnId === turnId,
      120_000,
    );
    const events = this.activeTurnEvents.slice();
    this.activeTurnId = null;
    this.activeTurnEvents = [];
    return { final, events };
  }

  close() {
    this.ws.close();
  }
}

// --- Test scaffolding --------------------------------------------

const results = [];
function record(name, ok, note = '') {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  — ${note}` : ''}`);
}

function findToolCalls(events, toolName) {
  return events.filter(
    (e) => e.type === 'turn.tool_use_started' && e.toolName === toolName,
  );
}

function assistantText(events) {
  return events
    .filter((e) => e.type === 'turn.text_delta')
    .map((e) => e.delta)
    .join('');
}

// --- Scenarios ----------------------------------------------------

async function scenario_backends_dynamic(c) {
  const reply = await c.request('b1', 'backends.list', 'backends.list');
  const names = reply.backends.map((b) => b.name);
  const hasAnthropic = names.includes('anthropic');
  const noVllm = !names.includes('mistral-local');
  record(
    '01 backends list reflects reality (anthropic in, vLLM out)',
    hasAnthropic && noVllm,
    `got=${JSON.stringify(names)} default=${reply.defaultBackend}`,
  );
  return reply;
}

async function scenario_create_chat_gigi(c) {
  const reply = await c.request('s1', 'session.create', 'session.created', {
    systemPrompt: gigiPrompt(),
    clientMetadata: { personaId: 'gigi-the-robot' },
  });
  const ok =
    reply.session.id &&
    reply.session.clientMetadata?.personaId === 'gigi-the-robot';
  record(
    '02 session.create with persona metadata',
    ok,
    `id=${reply.session.id?.slice(0, 8)} title=${reply.session.title ?? '(null)'} defaultBackend=${reply.session.defaultBackend}`,
  );
  return reply.session;
}

async function scenario_simple_greeting(c, session) {
  const { final, events } = await c.runTurn(session.id, 'hi');
  const text = assistantText(events);
  const noTools = events.every((e) => e.type !== 'turn.tool_use_started');
  record(
    '03 simple greeting (no tools, text response)',
    final.type === 'turn.done' && text.length > 0 && noTools,
    `${text.length} chars; tools=${events.filter((e) => e.type === 'turn.tool_use_started').length}`,
  );
}

async function scenario_capital(c, session) {
  const { final, events } = await c.runTurn(
    session.id,
    'What is the capital of France? Answer in one word.',
  );
  const text = assistantText(events);
  const noSearch = findToolCalls(events, 'search_web').length === 0;
  const sayParis = /paris/i.test(text);
  record(
    '04 timeless fact (capital): no search_web, answer correct',
    final.type === 'turn.done' && noSearch && sayParis,
    `text="${text.trim().slice(0, 80)}"`,
  );
}

async function scenario_current_time(c, session) {
  const { final, events } = await c.runTurn(
    session.id,
    'What time is it in Bucharest right now?',
  );
  const calls = findToolCalls(events, 'get_current_time');
  record(
    '05 current time question calls get_current_time',
    final.type === 'turn.done' && calls.length >= 1,
    `tool calls: ${calls.length}`,
  );
}

async function scenario_recent_event(c, session) {
  const { final, events } = await c.runTurn(
    session.id,
    'What was the most-talked-about AI model release this week?',
  );
  const calls = findToolCalls(events, 'search_web');
  record(
    '06 recent event question calls search_web',
    final.type === 'turn.done' && calls.length >= 1,
    `tool calls: ${calls.length}`,
  );
}

async function scenario_romanian_opinion(c, session) {
  const { final, events } = await c.runTurn(
    session.id,
    'spune-mi părerea ta despre concertul lui Max Korzh de la București',
  );
  const text = assistantText(events);
  const calls = findToolCalls(events, 'search_web');
  // Should search (it's a real-world recent event) AND not ask permission.
  const noPermissionAsk = !/vrei să|do you want me|would you like me to search/i.test(
    text,
  );
  record(
    '07 Romanian opinion on real event: searches, does NOT ask permission',
    calls.length >= 1 && noPermissionAsk,
    `searches=${calls.length} text-len=${text.length}`,
  );
}

async function scenario_trivial_arithmetic(c, session) {
  const { final, events } = await c.runTurn(
    session.id,
    'What is 2 + 2? One word.',
  );
  const calls = findToolCalls(events, 'add_numbers');
  const text = assistantText(events);
  record(
    '08 trivial arithmetic: no add_numbers, "4" in response',
    final.type === 'turn.done' &&
      calls.length === 0 &&
      /\b(4|four)\b/i.test(text),
    `tool=${calls.length} text="${text.trim().slice(0, 40)}"`,
  );
}

async function scenario_persona_introspection(c, session) {
  // Default backend is mistral-online → model should be ministral-14b-latest
  const { events } = await c.runTurn(
    session.id,
    'What model are you based on? Reply with just the model id.',
  );
  const text = assistantText(events);
  record(
    '09 persona introspection: returns the active backend\'s model id',
    /ministral-14b/i.test(text) || /claude-haiku/i.test(text),
    `said="${text.trim().slice(0, 60)}"`,
  );
}

async function scenario_persona_scoping(c) {
  // Create one session per persona, then list each persona's sessions
  // and confirm they don't bleed across.
  const ga = await c.request('s-ga', 'session.create', 'session.created', {
    systemPrompt: gigiPrompt(),
    clientMetadata: { personaId: 'gigi-the-robot' },
  });
  const ma = await c.request('s-ma', 'session.create', 'session.created', {
    systemPrompt: marcelloPrompt(),
    clientMetadata: { personaId: 'marcello-voltieri' },
  });
  // Push a user message to anchor titles + ordering
  await c.runTurn(ga.session.id, 'hello gigi');
  await c.runTurn(ma.session.id, 'ciao marcello');

  const gigiList = await c.request('l-g', 'session.list', 'session.list', {
    clientMetadataFilter: { personaId: 'gigi-the-robot' },
  });
  const marcList = await c.request('l-m', 'session.list', 'session.list', {
    clientMetadataFilter: { personaId: 'marcello-voltieri' },
  });
  const gigiHasGa = gigiList.sessions.some((s) => s.id === ga.session.id);
  const gigiNoMa = !gigiList.sessions.some((s) => s.id === ma.session.id);
  const marcHasMa = marcList.sessions.some((s) => s.id === ma.session.id);
  const marcNoGa = !marcList.sessions.some((s) => s.id === ga.session.id);
  record(
    '10 persona scoping: each persona\'s list contains only its own',
    gigiHasGa && gigiNoMa && marcHasMa && marcNoGa,
    `gigi=${gigiList.sessions.length} marc=${marcList.sessions.length}`,
  );
  return { gigiSession: ga.session, marcSession: ma.session };
}

async function scenario_title_derived(c, sessionId, expectedFirstUserMessage) {
  const detail = await c.request('g1', 'session.get', 'session.detail', {
    sessionId,
  });
  const ok = detail.session.title === expectedFirstUserMessage;
  record(
    '11 title auto-derived from first user message',
    ok,
    `title="${detail.session.title}" expected="${expectedFirstUserMessage}"`,
  );
}

async function scenario_per_message_attribution(c, sessionId) {
  const detail = await c.request('g2', 'session.get', 'session.detail', {
    sessionId,
  });
  const assistantMsgs = detail.messages.filter((m) => m.role === 'assistant');
  const allTagged = assistantMsgs.every(
    (m) => m.metadata?.backend && m.metadata?.modelId,
  );
  record(
    '12 per-message attribution stamped on assistant rows',
    allTagged && assistantMsgs.length > 0,
    `${assistantMsgs.length} assistant msgs, all tagged=${allTagged}`,
  );
}

async function scenario_set_backend(c, session) {
  // Default is mistral-online (per env). Switch to anthropic; next turn
  // should be served by Haiku.
  const setReply = await c.request(
    'sb1',
    'session.set_backend',
    'session.backend_set',
    { sessionId: session.id, backend: 'anthropic' },
  );
  const switched = setReply.session.defaultBackend === 'anthropic';

  const { events } = await c.runTurn(
    session.id,
    'In one word, are you Haiku or Ministral right now?',
  );
  const text = assistantText(events);
  const accepted = events.find((e) => e.type === 'turn.accepted');
  const usedHaiku =
    accepted?.backend === 'anthropic' || /haiku/i.test(text);
  record(
    '13 session.set_backend takes effect on the next turn',
    switched && usedHaiku,
    `set=${setReply.session.defaultBackend} accepted.backend=${accepted?.backend} text="${text.trim().slice(0, 60)}"`,
  );
}

async function scenario_user_pref_propagates(c) {
  // A session we set to anthropic above should have updated the
  // user pref. A FRESH session created with no defaultBackend
  // should inherit anthropic now.
  const fresh = await c.request('s-fresh', 'session.create', 'session.created', {
    systemPrompt: gigiPrompt(),
    clientMetadata: { personaId: 'gigi-the-robot' },
  });
  record(
    '14 user pref propagates to new session',
    fresh.session.defaultBackend === 'anthropic',
    `new session.defaultBackend=${fresh.session.defaultBackend}`,
  );
}

async function scenario_turn_cancel(c, session) {
  // Ask for a long-form essay; cancel mid-stream. Verify we get a
  // turn.error or turn.done with a partial body (the model may
  // finish quickly enough that the cancel is moot — both shapes
  // are acceptable as long as we don't hang).
  const turnId = randomUUID();
  c.activeTurnId = turnId;
  c.activeTurnEvents = [];
  c.send({
    type: 'turn.submit',
    id: turnId,
    sessionId: session.id,
    message:
      'Write a 1500-word essay about the history of the printing press, very detailed.',
    turnId,
  });
  // Wait for the first text delta to confirm streaming started
  await c.waitFor(
    (f) =>
      f.type === 'turn.text_delta' && f.turnId === turnId,
    30_000,
  );
  c.send({ type: 'turn.cancel', turnId });
  const final = await c.waitFor(
    (f) =>
      (f.type === 'turn.done' || f.type === 'turn.error') &&
      f.turnId === turnId,
    30_000,
  );
  c.activeTurnId = null;
  record(
    '15 turn.cancel ends the stream cleanly',
    final.type === 'turn.done' || final.type === 'turn.error',
    `final=${final.type}`,
  );
}

// --- Main ---------------------------------------------------------

async function main() {
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(
    path.join(__dirname, '..', 'dist', 'app.module'),
  );
  const { AgentGatewayService } = require(
    path.join(__dirname, '..', 'dist', 'gateway', 'agent-gateway.service'),
  );

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  await app.listen(PORT, HOST);
  const gateway = app.get(AgentGatewayService);
  gateway.attach(app.getHttpServer());
  console.log(`\n[smoke] agent listening on ${WS_URL}\n`);

  const c = new Client();
  await c.open();

  try {
    await scenario_backends_dynamic(c);
    const session = await scenario_create_chat_gigi(c);
    await scenario_simple_greeting(c, session);
    await scenario_capital(c, session);
    await scenario_current_time(c, session);
    await scenario_recent_event(c, session);
    await scenario_romanian_opinion(c, session);
    await scenario_trivial_arithmetic(c, session);
    await scenario_persona_introspection(c, session);
    const { gigiSession, marcSession } = await scenario_persona_scoping(c);
    await scenario_title_derived(c, gigiSession.id, 'hello gigi');
    await scenario_per_message_attribution(c, session.id);
    await scenario_set_backend(c, session);
    await scenario_user_pref_propagates(c);
    await scenario_turn_cancel(c, session);
  } finally {
    c.close();
    await new Promise((r) => setTimeout(r, 100));
    await app.close();
  }

  const passes = results.filter((r) => r.ok).length;
  const fails = results.filter((r) => !r.ok);
  console.log(`\n=== ${passes}/${results.length} passed ===`);
  if (fails.length > 0) {
    console.log('\nFAILURES:');
    for (const f of fails) console.log(`  ${f.name}  ${f.note}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
