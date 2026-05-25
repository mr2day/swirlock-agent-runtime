// `./env` MUST run before AppModule / any SDK is loaded — it populates
// process.env from service.config.local.cjs + service.config.cjs so
// Vercel AI SDK provider packages (@ai-sdk/anthropic, etc.) and our
// own services see the right values.
import './env';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Server as HttpServer } from 'node:http';
import { AppModule } from './app.module';
import { AgentGatewayService } from './gateway/agent-gateway.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();

  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? '3216');

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

void bootstrap();
