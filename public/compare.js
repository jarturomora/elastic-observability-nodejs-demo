function fire() {
  for (const id of ['before', 'after'])
    document.getElementById(id).contentWindow.postMessage({ type: 'skyward-search' }, '*');
}
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); fire(); }
});
// Panes forward Space here when they have focus
window.addEventListener('message', (e) => { if (e.data && e.data.type === 'skyward-fire') fire(); });

// 1 opens the left (before) chat window, 2 opens the right (after) one. Only opens; never toggles or reloads.
const CHAT_KEYS = { Digit1: 'before', Digit2: 'after' };
function openChat(id) {
  document.getElementById(id).contentWindow.postMessage({ type: 'skyward-open-chat' }, '*');
}
document.addEventListener('keydown', (e) => {
  const pane = CHAT_KEYS[e.code];
  if (pane && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openChat(pane); }
});
// Panes forward 1 / 2 here when they have focus
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'skyward-chat-key' && CHAT_KEYS[e.data.code]) openChat(CHAT_KEYS[e.data.code]);
});

// If a server isn't up yet (e.g. :3001 before `npm run start:fast`), keep checking and reload that
// pane as soon as it responds. Nothing is drawn on the page.
for (const [id, url] of [['before', 'http://localhost:3000'], ['after', 'http://localhost:3001']]) {
  let wasDown = false;
  (async function check() {
    try {
      await fetch(`${url}/health`, { mode: 'no-cors' }); // resolves if reachable, rejects if not
      if (wasDown) document.getElementById(id).src = `${url}/`;
      wasDown = false;
    } catch {
      wasDown = true;
      setTimeout(check, 3000);
    }
  })();
}
