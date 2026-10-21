#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Postgres + seed + partners (same script as `npm run services`)
bash scripts/services.sh

pkill -f src/app.js 2>/dev/null || true
sleep 1

nohup npm run start >/tmp/app.log 2>&1 &
echo $! > /tmp/skyward-app.pid
echo "Skyward starting on :3000 (logs: /tmp/app.log)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " App:      http://localhost:3000"
echo " Partners: http://localhost:4001 .. :4004"
echo " Logs:     /tmp/app.log  /tmp/partners.log"
echo " Stop:     npm run stop:all"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
