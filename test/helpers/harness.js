import { Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import net from 'node:net';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

export const ROOT = new URL('../..', import.meta.url).pathname;

// Capture pino output as parsed objects.
export function logSink() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, log: pino({ level: 'debug' }, stream) };
}

// Start an in-process app on an ephemeral port with injected collaborators.
export async function startApp({ env = {}, pool, llm, fetchImpl } = {}) {
  const sink = logSink();
  const config = loadConfig({ ENABLE_CHAOS: 'true', ...env });
  const app = createApp({ config, pool, llm, fetchImpl, log: sink.log });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, config, logs: sink.lines,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }),
    post: (path, body) => fetch(base + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    get: (path) => fetch(base + path),
  };
}

export function fakePool(handler) {
  const calls = [];
  return {
    calls,
    query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params);
    },
  };
}

// A mocked model boundary: records the messages it was given.
export function fakeLlm({ text = 'MOCK MODEL REPLY', error } = {}) {
  const calls = [];
  return {
    calls,
    async generate(messages) {
      calls.push(messages);
      if (error) throw error;
      return { text, model: 'mock-model' };
    },
  };
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

export function waitForPort(port, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function attempt() {
      const sock = net.connect(port, '127.0.0.1', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        if (Date.now() > deadline) return reject(new Error(`port ${port} not open after ${timeout}ms`));
        setTimeout(attempt, 250);
      });
    })();
  });
}

// Spawn a real child process (src/app.js or src/partners.js) and capture its output.
export function spawnNode(args, env) {
  const proc = spawn('node', args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'pipe' });
  proc.output = '';
  proc.stdout.on('data', d => { proc.output += d; });
  proc.stderr.on('data', d => { proc.output += d; });
  return proc;
}
