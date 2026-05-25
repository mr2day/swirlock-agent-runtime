/**
 * Bootstraps machine-specific environment variables before NestJS or
 * any third-party SDK gets a chance to read `process.env`.
 *
 * Loads `service.config.local.cjs` (gitignored) from the project root,
 * then `service.config.cjs` (committed defaults). The file's `env`
 * object is merged into `process.env`; values already set on
 * `process.env` are NOT overwritten (so an inline
 * `ANTHROPIC_API_KEY=... node ...` invocation still wins).
 *
 * Loaded for side effects — `import './env';` at the top of any entry
 * point that needs the env vars (currently: `src/main.ts` and every
 * smoke-test script under `scripts/`).
 */

import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs';

const projectRoot = path.join(__dirname, '..');
const requireLocal = createRequire(__filename);

function loadConfig(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const cfg = requireLocal(filePath) as {
    env?: Record<string, string | number | boolean>;
  };
  if (!cfg || typeof cfg.env !== 'object' || !cfg.env) return;
  for (const [name, value] of Object.entries(cfg.env)) {
    if (process.env[name] === undefined) {
      process.env[name] = String(value);
    }
  }
}

// Local first (so machine-specific overrides win when present), then
// defaults (which fill in anything local didn't set). The
// "undefined-only" rule above means already-set keys aren't clobbered.
loadConfig(path.join(projectRoot, 'service.config.local.cjs'));
loadConfig(path.join(projectRoot, 'service.config.cjs'));
