// Real-model smoke test. NOT part of `npm test` / CI. It calls whatever model the app is configured
// for: the local Ollama model by default (start it with `npm run services`), or OpenAI when
// OPENAI_API_KEY is set (one small paid call).
//   npm run test:live-llm        (reads .env)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { createLlm, buildMessages } from '../../src/llm.js';

const cfg = loadConfig(process.env).llm;

test('real model answers a policy question from the supplied facts', async () => {
  const llm = createLlm(cfg);
  const out = await llm.generate(buildMessages({
    message: 'How many checked bags are included and how heavy can they be?',
    searches: [{ origin: 'LHR', destination: 'SFO', date: '2026-11-05', purpose: 'client_meeting', searched_at: new Date() }],
  }));
  console.log(`model=${out.model}\nreply=${out.text}`);
  assert.ok(out.text.length > 0);
  assert.match(out.text, /23\s?kg|one checked|1 checked|checked bag/i);
});
