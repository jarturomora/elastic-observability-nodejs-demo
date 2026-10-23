#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Postgres + partners + Ollama (same script as `npm run services`)
bash scripts/services.sh

pkill -f src/app.js 2>/dev/null || true
sleep 1

nohup npm run start >/tmp/app.log 2>&1 &
echo $! > /tmp/skyward-app.pid
echo "Skyward starting on :3000 (logs: /tmp/app.log)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " App:      http://localhost:3000"
echo " Logs:     /tmp/app.log"
echo " Verify:   npm run verify"
echo " Stop:     npm run stop:all"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
