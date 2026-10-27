// Search, flags, per-partner timeouts, booking and UI logic: fake pool + fake fetch, no services needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { callPartner, fetchAllPartners } from '../src/partner-client.js';
import { startApp, fakePool, fakeLlm, ROOT } from './helpers/harness.js';
import { requestChat } from '../public/js/chat.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Flags ────────────────────────────────────────────────────────────────────
test('default config = exactly two bugs: staircase + chat', () => {
  const { chaos, mode } = loadConfig({});
  assert.deepEqual(chaos, { staircase: true, chat: true });
  assert.equal(mode, 'before');
});

test('search and chat flags are independent', () => {
  assert.deepEqual(
    pick(loadConfig({ CHAOS_STAIRCASE: 'false' }).chaos), { staircase: false, chat: true });
  assert.deepEqual(
    pick(loadConfig({ CHAOS_CHAT: 'false' }).chaos), { staircase: true, chat: false });
  assert.deepEqual(
    pick(loadConfig({ CHAOS_STAIRCASE: 'false', CHAOS_CHAT: 'false' }).chaos), { staircase: false, chat: false });
  function pick(c) { return { staircase: c.staircase, chat: c.chat }; }
});

test('ENABLE_CHAOS=false forces every bug off, even if flags are set true', () => {
  const c = loadConfig({ ENABLE_CHAOS: 'false', CHAOS_STAIRCASE: 'true', CHAOS_CHAT: 'true' });
  assert.ok(Object.values(c.chaos).every(v => v === false));
  assert.equal(c.mode, 'after');
});

test('model defaults: local Ollama with no settings, OpenAI only when a key is set', () => {
  const local = loadConfig({}).llm;
  assert.equal(local.baseURL, 'http://localhost:11434/v1');
  assert.equal(local.model, 'qwen2.5:1.5b');
  assert.equal(local.apiKey, '');
  const openai = loadConfig({ OPENAI_API_KEY: 'sk-test' }).llm;
  assert.equal(openai.baseURL, undefined);
  assert.equal(openai.model, 'gpt-4o-mini');
  assert.equal(loadConfig({ LOCAL_MODEL: 'qwen2.5:0.5b' }).llm.model, 'qwen2.5:0.5b');
  const custom = loadConfig({ OPENAI_BASE_URL: 'http://x/v1', OPENAI_MODEL: 'm' }).llm;
  assert.deepEqual([custom.baseURL, custom.model], ['http://x/v1', 'm']);
});

// ── Partner client: timeouts and ordering ────────────────────────────────────
const NAMES = ['PuffinAir', 'GooseJet', 'Pelican Air', 'Penguin Air'];
const P = n => ({ name: NAMES[n - 1], url: `http://localhost:${4000 + n}/fares`, port: 4000 + n });
const PARTNERS = [1, 2, 3, 4].map(P);
const faresFor = p => [{ id: `${p.name}_f1`, partner: p.name, priceCents: 50000 + p.port, durationMins: 650, stops: 0 }];

// A fetch that takes `delay(p)` ms and honours the abort signal like real fetch.
function fakeFetch({ delay = () => 20, status = () => 200, log = [] } = {}) {
  return async (url, init = {}) => {
    const p = PARTNERS.find(x => url.startsWith(x.url) || url.startsWith(x.url.replace('/fares', '/confirm')));
    log.push({ partner: p.name, signal: init.signal, start: Date.now() });
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, delay(p));
      init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); });
    });
    return {
      ok: status(p) === 200, status: status(p),
      json: async () => faresFor(p),
    };
  };
}

test('each partner call creates its own timeout signal', async () => {
  const log = [];
  await fetchAllPartners(PARTNERS, '?x', { sequential: true, fetchImpl: fakeFetch({ log }), timeoutMs: 1000 });
  assert.equal(log.length, 4);
  const signals = new Set(log.map(l => l.signal));
  assert.equal(signals.size, 4, 'four distinct AbortSignals');
  assert.ok(log.every(l => l.signal instanceof AbortSignal));
});

test('sequential run: total time exceeds one timeout, yet every partner succeeds (no shared clock)', async () => {
  // Each partner takes 80 ms with a 120 ms timeout. A single shared signal would abort partner 2+.
  const t0 = Date.now();
  const { responded, failed } = await fetchAllPartners(PARTNERS, '?x', {
    sequential: true, fetchImpl: fakeFetch({ delay: () => 80 }), timeoutMs: 120,
  });
  assert.ok(Date.now() - t0 >= 300);
  assert.equal(responded.length, 4);
  assert.equal(failed.length, 0);
});

