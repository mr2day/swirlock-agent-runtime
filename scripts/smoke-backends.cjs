#!/usr/bin/env node
'use strict';

const path = require('node:path');
require(path.join(__dirname, '..', 'dist', 'env'));

async function main() {
  require('reflect-metadata');
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require(
    path.join(__dirname, '..', 'dist', 'app.module'),
  );
  const { BackendsService } = require(
    path.join(__dirname, '..', 'dist', 'agent', 'backends'),
  );

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  const backends = app.get(BackendsService);
  const list = await backends.available();
  console.log(JSON.stringify(list, null, 2));
  await app.close();
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
