// `./env` MUST run before AppModule / any SDK is loaded — it populates
// process.env from service.config.local.cjs + service.config.cjs so
// Vercel AI SDK provider packages (@ai-sdk/anthropic, etc.) and our
// own services see the right values.
import './env';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import * as fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import * as path from 'node:path';
import { AppModule } from './app.module';
import { AgentGatewayService } from './gateway/agent-gateway.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();

  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? '3216');

  attachLiveUpdateEndpoint(app);

  await app.listen(port, host);

  // Attach the agent WebSocket gateway to the underlying HTTP server.
  // Nest gives us the http.Server via getHttpServer(); the gateway
  // mounts a ws.Server at /v1/agent on top of it.
  const httpServer = app.getHttpServer() as HttpServer;
  const gateway = app.get(AgentGatewayService);
  gateway.attach(httpServer);

  Logger.log(
    `Swirlock Agent Runtime listening on http://${host}:${port}`,
    'Bootstrap',
  );
}

/**
 * Capacitor Live Updates endpoint, served at /updates.
 *
 * The Android shell uses @capgo/capacitor-updater. On every app
 * launch the plugin POSTs /updates with the device's current bundle
 * version; we reply with `data/updates/manifest.json` if present.
 * The plugin compares versions and downloads the bundle ZIP from
 * /updates/<filename>.zip if newer.
 *
 * No auth — manifest and bundle are public (same compiled Angular
 * code the SPA serves to anyone).
 */
function attachLiveUpdateEndpoint(app: NestExpressApplication): void {
  const log = new Logger('LiveUpdate');
  const httpApp = app.getHttpAdapter().getInstance() as express.Express;
  const updatesDir = path.resolve(
    process.env.UPDATES_DIR ?? path.join(__dirname, '..', 'data', 'updates'),
  );
  fs.mkdirSync(updatesDir, { recursive: true });

  httpApp.post('/updates', express.json({ limit: '64kb' }), (_req, res) => {
    const manifestPath = path.join(updatesDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      res.set('Cache-Control', 'no-store');
      res.status(200).json({ message: 'no update available' });
      return;
    }
    try {
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      res.set('Cache-Control', 'no-store');
      res.status(200).json(manifest);
    } catch (err) {
      log.warn(
        `manifest read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ message: 'manifest unreadable' });
    }
  });

  httpApp.use(
    '/updates',
    express.static(updatesDir, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.zip')) {
          // Bundle ZIPs are immutable per version — every push lands
          // under a fresh filename, so cache forever at every layer.
          res.setHeader(
            'Cache-Control',
            'public, max-age=31536000, immutable',
          );
        } else {
          res.setHeader('Cache-Control', 'no-store');
        }
      },
    }),
  );

  log.log(`Live-update endpoint mounted at /updates (dir=${updatesDir})`);
}

void bootstrap();