test('a slow partner times out on its own without affecting the others', async () => {
  const slow4 = fakeFetch({ delay: p => (p.name === 'Penguin Air' ? 500 : 20) });
  for (const sequential of [true, false]) {
    const { responded, failed } = await fetchAllPartners(PARTNERS, '?x', { sequential, fetchImpl: slow4, timeoutMs: 100 });
    assert.deepEqual(responded.map(r => r.partner.name), ['PuffinAir', 'GooseJet', 'Pelican Air']);
    assert.deepEqual(failed.map(f => f.partner.name), ['Penguin Air']);
  }
});

test('non-2xx partner response is reported as failed, not as data', async () => {
  await assert.rejects(callPartner(P(1), '?x', { fetchImpl: fakeFetch({ status: () => 503 }), timeoutMs: 100 }), /503/);
});

test('sequential staircase vs Promise.allSettled: same data, concurrent is faster', async () => {
  const opts = { fetchImpl: fakeFetch({ delay: () => 80 }), timeoutMs: 1000 };
  let t = Date.now();
  const seq = await fetchAllPartners(PARTNERS, '?x', { sequential: true, ...opts });
  const seqMs = Date.now() - t;
  t = Date.now();
  const con = await fetchAllPartners(PARTNERS, '?x', { sequential: false, ...opts });
  const conMs = Date.now() - t;
  const norm = r => r.responded.map(x => [x.partner.name, x.fares]);
  assert.deepEqual(norm(seq), norm(con));
  assert.ok(seqMs >= 300, `sequential ${seqMs}ms`);
  assert.ok(conMs < 200, `concurrent ${conMs}ms`);
});

// ── /api/search through the app ──────────────────────────────────────────────
const searchPool = () => fakePool(async () => ({ rows: [] }));
const QS = '/api/search?origin=LHR&destination=SFO&date=2026-11-05&user=1';

test('search: before and after builds return equivalent flights and 4/4 partners', async () => {
  const run = async env => {
    const app = await startApp({ env, pool: searchPool(), llm: fakeLlm(), fetchImpl: fakeFetch({ delay: () => 60 }) });
    try {
      const r = await app.get(QS);
      assert.equal(r.status, 200);
      return await r.json();
    } finally { await app.close(); }
  };
  const before = await run({ CHAOS_STAIRCASE: 'true' });
  const after = await run({ CHAOS_STAIRCASE: 'false' });
  assert.equal(before.partners_responded, 4);
  assert.equal(after.partners_responded, 4);
  assert.deepEqual(before.flights, after.flights);
  assert.ok(before.elapsed_ms >= 230, `before ${before.elapsed_ms}`);
  assert.ok(after.elapsed_ms < before.elapsed_ms);
});

test('every partner call gets a timeout signal, in both builds', async () => {
  for (const CHAOS_STAIRCASE of ['true', 'false']) {
    const log = [];
    const app = await startApp({ env: { CHAOS_STAIRCASE }, pool: searchPool(), llm: fakeLlm(), fetchImpl: fakeFetch({ log }) });
    try {
      await app.get(QS);
      assert.equal(log.length, 4);
      assert.ok(log.every(l => l.signal instanceof AbortSignal));
    } finally { await app.close(); }
  }
});

test('search rejects invalid input with 400 and does not hit the database', async () => {
  const pool = searchPool();
  const app = await startApp({ pool, llm: fakeLlm(), fetchImpl: fakeFetch() });
  try {
    for (const q of ['', '?origin=LHR&destination=SFO', '?origin=LHR&destination=SFO&date=nope',
                     '?origin=LHRX&destination=SFO&date=2026-11-05', '?origin=LHR&destination=SFO&date=2026-11-05&user=x']) {
      assert.equal((await app.get('/api/search' + q)).status, 400, q);
    }
    assert.equal(pool.calls.length, 0);
  } finally { await app.close(); }
});

// ── Booking is never broken by the search/chat bugs ──────────────────────────
test('booking works with both teaching bugs on', async () => {
  const confirmFetch = async (url) => url.includes('/confirm')
    ? { ok: true, status: 200, json: async () => ({ confirmed: true, partner: 'PuffinAir' }) }
    : fakeFetch()(url);
  const app = await startApp({ env: { CHAOS_STAIRCASE: 'true', CHAOS_CHAT: 'true' }, pool: searchPool(), llm: fakeLlm(), fetchImpl: confirmFetch });
  try {
    const s = await (await app.get(QS)).json();
    const res = await app.post('/api/book', { flight_id: s.flights[0].id, user: 1 });
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.confirmed, true);
    assert.ok(b.request_id.startsWith('req_'));
  } finally { await app.close(); }
});

