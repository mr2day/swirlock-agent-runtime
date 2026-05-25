/**
 * PM2 process definition for swirlock-agent-runtime.
 *
 * Run:
 *   pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save
 *
 * Service env is loaded by `src/env.ts` at process start, NOT by PM2,
 * so any keys in `service.config.local.cjs` (PG_PASSWORD,
 * ANTHROPIC_API_KEY, etc.) are picked up automatically without
 * needing to be repeated here.
 */

'use strict';

module.exports = {
  apps: [
    {
      name: 'swirlock-agent-runtime',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      // Defaults to ~/.pm2/logs/swirlock-agent-runtime-{out,error}.log
      merge_logs: true,
      time: true,
    },
  ],
};
