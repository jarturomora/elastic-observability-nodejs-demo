import { describe } from './js/scenario.js';

function fire() {
  for (const id of ['before', 'after'])
    document.getElementById(id).contentWindow.postMessage({ type: 'skyward-search' }, '*');
}
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); fire(); }
});
// Panes forward Space here when they have focus
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'skyward-fire') fire(); });

// Label each pane with the scenarios that are actually active on that server.
for (const [id, url] of [['before', 'http://localhost:3000'], ['after', 'http://localhost:3001']]) {
  const label = document.getElementById(`label-${id}`);
  const name = id.toUpperCase();
  fetch(`${url}/api/mode`).then(r => r.json())
    .then(m => { label.innerHTML = `<b>${name}</b>`; label.append(describe(m.chaos)); })
    .catch(() => { label.innerHTML = `<b>${name}</b>`; label.append('scenario unavailable (server not running?)'); });
}
