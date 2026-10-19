#!/usr/bin/env bash
# Starts partners + BEFORE (slow, :3000) + AFTER (fast, :3001) side by side.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bash scripts/dev.sh >/dev/null   # postgres, seed, partners, slow app on :3000

nohup npm run start:fast >/tmp/app-fast.log 2>&1 &
echo $! > /tmp/skyward-app-fast.pid

for port in 3000 3001; do
  for i in $(seq 1 30); do
    curl -sf "localhost:$port/health" >/dev/null && break
    sleep 1
  done
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " BEFORE (slow):  http://localhost:3000"
echo " AFTER  (fast):  http://localhost:3001"
echo " Side by side:   http://localhost:3000/compare.html"
echo " Shortcut:       press S or Ctrl/Cmd+Enter to search"
echo " Stop:           npm run stop:all"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
