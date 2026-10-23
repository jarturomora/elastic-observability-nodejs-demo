// /api/chat with a MOCKED model boundary and a fake pool: no database, no network, no paid calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, fakePool, fakeLlm } from './helpers/harness.js';
import { startFakeOpenAI } from './helpers/fake-openai.js';
import { createLlm, LlmError, buildMessages, POLICY_FACTS } from '../src/llm.js';

const ROWS = [
  { origin: 'LHR', destination: 'SFO', date: '2026-11-05', purpose: 'client_meeting', searched_at: new Date('2026-10-22T10:00:00Z') },
  { origin: 'JFK', destination: 'LAX', date: '2026-12-01', purpose: null, searched_at: new Date('2026-10-21T10:00:00Z') },
];
const ok = rows => async () => ({ rows });
const body = { message: 'Is a $1,100 fare in policy?', user: 3 };

test('broken chat (CHAOS_CHAT=true): TypeError from the missing await, 200 degraded, model NOT called', async () => {
  const pool = fakePool(ok(ROWS));
  const llm = fakeLlm();
  const app = await startApp({ env: { CHAOS_CHAT: 'true' }, pool, llm });
  try {
    const res = await app.post('/api/chat', body);
    assert.equal(res.status, 200, 'HTTP 200 even though the request failed');
    const b = await res.json();
    assert.equal(b.degraded, true);
    assert.equal(b.error, 'history_unavailable');
    assert.match(b.reply, /couldn't load your recent searches/);
    assert.equal(b.request_id, res.headers.get('x-request-id'));
    assert.equal(llm.calls.length, 0, 'the model must not be reached');
    assert.equal(pool.calls.length, 1, 'the query was still issued, just never awaited');

    const errLog = app.logs.find(l => l.level === 50 && l.failure === 'history_access');
    assert.ok(errLog, 'expected a correlated server-side error log');
    assert.equal(errLog.request_id, b.request_id);
    assert.equal(errLog.err.type, 'TypeError');
    assert.match(errLog.err.message, /undefined/, 'history.rows is undefined on a Promise');
  } finally { await app.close(); }
});

test('broken chat is a missing-await bug, not an empty-result bug: empty rows still fail', async () => {
  const app = await startApp({ env: { CHAOS_CHAT: 'true' }, pool: fakePool(ok([])), llm: fakeLlm() });
  try {
    const b = await (await app.post('/api/chat', body)).json();
    assert.equal(b.degraded, true);
  } finally { await app.close(); }
});

test('fixed chat: retrieved searches + policy facts reach the model and its text is the reply', async () => {
  const pool = fakePool(ok(ROWS));
  const llm = fakeLlm({ text: 'Yes, under $1,200 is in policy.' });
  const app = await startApp({ env: { CHAOS_CHAT: 'false' }, pool, llm });
  try {
    const res = await app.post('/api/chat', body);
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.reply, 'Yes, under $1,200 is in policy.');
    assert.equal(b.degraded, undefined);
    assert.ok(b.request_id.startsWith('req_'));

    assert.deepEqual(pool.calls[0].params, [3], 'history is retrieved for the requesting user only');
    const [system, user] = llm.calls[0];
    assert.equal(system.role, 'system');
    assert.match(user.content, /LHR to SFO on 2026-11-05 \(client_meeting\)/);
    assert.match(user.content, /JFK to LAX on 2026-12-01/);
    assert.equal(user.content.match(/\[most recent\]/g).length, 1, 'only the newest search is marked');
    assert.match(user.content, /LHR to SFO on 2026-11-05 \(client_meeting\), searched \S+ \[most recent\]/);
    assert.match(user.content, /Is a \$1,100 fare in policy\?/);
    for (const fact of POLICY_FACTS) assert.ok(user.content.includes(fact));
    assert.match(user.content, /no booking records or earlier chat messages/);
  } finally { await app.close(); }
});

test('fixed chat: legitimately empty history is handled after awaiting', async () => {
  const llm = fakeLlm();
  const app = await startApp({ env: { CHAOS_CHAT: 'false' }, pool: fakePool(ok([])), llm });
  try {
    const res = await app.post('/api/chat', body);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reply, 'MOCK MODEL REPLY');
    assert.match(llm.calls[0][1].content, /No recent flight searches on record/);
  } finally { await app.close(); }
});

test('database rejection (fixed chat): 503 history_unavailable, logged as history_access, model not called', async () => {
  const llm = fakeLlm();
  const dbErr = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  const app = await startApp({ env: { CHAOS_CHAT: 'false' }, pool: fakePool(async () => { throw dbErr; }), llm });
  try {
    const res = await app.post('/api/chat', body);
    assert.equal(res.status, 503);
    const b = await res.json();
    assert.equal(b.error, 'history_unavailable');
    assert.equal(b.reply, undefined);
    assert.equal(llm.calls.length, 0);
    const l = app.logs.find(x => x.failure === 'history_access');
    assert.equal(l.request_id, b.request_id);
    assert.equal(l.chaos_chat, false);
  } finally { await app.close(); }
});

