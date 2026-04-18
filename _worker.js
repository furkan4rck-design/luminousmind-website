// LUMI Feed API — Pages advanced mode worker
// Static assets served via env.ASSETS (available in drag-and-drop / Wrangler deployments)
// D1 binding: DB (lumi-feed) | Env var: API_SECRET

const DEPLOY_START = new Date('2026-03-27T00:00:00Z');

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/latest' && request.method === 'GET') {
      return handleLatest(env);
    }
    if (url.pathname === '/api/feed' && request.method === 'POST') {
      return handleFeedWrite(request, env);
    }
    if (url.pathname === '/api/stats' && request.method === 'POST') {
      return handleStatsWrite(request, env);
    }
    if (url.pathname === '/api/stats/increment' && request.method === 'POST') {
      return handleStatsIncrement(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleLatest(env) {
  if (!env.DB) {
    return env.ASSETS.fetch(new Request('https://placeholder/latest.json'));
  }

  const [entriesResult, storedStatsResult, weekCountResult, latestEntryResult] = await Promise.all([
    env.DB.prepare(
      'SELECT type, agent, title, description, timestamp FROM feed_entries ORDER BY timestamp DESC LIMIT 20'
    ).all(),
    // Only fetch the two stats that require vault-side knowledge to compute
    env.DB.prepare(
      "SELECT key, value FROM stats WHERE key IN ('videosGenerated', 'memoryCycles')"
    ).all(),
    // Posts this week — computed live from the entries table
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM feed_entries WHERE timestamp >= datetime('now', '-7 days')"
    ).first(),
    // Last heartbeat — the timestamp of the most recent entry
    env.DB.prepare(
      'SELECT timestamp FROM feed_entries ORDER BY timestamp DESC LIMIT 1'
    ).first(),
  ]);

  const stats = {};

  // Vault-side counters from the stats table
  for (const row of storedStatsResult.results) {
    const num = Number(row.value);
    stats[row.key] = isNaN(num) ? row.value : num;
  }

  // Computed live — never stale
  const now = new Date();
  stats.daysRunning = Math.floor((now - DEPLOY_START) / (1000 * 60 * 60 * 24));
  stats.postsThisWeek = weekCountResult?.count ?? 0;
  stats.lastHeartbeat = latestEntryResult?.timestamp ?? null;

  return new Response(
    JSON.stringify({ updates: entriesResult.results, stats, updatedAt: now.toISOString() }),
    { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
  );
}

async function handleFeedWrite(request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 });
  const { type, agent, title, description, timestamp } = await request.json();
  if (!type || !agent || !title || !description) return new Response('Missing fields', { status: 400 });
  const ts = timestamp || new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO feed_entries (type, agent, title, description, timestamp) VALUES (?, ?, ?, ?, ?)'
  ).bind(type, agent, title, description, ts).run();
  return new Response(JSON.stringify({ ok: true, ts }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleStatsWrite(request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 });
  const body = await request.json();
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(body)) {
    await env.DB.prepare(
      'INSERT OR REPLACE INTO stats (key, value, updated_at) VALUES (?, ?, ?)'
    ).bind(key, String(value), now).run();
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

// POST /api/stats/increment — atomically increment a counter by a delta.
// Body: { "memoryCycles": 1, "videosGenerated": 1 }
// Inserts the key at the given delta if it doesn't exist; increments if it does.
async function handleStatsIncrement(request, env) {
  if (!auth(request, env)) return new Response('Unauthorized', { status: 401 });
  const body = await request.json();
  const now = new Date().toISOString();
  for (const [key, delta] of Object.entries(body)) {
    const by = Number(delta);
    if (isNaN(by) || by === 0) continue;
    await env.DB.prepare(
      `INSERT INTO stats (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CAST(value AS INTEGER) + CAST(excluded.value AS INTEGER),
         updated_at = excluded.updated_at`
    ).bind(key, String(by), now).run();
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

function auth(request, env) {
  return request.headers.get('Authorization') === `Bearer ${env.API_SECRET}`;
}
