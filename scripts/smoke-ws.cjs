#!/usr/bin/env node
/**
 * WebSocket smoke test: connects to ws://127.0.0.1:3216/v1/agent,
 * authenticates (DEV_BYPASS_AUTH=true sidesteps the real IdP),
 * creates a session, runs a turn, and verifies the streamed envelope.
 *
 * Boots its own Nest server in-process so this is fully self-contained.
 */

'use strict';

const path = require('node:path');

// Force bypass mode for this smoke regardless of what
// service.config.local.cjs has set (production runs DEV_BYPASS_AUTH=false).
// The env loader respects already-set values, so this wins.
process.env.DEV_BYPASS_AUTH = 'true';

require(path.join(__dirname, '..', 'dist', 'env'));

const WebSocket = require('ws');
const http = require('node:http');

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

  const host = '127.0.0.1';
  // Use a smoke-only port to avoid conflicts with a running server.
  const port = 3219;
  await app.listen(port, host);

  const gateway = app.get(AgentGatewayService);
  gateway.attach(app.getHttpServer());

  console.log(`[smoke] server listening on http://${host}:${port}`);

  const ws = new WebSocket(`ws://${host}:${port}/v1/agent`);

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  console.log('[smoke] ws open');

  const inbox = [];
  let waiter = null;
  ws.on('message', (data) => {
    const text = data.toString('utf8');
    const frame = JSON.parse(text);
    inbox.push(frame);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  });

  function waitFor(typeOrPredicate, timeoutMs = 30000) {
    const predicate =
      typeof typeOrPredicate === 'function'
        ? typeOrPredicate
        : (f) => f.type === typeOrPredicate;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timeout waiting for ${typeOrPredicate}`));
      }, timeoutMs);
      const tick = () => {
        const idx = inbox.findIndex(predicate);
        if (idx >= 0) {
          clearTimeout(timer);
          const [frame] = inbox.splice(idx, 1);
          resolve(frame);
          return;
        }
        waiter = tick;
      };
      tick();
    });
  }

  function send(frame) {
    ws.send(JSON.stringify(frame));
  }

  // 1. Auth (DEV_BYPASS_AUTH=true accepts any string).
  send({ id: 'auth-1', type: 'auth', token: 'dev-token' });
  const ready = await waitFor('ready');
  console.log(`[smoke] ready as userId=${ready.userId}`);

  // 2. backends.list
  send({ id: 'b1', type: 'backends.list' });
  const backends = await waitFor('backends.list');
  console.log(`[smoke] backends: ${backends.backends.join(', ')}`);

  // 3. session.create
  send({
    id: 's1',
    type: 'session.create',
    title: 'ws smoke',
    systemPrompt: 'You are a brief assistant. Answer in one short sentence.',
  });
  const created = await waitFor('session.created');
  const sessionId = created.session.id;
  console.log(`[smoke] session.created id=${sessionId}`);

  // 4. turn.submit
  send({
    id: 't1',
    type: 'turn.submit',
    sessionId,
    message: 'Reply with exactly the four words: WS GATEWAY IS GREEN.',
    maxSteps: 1,
    maxOutputTokens: 64,
  });
  const accepted = await waitFor('turn.accepted');
  console.log(
    `[smoke] turn.accepted turnId=${accepted.turnId} backend=${accepted.backend}/${accepted.model}`,
  );

  let textOut = '';
  while (true) {
    const evt = await waitFor(
      (f) =>
        f.type === 'turn.text_delta' ||
        f.type === 'turn.done' ||
        f.type === 'turn.error',
    );
    if (evt.type === 'turn.text_delta') {
      textOut += evt.delta;
      process.stdout.write(evt.delta);
    } else if (evt.type === 'turn.done') {
      console.log('');
      console.log(
        `[smoke] turn.done finishReason=${evt.finishReason} usage=${JSON.stringify(evt.usage)}`,
      );
      break;
    } else {
      console.error(`[smoke] turn.error: ${evt.error}`);
      throw new Error('turn errored');
    }
  }

  // 5. session.get — verify the messages are visible to the client too.
  send({ id: 'g1', type: 'session.get', sessionId });
  const detail = await waitFor('session.detail');
  console.log(`[smoke] session.detail messages=${detail.messages.length}`);
  for (const m of detail.messages) {
    console.log(
      `  seq=${m.seq} role=${m.role} text=${m.text.slice(0, 60).replace(/\s+/g, ' ')}`,
    );
  }

  ws.close();
  await new Promise((r) => setTimeout(r, 50));
  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] CRASHED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
