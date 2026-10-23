// Central, testable configuration. Reads only the env object it is given.
const bool = (v, dflt) => (v === undefined || v === '' ? dflt : v !== 'false');
const int = (v, dflt) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : dflt);

export function loadConfig(env = process.env) {
  // ENABLE_CHAOS=false forces every intentional bug off.
  const master = env.ENABLE_CHAOS !== 'false';
  // The two teaching bugs. Both default on; each is controlled on its own.
  const chaos = {
    staircase: master && bool(env.CHAOS_STAIRCASE, true),
    chat:      master && bool(env.CHAOS_CHAT, true),
  };
  // Model: a small local model (Ollama's OpenAI-compatible API) unless an OpenAI key is set.
  return {
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/skyward',
    partnerHost: env.PARTNER_HOST || 'localhost',
    // Per-partner timeout. The mock adds 1.3 s, so 4 s leaves plenty of headroom.
    partnerTimeoutMs: int(env.PARTNER_TIMEOUT_MS, 4000),
    chaos,
    mode: Object.values(chaos).some(Boolean) ? 'before' : 'after',
    llm: {
      apiKey: env.OPENAI_API_KEY || '',
      baseURL: env.OPENAI_BASE_URL || (env.OPENAI_API_KEY ? undefined : 'http://localhost:11434/v1'),
      // LOCAL_MODEL picks the local model for both the app and the Compose download.
      model: env.OPENAI_MODEL || (env.OPENAI_API_KEY && !env.OPENAI_BASE_URL ? 'gpt-4o-mini' : env.LOCAL_MODEL || 'qwen2.5:1.5b'),
      timeoutMs: int(env.LLM_TIMEOUT_MS, 30000), // room for a small local model on CPU
      maxOutputTokens: int(env.LLM_MAX_OUTPUT_TOKENS, 300),
    },
    showLoadingTimer: env.SHOW_LOADING_TIMER !== 'false',
  };
}
