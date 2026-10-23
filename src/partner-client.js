// Calls the partner fare APIs. Each call creates its OWN timeout signal when it starts, so a
// sequential run never starts a later partner with a clock that is already running.

export async function callPartner(partner, qs, { fetchImpl = fetch, timeoutMs } = {}) {
  const init = timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {};
  const r = await fetchImpl(partner.url + qs, init);
  if (!r.ok) throw new Error(`${partner.name} responded ${r.status}`);
  return { partner, fares: await r.json() };
}

// sequential=true  → CHAOS_STAIRCASE: one partner at a time (latencies add up)
// sequential=false → Promise.allSettled fan-out (latency = slowest partner)
export async function fetchAllPartners(partners, qs, { sequential, fetchImpl, timeoutMs }) {
  const opts = { fetchImpl, timeoutMs };
  const responded = [];
  const failed = [];

  if (sequential) {
    for (const partner of partners) {
      try {
        responded.push(await callPartner(partner, qs, opts));
      } catch (error) {
        failed.push({ partner, error });
      }
    }
  } else {
    const results = await Promise.allSettled(partners.map(p => callPartner(p, qs, opts)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') responded.push(r.value);
      else failed.push({ partner: partners[i], error: r.reason });
    });
  }
  return { responded, failed };
}
