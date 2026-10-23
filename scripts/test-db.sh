#!/usr/bin/env bash
# `npm test` pre-step: make sure a seeded Postgres is running on :5432 (via docker compose).
# Skipped in CI, where Postgres is provided and seeded by the workflow.
set -euo pipefail
[ -n "${CI:-}" ] && exit 0
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
docker compose up -d --wait db >/dev/null
docker compose run --rm --no-deps seed >/dev/null
echo "Postgres ready for tests."
