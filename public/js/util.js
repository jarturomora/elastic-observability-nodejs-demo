export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function fmtPrice(c) {
  return '$' + (c / 100).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
export function fmtDur(m) {
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function fmtTimer(ms) {
  const tenths = Math.floor(ms / 100) % 10;
  const secs = Math.floor(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}.${tenths}`;
}

// Random demo user 1-10 (matches the seeded users).
export const userId = Math.ceil(Math.random() * 10);
