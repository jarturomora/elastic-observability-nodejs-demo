// Minimal OpenAI-compatible Chat Completions server for tests and local telemetry checks.
// It is a stand-in for the provider, NOT proof that a real provider works.
import http from 'node:http';

export function startFakeOpenAI({ reply = 'Fake model reply.', status = 200, delayMs = 0 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      setTimeout(() => {
        if (status !== 200) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'fake provider failure', type: 'server_error' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-fake-1', object: 'chat.completion', created: 1, model: body.model || 'fake-model',
          choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 111, completion_tokens: 22, total_tokens: 133 },
        }));
      }, delayMs);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      requests,
      close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
    }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 4010);
  const s = http.createServer();
  s.close();
  const f = await startFakeOpenAI({ reply: process.env.FAKE_REPLY || 'Fake model reply.' });
  console.log('fake openai at', f.url);
}
