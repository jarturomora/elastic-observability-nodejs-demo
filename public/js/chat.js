import { $, userId } from './util.js';

// Pure request logic (no DOM) so it can be unit-tested. Never throws.
// → { kind: 'ok' | 'degraded' | 'error', text, requestId }
export async function requestChat(fetchFn, message, user) {
  try {
    const res = await fetchFn('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, user }),
    });
    const body = await res.json().catch(() => ({}));
    const requestId = body.request_id || null;
    if (res.ok && body.reply) {
      return { kind: body.degraded ? 'degraded' : 'ok', text: body.reply, requestId };
    }
    console.debug(`[chat:ERR_${res.status}] ${body.error || 'unexpected response'} rid=${requestId || 'n/a'}`);
    return { kind: 'error', text: body.message || 'Error: unexpected server response.', requestId };
  } catch (err) {
    console.debug('[chat:ERR_NETWORK] fetch failed', err.message);
    return { kind: 'error', text: 'Could not reach Travel Desk - check your connection.', requestId: null };
  }
}

export function initChat() {
  const bubble = $('chat-bubble');
  const panel = $('chat-panel');
  const msgs = $('chat-messages');
  const quick = $('quick-replies');
  const input = $('chat-input');

  function openPanel(focusInput = true) { panel.hidden = false; bubble.setAttribute('aria-expanded', 'true'); if (focusInput) input.focus(); }
  bubble.addEventListener('click', () => openPanel());

  // compare.html: it tells this pane to open the chat window (open only, no reload). Focus is NOT
  // moved into the text box, so the 1 / 2 keys keep working for the other pane; click the box to type.
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'skyward-open-chat') openPanel(false);
  });
  // ...and when this pane has focus, it passes the 1 / 2 keys up to compare.html.
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (window.parent !== window && !typing && (e.code === 'Digit1' || e.code === 'Digit2') &&
        !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      window.parent.postMessage({ type: 'skyward-chat-key', code: e.code }, '*');
    }
  });
  $('chat-close').addEventListener('click', () => { panel.hidden = true; bubble.setAttribute('aria-expanded', 'false'); });

  function addMsg(text, role, cls = '') {
    const el = document.createElement('div');
    el.className = `chat-msg ${role}${cls ? ' ' + cls : ''}`;
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  async function send(message) {
    quick.hidden = true;
    addMsg(message, 'user');

    const typing = document.createElement('div');
    typing.className = 'chat-msg bot typing-indicator';
    for (let i = 0; i < 3; i++) typing.appendChild(document.createElement('span'));
    msgs.appendChild(typing);
    msgs.scrollTop = msgs.scrollHeight;

    try {
      // The indicator lasts exactly as long as the real request.
      const r = await requestChat(fetch, message, userId);
      const text = r.requestId && r.kind !== 'ok' ? `${r.text} (Request ID: ${r.requestId})` : r.text;
      addMsg(text, 'bot', r.kind === 'ok' ? '' : 'error');
    } finally {
      typing.remove();
    }
  }

  document.querySelectorAll('.quick-reply').forEach(btn => {
    btn.addEventListener('click', () => send(btn.dataset.msg));
  });
  $('chat-form').addEventListener('submit', e => {
    e.preventDefault();
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    send(msg);
  });
}
