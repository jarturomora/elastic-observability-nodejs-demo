import autocannon from 'autocannon';

const BASE        = process.env.LOAD_URL        || 'http://localhost:3000';
const CONNECTIONS = parseInt(process.env.LOAD_CONNECTIONS       || '6');
const DURATION    = parseInt(process.env.LOAD_DURATION_SECONDS  || '300');

const ORIGINS = ['LHR', 'CDG', 'AMS', 'JFK', 'SFO', 'LAX', 'ORD', 'ATL', 'DFW', 'BOS'];
const DESTS   = ['SFO', 'JFK', 'LHR', 'LAX', 'NRT', 'CDG', 'AMS', 'ORD', 'BOS', 'DFW'];
const USERS   = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const PURPOSES= ['client_meeting', 'conference', 'internal'];
// Chat traffic makes real (paid) model calls on a build where CHAOS_CHAT is off.
// LOAD_CHAT_RATE is whole requests per second (default 1); set 0 to skip chat load entirely.
const CHAT_RATE   = parseInt(process.env.LOAD_CHAT_RATE ?? '1', 10);
const MESSAGES= [
  'Is a fare of $1,100 in policy?',
  'What is the baggage allowance?',
  'Can I change my booking?',
  'What is the cancellation policy?',
  'Is this fare in policy?',
  'How do I get approval for this flight?',
];
const SORTS   = ['fastest', 'cheapest', 'best'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randomDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1 + Math.floor(Math.random() * 89));
  return d.toISOString().slice(0, 10);
}

// Pre-generate search paths — collected fare IDs for /api/book sampling
const searchPaths = Array.from({ length: 2000 }, () => {
  let orig, dest;
  do { orig = rand(ORIGINS); dest = rand(DESTS); } while (orig === dest);
  return `/api/search?origin=${orig}&destination=${dest}&date=${randomDate()}&user=${rand(USERS)}&purpose=${rand(PURPOSES)}&sort=${rand(SORTS)}`;
});

const insightsPaths = Array.from({ length: 400 }, () => {
  let orig, dest;
  do { orig = rand(ORIGINS); dest = rand(DESTS); } while (orig === dest);
  return `/api/insights?origin=${orig}&destination=${dest}&user=${rand(USERS)}`;
});

// Book path uses a real fare id from a prior search (sampled at startup)
let cachedFareId = null;
(async () => {
  try {
    const r = await fetch(BASE + `/api/search?origin=LHR&destination=SFO&date=${randomDate()}&user=1&sort=fastest`);
    if (r.ok) {
      const body = await r.json();
      if (body.flights && body.flights.length) cachedFareId = body.flights[0].id;
    }
  } catch { /* continue without it */ }
})();

function bookBody() {
  const id = cachedFareId || `PN401_${randomDate()}`;
  return JSON.stringify({ flight_id: id, user: rand(USERS) });
}

const chatBodies = MESSAGES.map(m => JSON.stringify({ message: m, user: rand(USERS) }));

console.log(`\nStarting load against ${BASE} — ${DURATION}s, search=${CONNECTIONS} connections`);

// ── Streams ──────────────────────────────────────────────────────────────────

const searchRun = autocannon({
  url: BASE, connections: CONNECTIONS, duration: DURATION,
  requests: searchPaths.map(path => ({ method: 'GET', path })),
});

const chatRun = CHAT_RATE > 0 ? autocannon({
  url: BASE, connections: 1, duration: DURATION, overallRate: CHAT_RATE,
  requests: chatBodies.map(body => ({
    method: 'POST', path: '/api/chat',
    headers: { 'Content-Type': 'application/json' },
    body,
  })),
}) : null;

const bookRun = autocannon({
  url: BASE, connections: 1, duration: DURATION, overallRate: 1,
  requests: [{
    method: 'POST', path: '/api/book',
    headers: { 'Content-Type': 'application/json' },
    setupRequest(req) { req.body = bookBody(); return req; },
  }],
});

const insightsRun = autocannon({
  url: BASE, connections: 1, duration: DURATION, overallRate: 1,
  requests: insightsPaths.map(path => ({ method: 'GET', path })),
});

const healthRun = autocannon({
  url: BASE, connections: 1, duration: DURATION, overallRate: 1,
  requests: [{ method: 'GET', path: '/health' }],
});

autocannon.track(searchRun, { renderProgressBar: true });

function summary(label, r) {
  const errRate = r.requests.total > 0
    ? ((r.errors + r.non2xx) / r.requests.total * 100).toFixed(1) : '0.0';
  console.log(`\n── ${label} ──`);
  console.log(`  Requests : ${r.requests.total}  Errors: ${r.errors + r.non2xx} (${errRate}%)`);
  console.log(`  Latency  p50=${r.latency.p50}ms  p95=${r.latency.p95}ms  p99=${r.latency.p99}ms`);
}

searchRun.on('done',   r => summary('GET /api/search',   r));
chatRun?.on('done',    r => summary('POST /api/chat',     r));
bookRun.on('done',     r => summary('POST /api/book',     r));
insightsRun.on('done', r => summary('GET /api/insights',  r));
healthRun.on('done',   r => {
  summary('/health (event-loop proxy)', r);
  console.log('');
});
