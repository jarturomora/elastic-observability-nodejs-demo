# AGENTS.md

Skyward for Business is a Node.js observability tutorial: a flight-search app plus an LLM-backed chatbot that is **BROKEN ON PURPOSE**. It has exactly two intentional bugs, controlled independently (both on by default):

1. **CHAOS_STAIRCASE** — `/api/search` calls the four partners one at a time (`src/partner-client.js`, `sequential: true`; 4 × 1.3 s)
2. **CHAOS_CHAT** — `/api/chat` does not `await` `pool.query()` (`src/app.js`). `history.rows` is `undefined`, a `TypeError` is thrown **before the model call**, and the user gets HTTP 200 with `degraded: true`. This is a missing-`await` bug, not an empty-result bug.

Do not fix these unless the user explicitly asks. When asked, fix the cause, not the symptom: add the `await` (never optional-chain the Promise or default `rows` to `[]`), and use `Promise.allSettled` for search (already behind `CHAOS_STAIRCASE=false`). Do not remove the before/after mechanism or fix both bugs globally.

`ENABLE_CHAOS=false` forces both off. Flags live in `src/config.js` (`loadConfig`); changing the search flag must never change chat, and the reverse. Do not add more flags, random partner failures or degraded-partner modes; booking and the partners behave normally.

## Run

Recommended (Path A): Docker Compose for dependencies, the app on the host.

    cp .env.example .env           # set OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS; nothing else is required
    npm install
    npm run services               # compose: postgres (seeded), partners :4001-4004, ollama + model pull. Does NOT start the app
    npm start                      # node --env-file=.env --import @elastic/opentelemetry-node src/app.js
    npm run dev                    # services + app in the background
    npm run dev:compare            # + all-fixed app on :3001, /compare.html
    npm run verify                 # checks the running app against its active scenarios
    npm test                       # starts+seeds postgres itself (pretest); partner ports 4001-4004 must be free; mocked model
    npm run test:live-llm          # optional call to the real configured model (local Ollama by default)
    npm run stop:all               # stops the app, `docker compose down` (model volume kept)

Path B: everything in containers (no Node needed):

    docker compose up -d --build   # db, seed, partners, ollama (+ model pull), app :3000, app-fixed :3001

Scenarios (shell variables override `.env`):

    npm start                              # before
    CHAOS_STAIRCASE=false npm start        # search-only fixed
    CHAOS_CHAT=false npm start             # chat-only fixed
    ENABLE_CHAOS=false npm start           # all fixed

## Environment loading order

EDOT reads `OTEL_*` at `--import` time. Node loads `--env-file` before preloads, so `.env` (including `OTEL_*`) reaches the SDK; shell-exported values win over `.env`. The app does **not** load `.env` itself. Docker Compose uses `env_file: [.env]` (container env is set before `node` starts); partners get only explicit non-secret variables. Never commit `.env`.

## Architecture

    Browser → src/app.js (Express) → partners :4001-4004 (src/partners.js, mocks)
                                   → PostgreSQL :5432 (recent searches = retrieved user context)
                                   → LLM (OpenAI-compatible Chat Completions: local Ollama by default, or OpenAI; src/llm.js; compose runs an `ollama` container)
                                   → Elastic (OTLP, via EDOT)

- `src/app.js` exports `createApp({ config, pool, llm, fetchImpl, log })`; it only listens when run directly.
- `src/llm.js` — prompt construction (`buildMessages`, `POLICY_FACTS`) and the model client (`createLlm`). Tests mock the `{ generate(messages) }` boundary.
- `src/partner-client.js` — each partner call creates its **own** `AbortSignal.timeout`; never share one signal across calls.
- `public/js/*.js` — UI as ES modules (no inline scripts); `public/js/chat.js` exports `requestChat`.
- The app's LLM is not Elastic's investigation agent. Don't conflate them in docs.

## Chat model

With no settings the app uses a small local model, `qwen2.5:1.5b` (~1 GB), via Ollama's OpenAI-compatible API at `http://localhost:11434/v1` (no key); `src/config.js` holds these defaults. `npm run services` runs the Ollama container with that port published. Compose apps and the devcontainer point at `http://ollama:11434/v1` (container env overrides `.env`). `LOCAL_MODEL` picks the local model for both the app and the download (`qwen2.5:0.5b` is ~400 MB but gets facts wrong more often). Setting `OPENAI_API_KEY` (without `OPENAI_BASE_URL`) switches to OpenAI (`OPENAI_MODEL`, default `gpt-4o-mini`), natively only. If the model server is unreachable, chat returns `502 llm_error`. Small models hallucinate details: keep the prompt grounded (`src/llm.js`) and never present a failure as a model answer.

## Ports

    3000  app (default scenario)     3001  app-fixed (ENABLE_CHAOS=false)
    3002  start:search-fixed         3003  start:chat-fixed
    4001  PuffinAir  4002  GooseJet  4003  Pelican Air  4004  Penguin Air
    5432  postgres               11434  ollama (published by compose)

## API

    GET  /health
    GET  /api/mode                                     — active chaos flags + llm.configured (no secrets)
    GET  /api/search?origin&destination&date&user&sort&purpose — validated; 400 on bad input
    GET  /api/insights?origin&destination&user
    POST /api/chat     { message, user }               — 200 {reply, request_id}
                                                         200 {reply, degraded:true, error:"history_unavailable", request_id}  (CHAOS_CHAT only)
                                                         503 history_unavailable | 504 llm_timeout | 502 llm_error (also model unreachable) | 503 llm_not_configured (only if a custom config has no key and no base URL)
                                                         400 invalid_request. Failure bodies never contain `reply` unless degraded fallback.
    POST /api/book     { flight_id, user }             — 200 confirmed; 502 only if the partner really fails

Every response carries `X-Request-Id: req_<12hex>`.

## Defaults (code and .env.example agree)

`PARTNER_LATENCY_MS=1300` (every partner, fixed), `PARTNER_TIMEOUT_MS=4000`, `CHAOS_STAIRCASE=true`, `CHAOS_CHAT=true`. Partners never fail randomly.

## GenAI telemetry

The `openai` client (pinned `^6`; the bundled `@opentelemetry/instrumentation-openai` supports `>=4.19.0 <7`) is auto-instrumented by EDOT; do not add manual spans. The broken chat path has no model span. Prompt/response capture is opt-in via `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` and must only ever contain synthetic demo data. Never claim telemetry was verified in Elastic unless it was actually seen there.

## Conventions

- ESM only. No CommonJS `require()` in `src/`. No OpenTelemetry code in `src/`.
- Node >= 20.12 (`--env-file`, `--import`).
- Credentials are server-side env vars only. Never log or return `OPENAI_API_KEY`. A local model via `OPENAI_BASE_URL` needs no key.
- No embeddings, vector search, LangChain or stored chat history; the retrieved context is the user's recent searches.
- After any change run `npm test` and `npm run verify`. When you change setup, update README, AGENTS.md, `.env.example`, `docker-compose.yml`, `.devcontainer/` and the scripts together.

## Repo

https://github.com/suyashcjoshi/elastic-observability-nodejs-demo

## Deploy

    docker compose up -d --build      # db, seed, partners, ollama (+ one-time model pull), app (:3000), app-fixed (:3001)

Compose publishes db :5432, partners :4001-4004 and ollama :11434 so the host-run app (Path A) can use them.

`.devcontainer/` (Codespaces) has its own compose file with `db` and `ollama`; `start.sh` seeds, pulls the model in the background and starts partners and the app. Keep it in step with the root `docker-compose.yml` when changing env or services.
