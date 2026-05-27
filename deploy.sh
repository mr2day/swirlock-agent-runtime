#!/usr/bin/env bash
# Gated deploy for swirlock-agent-runtime.
#
# Builds, runs the eval harness, then reloads PM2. Any failure
# aborts before the change reaches the live process. Eval costs
# roughly $0.10 in API tokens and takes ~40s, but it's the gate
# that catches drift before it goes live — that's the whole point.
#
# Usage:
#   ./deploy.sh
#   npm run deploy
#
# To deploy WITHOUT the eval gate (e.g. fast local iteration where
# you're touching code the existing scenarios don't cover), run
# the steps manually: `npm run build && pm2 startOrReload ...`.
# Don't skip the gate before pushing to origin.

set -euo pipefail

cd "$(dirname "$0")"

echo "[deploy] Typecheck + build..."
npm run build --silent

echo "[deploy] Running eval harness..."
npm run eval --silent

echo "[deploy] Reloading PM2..."
# startOrReload re-reads ecosystem.config.cjs so env-var edits land,
# unlike plain `pm2 restart`, which only re-reads PM2's saved dump.
pm2 startOrReload ecosystem.config.cjs --update-env --silent
pm2 save --silent

echo "[deploy] Done."
echo "[deploy]   live at wss://agent.gigi-the-robot.com/v1/agent"
echo "[deploy]   (also reachable via wss://api.gigi-the-robot.com/v1/agent)"
