#!/usr/bin/env bash
set -uo pipefail

WORKSPACE=/workspaces/node-elastic-demo
cd "$WORKSPACE"

# Wait for Postgres to accept connections, then seed.
# psql is not installed in the app image, so we retry npm run seed instead.
echo "⏳ Waiting for Postgres…"
seeded=false
for i in $(seq 1 30); do
  if npm run seed > /tmp/seed.log 2>&1; then
    seeded=true
    break
  fi
  echo "   attempt $i/30 — retrying in 2 s…"
  sleep 2
done

if [ "$seeded" = false ]; then
  echo "❌ Postgres did not become ready after 60 s. Check /tmp/seed.log" >&2
  exit 1
fi
echo "✅ Database ready"

# Download the chat model in the background (~1 GB, first start only; later starts reuse the volume).
# Chat returns 502 until the pull finishes; check /tmp/ollama-pull.log.
nohup curl -s http://ollama:11434/api/pull -d "{\"model\":\"${OPENAI_MODEL:-qwen2.5:1.5b}\"}" > /tmp/ollama-pull.log 2>&1 &
echo "🧠 Pulling chat model ${OPENAI_MODEL:-qwen2.5:1.5b} in the background (log: /tmp/ollama-pull.log)"

# Kill any previous instances so re-running this script is safe.
pkill -f src/partners.js 2>/dev/null || true
pkill -f src/app.js     2>/dev/null || true
sleep 1

# Start mock partners (PuffinAir :4001, GooseJet :4002, Pelican Air :4003, Penguin Air :4004).
# Reads latency vars from .env; DATABASE_URL from the container environment takes precedence.
nohup node --env-file=.env src/partners.js > /tmp/partners.log 2>&1 &
echo "🤝 Mock partners starting (logs: /tmp/partners.log)"

# Start the app. With Elastic secrets set (OTEL_* from remoteEnv) use `npm start`
# (EDOT via --import); otherwise run without instrumentation.
if [ -n "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ]; then
  export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-skyward-travel-app}"
  nohup npm start > /tmp/app.log 2>&1 &
  echo "✈  Skyward starting on :3000 with Elastic (logs: /tmp/app.log)"
else
  nohup npm run start:plain > /tmp/app.log 2>&1 &
  echo "✈  Skyward starting on :3000 without Elastic (logs: /tmp/app.log)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Skyward is running on port 3000 — no Elastic connected yet."
echo " A browser tab should open automatically."
echo " Search JFK → LHR and watch the timer."
echo ""
echo " To connect to Elastic Cloud, in a terminal:"
echo "   1. export OTEL_EXPORTER_OTLP_ENDPOINT=... OTEL_EXPORTER_OTLP_HEADERS=..."
echo "      export OTEL_SERVICE_NAME=skyward-travel-app"
echo "      (or add them as Codespaces secrets)"
echo "   2. Run: npm run restart"
echo ""
echo " See README → 'Try it in GitHub Codespaces' for full instructions."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
