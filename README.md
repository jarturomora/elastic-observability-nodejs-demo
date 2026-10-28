# Skyward Travel App — Node.js observability tutorial with Elastic

[![Open in GitHub Codespaces](https://img.shields.io/badge/Open_in-GitHub_Codespaces-181717?style=for-the-badge&logo=github&logoColor=white)](https://codespaces.new/suyashcjoshi/elastic-observability-nodejs-demo?quickstart=1)
[![Observed with Elastic EDOT](https://img.shields.io/badge/Observed_with-Elastic_EDOT-00BFB3?style=for-the-badge&logo=elastic&logoColor=white)](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node)
[![Node 20.12+](https://img.shields.io/badge/node-%E2%89%A5_20.12-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge)](LICENSE)

A Node.js flight-search app with a chatbot. It has **two bugs on purpose**. Use Elastic Observability to find each one, fix it, and see the difference.

The app code has no OpenTelemetry code. One start flag, `--import @elastic/opentelemetry-node` (EDOT Node.js), sends traces, metrics and logs to Elastic.

> **This is a demo. Nothing is real.**
> - The four airlines (PuffinAir, GooseJet, Pelican Air, Penguin Air) are fake mock servers in [`src/partners.js`](src/partners.js). Fares are made up.
> - Bookings are fake. No ticket, no payment.
> - "Northwind Consulting" and its travel policy are made up. Don't trust the chatbot's answers.
> - The Hotels and Cars tabs do nothing.
> - Using an AI coding tool? Point it at [AGENTS.md](AGENTS.md).

## How it works

![Architecture](architecture.png)

- The browser calls the Node.js app.
- The app asks the four mock airlines for fares (1.3 s each).
- The app reads the user's recent searches from PostgreSQL. The chatbot uses them as context.
- The app sends the question to a small local model (Ollama), or to OpenAI if you set a key.
- EDOT sends telemetry to Elastic.

## The two bugs

| What you see | Cause | Fix |
|---|---|---|
| Search takes about 5.3 s | `CHAOS_STAIRCASE`: the four airlines are called one after another | `CHAOS_STAIRCASE=false` (calls them together, about 1.3 s) |
| Chat says "Sorry, I couldn't load your recent searches" | `CHAOS_CHAT`: a missing `await` on `pool.query()`, so a `TypeError` is thrown before the model is called | `CHAOS_CHAT=false` (adds the `await`) |

**HTTP 200 does not mean it worked.** The broken chat returns `200` with `degraded: true`. Only the server logs and traces show the error.

The two flags are independent. `ENABLE_CHAOS=false` turns both off.

## Setup

You need an Elastic Cloud project ([free trial](https://cloud.elastic.co/registration), choose **Serverless → Observability**), **Docker**, and Node.js 20.12+.

1. **Install**
   ```bash
   git clone https://github.com/suyashcjoshi/elastic-observability-nodejs-demo
   cd elastic-observability-nodejs-demo
   npm install
   ```
2. **Configure.** Run `cp .env.example .env`. Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` (`Authorization=ApiKey <key>`). You find them in Elastic under **Add data → Application → OpenTelemetry**. Nothing else is needed.
3. **Start the services** (PostgreSQL, the mock airlines, Ollama):
   ```bash
   npm run services
   ```
   The first run downloads the chat model (about 1 GB).
4. **Start the app**
   ```bash
   npm start
   ```
   Open http://localhost:3000. (`npm run dev` does steps 3 and 4 together.)
5. **Make some traffic.** Search for flights, ask the chat "Is a fare of $1,100 in policy?", and book a flight. Or run `npm run verify` or `npm run load`.
6. **Look in Elastic.** After about a minute, find `skyward-travel-app` under **Observability → Applications → Service inventory**.

Stop everything with `npm run stop:all`.

**No Node.js?** Run `docker compose up -d --build` instead. It starts everything, with the buggy app on :3000 and the fixed app on :3001. Put your settings in `.env` first.

**Smaller model:** set `LOCAL_MODEL=qwen2.5:0.5b` in `.env` (400 MB, less accurate).

## Scenarios

Shell variables override `.env`.

| Scenario | Command |
|---|---|
| Both bugs (default) | `npm start` |
| Search fixed | `CHAOS_STAIRCASE=false npm start` |
| Chat fixed | `CHAOS_CHAT=false npm start` |
| Both fixed | `ENABLE_CHAOS=false npm start` |

To compare side by side, run `npm run dev:compare` and open http://localhost:3000/compare.html. The buggy app runs on :3000 and the fixed app on :3001.

## Add EDOT to your own app

```bash
npm install --save @elastic/opentelemetry-node
node --import @elastic/opentelemetry-node src/app.js
```

No code changes needed. EDOT reads the `OTEL_*` settings from the environment. The app does not read `.env` itself, so load it first:

```bash
set -a; source .env; set +a
```

Or let Node load it: `node --env-file=.env --import @elastic/opentelemetry-node src/app.js` (this is what `npm start` runs). Quote the `OTEL_EXPORTER_OTLP_HEADERS` value in `.env`, because it has a space.

To see the app without telemetry, run `npm run start:plain`.

## See the chatbot's model call in Elastic

1. Open a `POST /api/chat` trace from a run with `CHAOS_CHAT=false`.
2. You will see a database span and a span named `chat <model>`. This is the model call.
3. The broken chat has **no model span**. It fails before the model is called. That missing span is the symptom.

Prompt and response text is off by default. To turn it on, set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` in `.env`. Use it only with demo data.

## Tests

```bash
npm test               # needs Docker; ports 4001-4004 must be free
npm run test:live-llm  # optional: one call to your real model
```

## Commands

| Command | What it does |
|---|---|
| `npm run services` | Start PostgreSQL, the mock airlines and Ollama (not the app) |
| `npm start` | Start the app on :3000 |
| `npm run dev` | Services + app |
| `npm run dev:compare` | Services + buggy and fixed apps side by side |
| `npm run verify` | Check the app's endpoints |
| `npm test` | Run the tests |
| `npm run stop:all` | Stop the app and the containers |

## Good to know

- Small models make mistakes. Expect an occasional wrong detail.
- Only the Node.js app is instrumented. The browser, partners, Postgres and Ollama are not.
- This is a demo, not a production pattern: no login, and the demo user is a random number.

## Learn more

- [EDOT Node.js setup](https://www.elastic.co/docs/reference/opentelemetry/edot-sdks/node/setup)
- [Quickstart: monitor application performance](https://www.elastic.co/docs/solutions/observability/get-started/quickstart-monitor-your-application-performance)
- No cloud account? Run Elastic locally: `curl -fsSL https://elastic.co/start-local | sh -s -- --edot`

## License

Apache-2.0. See [LICENSE](LICENSE).
