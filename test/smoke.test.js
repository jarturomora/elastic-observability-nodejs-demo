// Integration test: real PostgreSQL + the real partner mock servers + real app processes.
// The model is a local fake OpenAI-compatible server (the real openai client talks to it over HTTP),
// so CI never makes a paid call. Needs Postgres seeded (`npm run seed`) and ports 4001-4004 free.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { freePort, waitForPort, spawnNode } from './helpers/harness.js';
import { startFakeOpenAI } from './helpers/fake-openai.js';

const DB_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/skyward';
const LATENCY = 150;
const REPLY = 'FAKE PROVIDER ANSWER';

const nextThursday = (() => {
  const d = new Date();
  const gap = (4 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + gap);
  return d.toISOString().slice(0, 10);
})();
const SEARCH = (user) => `/api/search?origin=LHR&destination=SFO&date=${nextThursday}&user=${user}&sort=fastest`;

let pool, partners, fake, failingFake;
const apps = {};   // name → { proc, base }
const procs = [];

async function startAppProc(name, env) {
  const port = await freePort();
  const proc = spawnNode(['src/app.js'], { DATABASE_URL: DB_URL, PORT: String(port), ...env });
  procs.push(proc);
  await waitForPort(port);
  apps[name] = { proc, base: `http://127.0.0.1:${port}` };
}
const post = (app, path, body) => fetch(apps[app].base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

before(async () => {
  for (const port of [4001, 4002, 4003, 4004]) {
    const busy = await waitForPort(port, 300).then(() => true, () => false);
    assert.ok(!busy, `port ${port} is in use (npm run services?). This test starts its own fast partners: run \`docker compose stop partners\` first.`);
  }
  pool = new pg.Pool({ connectionString: DB_URL });
  const partnerEnv = { FARES_PER_PARTNER: '200', PARTNER_LATENCY_MS: String(LATENCY) };
  partners = spawnNode(['src/partners.js'], partnerEnv);
  procs.push(partners);
  fake = await startFakeOpenAI({ reply: REPLY });
  failingFake = await startFakeOpenAI({ status: 500 });
  await Promise.all([4001, 4002, 4003, 4004].map(p => waitForPort(p)));

  const llm = { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: fake.url, OPENAI_MODEL: 'test-model' };
  // "before" = defaults (flags unset): sequential search + chat missing await
  delete process.env.ENABLE_CHAOS; delete process.env.CHAOS_STAIRCASE; delete process.env.CHAOS_CHAT;
  await Promise.all([
    startAppProc('before', { ...llm }),
    startAppProc('after', { ...llm, ENABLE_CHAOS: 'false' }),
    startAppProc('chatFixedOnly', { ...llm, CHAOS_CHAT: 'false' }),
    startAppProc('searchFixedOnly', { ...llm, CHAOS_STAIRCASE: 'false' }),
    startAppProc('providerDown', { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: failingFake.url, ENABLE_CHAOS: 'false' }),
    startAppProc('modelDown', { ENABLE_CHAOS: 'false', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' }),
  ]);
});

after(async () => {
  procs.forEach(p => p.kill());
  await Promise.all([fake?.close(), failingFake?.close(), pool?.end()]);
});

test('/api/mode reports the active scenarios per build', async () => {
  const mode = async n => (await fetch(apps[n].base + '/api/mode')).json();
  assert.deepEqual((await mode('before')).chaos, { staircase: true, chat: true });
  assert.ok(Object.values((await mode('after')).chaos).every(v => v === false));
  const c = (await mode('chatFixedOnly')).chaos;
  assert.equal(c.chat, false); assert.equal(c.staircase, true);
  const s = (await mode('searchFixedOnly')).chaos;
  assert.equal(s.chat, true); assert.equal(s.staircase, false);
});

test('GET /health returns ok with X-Request-Id', async () => {
  const res = await fetch(apps.after.base + '/health');
  assert.equal((await res.json()).ok, true);
  assert.ok(res.headers.get('x-request-id')?.startsWith('req_'));
});

test('partners never fail: every search gets 4/4 successful partner responses', async () => {
  for (let i = 0; i < 5; i++) {
    const b = await (await fetch(apps.after.base + SEARCH(1))).json();
    assert.equal(b.partners_responded, 4, `search ${i}`);
    assert.equal(b.partners_total, 4);
  }
});

test('before (sequential) and after (Promise.allSettled) return the same flights; before is slower', async () => {
  const before = await (await fetch(apps.before.base + SEARCH(2))).json();
  const after = await (await fetch(apps.after.base + SEARCH(2))).json();
  assert.equal(before.partners_responded, 4);
  assert.equal(after.partners_responded, 4);
  assert.deepEqual(before.flights, after.flights);
  assert.ok(before.flights.length >= 10);
  assert.ok(before.elapsed_ms >= LATENCY * 4 * 0.9, `before ${before.elapsed_ms}ms should be ~4x ${LATENCY}ms`);
  assert.ok(after.elapsed_ms < before.elapsed_ms, `after ${after.elapsed_ms} < before ${before.elapsed_ms}`);
  const realistic = after.flights.filter(f => f.durationMins >= 600 && f.durationMins <= 1100 && f.priceCents <= 120000);
  assert.ok(realistic.length >= 10 && realistic.some(f => f.stops === 0));
});

test('GET /api/insights returns avg_price_cents and recent_searches', async () => {
  const res = await fetch(apps.after.base + '/api/insights?origin=LHR&destination=SFO&user=1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok('avg_price_cents' in body);
  assert.ok(Array.isArray(body.recent_searches));
});

test('chat BEFORE: missing await → 200 degraded, TypeError logged with the request id, model never called', async () => {
  const seen = fake.requests.length;
  const res = await post('before', '/api/chat', { message: 'Is the direct flight available?', user: 1 });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.degraded, true);
  assert.equal(b.error, 'history_unavailable');
  assert.equal(b.reply.includes(REPLY), false);
  assert.equal(fake.requests.length, seen, 'no model request was made');
  await new Promise(r => setTimeout(r, 100));
  const line = apps.before.proc.output.split('\n').find(l => l.includes(b.request_id) && l.includes('TypeError'));
  assert.ok(line, 'expected a TypeError log line carrying the response request_id');
});

test('chat with the await fixed: empty history (new user) works and the model gets that context', async () => {
  const { rows } = await pool.query(
    `INSERT INTO users (name, email) VALUES ('Test New', $1) RETURNING id`, [`new-${Date.now()}@test.example`]);
  const uid = rows[0].id;
  const seen = fake.requests.length;
  for (const app of ['after', 'chatFixedOnly']) {
    const res = await post(app, '/api/chat', { message: 'What is the baggage allowance?', user: uid });
    assert.equal(res.status, 200, app);
    const b = await res.json();
    assert.equal(b.reply, REPLY);
    assert.ok(!b.degraded);
    assert.ok(b.request_id.startsWith('req_'));
  }
  const sent = fake.requests.slice(seen);
  assert.equal(sent.length, 2);
  assert.match(sent[0].body.messages[1].content, /No recent flight searches on record/);
  assert.equal(sent[0].body.model, 'test-model');
  await pool.query('DELETE FROM users WHERE id = $1', [uid]);
});

test('chat with the await fixed: the user\'s real search history is retrieved from PostgreSQL', async () => {
  await fetch(apps.after.base + SEARCH(4) + '&purpose=conference');
  const seen = fake.requests.length;
  const b = await (await post('after', '/api/chat', { message: 'Can I change my booking?', user: 4 })).json();
  assert.equal(b.reply, REPLY);
  const prompt = fake.requests[seen].body.messages[1].content;
  assert.match(prompt, new RegExp(`LHR to SFO on ${nextThursday} \\(conference\\)`));
  assert.match(prompt, /Can I change my booking\?/);
});

test('search and chat bugs are independent on the real stack', async () => {
  // chat fixed, search still sequential
  const c = await (await post('chatFixedOnly', '/api/chat', { message: 'hi', user: 1 })).json();
  assert.equal(c.reply, REPLY);
  const s1 = await (await fetch(apps.chatFixedOnly.base + SEARCH(1))).json();
  assert.ok(s1.elapsed_ms >= LATENCY * 4 * 0.9, `still sequential: ${s1.elapsed_ms}`);
  // search fixed, chat still broken
  const s2 = await (await fetch(apps.searchFixedOnly.base + SEARCH(1))).json();
  assert.ok(s2.elapsed_ms < LATENCY * 3, `concurrent: ${s2.elapsed_ms}`);
  const c2 = await (await post('searchFixedOnly', '/api/chat', { message: 'hi', user: 1 })).json();
  assert.equal(c2.degraded, true);
});

test('chat: provider failure and an unreachable model are clearly identified errors, never a reply', async () => {
  const down = await post('providerDown', '/api/chat', { message: 'hi', user: 1 });
  assert.equal(down.status, 502);
  const db = await down.json();
  assert.equal(db.error, 'llm_error');
  assert.equal(db.reply, undefined);
  const nk = await post('modelDown', '/api/chat', { message: 'hi', user: 1 });
  assert.equal(nk.status, 502);
  const nb = await nk.json();
  assert.equal(nb.error, 'llm_error');
  assert.equal(nb.reply, undefined);
});

test('POST /api/book confirms on the default (buggy-search/chat) build and the fixed build', async () => {
  for (const app of ['before', 'after']) {
    const s = await (await fetch(apps[app].base + SEARCH(1))).json();
    const flight_id = s.flights[0].id;
    const res = await post(app, '/api/book', { flight_id, user: 1 });
    assert.ok(res.headers.get('x-request-id')?.startsWith('req_'));
    assert.equal(res.status, 200, `${app}: booking must not depend on the search/chat bugs`);
    const body = await res.json();
    assert.equal(body.confirmed, true);
    assert.equal(body.flight_id, flight_id);
    assert.ok(body.request_id.startsWith('req_'));
  }
});

test('UI: served page uses a module script and the modules resolve', async () => {
  const html = await (await fetch(apps.after.base + '/')).text();
  assert.match(html, /<script type="module" src="\/js\/main\.js"><\/script>/);
  for (const m of ['main', 'search', 'chat', 'booking', 'util']) {
    assert.equal((await fetch(`${apps.after.base}/js/${m}.js`)).status, 200);
  }
});
