import { $, esc, fmtPrice, fmtDur, userId } from './util.js';

const overlay = $('modal-overlay');
let currentFlight = null;

export function openBookModal(flight) {
  currentFlight = flight;
  $('modal-title').textContent = 'Confirm booking';
  $('modal-flight-info').innerHTML =
    `<strong>${esc(flight.flightNumber)}</strong> &nbsp;${esc(flight.depart)} → ${esc(flight.arrive)} &nbsp;` +
    `${fmtDur(flight.durationMins)} &nbsp;${esc(flight.airline)}` +
    `<br><span style="font-size:1.02rem;color:var(--muted)">Price: ${fmtPrice(flight.priceCents)} per person</span>`;
  $('modal-price-check').hidden = false;
  $('modal-processing').hidden = true;
  $('modal-failure').hidden = true;
  $('modal-success').hidden = true;
  overlay.hidden = false;
}

function closeModal() {
  overlay.hidden = true;
  currentFlight = null;
}

const FALLBACK = 'Please contact customer care to book this flight as it is not available anymore.';

export function initBooking() {
  $('modal-close').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  $('modal-confirm-btn').addEventListener('click', async () => {
    if (!currentFlight) return;
    $('modal-price-check').hidden = true;
    $('modal-processing').hidden = false;
    try {
      const res = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flight_id: currentFlight.id, user: userId }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.confirmed) {
        $('modal-success').hidden = false;
        $('modal-success-msg').textContent = `Booking confirmed with ${body.partner}. Flight ${body.flight_id}.`;
        $('modal-success-id').textContent = body.request_id ? `Request ID: ${body.request_id}` : '';
      } else {
        $('modal-failure').hidden = false;
        $('modal-failure-msg').textContent = body.message || FALLBACK;
        $('modal-failure-id').textContent = body.request_id ? `Request ID: ${body.request_id}` : '';
      }
    } catch {
      $('modal-failure').hidden = false;
      $('modal-failure-msg').textContent = FALLBACK;
      $('modal-failure-id').textContent = '';
    } finally {
      $('modal-processing').hidden = true;
    }
  });
}
