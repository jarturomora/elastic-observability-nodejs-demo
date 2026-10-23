#!/usr/bin/env bash
cd "$(dirname "$0")/.."
pkill -f src/app.js 2>/dev/null && echo "Stopped app." || echo "App was not running."
# Containers are removed; the downloaded model (docker volume) is kept. `docker compose down -v` deletes it.
if docker compose down >/dev/null 2>&1; then
  echo "Stopped Postgres, partners and Ollama containers."
else
  echo "Could not stop containers (is Docker running?)."
fi
