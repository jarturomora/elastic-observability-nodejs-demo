// Skyward for Business — search + chat API
// Contains no OpenTelemetry code; EDOT is loaded at startup by:
//   node --env-file=.env --import @elastic/opentelemetry-node src/app.js
// (Node reads --env-file BEFORE the --import preload, so OTEL_* from .env reach the SDK.)
import express from 'express';
import pg from 'pg';
import pino from 'pino';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { fetchAllPartners } from './partner-client.js';
import { buildMessages, createLlm, LlmError } from './llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HISTORY_SQL = `SELECT origin, destination, date::text, purpose, searched_at
           FROM search_history WHERE user_id = $1
           ORDER BY searched_at DESC LIMIT 5`;
const MAX_CACHE = 5000;

const parseUserId = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : NaN;
};

export function createApp({
  config = loadConfig(),
  pool,
  llm = createLlm(config.llm),
  fetchImpl = fetch,
  log = pino({ level: process.env.LOG_LEVEL || 'info' }),
} = {}) {
  const { chaos } = config;

  const PARTNER_PORTS = { PuffinAir: 4001, GooseJet: 4002, 'Pelican Air': 4003, 'Penguin Air': 4004 };
  const PARTNERS = Object.entries(PARTNER_PORTS).map(([name, port]) => ({
    name, port, url: `http://${config.partnerHost}:${port}/fares`,
  }));

  // flight_id → { fare, partnerPort }; bounded, oldest evicted first
  const fareCache = new Map();
  // `${user}|${origin}|${destination}` → lowest price seen in that user's last search
  const searchMeta = new Map();
  const remember = (map, key, value) => {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_CACHE) map.delete(map.keys().next().value);
  };

  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, '..', 'public')));

  app.use((req, res, next) => {
    req.id  = 'req_' + crypto.randomBytes(6).toString('hex');
    req.log = log.child({ request_id: req.id });
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/config', (_req, res) => res.json({ showLoadingTimer: config.showLoadingTimer }));

  // Active scenarios, used by verify.js. Never returns secrets.
  app.get('/api/mode', (_req, res) => res.json({
    mode: config.mode,
    chaos,
    llm: { configured: Boolean(config.llm.apiKey || config.llm.baseURL), model: config.llm.model },
  }));

  // ── /api/search ─────────────────────────────────────────────────────────────
  app.get('/api/search', async (req, res, next) => {
    const t0 = Date.now();
    const origin      = String(req.query.origin ?? '').toUpperCase();
    const destination = String(req.query.destination ?? '').toUpperCase();
    const date        = String(req.query.date ?? '');
    const purpose     = req.query.purpose;
    const sort        = req.query.sort || 'fastest';
    const userId      = parseUserId(req.query.user);

    const badDate = !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date));
    if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || badDate || Number.isNaN(userId)) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'origin and destination must be 3-letter codes, date YYYY-MM-DD, user a positive integer',
        request_id: req.id,
      });
    }

    try {
      const [historyResult, trendResult] = await Promise.all([
        pool.query(HISTORY_SQL, [userId]),
        pool.query(
          `SELECT avg_price_cents FROM fare_trends
             WHERE origin = $1 AND destination = $2 AND month = $3`,
          [origin, destination, Number(date.slice(5, 7))]
        ),
      ]);
      const recentSearches = historyResult.rows;
      const trendAvgCents  = trendResult.rows[0]?.avg_price_cents ?? null;

      if (userId) {
        await pool.query(
          `INSERT INTO search_history (user_id, origin, destination, date, purpose)
             VALUES ($1, $2, $3, $4, $5)`,
          [userId, origin, destination, date, purpose || null]
        );
      }

      const qs = `?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&date=${encodeURIComponent(date)}`;

      // CHAOS_STAIRCASE: partners one at a time. Otherwise Promise.allSettled fan-out.
      // Either way each partner call gets its own timeout.
      const { responded, failed } = await fetchAllPartners(PARTNERS, qs, {
        sequential: chaos.staircase,
        fetchImpl,
        timeoutMs: config.partnerTimeoutMs,
      });
      for (const f of failed) {
        req.log.warn({ partner: f.partner.name, err: f.error }, 'partner failed — skipped');
      }

      const allFares = responded.flatMap(({ fares }) => fares);

      // Dedupe by fare id, keeping the cheapest
      const byId = new Map();
      for (const fare of allFares) {
        const existing = byId.get(fare.id);
        if (!existing || fare.priceCents < existing.priceCents) byId.set(fare.id, fare);
      }
      const unique = [...byId.values()];

      const withPolicy = unique.map(f => ({ ...f, in_policy: f.priceCents < 120000 }));

      const sortFn = {
        fastest:  (a, b) => a.durationMins - b.durationMins || a.priceCents - b.priceCents,
        cheapest: (a, b) => a.priceCents - b.priceCents,
        best:     (a, b) => (a.priceCents * a.durationMins) - (b.priceCents * b.durationMins),
      }[sort] || ((a, b) => a.durationMins - b.durationMins);

      withPolicy.sort(sortFn);
      const flights = withPolicy.slice(0, 50);
      const elapsed_ms = Date.now() - t0;

      // Only the flights shown to the user are bookable (and the cache stays small).
      for (const fare of flights) {
        remember(fareCache, fare.id, { fare, partnerPort: PARTNER_PORTS[fare.partner] ?? null });
      }
      const lowestPriceCents = withPolicy.length
        ? withPolicy.reduce((m, f) => Math.min(m, f.priceCents), Infinity) : null;
      remember(searchMeta, `${userId}|${origin}|${destination}`, lowestPriceCents);

      req.log.info({
        user: userId, origin, destination, date, purpose,
        partners_responded: responded.length, sequential: chaos.staircase,
        sort, ms: elapsed_ms,
      }, 'search complete');

      res.json({
        flights,
        partners_responded: responded.length,
        partners_total: PARTNERS.length,
        trend_avg_cents: trendAvgCents,
        recent_searches: recentSearches,
        elapsed_ms,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── /api/insights ───────────────────────────────────────────────────────────
  app.get('/api/insights', async (req, res, next) => {
    const origin = String(req.query.origin ?? '').toUpperCase();
    const destination = String(req.query.destination ?? '').toUpperCase();
    const userId = parseUserId(req.query.user);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: 'invalid_request', message: 'user must be a positive integer', request_id: req.id });
    }
    const t0 = Date.now();
    try {
      const currentMonth = new Date().getMonth() + 1;
      const prevMonth    = currentMonth === 1 ? 12 : currentMonth - 1;

      const [trendResult, historyResult] = await Promise.all([
        pool.query(
          `SELECT month, avg_price_cents FROM fare_trends
             WHERE origin = $1 AND destination = $2 AND month IN ($3, $4)`,
          [origin, destination, currentMonth, prevMonth]
        ),
        pool.query(HISTORY_SQL, [userId]),
      ]);

      const current  = trendResult.rows.find(r => r.month === currentMonth);
      const previous = trendResult.rows.find(r => r.month === prevMonth);
      let pct_change = null;
      if (current && previous && previous.avg_price_cents > 0) {
        pct_change = Math.round(
          (current.avg_price_cents - previous.avg_price_cents) / previous.avg_price_cents * 100
        );
      }

      req.log.info({ origin, destination, user: userId, ms: Date.now() - t0 }, 'insights');
      res.json({
        avg_price_cents: current?.avg_price_cents ?? null,
        pct_change,
        recent_searches: historyResult.rows,
        lowest_price_today: searchMeta.get(`${userId}|${origin}|${destination}`) ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── /api/chat ───────────────────────────────────────────────────────────────
  // retrieve (PostgreSQL: this user's recent searches) → prompt → model.
  app.post('/api/chat', async (req, res) => {
    const body = req.body ?? {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const userId = parseUserId(body.user);
    if (!message || message.length > 500 || userId === null || Number.isNaN(userId)) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'message (1-500 chars) and user (positive integer) are required',
        request_id: req.id,
      });
    }

    // 1) Retrieve context
    let searches;
    try {
      const query = pool.query(HISTORY_SQL, [userId]);
      let history;
      if (chaos.chat) {
        // CHAOS_CHAT — BEFORE build: `await` is deliberately missing, so `history` is a Promise,
        // `history.rows` is undefined and the next line throws a TypeError. The catch below turns
        // that into a friendly HTTP 200 fallback: the user sees a degraded answer, the browser
        // console is clean, and the only evidence is the server-side error log and trace.
        // (The no-op catch only stops the dangling promise from crashing the process if the
        // database itself fails; it does not fix the bug.)
        query.catch(err => req.log.warn({ err }, 'un-awaited history query rejected'));
        history = query;
      } else {
        history = await query;
      }
      searches = history.rows.map(r => ({ ...r })); // legitimately empty for new users
    } catch (err) {
      req.log.error({ err, user: userId, failure: 'history_access', chaos_chat: chaos.chat },
        'chat history lookup failed');
      if (chaos.chat) {
        // Intentional teaching behaviour: HTTP 200 does NOT mean the request succeeded.
        return res.json({
          reply: "Sorry, I couldn't load your recent searches. How can I help?",
          degraded: true,
          error: 'history_unavailable',
          request_id: req.id,
        });
      }
      return res.status(503).json({
        error: 'history_unavailable',
        message: "We couldn't load your recent searches. Please try again.",
        request_id: req.id,
      });
    }

    // 2) Prompt + 3) model call
    try {
      const out = await llm.generate(buildMessages({ message, searches }));
      req.log.info({ user: userId, searches: searches.length, model: out.model }, 'chat reply generated');
      res.json({ reply: out.text, request_id: req.id });
    } catch (err) {
      const code = err instanceof LlmError ? err.code : 'llm_error';
      req.log.error({ err, user: userId, failure: 'llm', code, provider_status: err.providerStatus },
        'chat model call failed');
      const status = code === 'llm_not_configured' ? 503 : code === 'llm_timeout' ? 504 : 502;
      res.status(status).json({
        error: code,
        message: code === 'llm_not_configured'
          ? 'The AI assistant is not configured on this server.'
          : 'The AI assistant is unavailable right now. Please try again.',
        request_id: req.id,
      });
    }
  });

  // ── /api/book ───────────────────────────────────────────────────────────────
  app.post('/api/book', async (req, res) => {
    const { flight_id, user: userId } = req.body ?? {};
    const cached = fareCache.get(flight_id);
    if (!cached || !cached.partnerPort) {
      req.log.warn({ user: userId, flight_id }, 'booking rejected — unknown flight');
      return res.status(404).json({
        error: 'flight_not_found',
        message: 'Search for this flight before booking it.',
        request_id: req.id,
      });
    }

    const unavailable = () => res.status(502).json({
      error: 'partner_unavailable',
      message: 'The airline could not confirm this booking. Please try again.',
      request_id: req.id,
    });

    try {
      // Generous timeout and one retry for the partner confirmation call
      const url = `http://${config.partnerHost}:${cached.partnerPort}/confirm?flight_id=${encodeURIComponent(flight_id)}`;
      let r = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) r = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`partner responded ${r.status}`);
      const confirmation = await r.json();
      req.log.info({ user: userId, flight_id, partner: confirmation.partner }, 'booking confirmed');
      res.json({
        confirmed: true, flight_id, partner: confirmation.partner,
        fare: cached.fare, request_id: req.id,
      });
    } catch (err) {
      req.log.error({ err, user: userId, flight_id }, 'booking failed — partner unavailable');
      unavailable();
    }
  });

  // ── Error handler ───────────────────────────────────────────────────────────
  app.use((err, req, res, _next) => {
    req.log.error({ err, path: req.path }, 'request failed');
    res.status(500).json({ error: 'internal_server_error', request_id: req.id });
  });

  return app;
}

// ── Start (only when run directly, so tests can import createApp) ─────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const log = pino({ level: process.env.LOG_LEVEL || 'info' });
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  pool.on('error', err => log.error({ err }, 'idle postgres client error'));
  createApp({ config, pool, log }).listen(config.port, () => {
    log.info({ port: config.port, chaos: config.chaos, llm_configured: Boolean(config.llm.apiKey || config.llm.baseURL), model: config.llm.model },
      'skyward-search listening');
  });
}
