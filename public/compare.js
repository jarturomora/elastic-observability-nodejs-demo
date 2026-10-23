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
// Label each pane with the scenario that server reports. If a server is not running, say how to
// start it, keep polling, and reload the pane as soon as it comes up.
const PANES = [
  ['before', 'http://localhost:3000', 'npm start'],
  ['after', 'http://localhost:3001', 'npm run start:fast'],
];

for (const [id, url, startCmd] of PANES) {
  const label = document.getElementById(`label-${id}`);
  const name = id.toUpperCase();
  let wasDown = false;

  const setLabel = (text) => { label.innerHTML = `<b>${name}</b>`; label.append(text); };

  async function check() {
    try {
      const m = await (await fetch(`${url}/api/mode`)).json();
      setLabel(describe(m.chaos));
      if (wasDown) { document.getElementById(id).src = `${url}/`; wasDown = false; }
    } catch {
      wasDown = true;
      setLabel(`not running on ${url.replace('http://', '')}. Start it with: ${startCmd}`);
      setTimeout(check, 3000);
    }
  }
  check();
}
