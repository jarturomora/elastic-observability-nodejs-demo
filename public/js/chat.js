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

  bubble.addEventListener('click', () => { panel.hidden = false; bubble.setAttribute('aria-expanded', 'true'); input.focus(); });
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