test('database rejection while the await is missing never becomes an unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const app = await startApp({
    env: { CHAOS_CHAT: 'true' }, llm: fakeLlm(),
    pool: fakePool(() => Promise.reject(new Error('db down'))),
  });
  try {
    assert.equal((await app.post('/api/chat', body)).status, 200);
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); await app.close(); }
});

test('model failures are distinct from history failures (status, error code, log tag)', async () => {
  const cases = [
    [new LlmError('llm_error', 'upstream 500', { status: 500 }), 502, 'llm_error'],
    [new LlmError('llm_timeout', 'timed out'), 504, 'llm_timeout'],
    [new LlmError('llm_not_configured', 'no key'), 503, 'llm_not_configured'],
    [new Error('something unexpected'), 502, 'llm_error'],
  ];
  for (const [error, status, code] of cases) {
    const app = await startApp({ env: { CHAOS_CHAT: 'false' }, pool: fakePool(ok(ROWS)), llm: fakeLlm({ error }) });
    try {
      const res = await app.post('/api/chat', body);
      assert.equal(res.status, status, code);
      const b = await res.json();
      assert.equal(b.error, code);
      assert.equal(b.reply, undefined, 'a failure must never carry a reply');
      assert.equal(b.degraded, undefined);
      const l = app.logs.find(x => x.failure === 'llm');
      assert.ok(l && l.request_id === b.request_id && l.code === code);
      assert.ok(!app.logs.some(x => x.failure === 'history_access'));
    } finally { await app.close(); }
  }
});

test('a local OpenAI-compatible server needs no API key', async () => {
  const fake = await startFakeOpenAI({ reply: 'Local model says hi.' });
  try {
    const out = await createLlm({ ...cfg({ apiKey: '' }), baseURL: fake.url }).generate([{ role: 'user', content: 'hi' }]);
    assert.equal(out.text, 'Local model says hi.');
  } finally { await fake.close(); }
});

test('model unreachable (e.g. Ollama not started) → clearly identified 502, no canned answer', async () => {
  const app = await startApp({
    env: { CHAOS_CHAT: 'false', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1', LLM_TIMEOUT_MS: '2000' },
    pool: fakePool(ok(ROWS)),
  }); // real createLlm against a closed port
  try {
    const res = await app.post('/api/chat', body);
    assert.equal(res.status, 502);
    const b = await res.json();
    assert.equal(b.error, 'llm_error');
    assert.equal(b.reply, undefined);
    const mode = await (await app.get('/api/mode')).json();
    assert.equal(mode.llm.configured, true);
    assert.ok(!JSON.stringify(mode).includes('sk-'));
  } finally { await app.close(); }
});

test('input validation happens before anything else', async () => {
  const pool = fakePool(ok(ROWS));
  const llm = fakeLlm();
  const app = await startApp({ env: { CHAOS_CHAT: 'true' }, pool, llm });
  try {
    for (const bad of [{}, { message: '', user: 1 }, { message: 'hi' }, { message: 'hi', user: 'abc' },
                       { message: 'hi', user: -1 }, { message: 'x'.repeat(501), user: 1 }, { message: 5, user: 1 }]) {
      const res = await app.post('/api/chat', bad);
      assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 40));
      assert.equal((await res.json()).error, 'invalid_request');
    }
    assert.equal(pool.calls.length, 0);
    assert.equal(llm.calls.length, 0);
  } finally { await app.close(); }
});

// ── The real model client against a fake OpenAI-compatible HTTP server ───────
const cfg = (o = {}) => ({ apiKey: 'test-key', model: 'test-model', timeoutMs: 2000, maxOutputTokens: 77, ...o });

test('createLlm sends model, bounded output and messages; returns the provider text', async () => {
  const fake = await startFakeOpenAI({ reply: '  Provider text.  ' });
  try {
    const llm = createLlm(cfg({ baseURL: fake.url }));
    const messages = buildMessages({ message: 'hello', searches: [] });
    const out = await llm.generate(messages);
    assert.equal(out.text, 'Provider text.');
    const sent = fake.requests[0];
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, 'Bearer test-key');
    assert.equal(sent.body.model, 'test-model');
    assert.equal(sent.body.max_completion_tokens, 77);
    assert.deepEqual(sent.body.messages, messages);
  } finally { await fake.close(); }
});

test('createLlm maps provider errors and timeouts to LlmError codes', async () => {
  const failing = await startFakeOpenAI({ status: 500 });
  const slow = await startFakeOpenAI({ delayMs: 600 });
  try {
    await assert.rejects(createLlm(cfg({ baseURL: failing.url })).generate([]),
      e => e instanceof LlmError && e.code === 'llm_error' && e.providerStatus === 500);
    assert.equal(failing.requests.length, 1, 'no retries: bounded');
    await assert.rejects(createLlm(cfg({ baseURL: slow.url, timeoutMs: 150 })).generate([]),
      e => e instanceof LlmError && e.code === 'llm_timeout');
    await assert.rejects(createLlm(cfg({ apiKey: '' })).generate([]), e => e.code === 'llm_not_configured');
  } finally { await failing.close(); await slow.close(); }
});
