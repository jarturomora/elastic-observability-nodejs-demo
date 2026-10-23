import { $, esc, fmtPrice, fmtDur, fmtTimer, userId } from './util.js';
import { openBookModal } from './booking.js';

let searchResults = [];
let currentSort = 'fastest';
let timerInterval = null;

const form = $('search-form');
const searchBtn = $('search-btn');

function show(id) {
  ['loading-section', 'results-section', 'error-section']
    .forEach(s => { $(s).hidden = s !== id; });
}

function sortedResults() {
  const fns = {
    fastest:  (a, b) => a.durationMins - b.durationMins || a.priceCents - b.priceCents,
    cheapest: (a, b) => a.priceCents - b.priceCents,
    best:     (a, b) => (a.priceCents * a.durationMins) - (b.priceCents * b.durationMins),
  };
  return [...searchResults].sort(fns[currentSort] || fns.fastest);
}

function renderFlights(flights) {
  const list = $('flights-list');
  list.innerHTML = '';
  if (!flights.length) {
    list.innerHTML = '<p class="no-results">No flights found for this route.</p>';
    return;
  }
  for (const f of flights) {
    const card = document.createElement('article');
    card.className = 'flight-card';
    const stopsLabel = f.stops === 0 ? 'Direct' : `1 stop${f.via ? ' via ' + f.via : ''}`;
    const policyBadge = f.in_policy
      ? '<span class="badge badge-policy">In policy</span>'
      : '<span class="badge badge-approval">Needs approval</span>';
    card.innerHTML = `
      <div class="fc-airline">
        <div class="fc-logo al-${esc(f.code)}">${esc(f.code)}</div>
        <div class="fc-name">${esc(f.airline)}</div>
        <div class="fc-num">${esc(f.flightNumber)}</div>
      </div>
      <div class="fc-route">
        <div class="time-block"><div class="time">${esc(f.depart)}</div><div class="iata">LHR</div></div>
        <div class="route-mid">
          <div class="route-line"><div class="route-dot"></div></div>
          <div class="dur-label">${fmtDur(f.durationMins)}</div>
          <div class="stops-label">${esc(stopsLabel)}</div>
        </div>
        <div class="time-block"><div class="time">${esc(f.arrive)}</div><div class="iata">SFO</div></div>
      </div>
      <div class="fc-right">
        <div class="fc-price">${fmtPrice(f.priceCents)}</div>
        <div class="fc-price-sub">per person</div>
        ${policyBadge}
        <button class="book-btn" data-id="${esc(f.id)}">Book</button>
      </div>`;
    list.appendChild(card);
  }
  list.querySelectorAll('.book-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const flight = searchResults.find(f => f.id === btn.dataset.id);
      if (flight) openBookModal(flight);
    });
  });
}

function renderStatusBar(data) {
  const bar = $('status-bar');
  bar.innerHTML = '';
  const addPill = (cls, text) => {
    const p = document.createElement('span');
    p.className = `pill ${cls}`;
    p.textContent = text;
    bar.appendChild(p);
  };
  addPill('partners', `${data.partners_responded}/${data.partners_total} partners`);
  addPill('time', `${(data.elapsed_ms / 1000).toFixed(2)}s`);
  if (data.trend_avg_cents && searchResults.length) {
    const best = searchResults[0].priceCents;
    const pct = Math.round(Math.abs(best - data.trend_avg_cents) / data.trend_avg_cents * 100);
    const dir = best < data.trend_avg_cents ? 'below' : 'above';
    addPill(`trend-${dir}`, `${pct}% ${dir} route avg`);
  }
}

function startTimer() {
  const t0 = Date.now();
  const el = $('timer');
  el.textContent = '0:00.0';
  return setInterval(() => { el.textContent = fmtTimer(Date.now() - t0); }, 100);
}

function triggerSearch() {
  if (!searchBtn.disabled) form.requestSubmit();
}

export function initSearch() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  $('date').value = d.toISOString().slice(0, 10);

  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSort = btn.dataset.sort;
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderFlights(sortedResults());
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const origin = $('origin').value.trim().toUpperCase();
    const dest = $('destination').value.trim().toUpperCase();
    const date = $('date').value;
    const purpose = $('purpose').value;

    searchBtn.disabled = true;
    searchBtn.textContent = 'Searching…';
    $('loading-route').textContent = `${origin} → ${dest} · ${date}`;
    show('loading-section');
    clearInterval(timerInterval);
    timerInterval = startTimer();

    try {
      const res = await fetch(
        `/api/search?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}` +
        `&date=${encodeURIComponent(date)}&user=${userId}&purpose=${encodeURIComponent(purpose)}&sort=${currentSort}`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        show('error-section');
        $('error-msg').textContent =
          (body.message || body.error || `HTTP ${res.status} — please try again.`) +
          (body.request_id ? ` (Request ID: ${body.request_id})` : '');
        return;
      }
      const data = await res.json();
      searchResults = data.flights || [];
      renderStatusBar(data);
      show('results-section');
      renderFlights(sortedResults());
    } catch {
      show('error-section');
      $('error-msg').textContent = 'Network error — check your connection.';
    } finally {
      clearInterval(timerInterval);
      searchBtn.disabled = false;
      searchBtn.textContent = 'Search flights';
    }
  });

  // S or Ctrl/Cmd+Enter runs the search; compare.html can also trigger it via postMessage.
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    // Inside compare.html: forward Space to the parent so it fires both panes
    if (window.parent !== window && e.code === 'Space' && !typing) {
      e.preventDefault(); window.parent.postMessage({ type: 'skyward-fire' }, '*'); return;
    }
    if ((e.key === 's' || e.key === 'S') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); triggerSearch();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); triggerSearch();
    }
  });
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'skyward-search') triggerSearch();
  });
}
