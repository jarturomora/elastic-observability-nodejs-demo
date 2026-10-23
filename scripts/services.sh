#!/usr/bin/env bash
# Starts everything the app depends on, in Docker Compose: PostgreSQL (seeded), the four partner
# mocks and the Ollama chat model. Does NOT start the app (npm start does).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/get-docker/" >&2; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example (add your Elastic OTEL_* settings to it)."
fi

# Older versions of this repo ran Postgres as a plain `docker run` container on :5432.
if docker ps -q --filter name='^skyward-db$' | grep -q .; then
  echo "Stopping the legacy skyward-db container (Postgres now runs under docker compose)."
  docker stop skyward-db >/dev/null
fi

echo "Starting PostgreSQL, partner mocks and Ollama..."
docker compose up -d --build --wait db partners ollama

echo "Seeding the database..."
docker compose run --rm --no-deps seed

echo "Making sure the chat model is downloaded (first run is ~1 GB, later runs are instant)..."
docker compose run --rm --no-deps ollama-pull

echo ""
echo "Services ready: Postgres :5432, partners :4001-4004, Ollama :11434."
echo "Start the app with: npm start"