test('booking still works at realistic volume (3000 fares per partner)', async () => {
  const bigFetch = async (url) => {
    if (url.includes('/confirm')) return { ok: true, status: 200, json: async () => ({ confirmed: true, partner: 'PuffinAir' }) };
    const p = PARTNERS.find(x => url.startsWith(x.url));
    const fares = Array.from({ length: 3000 }, (_, i) => ({
      id: `${p.name}_${i}`, partner: p.name, priceCents: 50000 + i, durationMins: 600 + i, stops: 0,
    }));
    return { ok: true, status: 200, json: async () => fares };
  };
  const app = await startApp({ env: { CHAOS_STAIRCASE: 'false' }, pool: searchPool(), llm: fakeLlm(), fetchImpl: bigFetch });
  try {
    const s = await (await app.get(QS)).json();
    assert.equal(s.flights.length, 50);
    const res = await app.post('/api/book', { flight_id: s.flights[0].id, user: 1 });
    assert.equal(res.status, 200, 'the top result must be bookable');
  } finally { await app.close(); }
});

test('booking an unknown flight is a 404', async () => {
  const app = await startApp({ pool: searchPool(), llm: fakeLlm(), fetchImpl: fakeFetch() });
  try { assert.equal((await app.post('/api/book', { flight_id: 'nope', user: 1 })).status, 404); }
  finally { await app.close(); }
});

// ── UI ───────────────────────────────────────────────────────────────────────
test('index.html has no inline script and loads the module entry point', async () => {
  const html = await readFile(`${ROOT}public/index.html`, 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0][1], /type="module"/);
  assert.match(scripts[0][1], /src="\/js\/main\.js"/);
  assert.equal(scripts[0][2].trim(), '');
  const cmp = await readFile(`${ROOT}public/compare.html`, 'utf8');
  assert.ok([...cmp.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].every(m => m[1].trim() === ''));
});

test('static UI modules are served and the app serves index.html', async () => {
  const app = await startApp({ pool: searchPool(), llm: fakeLlm() });
  try {
    for (const p of ['/', '/js/main.js', '/js/chat.js', '/js/search.js', '/js/booking.js', '/js/util.js', '/compare.html', '/compare.js']) {
      assert.equal((await app.get(p)).status, 200, p);
    }
    assert.match((await app.get('/js/main.js')).headers.get('content-type'), /javascript/);
  } finally { await app.close(); }
});

test('compare page shortcuts: Space searches both panes, 1 / 2 open the left / right chat', async () => {
  const cmp = await readFile(`${ROOT}public/compare.js`, 'utf8');
  assert.match(cmp, /Space/);
  assert.match(cmp, /Digit1:\s*'before'/);
  assert.match(cmp, /Digit2:\s*'after'/);
  const chat = await readFile(`${ROOT}public/js/chat.js`, 'utf8');
  assert.match(chat, /skyward-open-chat/);
});

test('compare page is just the two panes: no label bar', async () => {
  const html = await readFile(`${ROOT}public/compare.html`, 'utf8');
  assert.match(html, /id="before"/);
  assert.match(html, /id="after"/);
  assert.ok(!/class="label"|label-before|label-after/.test(html));
});

test('chat UI has no artificial delay', async () => {
  const src = await readFile(`${ROOT}public/js/chat.js`, 'utf8');
  assert.ok(!/setTimeout/.test(src));
  assert.match(src, /finally\s*{\s*typing\.remove\(\)/);
});

test('requestChat: ok / degraded / error states, request IDs, never throws', async () => {
  const resp = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
  assert.deepEqual(await requestChat(resp(200, { reply: 'hi', request_id: 'req_1' }), 'q', 1),
    { kind: 'ok', text: 'hi', requestId: 'req_1' });
  assert.deepEqual(await requestChat(resp(200, { reply: 'Sorry', degraded: true, request_id: 'req_2' }), 'q', 1),
    { kind: 'degraded', text: 'Sorry', requestId: 'req_2' });
  const e = await requestChat(resp(503, { error: 'llm_not_configured', message: 'not configured', request_id: 'req_3' }), 'q', 1);
  assert.deepEqual(e, { kind: 'error', text: 'not configured', requestId: 'req_3' });
  const bad = await requestChat(async () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }), 'q', 1);
  assert.equal(bad.kind, 'error');
  const net = await requestChat(async () => { throw new Error('offline'); }, 'q', 1);
  assert.equal(net.kind, 'error');
  assert.match(net.text, /Could not reach/);
});
