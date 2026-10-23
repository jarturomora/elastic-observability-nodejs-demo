// Smoke-check the running app. Exits 0 on success, 1 on any failure.
const BASE = process.env.VERIFY_URL || 'http://localhost:3000';

const nextThursday = (() => {
  const d = new Date();
  const gap = (4 - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + gap);
  return d.toISOString().slice(0, 10);
})();

let passed = 0;
let failed = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`PASS  ${label}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${label} — ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── /health ───────────────────────────────────────────────────────────────────
await check('/health', async () => {
  const res = await fetch(`${BASE}/health`);
  const b = await res.json();
  assert(b.ok === true, 'ok !== true');
  assert(res.headers.get('x-request-id')?.startsWith('req_'), 'missing X-Request-Id header');
});

// ── /api/search — LHR→SFO must return ≥10 real fares from all 4 partners ──────
let searchedFareId = null;
await check('/api/search (LHR→SFO)', async () => {
  const res = await fetch(
    `${BASE}/api/search?origin=LHR&destination=SFO&date=${nextThursday}&user=1&sort=fastest`
  );
  assert(res.ok, `HTTP ${res.status}`);
  assert(res.headers.get('x-request-id')?.startsWith('req_'), 'missing X-Request-Id');
  const b = await res.json();
  assert(b.partners_total === 4, `partners_total ${b.partners_total} !== 4`);
  assert(b.partners_responded === 4, `only ${b.partners_responded}/4 partners responded`);
  console.log(`INFO  search took ${b.elapsed_ms} ms`);
  assert(Array.isArray(b.flights) && b.flights.length >= 10, `only ${b.flights?.length} flights`);
  // Realistic LHR→SFO fares are 600–1100 min and $400–$1200; filler fares (longer/pricier)
  // pad the response with volume — at least 10 realistic fares must be present.
  const realistic = b.flights.filter(f =>
    f.durationMins >= 600 && f.durationMins <= 1100 &&
    f.priceCents >= 40000 && f.priceCents <= 120000
  );
  assert(realistic.length >= 10, `only ${realistic.length} realistic fares in range (600–1100 min, $400–$1200)`);
  const direct = realistic.filter(f => f.stops === 0);
  assert(direct.length >= 1, 'no direct flight among realistic results');
  searchedFareId = b.flights[0].id;
});

// ── /api/insights ─────────────────────────────────────────────────────────────
await check('/api/insights', async () => {
  const res = await fetch(`${BASE}/api/insights?origin=LHR&destination=SFO&user=1`);
  assert(res.ok, `HTTP ${res.status}`);
  assert(res.headers.get('x-request-id')?.startsWith('req_'), 'missing X-Request-Id');
  const b = await res.json();
  assert('avg_price_cents' in b, 'missing avg_price_cents');
  assert(Array.isArray(b.recent_searches), 'missing recent_searches array');
});

const modeInfo = await fetch(`${BASE}/api/mode`).then(r => r.json()).catch(() => null);
const chaos = modeInfo?.chaos ?? {};
const llmConfigured = modeInfo?.llm?.configured ?? false;
console.log(`INFO  active bugs: ${Object.entries(chaos).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}; llm configured: ${llmConfigured}`);

// ── /api/chat ─────────────────────────────────────────────────────────────────
// CHAOS_CHAT on  → intentional 200 + degraded fallback (history_unavailable, TypeError in logs)
// CHAOS_CHAT off → real model answer (needs a model) or a clearly-labelled 503
const chatExpect = chaos.chat ? '200 degraded fallback (missing await)'
  : llmConfigured ? '200 model reply' : '503 llm_not_configured (no key or OPENAI_BASE_URL)';
await check(`/api/chat (${chatExpect})`, async () => {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Is a fare of $1,100 in policy?', user: 1 }),
  });
  assert(res.headers.get('x-request-id')?.startsWith('req_'), 'missing X-Request-Id');
  const b = await res.json();
  assert(typeof b.request_id === 'string' && b.request_id.startsWith('req_'), 'missing request_id in body');
  if (chaos.chat) {
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(b.degraded === true && b.error === 'history_unavailable', 'expected degraded history_unavailable fallback');
  } else if (llmConfigured) {
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(b)} (is the model up? npm run services, then wait for the model download)`);
    assert(typeof b.reply === 'string' && b.reply.length > 0 && !b.degraded, 'expected a real, non-degraded reply');
  } else {
    assert(res.status === 503 && b.error === 'llm_not_configured', `expected 503 llm_not_configured, got ${res.status} ${b.error}`);
    assert(b.reply === undefined, 'must not return a reply when the model is unavailable');
  }
});

// ── /api/book ─────────────────────────────────────────────────────────────────
await check('/api/book (200 confirmed)', async () => {
  const flight_id = searchedFareId || `PN401_${nextThursday}`;
  const res = await fetch(`${BASE}/api/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flight_id, user: 1 }),
  });
  assert(res.headers.get('x-request-id')?.startsWith('req_'), 'missing X-Request-Id');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const b = await res.json();
  assert(b.confirmed === true, 'expected confirmed=true');
  assert(b.flight_id === flight_id, 'flight_id mismatch');
  assert(typeof b.request_id === 'string' && b.request_id.startsWith('req_'),
    `missing or malformed request_id in body: ${JSON.stringify(b)}`);
});

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
