# AGENTS.md

Skyward for Business is a demo Node.js app that is **BROKEN ON PURPOSE**. It contains four intentional bugs:

1. **CHAOS_STAIRCASE** — sequential partner `await`s in `src/app.js` (the dominant cause of slow search: 4 × 1.3 s)
2. **CHAOS_GAP** — O(n²) dedupe blocks the event loop in `src/app.js`
3. **CHAOS_PARTNER** — no outbound timeout on Penguin Air in `src/app.js`
4. **Missing `await`** — `pool.query()` in `/api/chat` is not awaited → TypeError, caught and logged; the user gets a 200 fallback

Do not fix these bugs unless the user explicitly asks you to. When asked, fix the cause, not the symptom: add the missing `await` in `/api/chat` (do not add a guard around `history.rows`); replace the sequential loop in `/api/search` with `Promise.allSettled` plus a per-partner timeout. The CHAOS flags already have correct implementations behind the `false` path.

The chat bug is gated by `MODE` (`before` when any CHAOS flag is on), so the fixed build (`ENABLE_CHAOS=false`) can run side by side on :3001.

## Run

    cp -n .env.example .env
    npm install
    npm run services     # postgres (docker), seed, partners; does NOT start the app
    npm start            # the app: node --import @elastic/opentelemetry-node src/app.js
    npm run dev          # services + app in one go
    npm run verify       # checks /health, /api/search, /api/insights, /api/chat, /api/book; exits 0 on success
    npm run stop:all

## Ports

    3000  app (all chaos on)
    3001  app-fixed (ENABLE_CHAOS=false)
    4001  PuffinAir (PF)
    4002  GooseJet (GJ)
    4003  Pelican Air (PA)
    4004  Penguin Air (PN) — flaky when PENGUIN_DEGRADED=true
    5432  postgres

## API endpoints

    GET  /health                                              — liveness check
    GET  /api/search?origin&destination&date&user&sort&purpose — fan-out to 4 partners, dedupe, return top 50
    GET  /api/insights?origin&destination&user               — avg price + pct change vs prev month + recent searches
    POST /api/chat     { message, user }                     — keyword-based canned reply; on error returns 200 with a degraded fallback (the missing-await TypeError is logged server-side, not returned)
    POST /api/book     { flight_id, user }                   — confirm with partner; 502 when CHAOS_PARTNER=true

    Each partner also exposes:
    GET /confirm?flight_id=<id>  — confirmation endpoint called by /api/book

## Chaos flags

| Flag | `true` (default) | `false` |
|---|---|---|
| `CHAOS_STAIRCASE` | Partners called one at a time (staircase in traces) | `Promise.allSettled` fan-out |
| `CHAOS_GAP` | O(n²) dedupe blocks event loop ~700 ms | `Map`-based O(n) dedupe |
| `CHAOS_PARTNER` | No outbound timeout; Penguin's 5.2 s latency (when `PENGUIN_DEGRADED=true`) flows through | `AbortSignal.timeout(1500)`, held-fare fallback |
| `ENABLE_CHAOS` | — | Forces all three flags to `false` |
| `PENGUIN_DEGRADED` | Penguin Air adds 5.2 s + 15% 503 (opt-in; needed for the booking bug) | Penguin behaves normally (default) |

## Elastic

Export these in the shell before `npm start` (never in `.env`; the SDK reads them at `--import` time, before the app loads `.env`):

    export OTEL_EXPORTER_OTLP_ENDPOINT="https://<project>.ingest.<region>.elastic.cloud:443"
    export OTEL_EXPORTER_OTLP_HEADERS="Authorization=ApiKey <key>"
    export OTEL_SERVICE_NAME="skyward-travel-app"

Then `npm run restart:elastic`. Never commit `.env`.

## Repo

https://github.com/suyashcjoshi/elastic-observability-nodejs-demo

## Deploy

    docker compose up -d      # db, partners, app, app-fixed

## Conventions

- ESM only (`"type": "module"` in package.json). No CommonJS `require()` in `src/`.
- No OpenTelemetry code in `src/` — EDOT is loaded via `--import @elastic/opentelemetry-node`.
- Node >= 20.12 (required for `--import` and `process.loadEnvFile`; the app loads `.env` itself).
- Run `npm run verify` after any change to confirm the golden path still works.
- Run `npm test` to run the smoke test suite.
- Every response carries `X-Request-Id: req_<12hex>` — generated per-request by request ID middleware.
